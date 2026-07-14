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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'lookup') return;
  port.onMessage.addListener((msg) => {
    handleLookupWithProgress(msg.streetNumber, msg.streetName, msg.municipality, port);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'refreshRatings') {
    handleRefreshRatings()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.action === 'getRatingsStatus') {
    chrome.storage.local.get(['schoolRatings'], (data) => {
      if (data.schoolRatings) {
        sendResponse({ lastUpdated: data.schoolRatings.lastUpdated, count: data.schoolRatings.schools.length });
      } else {
        sendResponse({ lastUpdated: null, count: 0 });
      }
    });
    return true;
  }
});

async function handleLookupWithProgress(streetNumber, streetName, municipality, port) {
  try {
    port.postMessage({ type: 'progress', step: 'Resolving street name...' });
    const resolvedStreet = await resolveStreetName(streetName, municipality);
    if (!resolvedStreet) {
      port.postMessage({ type: 'error', message: 'Could not resolve street name from autocomplete' });
      return;
    }

    port.postMessage({ type: 'progress', step: `Street resolved: ${resolvedStreet}` });

    const allResults = [];
    for (const district of DISTRICTS) {
      port.postMessage({ type: 'progress', step: `Looking up ${district.name}...` });
      const results = await lookupDistrict(streetNumber, resolvedStreet, municipality, district);
      allResults.push(...results);
    }

    port.postMessage({ type: 'progress', step: 'Matching school ratings...' });
    const enriched = await enrichWithRatings(allResults);

    port.postMessage({ type: 'done', results: enriched });
  } catch (err) {
    port.postMessage({ type: 'error', message: err.message });
  }
}

async function resolveStreetName(streetName, municipality) {
  const items = await queryAutocomplete(streetName, municipality);
  if (items.length > 0) return pickBestMatch(streetName, items);

  // Retry with progressively shorter prefixes (strip trailing words)
  const words = streetName.trim().split(/\s+/);
  for (let len = words.length - 1; len >= 1; len--) {
    const prefix = words.slice(0, len).join(' ');
    const retry = await queryAutocomplete(prefix, municipality);
    if (retry.length > 0) return pickBestMatch(streetName, retry);
  }

  return null;
}

