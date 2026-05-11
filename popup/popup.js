const form = document.getElementById('lookup-form');
const loadingEl = document.getElementById('loading');
const errorEl = document.getElementById('error');
const resultsEl = document.getElementById('results');
const resultsBody = document.getElementById('results-body');
const searchBtn = document.getElementById('search-btn');
const streetNumberInput = document.getElementById('street-number');
const streetNameInput = document.getElementById('street-name');
const municipalityInput = document.getElementById('municipality');
const ratingsInfoEl = document.getElementById('ratings-info');
const refreshRatingsBtn = document.getElementById('refresh-ratings-btn');

chrome.storage.local.get(['lastStreetNumber', 'lastStreetName', 'lastMunicipality', 'lastResults'], (data) => {
  if (data.lastStreetNumber) streetNumberInput.value = data.lastStreetNumber;
  if (data.lastStreetName) streetNameInput.value = data.lastStreetName;
  if (data.lastMunicipality) municipalityInput.value = data.lastMunicipality;
  if (data.lastResults && data.lastResults.length > 0) showResults(data.lastResults);
});

chrome.runtime.sendMessage({ action: 'getRatingsStatus' }, (response) => {
  if (response && response.lastUpdated) {
    ratingsInfoEl.textContent = `Ratings: ${response.count} schools (${response.lastUpdated})`;
  }
});

refreshRatingsBtn.addEventListener('click', async () => {
  refreshRatingsBtn.disabled = true;
  ratingsInfoEl.textContent = 'Updating ratings...';
  try {
    const response = await chrome.runtime.sendMessage({ action: 'refreshRatings' });
    if (response.error) {
      ratingsInfoEl.textContent = `Error: ${response.error}`;
    } else {
      ratingsInfoEl.textContent = `Ratings: ${response.count} schools (${response.lastUpdated})`;
    }
  } catch (err) {
    ratingsInfoEl.textContent = `Error: ${err.message}`;
  } finally {
    refreshRatingsBtn.disabled = false;
  }
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const streetNumber = streetNumberInput.value.trim();
  const streetName = streetNameInput.value.trim();
  const municipality = municipalityInput.value.trim();

  if (!streetNumber || !streetName || !municipality) return;

  chrome.storage.local.set({ lastStreetNumber: streetNumber, lastStreetName: streetName, lastMunicipality: municipality });

  showLoading();

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'lookup',
      streetNumber,
      streetName,
      municipality
    });

    if (response.error) {
      showError(response.error);
    } else {
      showResults(response.results);
    }
  } catch (err) {
    showError(`Extension error: ${err.message}`);
  }
});

function showLoading() {
  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  resultsEl.classList.add('hidden');
  searchBtn.disabled = true;
}

function showError(message) {
  loadingEl.classList.add('hidden');
  errorEl.classList.remove('hidden');
  resultsEl.classList.add('hidden');
  errorEl.textContent = message;
  searchBtn.disabled = false;
}

function showResults(results) {
  loadingEl.classList.add('hidden');
  errorEl.classList.add('hidden');
  searchBtn.disabled = false;

  if (!results || results.length === 0) {
    showError('No schools found for this address.');
    return;
  }

  chrome.storage.local.set({ lastResults: results });

  resultsBody.innerHTML = '';
  results.forEach(({ name, type, district, rating, sid, schoolType, city }) => {
    const row = document.createElement('tr');
    let ratingCell;
    if (rating && sid) {
      const url = `https://www.compareschoolrankings.org/school/on/${escapeHtml(schoolType || 'elementary')}/${escapeHtml(sid)}`;
      ratingCell = `<a href="${url}" target="_blank" class="rating-link">${escapeHtml(rating)}/10</a>`;
    } else if (rating) {
      ratingCell = `${escapeHtml(rating)}/10`;
    } else {
      ratingCell = '—';
    }
    row.innerHTML = `<td>${escapeHtml(name)}</td><td>${escapeHtml(type)}</td><td>${escapeHtml(district)}</td><td>${escapeHtml(city || '—')}</td><td>${ratingCell}</td>`;
    resultsBody.appendChild(row);
  });

  resultsEl.classList.remove('hidden');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
