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

async function handleLookup(streetNumber, streetName, municipality) {
  const resolvedStreet = await resolveStreetName(streetName, municipality);
  if (!resolvedStreet) {
    throw new Error('Could not resolve street name from autocomplete');
  }

  const districtResults = await Promise.all(
    DISTRICTS.map(d => lookupDistrict(streetNumber, resolvedStreet, municipality, d))
  );
  return enrichWithRatings(districtResults.flat());
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

function findRatings(schoolName, cachedSchools) {
  const normalized = normalizeSchoolName(schoolName);
  const words = normalized.split(' ').filter(w => w.length > 2);

  // Exact normalized matches
  const exact = cachedSchools.filter(s => normalizeSchoolName(s.name) === normalized);
  if (exact.length > 0) return exact;

  // All significant words from one appear in the other
  const wordMatch = cachedSchools.filter(s => {
    const cachedNorm = normalizeSchoolName(s.name);
    const cachedWords = cachedNorm.split(' ').filter(w => w.length > 2);
    const shorter = words.length <= cachedWords.length ? words : cachedWords;
    const longer = words.length > cachedWords.length ? words : cachedWords;
    return shorter.length > 0 && shorter.every(w => longer.includes(w));
  });
  if (wordMatch.length > 0) return wordMatch;

  // Bigram similarity — return all above threshold
  const similar = [];
  for (const s of cachedSchools) {
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
