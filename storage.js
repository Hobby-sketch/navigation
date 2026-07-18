/**
 * storage.js
 * Persistence layer for BeAT Dash.
 * - Simple key/value settings + running trip counters -> localStorage (fast, synchronous-ish).
 * - Trip history log (list of completed trips) -> IndexedDB (better for growing lists).
 * Falls back gracefully if a storage API is unavailable (e.g. private browsing).
 */

const LS_KEYS = {
  ODOMETER: 'beatdash_odometer_km',
  TRIP_A: 'beatdash_tripA_km',
  TRIP_B: 'beatdash_tripB_km',
  SETTINGS: 'beatdash_settings',
};

const IDB_NAME = 'beatdash-db';
const IDB_VERSION = 1;
const IDB_STORE = 'trip_history';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

export const storage = {
  /* ---------- localStorage helpers (numeric distances) ---------- */
  getNumber(key, fallback = 0) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : parseFloat(v);
    } catch (e) {
      return fallback;
    }
  },
  setNumber(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch (e) { /* storage unavailable, ignore */ }
  },

  getOdometer() { return this.getNumber(LS_KEYS.ODOMETER, 0); },
  setOdometer(v) { this.setNumber(LS_KEYS.ODOMETER, v); },

  getTripA() { return this.getNumber(LS_KEYS.TRIP_A, 0); },
  setTripA(v) { this.setNumber(LS_KEYS.TRIP_A, v); },

  getTripB() { return this.getNumber(LS_KEYS.TRIP_B, 0); },
  setTripB(v) { this.setNumber(LS_KEYS.TRIP_B, v); },

  /* ---------- settings object ---------- */
  getSettings() {
    try {
      const raw = localStorage.getItem(LS_KEYS.SETTINGS);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  },
  setSettings(obj) {
    try {
      localStorage.setItem(LS_KEYS.SETTINGS, JSON.stringify(obj));
    } catch (e) { /* ignore */ }
  },
  updateSetting(key, value) {
    const s = this.getSettings();
    s[key] = value;
    this.setSettings(s);
  },

  /* ---------- IndexedDB trip history ---------- */
  async addHistoryEntry(entry) {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).add({ ...entry, ts: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  async getHistory(limit = 50) {
    const db = await openDB();
    if (!db) return [];
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const results = [];
      const req = store.openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor && results.length < limit) {
          results.push(cursor.value);
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => resolve(results);
    });
  },

  async clearHistory() {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },
};
