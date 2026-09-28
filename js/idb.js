/* TRALIX EDITOR — IndexedDB persistence: projects, media blobs, exported edits, settings */
const DB_NAME = 'tralix-editor';
const DB_VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('exports')) db.createObjectStore('exports', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
const wrapReq = (req) => { const o = { __req: req }; return o; }

export const idb = {
  async put(store, value) { return tx(store, 'readwrite', s => s.put(value)); },
  async get(store, key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  },
  async getAll(store) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const r = db.transaction(store).objectStore(store).getAll();
      r.onsuccess = () => resolve(r.result || []); r.onerror = () => reject(r.error);
    });
  },
  async delete(store, key) { return tx(store, 'readwrite', s => s.delete(key)); },
  async clear(store) { return tx(store, 'readwrite', s => s.clear()); },
  async kvGet(key) { return this.get('kv', key); },
  async kvSet(key, value) { return tx('kv', 'readwrite', s => s.put(value, key)); },
};
