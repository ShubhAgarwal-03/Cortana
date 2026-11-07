# Taste Profile

A local-only, reactive browser extension (Chrome/Brave, Manifest V3) that
scrapes metadata from pages you already visit on a small set of
configured sites, tracks implicit signals (clicks, dwell time) plus
explicit stated interests, and turns that into on-demand recommendations
and free-text recall search over your own history.

**Nothing is sent anywhere.** All storage is local IndexedDB in your
browser profile. There is no external API, no LLM call — even the recall
search is plain token-overlap matching against your own scraped data.

## What it does

- Reads pages already loaded in the tab. It never crawls or fetches in
  the background on its own.
- Two page types per site: `itemCard` (listing/grid pages with many
  repeating cards) and `itemPage` (a single item's own page).
- Builds a weighted preference profile from your activity (clicks,
  dwell time) and from interests you type in explicitly.
- **Recommend** tab: on-demand ranked suggestions from your local
  history, based on that profile.
- **Find it** tab: free-text recall search over everything scraped so
  far — e.g. type a name or a few remembered details to relocate
  something.
- **Log** tab: recent activity, plus **Export** (full JSON dump you
  choose where to save) and **Clear local data**.

## Status by site

| Site | itemCard | itemPage |
|---|---|---|
| pornhub.com | done | done |
| site 2 | pending | pending |
| site 3 | pending | pending |

To add a site, edit `siteConfigs.js`: add a hostname key with the same
shape as the `pornhub.com` block, plus the matching `host_permissions`
and `content_scripts.matches` entries in `manifest.json`.

## Loading the extension

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. After editing any file: click the refresh icon on the extension's
   card. If you changed `manifest.json`, remove the extension and load
   it again instead of just refreshing.

## Where your data lives

IndexedDB inside Chrome's profile folder — the extension can't choose a
different physical drive for it. If you want your data on a specific
drive, use the **Export** button in the Log tab to save a full JSON
dump wherever you choose, or move Chrome's whole profile folder via the
`--user-data-dir` launch flag or an NTFS junction.

## Privacy / storage notes

- Activity log auto-prunes to the most recent 5,000 entries, checked
  about once a minute.
- The background service worker keeps an in-memory copy of your
  profile weights to avoid an IndexedDB round-trip on every click or
  dwell event; it's written to disk asynchronously right after.
- The MutationObserver that watches for new cards disconnects when the
  tab is backgrounded and reconnects on focus, and re-scrapes are
  debounced (900ms) so a burst of DOM changes doesn't cause a burst of
  scrapes.
