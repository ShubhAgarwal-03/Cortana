// contentScript.js
// Wires scraper.js to the live DOM. Reactive only:
//  - scrapes once on load
//  - re-scrapes on DOM mutation, debounced
//  - disconnects the observer when the tab is backgrounded, reconnects on focus
// Never fetches or navigates on its own.

(function () {
  if (!getSiteConfig()) return;
  const config = getSiteConfig();

  const DEBOUNCE_MS = 900;
  let debounceTimer = null;
  let observer = null;

  function doScrape() {
    const { items, pageItem } = runScrape();
    if (items.length) {
      chrome.runtime.sendMessage({ type: "SCRAPED_ITEMS", payload: items });
    }
    if (pageItem) {
      chrome.runtime.sendMessage({ type: "SCRAPED_ITEMS", payload: [pageItem] });
    }
    refreshBadges(); // re-check which visible cards are top-20 recommendations
  }

  function scheduleScrape() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doScrape, DEBOUNCE_MS);
  }

  function startObserving() {
    if (observer) return;
    observer = new MutationObserver(scheduleScrape);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserving() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopObserving();
    } else {
      startObserving();
      scheduleScrape(); // catch anything that changed while backgrounded
    }
  });

  // --- Automatic "this is a top recommendation" badge ---
  // Every scrape pass, cross-checks visible cards against your current
  // top-20 recommendations and adds a steady gold border to any match.
  // Border-only — doesn't dim, overlay, or otherwise disrupt the rest
  // of the page's content.

  const BADGE_STYLE_ID = "__taste-profile-badge-style";
  const BADGE_CLASS = "__taste-profile-recommended";
  const RECOMMENDED_CACHE_TTL_MS = 5 * 60 * 1000;

  let cachedRecommendedIds = null;
  let cachedAt = 0;

  function ensureBadgeStylesInjected() {
    if (document.getElementById(BADGE_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = BADGE_STYLE_ID;
    style.textContent = `
      .${BADGE_CLASS} {
        border: 3px solid #d4af37 !important;
        border-radius: 6px !important;
        box-shadow: 0 0 5px rgba(212, 175, 55, 0.5) !important;
      }
    `;
    document.head.appendChild(style);
  }

  function idFromLink(link) {
    try {
      const u = new URL(link.getAttribute("href"), location.origin);
      return u.origin + u.pathname + u.search;
    } catch {
      return null;
    }
  }

  function getTopRecommendedIds() {
    const now = Date.now();
    if (cachedRecommendedIds && now - cachedAt < RECOMMENDED_CACHE_TTL_MS) {
      return Promise.resolve(cachedRecommendedIds);
    }
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: "GET_RECOMMENDATIONS", payload: { limit: 20 } },
        (response) => {
          const ids = new Set((response?.items || []).map((i) => i.id));
          cachedRecommendedIds = ids;
          cachedAt = Date.now();
          resolve(ids);
        }
      );
    });
  }

  function applyRecommendedBadges(recommendedIds) {
    if (!config.itemCard) return;
    ensureBadgeStylesInjected();
    const cards = document.querySelectorAll(config.itemCard);
    for (const card of cards) {
      const link = card.querySelector(config.link ? config.link.selector : "a");
      const id = link ? idFromLink(link) : null;
      if (id && recommendedIds.has(id)) {
        card.classList.add(BADGE_CLASS);
      } else {
        card.classList.remove(BADGE_CLASS);
      }
    }
  }

  function refreshBadges() {
    getTopRecommendedIds()
      .then(applyRecommendedBadges)
      .catch(() => {}); // silent — badging is cosmetic, never worth surfacing an error over
  }

  // Initial run
  doScrape();
  if (document.visibilityState === "visible") startObserving();
})();