# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) that looks up school eligibility on the Student Transportation Services of Waterloo Region (STSWR) website. Given an address, it returns which schools (elementary/secondary, Catholic/public) serve that location, enriched with Fraser Institute ratings from compareschoolrankings.org.

## Development

No build step, no bundler, no package manager. Load directly in Chrome via `chrome://extensions` → "Load unpacked" pointing at the repo root.

To test changes: reload the extension in `chrome://extensions`, then reopen the popup.

## File Structure

```
manifest.json              — Manifest V3 config (permissions, service worker, popup)
background/background.js   — Service worker: lookup orchestration + ratings scraping
popup/popup.html           — Popup DOM structure
popup/popup.js             — Popup logic: form handling, messaging, result rendering
popup/popup.css            — Popup styles (420px fixed width)
icons/                     — Extension icons (16/48/128)
```

## Architecture

### Messaging

Two communication channels between popup and background:

1. **Port-based** (`chrome.runtime.connect`, name: `'lookup'`) — used for school lookups. Enables streaming progress updates back to the popup as each step completes.
2. **One-shot** (`chrome.runtime.sendMessage`) — used for `refreshRatings` and `getRatingsStatus` actions.

### Lookup Flow (background.js)

1. **Street resolution** — POSTs to `Eligibility.aspx/GetCompletionList` with prefix text. If no match, retries with progressively shorter prefixes (strips trailing words). Uses cascading match strategy: exact → startsWith → includes → reverse-includes → first item.
2. **District lookup** (runs sequentially for WCDSB, then WRDSB):
   - GETs eligibility page → extracts ASP.NET hidden tokens (`__VIEWSTATE`, `__EVENTVALIDATION`, `__VIEWSTATEGENERATOR`)
   - POSTs form with address + tokens → parses elementary results
   - Re-POSTs from the result page with `ddlGrade = GRADE_09_GUID` → parses secondary results
3. **Result parsing** — two strategies tried in order:
   - Primary: extract `SchoolPositions` JSON from embedded `<script>` tag
   - Fallback: regex over HTML repeater elements (`MainContent_repSchoolDetail_hlSchoolName_N`)
4. **Ratings enrichment** — matches results against cached ratings using fuzzy name matching (normalized words → bigram similarity with 0.7 threshold). Filters to Waterloo Region cities only.

### Ratings Scraping (background.js)

Triggered manually via "Update" button in popup:
- Opens `compareschoolrankings.org` in a background tab
- Polls via `chrome.scripting.executeScript` in `MAIN` world
- Accesses Vue store (`app.__vue__.$store.state.searchSchoolList`)
- Caches results in `chrome.storage.local` under key `schoolRatings`

### Popup (popup/)

- Form with 3 fields (street number, street name, municipality — defaults to "Kitchener")
- Persists last input + last results in `chrome.storage.local`
- Shows live progress steps during lookup (animated checklist)
- Results rendered as table: School Name | Type | District | City | Rating (linked to source)

### Storage (`chrome.storage.local`)

| Key | Purpose |
|-----|---------|
| `lastStreetNumber`, `lastStreetName`, `lastMunicipality` | Persist form input across popup reopens |
| `lastResults` | Cache last lookup results for instant display |
| `schoolRatings` | Cached ratings data `{ lastUpdated, schools[] }` |

## Constants That Need Manual Updates

- `SCHOOL_YEAR_GUID` (background.js:8) — must update when STSWR rolls over to a new academic year
- `GRADE_09_GUID` (background.js:113) — grade identifier for secondary school lookup

## Constraints

- Form field names (e.g. `ctl00$MainContent$eaSchool$txtStreetNumber`) and hidden token IDs are coupled to ASP.NET WebForms — if the site updates these, form submission will break.
- Result parsing relies on either embedded `SchoolPositions` JSON or repeater element ID patterns — DOM changes on the results page can break parsing.
- Ratings scraping depends on Vue 2/3 store structure of compareschoolrankings.org — if they change frameworks or store shape, scraping breaks.
- `host_permissions`: `https://bpweb.stswr.ca/*` and `https://www.compareschoolrankings.org/*`
- Permissions include `tabs` and `scripting` (needed only for ratings scraping flow).
