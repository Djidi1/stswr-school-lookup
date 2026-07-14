# STSWR School Lookup — Chrome Extension

Chrome extension that finds which schools serve a given address in the Waterloo Region (Ontario, Canada). Queries the Student Transportation Services of Waterloo Region (STSWR) eligibility system and enriches results with Fraser Institute school ratings.

## Features

- Look up elementary and secondary schools for any address in Waterloo Region
- Covers both school boards: WCDSB (Catholic) and WRDSB (Public)
- Fuzzy street name resolution (handles abbreviations and partial input)
- School ratings from compareschoolrankings.org with direct links
- Persists last search across popup reopens
- Live progress indicator during lookup

## Installation

1. Clone this repo
2. Open `chrome://extensions` in Chrome
3. Enable "Developer mode"
4. Click "Load unpacked" and select the repo root

No build step, no dependencies.

## Usage

1. Click the extension icon
2. Enter street number, street name, and municipality
3. Click "Search"
4. (Optional) Click "Update" in the ratings bar to fetch school ratings data

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Popup (popup/)                                                      │
│  ┌──────────┐    port.postMessage()     ┌───────────────────────┐  │
│  │ Form UI  │ ──────────────────────────►│ Background Service    │  │
│  │          │ ◄──────────────────────────│ Worker                │  │
│  │ Results  │    port.onMessage          │ (background.js)       │  │
│  │ Table    │    (progress/done/error)   │                       │  │
│  └──────────┘                            └───────┬───────┬───────┘  │
│                                                  │       │          │
└──────────────────────────────────────────────────┼───────┼──────────┘
                                                   │       │
                              fetch (POST/GET)     │       │ chrome.scripting
                                                   │       │ .executeScript
                                                   ▼       ▼
                                    ┌──────────┐  ┌──────────────────┐
                                    │ STSWR    │  │ compareschool    │
                                    │ Eligibi- │  │ rankings.org     │
                                    │ lity API │  │ (Vue app)        │
                                    └──────────┘  └──────────────────┘
```

### Components

#### Popup (`popup/`)

| File | Role |
|------|------|
| `popup.html` | Static DOM — form, progress area, results table |
| `popup.js` | Form handling, port-based messaging to background, result rendering |
| `popup.css` | Styles (fixed 420px width popup) |

The popup communicates with the background worker via two mechanisms:
- **Port** (`chrome.runtime.connect({ name: 'lookup' })`) for school lookups — enables streaming progress updates
- **sendMessage** for ratings management (`refreshRatings`, `getRatingsStatus`)

#### Background Service Worker (`background/background.js`)

Handles all network logic. No content scripts, no tab injection for the core lookup flow.

**School Lookup Pipeline:**

```
User Input → Street Resolution → District Lookup (×2) → Result Parsing → Ratings Enrichment → Response
```

1. **Street Resolution** (`resolveStreetName`)
   - Queries STSWR autocomplete API with the entered street name
   - If no match, retries with progressively shorter prefixes
   - Cascading match: exact → startsWith → includes → reverse-includes → first

2. **District Lookup** (`lookupDistrict`)
   - For each board (WCDSB, WRDSB):
     - GET eligibility page → extract `__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR`
     - POST form with address + tokens → elementary results
     - Re-POST from result page with grade 09 GUID → secondary results

3. **Result Parsing** (`parseResults`)
   - Strategy 1: Extract `SchoolPositions` JSON from `<script>` tag
   - Strategy 2: Regex match repeater elements (`MainContent_repSchoolDetail_hlSchoolName_N`)
   - Type inference from name keywords or grade list

4. **Ratings Enrichment** (`enrichWithRatings`)
   - Matches school names against cached ratings via fuzzy matching
   - Name normalization strips common suffixes (Catholic, Elementary, S.S., etc.)
   - Bigram similarity with 0.7 threshold as final fallback
   - Filters to Waterloo Region cities only

**Ratings Scraping** (`handleRefreshRatings`):
- Opens compareschoolrankings.org in a hidden tab
- Polls via `chrome.scripting.executeScript` (MAIN world)
- Extracts data from Vue store (`$store.state.searchSchoolList`)
- Caches to `chrome.storage.local`

### Data Flow

```
chrome.storage.local
├── lastStreetNumber, lastStreetName, lastMunicipality  (form persistence)
├── lastResults                                          (cached results for instant display)
└── schoolRatings { lastUpdated, schools[] }            (ratings cache)
```

### External Dependencies

| Service | Usage | Failure Mode |
|---------|-------|--------------|
| `bpweb.stswr.ca/Eligibility` | School eligibility lookup | Core feature breaks |
| `compareschoolrankings.org` | School ratings data | Ratings show "—", lookup still works |

### Permissions

| Permission | Reason |
|------------|--------|
| `storage` | Persist form input and cached data |
| `tabs` | Open background tab for ratings scraping |
| `scripting` | Execute script in ratings page to extract Vue store |
| `host_permissions: bpweb.stswr.ca/*` | Fetch eligibility data |
| `host_permissions: compareschoolrankings.org/*` | Scrape ratings |

## Maintenance

### Annual Update

When STSWR rolls over to a new school year, update `SCHOOL_YEAR_GUID` in `background/background.js` (line 8). The GUID can be found by inspecting the `ctl00$_cbDatabase` hidden field on the eligibility page.

### Breakage Scenarios

| What broke | Likely cause | Fix |
|------------|--------------|-----|
| "Could not extract form tokens" | STSWR changed page structure | Update `extractHidden` regex or field IDs |
| No schools returned | Form field names changed | Update `ctl00$...` field names in `lookupDistrict` |
| Ratings update returns 0 schools | compareschoolrankings.org changed Vue store shape | Update `extractSchoolsFromPage` function |
| Wrong schools matched to ratings | Name normalization mismatch | Adjust `normalizeSchoolName` or similarity threshold |
