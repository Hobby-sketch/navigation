/**
 * storage.js — Storage Engine
 * Persistence layer for BeAT Dash, shared by every other engine.
 * - Simple key/value settings + running trip counters -> localStorage (fast, synchronous-ish).
 * - Trip-reset log + full ride-session log -> IndexedDB (better for growing lists).
 * Falls back gracefully if a storage API is unavailable (e.g. private browsing).
 */

const LS_KEYS = {
  ODOMETER: 'beatdash_odometer_km',
  TRIP_A: 'beatdash_tripA_km',
  TRIP_B: 'beatdash_tripB_km',
  SETTINGS: 'beatdash_settings',
  SEARCH_HISTORY: 'beatdash_search_history',
  FAVORITES: 'beatdash_favorites',
  TRAFFIC_SETTINGS: 'beatdash_traffic_settings',
  DAILY_TRIP: 'beatdash_daily_trip',
};

const MAX_SEARCH_HISTORY = 15;
const MAX_DAILY_DAYS = 30;

const IDB_NAME = 'beatdash-db';
const IDB_VERSION = 2;
const IDB_STORE = 'trip_history';
const IDB_RIDE_STORE = 'ride_sessions';

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
      if (!db.objectStoreNames.contains(IDB_RIDE_STORE)) {
        db.createObjectStore(IDB_RIDE_STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return dbPromise;
}

/** Generic "add newest-first, capped at `limit`, from any object store" reader. */
function readAllFromStore(db, storeName, limit) {
  return new Promise((resolve) => {
    if (!db) { resolve([]); return; }
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
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

  /* ---------- generic JSON helpers (reused by history/favorites) ---------- */
  getJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  },
  setJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) { /* storage unavailable, ignore */ }
  },

  /* ---------- search history (Riwayat Pencarian) ---------- */
  getSearchHistory() {
    return this.getJSON(LS_KEYS.SEARCH_HISTORY, []);
  },
  addSearchHistory(place) {
    // place: { name, lat, lon }
    const list = this.getSearchHistory().filter(
      (p) => !(p.lat === place.lat && p.lon === place.lon)
    );
    list.unshift({ ...place, ts: Date.now() });
    this.setJSON(LS_KEYS.SEARCH_HISTORY, list.slice(0, MAX_SEARCH_HISTORY));
  },
  clearSearchHistory() {
    this.setJSON(LS_KEYS.SEARCH_HISTORY, []);
  },

  /* ---------- favorites (Favorit) ---------- */
  getFavorites() {
    return this.getJSON(LS_KEYS.FAVORITES, []);
  },
  isFavorite(lat, lon) {
    return this.getFavorites().some((p) => p.lat === lat && p.lon === lon);
  },
  toggleFavorite(place) {
    const list = this.getFavorites();
    const idx = list.findIndex((p) => p.lat === place.lat && p.lon === place.lon);
    if (idx >= 0) {
      list.splice(idx, 1);
      this.setJSON(LS_KEYS.FAVORITES, list);
      return false; // now un-favorited
    }
    list.unshift({ ...place, ts: Date.now() });
    this.setJSON(LS_KEYS.FAVORITES, list);
    return true; // now favorited
  },

  /* ---------- IndexedDB: trip-reset log (Trip A/B resets) ---------- */
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
    return readAllFromStore(db, IDB_STORE, limit);
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

  /* ---------- IndexedDB: full ride-session log (Ride Engine) ---------- */
  // session: { startedAt, endedAt, distanceKm, avgSpeedKmh, maxSpeedKmh, movingSec, stoppedSec }
  async addRideSession(session) {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_RIDE_STORE, 'readwrite');
      tx.objectStore(IDB_RIDE_STORE).add({ ...session, ts: Date.now() });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  async getRideSessions(limit = 50) {
    const db = await openDB();
    return readAllFromStore(db, IDB_RIDE_STORE, limit);
  },

  async clearRideSessions() {
    const db = await openDB();
    if (!db) return;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_RIDE_STORE, 'readwrite');
      tx.objectStore(IDB_RIDE_STORE).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  },

  /* ---------- Traffic Engine settings (provider + user-supplied key) ---------- */
  getTrafficSettings() {
    return this.getJSON(LS_KEYS.TRAFFIC_SETTINGS, { enabled: false, provider: null, apiKeys: {} });
  },
  setTrafficSettings(obj) {
    this.setJSON(LS_KEYS.TRAFFIC_SETTINGS, obj);
  },
  setTrafficApiKey(provider, apiKey) {
    const s = this.getTrafficSettings();
    s.apiKeys = s.apiKeys || {};
    s.apiKeys[provider] = apiKey;
    this.setTrafficSettings(s);
  },

  /* ---------- Daily trip (Ride Engine) — km driven per calendar day ---------- */
  _todayKey() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (local-ish, good enough for a dashboard)
  },
  getDailyTripMap() {
    return this.getJSON(LS_KEYS.DAILY_TRIP, {});
  },
  getTodayTripKm() {
    const map = this.getDailyTripMap();
    return map[this._todayKey()] || 0;
  },
  addDailyDistance(deltaKm) {
    const map = this.getDailyTripMap();
    const key = this._todayKey();
    map[key] = (map[key] || 0) + deltaKm;
    // prune old entries so this object never grows unbounded
    const keys = Object.keys(map).sort();
    if (keys.length > MAX_DAILY_DAYS) {
      keys.slice(0, keys.length - MAX_DAILY_DAYS).forEach((k) => delete map[k]);
    }
    this.setJSON(LS_KEYS.DAILY_TRIP, map);
    return map[key];
  },
};
