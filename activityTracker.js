// activityTracker.js
// Implicit signal collection: clicks on cards, dwell time, and watch
// percentage on watch pages. Reactive only — never initiates navigation
// or fetches on its own.

(function () {
  const config = typeof getSiteConfig === "function" ? getSiteConfig() : null;
  if (!config) return;

  // --- Click tracking on listing cards ---
  document.addEventListener(
    "click",
    evt => {
      const card = evt.target.closest(config.itemCard);
      if (!card) return;
      const link = card.querySelector(config.link ? config.link.selector : "a");
      if (!link) return;

      let id;
      try {
        const u = new URL(link.getAttribute("href"), location.origin);
        id = u.origin + u.pathname + u.search;
      } catch {
        return;
      }

      chrome.runtime.sendMessage({
        type: "ACTIVITY_EVENT",
        payload: { kind: "click", itemId: id, site: location.hostname, at: Date.now() }
      });
    },
    true
  );

  // --- Hover tracking on listing cards ---
  // Weak signal: "saw it and considered it" without necessarily clicking.
  // Only reported if the hover lasts past a minimum threshold, to filter
  // out incidental mouse pass-overs while scrolling.
  const HOVER_MIN_MS = 1500;
  const hoverTimers = new WeakMap(); // card element -> timeout id

  document.addEventListener(
    "mouseover",
    evt => {
      const card = evt.target.closest(config.itemCard);
      if (!card || hoverTimers.has(card)) return;

      const timer = setTimeout(() => {
        hoverTimers.delete(card);

        const link = card.querySelector(config.link ? config.link.selector : "a");
        if (!link) return;
        let id;
        try {
          const u = new URL(link.getAttribute("href"), location.origin);
          id = u.origin + u.pathname + u.search;
        } catch {
          return;
        }

        chrome.runtime.sendMessage({
          type: "ACTIVITY_EVENT",
          payload: { kind: "hover", itemId: id, site: location.hostname, at: Date.now() }
        });
      }, HOVER_MIN_MS);

      hoverTimers.set(card, timer);
    },
    true
  );

  document.addEventListener(
    "mouseout",
    evt => {
      const card = evt.target.closest(config.itemCard);
      if (!card) return;
      const timer = hoverTimers.get(card);
      if (timer) {
        clearTimeout(timer);
        hoverTimers.delete(card);
      }
    },
    true
  );

  // --- Dwell time + watch percentage on an item's own page ---
  if (config.itemPage && config.itemPage.detect()) {
    // Must match scraper.js's idFromUrl() exactly so dwell events land
    // on the same item record (keeps the query string — on sites like
    // Pornhub that's the only thing that tells videos apart).
    const itemId = location.origin + location.pathname + location.search;
    const startedAt = Date.now();
    let reported = false;

    // Best-effort watch-percentage tracking. Not all sites expose a
    // standard <video> element (some use custom players), so this
    // degrades gracefully to dwell-only if none is found.
    let maxWatchedFraction = 0;
    let videoEl = null;

    function findVideoEl() {
      return document.querySelector("video");
    }

    function trackVideoProgress() {
      videoEl = findVideoEl();
      if (!videoEl) return; // no standard <video> tag; skip watch-% silently

      videoEl.addEventListener("timeupdate", () => {
        if (!videoEl.duration || isNaN(videoEl.duration)) return;
        const fraction = videoEl.currentTime / videoEl.duration;
        if (fraction > maxWatchedFraction) maxWatchedFraction = fraction;
      });
    }

    // The player may not exist yet at script-run time on some sites
    // (lazy-mounted), so retry briefly before giving up.
    let videoFindAttempts = 0;
    const videoFindTimer = setInterval(() => {
      videoFindAttempts++;
      if (videoEl || videoFindAttempts > 10) {
        clearInterval(videoFindTimer);
        if (!videoEl) trackVideoProgress(); // last attempt
        return;
      }
      trackVideoProgress();
    }, 500);

    const reportDwell = () => {
      if (reported) return;
      reported = true;
      clearInterval(videoFindTimer);

      const dwellMs = Date.now() - startedAt;
      if (dwellMs < 1500) return; // ignore drive-by loads

      chrome.runtime.sendMessage({
        type: "ACTIVITY_EVENT",
        payload: {
          kind: "dwell",
          itemId,
          site: location.hostname,
          dwellMs,
          // Rounded to avoid false precision; null if no <video> was found.
          watchedFraction: videoEl ? Math.round(maxWatchedFraction * 100) / 100 : null,
          at: Date.now()
        }
      });
    };

    window.addEventListener("pagehide", reportDwell);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") reportDwell();
    });
  }
})();