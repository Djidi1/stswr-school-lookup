# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Chrome extension (Manifest V3) that looks up school eligibility on the Student Transportation Services of Waterloo Region (STSWR) website. Given an address, it returns which schools (elementary/secondary, Catholic/public) serve that location.

## Development

No build step, no bundler, no package manager. Load directly in Chrome via `chrome://extensions` → "Load unpacked" pointing at the repo root.

To test changes: reload the extension in `chrome://extensions`, then reopen the popup.

## Architecture

**Popup** (`popup/`) — simple form UI. Sends a `{ action: 'lookup', streetNumber, streetName, municipality }` message to the background service worker and renders results as a table. Persists last input via `chrome.storage.local`.

**Background service worker** (`background/background.js`) — orchestrates the lookup via direct HTTP requests (no tabs or content script injection):
1. Resolves street name against the autocomplete API (`Eligibility.aspx/GetCompletionList`)
2. For each district (WCDSB, WRDSB):
   - GETs the eligibility page to extract ASP.NET form tokens (`__VIEWSTATE`, `__EVENTVALIDATION`, etc.)
   - POSTs the form with address fields, district, and extracted tokens
   - Parses results from the response HTML (tries `SchoolPositions` JSON embedded in script tags first, falls back to repeater element regex parsing)
3. Returns aggregated `{ name, type, district }` results to the popup

Key pattern: pure `fetch`-based — no tab manipulation, no injected scripts, no delays. The extension mimics the ASP.NET WebForms postback by replaying hidden fields extracted from a fresh GET of the page.

## Constraints

- Form field names (e.g. `ctl00$MainContent$eaSchool$txtStreetNumber`) and hidden token IDs (`__VIEWSTATE`, `__EVENTVALIDATION`) are coupled to ASP.NET WebForms — if the site updates these, form submission will break.
- Result parsing relies on either embedded `SchoolPositions` JSON or repeater element ID patterns (`MainContent_repSchoolDetail_hlSchoolName_N`) — DOM changes on the results page can break parsing.
- `host_permissions` is locked to `https://bpweb.stswr.ca/*`.
- School year GUID (`SCHOOL_YEAR_GUID` constant) must be updated when the site rolls over to a new academic year.
