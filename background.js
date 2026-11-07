// background.js
// MV3 service worker. Routes messages from content scripts and the popup.
// Keeps an in-memory profile cache so click/dwell events don't hit
// IndexedDB on every single event; persistence to disk is async and
// non-blocking.
importScripts("siteConfigs.js", "db.js", "scoring.js", "bookmarkImport.js");

// One-time (per install/update) bookmark cold-start: import existing
// bookmarks as stub items so recommendations aren't starting from zero.
// Safe to re-run on extension updates — upsertItems/store.put overwrites
// by id, so no duplicates are created.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const stubs = await importBookmarksAsStubs(getSiteConfigForHostname);
    await upsertItems(stubs);

    // Fire-and-forget: don't await this, so onInstalled resolves quickly
    // and enrichment continues in the background, rate-limited internally.
    enrichStubsEagerly(stubs, {
      onProgress: (done, total) => {
        console.log(`Taste Profile: enriched ${done}/${total} bookmarks`);
      }
    }).catch(err => console.error("Taste Profile: eager enrichment failed", err));

  } catch (err) {
    console.error("Taste Profile: bookmark import failed", err);
  }
});

// Live sync: catch bookmarks added after the initial import, one at a time.
// Lazy-enriches only (waits for a natural visit) — cheap, no extra tab opens.
chrome.bookmarks.onCreated.addListener(async (id, node) => {
  try {
    const stub = bookmarkNodeToStub(node, getSiteConfigForHostname);
    if (stub) await upsertItems([stub]);
  } catch (err) {
    console.error("Taste Profile: live bookmark sync failed", err);
  }
});

let profileCache = null;
let profileDirty = false;

// Tracks URLs opened via OPEN_RECOMMENDED_ITEM so the resulting dwell event
// can be tagged source: "recommendation" instead of relying only on
// document.referrer (which won't reflect "opened from our own popup").
// Short-lived, in-memory only — cleared once consumed or after a timeout.
const pendingRecommendationOpens = new Map(); // url -> timestamp

function markPendingRecommendation(url) {
  pendingRecommendationOpens.set(url, Date.now());
  // Safety cleanup in case the tab never reports back (closed early, etc.)
  setTimeout(() => pendingRecommendationOpens.delete(url), 5 * 60 * 1000);
}

async function ensureProfileCache() {
  if (!profileCache) profileCache = await getProfile();
  return profileCache;
}

function persistProfileSoon() {
  profileDirty = true;
  // Fire-and-forget; never block the caller.
  saveProfile(profileCache)
    .then(() => (profileDirty = false))
    .catch(err => console.error("Taste Profile: failed to persist profile", err));
}

let pruneTimer = null;
function schedulePrune() {
  if (pruneTimer) return;
  pruneTimer = setTimeout(() => {
    pruneTimer = null;
    pruneActivity().catch(err => console.error("Taste Profile: prune failed", err));
  }, 60000); // once a minute at most
}

// Any dwell event counts toward "recently seen" — doesn't matter if the
// visit came from a recommendation click, a bookmark, or plain browsing.
// This is what makes opening something via a bookmark also reduce how
// often it resurfaces as a "top" recommendation.
const RECENTLY_SEEN_WINDOW_DAYS = 14;

async function getRecentlySeenItemIds() {
  const activity = await getRecentActivity(MAX_ACTIVITY_ENTRIES);
  const cutoff = Date.now() - RECENTLY_SEEN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const ids = new Set();
  for (const entry of activity) {
    if (entry.kind === "dwell" && entry.at >= cutoff) ids.add(entry.itemId);
  }
  return ids;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => {
      console.error("Taste Profile: message handler error", err);
      sendResponse({ error: String(err) });
    });
  return true; // keep the message channel open for the async response
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "SCRAPED_ITEMS": {
      await upsertItems(message.payload);
      return { ok: true };
    }

    case "ACTIVITY_EVENT": {
      const entry = message.payload;

      // Resolve final source: extension-driven takes priority over the
      // content script's own referrer-based guess.
      if (entry.kind === "dwell" && pendingRecommendationOpens.has(entry.itemId)) {
        entry.source = "recommendation";
        pendingRecommendationOpens.delete(entry.itemId);
      } else if (entry.kind === "dwell") {
        entry.source = entry.referrerSource || "unknown";
      }

      await appendActivity(entry);
      schedulePrune();

      const profile = await ensureProfileCache();
      const items = await getAllItems();
      const itemsById = Object.fromEntries(items.map(i => [i.id, i]));

      // Group recent activity by item id so scoring.js can work out
      // distinct-session counts for the frequency/rewatch multiplier.
      const recentActivity = await getRecentActivity(MAX_ACTIVITY_ENTRIES);
      const activityLogByItemId = {};
      for (const a of recentActivity) {
        (activityLogByItemId[a.itemId] ||= []).push(a);
      }

      profileCache = applyActivityToProfile(profile, [entry], itemsById, activityLogByItemId);
      persistProfileSoon();
      return { ok: true };
    }

    // Called by the popup right before it opens a recommended item in a
    // new tab, so the resulting dwell event can be attributed correctly.
    case "OPEN_RECOMMENDED_ITEM": {
      const url = message.payload?.url;
      if (!url) return { error: "Missing url" };
      markPendingRecommendation(url);
      chrome.tabs.create({ url });
      return { ok: true };
    }

    case "SET_EXPLICIT_INTERESTS": {
      const profile = await ensureProfileCache();
      profileCache = applyExplicitInterests(profile, message.payload);
      persistProfileSoon();
      return { ok: true };
    }

    // Two-tier recommendations:
    //  - "top" tier: items you haven't recently watched, ranked by score.
    //  - "recommended" (fallback) tier: once the fresh pool runs dry,
    //    recycle previously-seen items rather than returning nothing.
    // Pass a growing `excludeIds` list (items already shown/opened this
    // session) each time the popup asks for more, so repeats don't show
    // up within the same browsing session even within the fallback tier.
    case "GET_RECOMMENDATIONS": {
      const { limit = 10, excludeIds = [] } = message.payload || {};
      const [items, profile, recentlySeenIds] = await Promise.all([
        getAllItems(),
        ensureProfileCache(),
        getRecentlySeenItemIds()
      ]);

      const excludeSet = new Set(excludeIds);
      const combinedExclude = new Set([...excludeSet, ...recentlySeenIds]);

      let pool = items.filter(i => !combinedExclude.has(i.id));
      let tier = "top";

      if (pool.length < limit) {
        // Fresh pool exhausted — fall back to recycling anything not
        // explicitly excluded this session, even if recently watched.
        pool = items.filter(i => !excludeSet.has(i.id));
        tier = "recommended";
      }

      return { items: recommend(pool, profile, limit), tier };
    }

    case "FIND_BY_DESCRIPTION": {
      const items = await getAllItems();
      return { items: searchByDescription(items, message.payload?.query || "", message.payload?.limit || 20) };
    }

    case "GET_RECENT_LOG": {
      const activity = await getRecentActivity(message.payload?.limit || 200);
      return { activity };
    }

    case "GET_STATS": {
      const [items, activity] = await Promise.all([getAllItems(), getRecentActivity(MAX_ACTIVITY_ENTRIES)]);
      return { itemCount: items.length, activityCount: activity.length };
    }

    case "EXPORT_DATA": {
      const data = await exportAllData();
      return { data };
    }

    case "CLEAR_ALL_DATA": {
      await clearAllData();
      profileCache = emptyProfile();
      return { ok: true };
    }

    default:
      return { error: "Unknown message type: " + message.type };
  }
}