async function queryAutocomplete(prefix, municipality) {
  const resp = await fetchWithTimeout(`${TARGET_URL}.aspx/GetCompletionList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      prefixText: prefix,
      count: 100,
      contextKey: municipality.toUpperCase()
    })
  });
  if (!resp.ok) throw new Error('Autocomplete request failed');
  const data = await resp.json();
  return data.d || [];
}

function pickBestMatch(streetName, items) {
  const upper = streetName.toUpperCase();
  return items.find(i => i.toUpperCase() === upper)
    || items.find(i => i.toUpperCase().startsWith(upper))
    || items.find(i => i.toUpperCase().includes(upper))
    || items.find(i => upper.includes(i.toUpperCase()))
    || items[0];
}

const GRADE_09_GUID_FALLBACK = 'a85cd392-045a-47c3-b121-04d7efdae5ab';

function extractGrade09Guid(html) {
  const selectMatch = html.match(/<select[^>]*name="ctl00\$MainContent\$eaSchool\$ddlGrade"[^>]*>([\s\S]*?)<\/select>/i);
  if (!selectMatch) return null;
  const optionMatch = selectMatch[1].match(/<option[^>]*value="([^"]+)"[^>]*>\s*(?:Grade\s*)?0?9\b/i);
  return optionMatch ? optionMatch[1] : null;
}

function extractDropdownValues(html, fieldId) {
  const selectRegex = new RegExp(`id="${fieldId}"[^>]*>([\\s\\S]*?)<\\/select>`, 'i');
  const selectMatch = html.match(selectRegex);
  if (!selectMatch) return [];
  const optionRegex = /<option[^>]*value="([^"]*)"[^>]*>/gi;
  const values = [];
  let m;
  while ((m = optionRegex.exec(selectMatch[1])) !== null) {
    if (m[1]) values.push(m[1]);
  }
  return values;
}

function matchCityValue(municipality, cityValues) {
  const upper = municipality.toUpperCase();
  return cityValues.find(v => v.toUpperCase() === upper) || municipality;
}

async function lookupDistrict(streetNumber, streetName, municipality, district) {
  const pageResp = await fetchWithTimeout(TARGET_URL, { credentials: 'include' });
  if (!pageResp.ok) throw new Error('Failed to load eligibility page');
  const html = await pageResp.text();

  const viewState = extractHidden(html, '__VIEWSTATE');
  const viewStateGenerator = extractHidden(html, '__VIEWSTATEGENERATOR');
  const eventValidation = extractHidden(html, '__EVENTVALIDATION');

  if (!viewState || !eventValidation) {
    throw new Error('Could not extract form tokens');
  }

  const cityValues = extractDropdownValues(html, 'MainContent_eaSchool_ddlCity');
  const cityValue = matchCityValue(municipality, cityValues);

  const formData = new URLSearchParams();
  formData.set('__VIEWSTATE', viewState);
  formData.set('__VIEWSTATEGENERATOR', viewStateGenerator || '');
  formData.set('__VIEWSTATEENCRYPTED', '');
  formData.set('__EVENTVALIDATION', eventValidation);
  formData.set('ctl00$hfApplicationRoot', '/');
  formData.set('ctl00$hfDateFormat', 'yy-mm-dd');
  formData.set('ctl00$MainContent$eaSchool$txtStreetNumber', streetNumber);
  formData.set('ctl00$MainContent$eaSchool$meeStreetNumber_ClientState', '');
  formData.set('ctl00$MainContent$eaSchool$txtStreetName', streetName);
  formData.set('ctl00$MainContent$eaSchool$ddlCity', cityValue);
  formData.set('ctl00$MainContent$eaSchool$hfPostCode', '');
  formData.set('ctl00$MainContent$eaSchool$ddlDistrict', district.value);
  formData.set('ctl00$ddlLanguages', 'en-CA');
  formData.set('ctl00$cbDefaultDatabase', SCHOOL_YEAR_GUID);
  formData.set('ctl00$MainContent$btnSubmit', 'Submit');

  const submitResp = await fetchWithTimeout(TARGET_URL, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString()
  });

  if (!submitResp.ok) throw new Error(`Submit failed for ${district.value}`);
  const resultHtml = await submitResp.text();
  const elementaryResults = parseResults(resultHtml, district);

  // Re-submit with grade 09 to get secondary school
  const grade09Guid = extractGrade09Guid(resultHtml) || GRADE_09_GUID_FALLBACK;
  const secondaryResults = await lookupSecondary(resultHtml, streetNumber, streetName, cityValue, district, grade09Guid);

  return [...elementaryResults, ...secondaryResults];
}

async function lookupSecondary(resultPageHtml, streetNumber, streetName, cityValue, district, gradeGuid) {
  // Result page has disabled dropdowns — click "New Search" to get an enabled form with ddlGrade
  const resetViewState = extractHidden(resultPageHtml, '__VIEWSTATE');
  const resetViewStateGenerator = extractHidden(resultPageHtml, '__VIEWSTATEGENERATOR');
  const resetEventValidation = extractHidden(resultPageHtml, '__EVENTVALIDATION');

  if (!resetViewState || !resetEventValidation) return [];

  const resetForm = new URLSearchParams();
  resetForm.set('__VIEWSTATE', resetViewState);
  resetForm.set('__VIEWSTATEGENERATOR', resetViewStateGenerator || '');
  resetForm.set('__VIEWSTATEENCRYPTED', '');
  resetForm.set('__EVENTVALIDATION', resetEventValidation);
  resetForm.set('ctl00$hfApplicationRoot', '/');
  resetForm.set('ctl00$hfDateFormat', 'yy-mm-dd');
  resetForm.set('ctl00$MainContent$eaSchool$txtStreetNumber', streetNumber);
  resetForm.set('ctl00$MainContent$eaSchool$meeStreetNumber_ClientState', '');
  resetForm.set('ctl00$MainContent$eaSchool$txtStreetName', streetName);
  resetForm.set('ctl00$MainContent$eaSchool$hfPostCode', '');
  resetForm.set('ctl00$ddlLanguages', 'en-CA');
  resetForm.set('ctl00$cbDefaultDatabase', SCHOOL_YEAR_GUID);
  resetForm.set('ctl00$MainContent$btnReset', 'New Search');

  try {
    const resetResp = await fetchWithTimeout(TARGET_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: resetForm.toString()
    });
    if (!resetResp.ok) return [];
    const resetHtml = await resetResp.text();

    const viewState = extractHidden(resetHtml, '__VIEWSTATE');
    const viewStateGenerator = extractHidden(resetHtml, '__VIEWSTATEGENERATOR');
    const eventValidation = extractHidden(resetHtml, '__EVENTVALIDATION');
    if (!viewState || !eventValidation) return [];

    const resetCityValues = extractDropdownValues(resetHtml, 'MainContent_eaSchool_ddlCity');
    const resetCityValue = matchCityValue(cityValue, resetCityValues);
    const grade = extractGrade09Guid(resetHtml) || gradeGuid;

    const formData = new URLSearchParams();
    formData.set('__VIEWSTATE', viewState);
    formData.set('__VIEWSTATEGENERATOR', viewStateGenerator || '');
    formData.set('__VIEWSTATEENCRYPTED', '');
    formData.set('__EVENTVALIDATION', eventValidation);
    formData.set('ctl00$hfApplicationRoot', '/');
    formData.set('ctl00$hfDateFormat', 'yy-mm-dd');
    formData.set('ctl00$MainContent$eaSchool$txtStreetNumber', streetNumber);
    formData.set('ctl00$MainContent$eaSchool$meeStreetNumber_ClientState', '');
    formData.set('ctl00$MainContent$eaSchool$txtStreetName', streetName);
    formData.set('ctl00$MainContent$eaSchool$ddlCity', resetCityValue);
    formData.set('ctl00$MainContent$eaSchool$hfPostCode', '');
    formData.set('ctl00$MainContent$eaSchool$ddlDistrict', district.value);
    formData.set('ctl00$MainContent$eaSchool$ddlGrade', grade);
    formData.set('ctl00$ddlLanguages', 'en-CA');
    formData.set('ctl00$cbDefaultDatabase', SCHOOL_YEAR_GUID);
    formData.set('ctl00$MainContent$btnSubmit', 'Submit');

    const resp = await fetchWithTimeout(TARGET_URL, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    });
    if (!resp.ok) return [];
    const html = await resp.text();
    return parseResults(html, district);
  } catch (e) {
    console.warn('Secondary lookup failed:', e.message);
    return [];
  }
}

function parseResults(html, district) {
  // Try parsing embedded JSON from script tags (SchoolPositions)
  const jsonMatch = html.match(/SchoolPositions\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (jsonMatch) {
    try {
      const cleaned = jsonMatch[1].replace(/\\"/g, '"');
      const parsed = JSON.parse(cleaned);
      const schools = Array.isArray(parsed[0]) ? parsed.flat() : parsed;
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

// --- School Ratings ---

async function handleRefreshRatings() {
  const tab = await chrome.tabs.create({
    url: 'https://www.compareschoolrankings.org/',
    active: false
  });

  try {
    await waitForTabLoad(tab.id);
    const schools = await pollForSchoolData(tab.id, 30000);

    if (!schools || schools.length === 0) {
      throw new Error('No school data found. The site structure may have changed.');
    }

    const ratingsData = {
      lastUpdated: new Date().toISOString().split('T')[0],
      schools
    };
    await chrome.storage.local.set({ schoolRatings: ratingsData });
    return { success: true, count: schools.length, lastUpdated: ratingsData.lastUpdated };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Page load timed out'));
    }, 30000);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function pollForSchoolData(tabId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: extractSchoolsFromPage
    });

    const data = results && results[0] && results[0].result;
    if (data && data.length > 0) return data;

    await new Promise(r => setTimeout(r, 1000));
  }
  return null;
}

function extractSchoolsFromPage() {
  try {
    const app = document.querySelector('#app');
    if (!app) return null;

    const vue = app.__vue__ || (app.__vue_app__ && app.__vue_app__._instance && app.__vue_app__._instance.proxy);
    if (!vue || !vue.$store) return null;

    const schools = vue.$store.state.searchSchoolList;
    if (!Array.isArray(schools) || schools.length === 0) return null;

    return schools
      .filter(s => s.id && s.name)
      .map(s => ({
        sid: s.id,
        name: s.name,
        type: s.level || 'elementary',
        rating: s.score || null,
        rank: s.ranking || null,
        city: s.city || null
      }));
  } catch (e) {
    return null;
  }
}

async function enrichWithRatings(results) {
  const data = await chrome.storage.local.get(['schoolRatings']);
  if (!data.schoolRatings || !data.schoolRatings.schools) {
    return results.map(r => ({ ...r, rating: null, rank: null, sid: null, schoolType: null }));
  }

  const cached = data.schoolRatings.schools;
  const enriched = [];
  for (const result of results) {
    const matches = findRatings(result.name, cached);
    if (matches.length === 0) {
      enriched.push({ ...result, rating: null, rank: null, sid: null, schoolType: null, city: null });
    } else {
      for (const match of matches) {
        enriched.push({
          ...result,
          rating: match.rating,
          rank: match.rank,
          sid: match.sid,
          schoolType: match.type,
          city: match.city
        });
      }
    }
  }
  return enriched;
}

function normalizeSchoolName(name) {
  return name
    .toLowerCase()
    .replace(/\b(catholic|public|separate|elementary|secondary|school|collegiate|institute|academy|s\.s\.|ss|p\.s\.|ps|c\.s\.|cs|c\.e\.s\.|ces)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const WATERLOO_REGION_CITIES = new Set([
  'waterloo', 'kitchener', 'cambridge', 'elmira', 'ayr', 'baden',
  'breslau', 'conestogo', 'heidelberg', 'new hamburg', 'st. jacobs',
  'wellesley', 'woolwich', 'wilmot', 'north dumfries', 'st. clements',
  'linwood', 'maryhill', 'bloomingdale', 'new dundee', 'petersburg',
  'mannheim', 'crosshill', 'hawkesville', 'wallenstein', 'west montrose'
]);

function isWaterlooRegion(city) {
  return !city || WATERLOO_REGION_CITIES.has(city.toLowerCase().trim());
}

function findRatings(schoolName, cachedSchools) {
  const normalized = normalizeSchoolName(schoolName);
  const words = normalized.split(' ').filter(w => w.length > 2);
  const regional = cachedSchools.filter(s => isWaterlooRegion(s.city));

  const exact = regional.filter(s => normalizeSchoolName(s.name) === normalized);
  if (exact.length > 0) return exact;

  const wordMatch = regional.filter(s => {
    const cachedNorm = normalizeSchoolName(s.name);
    const cachedWords = cachedNorm.split(' ').filter(w => w.length > 2);
    const shorter = words.length <= cachedWords.length ? words : cachedWords;
    const longer = words.length > cachedWords.length ? words : cachedWords;
    return shorter.length > 0 && shorter.every(w => longer.includes(w));
  });
  if (wordMatch.length > 0) return wordMatch;

  const similar = [];
  for (const s of regional) {
    const score = bigramSimilarity(normalized, normalizeSchoolName(s.name));
    if (score > 0.7) {
      similar.push({ ...s, _score: score });
    }
  }
  similar.sort((a, b) => b._score - a._score);
  return similar;
}

function bigramSimilarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigramsA = new Set();
  for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
  let matches = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (bigramsA.has(b.slice(i, i + 2))) matches++;
  }
  return (2 * matches) / (a.length - 1 + b.length - 1);
}
