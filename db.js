// db.js
// IndexedDB wrapper. Everything here is local to the browser profile —
// this extension never sends any of it anywhere.

const DB_NAME = "taste-profile-db";
const DB_VERSION = 1;
const MAX_ACTIVITY_ENTRIES = 5000;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) {
        db.createObjectStore("items", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("activity")) {
        const store = db.createObjectStore("activity", { keyPath: "seq", autoIncrement: true });
        store.createIndex("at", "at");
      }
      if (!db.objectStoreNames.contains("profile")) {
        db.createObjectStore("profile", { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const result = fn(store);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  });
}

async function upsertItems(items) {
  const db = await openDb();
  return tx(db, "items", "readwrite", store => {
    items.forEach(item => store.put(item));
  });
}

async function getAllItems() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("items", "readonly");
    const req = t.objectStore("items").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function appendActivity(entry) {
  const db = await openDb();
  await tx(db, "activity", "readwrite", store => {
    store.add(entry);
  });
}

async function pruneActivity() {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const t = db.transaction("activity", "readonly");
    const req = t.objectStore("activity").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (all.length <= MAX_ACTIVITY_ENTRIES) return;

  const toDelete = all
    .sort((a, b) => a.seq - b.seq)
    .slice(0, all.length - MAX_ACTIVITY_ENTRIES);

  const db2 = await openDb();
  await tx(db2, "activity", "readwrite", store => {
    toDelete.forEach(entry => store.delete(entry.seq));
  });
}

async function getRecentActivity(limit = 200) {
  const db = await openDb();
  const all = await new Promise((resolve, reject) => {
    const t = db.transaction("activity", "readonly");
    const req = t.objectStore("activity").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

// Default shape for a brand-new profile, matching the three-tier scoring
// model in scoring.js: bookmark (anchor), longTerm (slow decay, needs
// cross-session repetition), recent (fast decay, current mood).
function emptyProfile() {
  return {
    bookmark: { tags: {}, people: {} },
    longTerm: { tags: {}, people: {}, lastUpdated: Date.now() },
    recent: { tags: {}, people: {} },
    explicit: []
  };
}

async function getProfile() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("profile", "readonly");
    const req = t.objectStore("profile").get("weights");
    req.onsuccess = () => resolve(req.result ? req.result.value : emptyProfile());
    req.onerror = () => reject(req.error);
  });
}

async function saveProfile(profile) {
  const db = await openDb();
  return tx(db, "profile", "readwrite", store => {
    store.put({ key: "weights", value: profile });
  });
}

async function clearAllData() {
  const db = await openDb();
  await tx(db, "items", "readwrite", store => store.clear());
  await tx(db, "activity", "readwrite", store => store.clear());
  await tx(db, "profile", "readwrite", store => store.clear());
}

async function exportAllData() {
  const [items, activity, profile] = await Promise.all([
    getAllItems(),
    getRecentActivity(MAX_ACTIVITY_ENTRIES),
    getProfile()
  ]);
  return { exportedAt: Date.now(), items, activity, profile };
}