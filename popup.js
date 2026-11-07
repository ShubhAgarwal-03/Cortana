// popup.js

function send(type, payload) {
  return chrome.runtime.sendMessage({ type, payload });
}

function renderItemList(el, items, { onOpen } = {}) {
  el.innerHTML = "";
  if (!items.length) {
    el.innerHTML = `<li class="item-meta">Nothing yet.</li>`;
    return;
  }
  items.forEach(item => {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = item.link || "#";
    a.target = "_blank";
    a.textContent = item.title || "(untitled)";

    if (onOpen) {
      // Route through background so the resulting dwell event gets
      // tagged source: "recommendation" instead of relying on referrer.
      a.addEventListener("click", evt => {
        evt.preventDefault();
        onOpen(item);
        send("OPEN_RECOMMENDED_ITEM", { url: a.href });
      });
    }

    const meta = document.createElement("div");
    meta.className = "item-meta";
    const bits = [];
    if (item.people && item.people.length) bits.push(item.people.join(", "));
    if (item.duration) bits.push(item.duration);
    meta.textContent = bits.join(" · ");
    li.appendChild(a);
    li.appendChild(meta);
    el.appendChild(li);
  });
}

// --- Tabs ---
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// --- Recommend tab ---
// excludeIds grows as the user opens items, so repeats don't reappear
// within the same popup session, and drives the "top" -> "recommended"
// fallback once the fresh pool runs out.
let excludeIds = [];

function setTierLabel(tier) {
  const label = document.getElementById("recsTierLabel");
  if (!label) return;
  label.textContent = tier === "recommended"
    ? "Recommended (revisiting earlier picks)"
    : "Top recommendations";
}

async function loadRecommendations({ reset = true } = {}) {
  if (reset) excludeIds = [];
  const { items, tier } = await send("GET_RECOMMENDATIONS", { limit: 20, excludeIds });
  setTierLabel(tier);
  renderItemList(document.getElementById("recsList"), items || [], {
    onOpen: item => {
      if (item.id && !excludeIds.includes(item.id)) excludeIds.push(item.id);
    }
  });
}

document.getElementById("refreshRecs").addEventListener("click", () => loadRecommendations({ reset: true }));

const loadMoreBtn = document.getElementById("loadMoreRecs");
if (loadMoreBtn) {
  loadMoreBtn.addEventListener("click", () => loadRecommendations({ reset: false }));
}

// --- Find it tab ---
async function runFind() {
  const query = document.getElementById("findInput").value;
  const { items } = await send("FIND_BY_DESCRIPTION", { query, limit: 20 });
  renderItemList(document.getElementById("findList"), items || []);
}
document.getElementById("findBtn").addEventListener("click", runFind);
document.getElementById("findInput").addEventListener("keydown", e => {
  if (e.key === "Enter") runFind();
});

// --- Interests tab ---
document.getElementById("saveInterests").addEventListener("click", async () => {
  const raw = document.getElementById("interestsInput").value;
  const list = raw.split("\n").map(s => s.trim()).filter(Boolean);
  await send("SET_EXPLICIT_INTERESTS", list);
  document.getElementById("interestsStatus").textContent = "Saved.";
  setTimeout(() => (document.getElementById("interestsStatus").textContent = ""), 2000);
});

// --- Log tab ---
async function loadLog() {
  const [{ activity }, stats] = await Promise.all([send("GET_RECENT_LOG", { limit: 50 }), send("GET_STATS")]);
  document.getElementById("statsLine").textContent =
    `${stats.itemCount} items scraped · ${stats.activityCount} activity events stored`;

  const el = document.getElementById("logList");
  el.innerHTML = "";
  (activity || []).forEach(entry => {
    const li = document.createElement("li");
    const when = new Date(entry.at).toLocaleString();
    const detail = entry.kind === "dwell" ? `${Math.round(entry.dwellMs / 1000)}s` : "click";
    const sourceBit = entry.source ? ` [${entry.source}]` : "";
    li.textContent = `${when} — ${entry.kind} (${detail}) — ${entry.site}${sourceBit}`;
    el.appendChild(li);
  });
}

document.getElementById("exportBtn").addEventListener("click", async () => {
  const { data } = await send("EXPORT_DATA");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({
    url,
    filename: `taste-profile-export-${Date.now()}.json`,
    saveAs: true
  });
});

document.getElementById("clearBtn").addEventListener("click", async () => {
  if (!confirm("This deletes all locally stored items, activity, and profile weights. Continue?")) return;
  await send("CLEAR_ALL_DATA");
  loadRecommendations({ reset: true });
  loadLog();
});

// Initial load
loadRecommendations({ reset: true });
loadLog();