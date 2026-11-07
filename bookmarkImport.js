// bookmarkImport.js
// Cold-start bootstrap: import existing browser bookmarks as "stub" items,
// then enrich them (lazily or eagerly) once real page data is available.
//
// Requires "bookmarks" permission in manifest.json (and "tabs" if using
// eager background-tab enrichment).
//
// This file is intentionally generic — it doesn't know about any specific
// site's markup. It relies on getSiteConfig(hostname) (from siteConfigs.js)
// only to decide whether a bookmarked URL belongs to a supported site.

// ---- Stub creation ---------------------------------------------------

// Walk the full bookmark tree and return stub items for URLs matching a
// configured site. Does not touch the DOM or network.
function collectBookmarkStubs(bookmarkTreeNodes, getSiteConfigFn) {
  const stubs = [];

  function walk(nodes, folderPath) {
    for (const node of nodes) {
      if (node.url) {
        let hostname;
        try {
          hostname = new URL(node.url).hostname;
        } catch {
          continue;
        }
        if (!getSiteConfigFn(hostname)) continue; // not a supported site

        stubs.push({
          id: node.url, // idFrom: "url" convention, adjust if you key by viewkey/slug elsewhere
          url: node.url,
          status: "stub",
          source: "bookmark",
          folderTags: folderPath.slice(), // user's own taxonomy, treated as extra tags
          tags: [],
          people: [],
          createdAt: node.dateAdded || Date.now(),
        });
      }
      if (node.children) {
        walk(node.children, [...folderPath, node.title].filter(Boolean));
      }
    }
  }

  walk(bookmarkTreeNodes, []);
  return stubs;
}

// Entry point: read the browser's bookmark tree and hand back stubs.
// Caller is responsible for upserting these into the items store.
function importBookmarksAsStubs(getSiteConfigFn) {
  return new Promise((resolve) => {
    chrome.bookmarks.getTree((tree) => {
      resolve(collectBookmarkStubs(tree, getSiteConfigFn));
    });
  });
}

// ---- Live sync (new bookmarks added after initial import) ---------------
// Converts a single chrome.bookmarks.BookmarkTreeNode (as delivered by
// chrome.bookmarks.onCreated) into a stub, or returns null if it's a
// folder or an unsupported site. Caller upserts the result if non-null.
function bookmarkNodeToStub(node, getSiteConfigFn) {
  if (!node.url) return null; // folders have no url

  let hostname;
  try {
    hostname = new URL(node.url).hostname;
  } catch {
    return null;
  }
  if (!getSiteConfigFn(hostname)) return null;

  return {
    id: node.url,
    url: node.url,
    status: "stub",
    source: "bookmark",
    folderTags: [], // parent folder name not resolved here; fine to leave empty
    tags: [],
    people: [],
    createdAt: node.dateAdded || Date.now(),
  };
}

// ---- Lazy enrichment ---------------------------------------------------
// Nothing to do here beyond what already exists: when the user naturally
// visits a bookmarked URL, contentScript.js's normal doScrape() fires and
// upsertItems() overwrites the stub with real data (status: "enriched").
// Just make sure upsertItems() sets status: "enriched" when tags/people
// are non-empty, e.g. in db.js:
//
//   function upsertItems(items) {
//     for (const item of items) {
//       item.status = (item.tags?.length || item.people?.length) ? "enriched" : "stub";
//       store.put(item);
//     }
//   }

// ---- Eager enrichment (optional, heavier) --------------------------------
// Opens each stub's URL in a background tab, waits for the content script's
// scrape to complete, then closes the tab. Rate-limited to avoid hammering
// the target site or the user's machine.
//
// Requires "tabs" permission. The content script must already post
// SCRAPED_ITEMS messages as it does today — this just listens for the
// first one matching the tab it opened.

const EAGER_RATE_LIMIT_MS = 2500;

async function enrichStubsEagerly(stubs, { onProgress } = {}) {
  let done = 0;

  for (const stub of stubs) {
    await enrichOneStub(stub);
    done++;
    if (onProgress) onProgress(done, stubs.length);
    await sleep(EAGER_RATE_LIMIT_MS);
  }
}

function enrichOneStub(stub) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url: stub.url, active: false }, (tab) => {
      const timeout = setTimeout(() => {
        cleanup();
        resolve(null); // gave up waiting; stub remains a stub, will enrich lazily later
      }, 8000);

      function listener(message, sender) {
        if (
          message.type === "SCRAPED_ITEMS" &&
          sender.tab &&
          sender.tab.id === tab.id
        ) {
          cleanup();
          resolve(message.payload);
        }
      }

      function cleanup() {
        clearTimeout(timeout);
        chrome.runtime.onMessage.removeListener(listener);
        chrome.tabs.remove(tab.id, () => {});
      }

      chrome.runtime.onMessage.addListener(listener);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
