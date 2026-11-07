// scraper.js
// Generic scraper driven entirely by SITE_CONFIGS (siteConfigs.js).
// Never fetches anything — only reads the DOM of the page already loaded.

function getSiteConfig() {
  return SITE_CONFIGS[location.hostname] || null;
}

function readField(root, field) {
  if (!field) return field === undefined ? null : field;
  if (field.multiple) {
    return Array.from(root.querySelectorAll(field.selector))
      .map(el => (field.attr ? el.getAttribute(field.attr) : el.textContent))
      .map(v => (v || "").trim())
      .filter(Boolean);
  }
  const el = root.querySelector(field.selector);
  if (!el) return null;
  const v = field.attr ? el.getAttribute(field.attr) : el.textContent;
  return (v || "").trim() || null;
}

function idFromLink(link) {
  if (!link) return null;
  try {
    const u = new URL(link, location.origin);
    return u.origin + u.pathname + u.search;
  } catch {
    return link;
  }
}

function idFromUrl() {
  // Keep the full path + query — on sites like Pornhub the path is
  // identical for every watch page (/view_video.php) and only the
  // query string (?viewkey=...) identifies which video it is.
  // Stripping the query here would collapse every video into one
  // record. Must match activityTracker.js's dwell-time id exactly.
  return location.origin + location.pathname + location.search;
}

// Some sites (e.g. fpo.xxx) expose categories/tags only as a JS
// variable inside an inline <script> tag rather than as DOM elements
// with a stable selector. This pulls a simple `varName: 'a, b, c'`
// value out of any script on the page and splits it into a list.
function extractFlashvarsField(varName) {
  const scripts = document.querySelectorAll("script");
  const pattern = new RegExp(varName + "\\s*:\\s*'([^']*)'");
  for (const s of scripts) {
    const match = (s.textContent || "").match(pattern);
    if (match) {
      return match[1].split(",").map(t => t.trim()).filter(Boolean);
    }
  }
  return [];
}

// ---- Listing / grid pages: many repeating cards ----
function scrapeVisibleItems() {
  const config = getSiteConfig();
  if (!config || !config.itemCard) return [];

  const cards = document.querySelectorAll(config.itemCard);
  const items = [];
  const seen = new Set();

  cards.forEach(card => {
    const link = readField(card, config.link);
    const id = config.idFrom === "link" ? idFromLink(link) : idFromUrl();
    if (!id || seen.has(id)) return;
    seen.add(id);

    items.push({
      id,
      site: location.hostname,
      pageType: "itemCard",
      title: readField(card, config.title),
      link: link ? new URL(link, location.origin).href : null,
      thumbnail: readField(card, config.thumbnail),
      duration: readField(card, config.duration),
      tags: readField(card, config.tags) || [],
      people: readField(card, config.people) || [],
      scrapedAt: Date.now()
    });
  });

  return items;
}

// ---- Watch / detail pages: one item, different layout ----
function scrapeItemPage() {
  const config = getSiteConfig();
  if (!config || !config.itemPage || !config.itemPage.detect()) return null;

  const ip = config.itemPage;
  const id = ip.idFrom === "url" ? idFromUrl() : idFromLink(readField(document, ip.link));

  const tags = [
    ...(readField(document, ip.tags) || []),
    ...(readField(document, ip.freeTags) || []),
    ...(ip.categoriesFromFlashvar ? extractFlashvarsField(ip.categoriesFromFlashvar) : [])
  ];

  return {
    id,
    site: location.hostname,
    pageType: "itemPage",
    title: readField(document, ip.title),
    link: location.href,
    thumbnail: readField(document, ip.thumbnail),
    duration: readField(document, ip.duration),
    tags,
    people: readField(document, ip.people) || [],
    scrapedAt: Date.now()
  };
}

// Single entry point contentScript.js calls on load / mutation.
function runScrape() {
  const config = getSiteConfig();
  if (!config) return { items: [], pageItem: null };

  const pageItem = config.itemPage ? scrapeItemPage() : null;
  const items = pageItem ? [] : scrapeVisibleItems();

  return { items, pageItem };
}
