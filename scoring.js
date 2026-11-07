// scoring.js
// Pure local scoring. No network calls, no LLM calls — recall search is
// plain token-overlap matching against your own scraped history.

const CLICK_WEIGHT = 1;
const DWELL_WEIGHT_PER_MIN = 0.5;
const MAX_DWELL_MINUTES_COUNTED = 20;
const EXPLICIT_WEIGHT = 3;
const HOVER_WEIGHT = 0.15;
const BOOKMARK_WEIGHT = 5;

const DECAY_RECENT = 0.97;             // per activity event
const DECAY_LONGTERM_PER_DAY = 0.98;   // per day of inactivity, not per event
const BLEND = { bookmark: 0.3, longTerm: 0.4, recent: 0.3 };
const PROMOTE_SESSION_THRESHOLD = 3;   // distinct sessions before recent -> long-term
const SESSION_GAP_MS = 30 * 60 * 1000; // 30 min gap = new session

function bumpWeight(map, key, amount) {
  if (!key) return;
  const k = key.toLowerCase().trim();
  if (!k) return;
  map[k] = (map[k] || 0) + amount;
}

function decayMap(map, factor) {
  for (const key in map) {
    map[key] *= factor;
    if (Math.abs(map[key]) < 0.001) delete map[key];
  }
}

function applyLongTermTimeDecay(longTerm, now) {
  const elapsedDays = (now - longTerm.lastUpdated) / (24 * 60 * 60 * 1000);
  if (elapsedDays >= 1) {
    const factor = Math.pow(DECAY_LONGTERM_PER_DAY, Math.floor(elapsedDays));
    decayMap(longTerm.tags, factor);
    decayMap(longTerm.people, factor);
    longTerm.lastUpdated = now;
  }
}

function frequencyMultiplier(distinctSessionCount) {
  return 1 + Math.log(1 + Math.max(0, distinctSessionCount - 1));
}

function computeSessionInfo(priorTimestamps, newTimestamp) {
  const all = [...priorTimestamps, newTimestamp].sort((a, b) => a - b);
  let sessions = 1;
  for (let i = 1; i < all.length; i++) {
    if (all[i] - all[i - 1] > SESSION_GAP_MS) sessions++;
  }
  return { distinctSessionCount: sessions };
}

function applyActivityToProfile(profile, activityEntries, itemsById, activityLogByItemId = {}) {
  const bookmark = { tags: { ...profile.bookmark.tags }, people: { ...profile.bookmark.people } };
  const longTerm = { tags: { ...profile.longTerm.tags }, people: { ...profile.longTerm.people }, lastUpdated: profile.longTerm.lastUpdated };
  const recent = { tags: { ...profile.recent.tags }, people: { ...profile.recent.people } };

  const now = Date.now();
  decayMap(recent.tags, DECAY_RECENT);
  decayMap(recent.people, DECAY_RECENT);
  applyLongTermTimeDecay(longTerm, now);

  activityEntries.forEach(entry => {
    const item = itemsById[entry.itemId];
    if (!item) return;

    if (entry.kind === "bookmark") {
      (item.tags || []).forEach(t => bumpWeight(bookmark.tags, t, BOOKMARK_WEIGHT));
      (item.people || []).forEach(p => bumpWeight(bookmark.people, p, BOOKMARK_WEIGHT));
      return;
    }

    let amount = 0;
    if (entry.kind === "click") amount = CLICK_WEIGHT;
    if (entry.kind === "dwell") {
      const minutes = Math.min(entry.dwellMs / 60000, MAX_DWELL_MINUTES_COUNTED);
      const watchFactor = entry.watchedFraction != null ? Math.max(0.3, entry.watchedFraction) : 1;
      amount = minutes * DWELL_WEIGHT_PER_MIN * watchFactor;
    }
    if (entry.kind === "hover") amount = HOVER_WEIGHT;
    if (amount <= 0) return;

    const priorTimestamps = (activityLogByItemId[entry.itemId] || []).map(e => e.at);
    const { distinctSessionCount } = computeSessionInfo(priorTimestamps, entry.at || now);
    const freqMult = frequencyMultiplier(distinctSessionCount);
    const finalAmount = amount * freqMult;

    (item.tags || []).forEach(t => bumpWeight(recent.tags, t, finalAmount));
    (item.people || []).forEach(p => bumpWeight(recent.people, p, finalAmount));

    if (distinctSessionCount >= PROMOTE_SESSION_THRESHOLD) {
      (item.tags || []).forEach(t => bumpWeight(longTerm.tags, t, finalAmount * 0.5));
      (item.people || []).forEach(p => bumpWeight(longTerm.people, p, finalAmount * 0.5));
    }
  });

  return { ...profile, bookmark, longTerm, recent };
}

function applyExplicitInterests(profile, interestStrings) {
  const bookmark = { ...profile.bookmark, tags: { ...profile.bookmark.tags } };
  interestStrings.forEach(s => bumpWeight(bookmark.tags, s, EXPLICIT_WEIGHT));
  return { ...profile, bookmark, explicit: interestStrings };
}

function blendedWeight(profile, mapName, key) {
  const k = key.toLowerCase().trim();
  const b = profile.bookmark[mapName][k] || 0;
  const l = profile.longTerm[mapName][k] || 0;
  const r = profile.recent[mapName][k] || 0;
  return BLEND.bookmark * b + BLEND.longTerm * l + BLEND.recent * r;
}

function scoreItem(item, profile) {
  let score = 0;
  (item.tags || []).forEach(t => { score += blendedWeight(profile, "tags", t); });
  (item.people || []).forEach(p => { score += blendedWeight(profile, "people", p) * 1.5; });
  return score;
}

function recommend(items, profile, limit = 20) {
  return items
    .map(item => ({ item, score: scoreItem(item, profile) }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.item);
}

// Recall search: pure token-overlap, no embeddings, no external calls.
function tokenize(str) {
  return (str || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function searchByDescription(items, query, limit = 20) {
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];

  return items
    .map(item => {
      const peopleTokens = new Set((item.people || []).flatMap(tokenize));
      const otherTokens = new Set([
        ...tokenize(item.title),
        ...(item.tags || []).flatMap(tokenize)
      ]);

      let score = 0;
      queryTokens.forEach(qt => {
        if (peopleTokens.has(qt)) score += 3; // performer-name matches weighted highest
        else if (otherTokens.has(qt)) score += 1;
      });

      return { item, score };
    })
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(r => r.item);
}
