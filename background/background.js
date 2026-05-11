const TARGET_URL = 'https://bpweb.stswr.ca/Eligibility';

const DISTRICTS = [
  { value: 'WCDSB', name: 'Waterloo Catholic District School Board' },
  { value: 'WRDSB', name: 'Waterloo Region District School Board' }
];

const SCHOOL_YEAR_GUID = '16f9713c-1b82-45f8-9b85-376db865fb68';

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'lookup') {
    handleLookup(message.streetNumber, message.streetName, message.municipality)
      .then(results => sendResponse({ results }))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});

async function handleLookup(streetNumber, streetName, municipality) {
  const resolvedStreet = await resolveStreetName(streetName, municipality);
  if (!resolvedStreet) {
    throw new Error('Could not resolve street name from autocomplete');
  }

  const districtResults = await Promise.all(
    DISTRICTS.map(d => lookupDistrict(streetNumber, resolvedStreet, municipality, d))
  );
  return districtResults.flat();
}

async function resolveStreetName(streetName, municipality) {
  const resp = await fetchWithTimeout(`${TARGET_URL}.aspx/GetCompletionList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      prefixText: streetName,
      count: 100,
      contextKey: municipality.toUpperCase()
    })
  });

  if (!resp.ok) throw new Error('Autocomplete request failed');

  const data = await resp.json();
  const items = data.d || [];
  if (items.length === 0) return null;

  const upper = streetName.toUpperCase();
  return items.find(i => i.toUpperCase() === upper)
    || items.find(i => i.toUpperCase().startsWith(upper))
    || items.find(i => i.toUpperCase().includes(upper))
    || items[0];
}

async function lookupDistrict(streetNumber, streetName, municipality, district) {
  // Step 1: GET the page to extract tokens
  const pageResp = await fetchWithTimeout(TARGET_URL, { credentials: 'include' });
  if (!pageResp.ok) throw new Error('Failed to load eligibility page');
  const html = await pageResp.text();

  const viewState = extractHidden(html, '__VIEWSTATE');
  const viewStateGenerator = extractHidden(html, '__VIEWSTATEGENERATOR');
  const eventValidation = extractHidden(html, '__EVENTVALIDATION');

  if (!viewState || !eventValidation) {
    throw new Error('Could not extract form tokens');
  }

  // Step 2: POST form data
  const formData = new URLSearchParams();
  formData.set('__VIEWSTATE', viewState);
  formData.set('__VIEWSTATEGENERATOR', viewStateGenerator || '');
  formData.set('__VIEWSTATEENCRYPTED', '');
  formData.set('__EVENTVALIDATION', eventValidation);
  formData.set('__EVENTTARGET', '');
  formData.set('__EVENTARGUMENT', '');
  formData.set('__LASTFOCUS', '');
  formData.set('ctl00$hfApplicationRoot', '/');
  formData.set('ctl00$hfDateFormat', 'yy-mm-dd');
  formData.set('ctl00$MainContent$eaSchool$txtStreetNumber', streetNumber);
  formData.set('ctl00$MainContent$eaSchool$meeStreetNumber_ClientState', '');
  formData.set('ctl00$MainContent$eaSchool$txtStreetName', streetName);
  formData.set('ctl00$MainContent$eaSchool$ddlCity', municipality.toUpperCase());
  formData.set('ctl00$MainContent$eaSchool$hfPostCode', '');
  formData.set('ctl00$MainContent$eaSchool$ddlDistrict', district.value);
  formData.set('ctl00$_cbDatabase', SCHOOL_YEAR_GUID);
  formData.set('ctl00$ddlLanguages', 'en-CA');
  formData.set('ctl00$cbDefaultDatabase', SCHOOL_YEAR_GUID);
  formData.set('hiddenInputToUpdateATBuffer_CommonToolkitScripts', '1');
  formData.set('ctl00$MainContent$btnSubmit', 'Submit');

  const submitResp = await fetchWithTimeout(TARGET_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString()
  });

  if (!submitResp.ok) throw new Error(`Submit failed for ${district.value}`);
  const resultHtml = await submitResp.text();

  return parseResults(resultHtml, district);
}

function parseResults(html, district) {
  // Try parsing embedded JSON from script tags (SchoolPositions)
  const jsonMatch = html.match(/SchoolPositions\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (jsonMatch) {
    try {
      const cleaned = jsonMatch[1].replace(/\\"/g, '"');
      const parsed = JSON.parse(cleaned);
      const schools = Array.isArray(parsed[0]) ? parsed[0] : parsed;
      return schools.map(s => ({
        name: s.Name ? s.Name.replace(/\s*\(\d{3}-\d{3}-\d{4}\)\s*$/, '').trim() : 'Unknown',
        type: s.GradeSchoolType || inferType(s),
        district: district.value
      }));
    } catch (e) { console.warn('SchoolPositions JSON parse failed, using HTML fallback', e); }
  }

  // Fallback: parse HTML repeater elements
  return parseResultsFromHtml(html, district);
}

function parseResultsFromHtml(html, district) {
  const results = [];
  const linkRegex = /id="MainContent_repSchoolDetail_hlSchoolName_(\d+)"[^>]*>([^<]+)</g;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const rawName = match[2].trim();
    const name = rawName.replace(/\s*\(\d{3}-\d{3}-\d{4}\)\s*$/, '').trim();

    let type = 'Elementary';
    const lower = name.toLowerCase();
    if (lower.includes('secondary') || lower.includes('collegiate') || lower.includes('high school')) {
      type = 'Secondary';
    }

    results.push({ name, type, district: district.value });
  }

  // Try grade-based inference for schools not caught by name
  const gradeRegex = /id="MainContent_repSchoolDetail_rBoundary_0_lblGradeList_(\d+)"[^>]*>([^<]+)</g;
  while ((match = gradeRegex.exec(html)) !== null) {
    const idx = parseInt(match[1], 10);
    if (idx < results.length && results[idx].type === 'Elementary') {
      const grades = match[2].trim();
      const hasHigh = grades.split(',').some(g => parseInt(g, 10) >= 9);
      if (hasHigh) results[idx].type = 'Secondary';
    }
  }

  return results;
}

function inferType(school) {
  if (school.GradeSchoolType) return school.GradeSchoolType;
  const lower = (school.Name || '').toLowerCase();
  if (lower.includes('secondary') || lower.includes('collegiate') || lower.includes('high school')) {
    return 'Secondary';
  }
  if (school.Grades && school.Grades.some(g => parseInt(g, 10) >= 9)) {
    return 'Secondary';
  }
  return 'Elementary';
}

function extractHidden(html, name) {
  const regex = new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i');
  const match = html.match(regex);
  return match ? match[1] : null;
}
