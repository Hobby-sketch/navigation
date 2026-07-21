/**
 * app.js — main entry point.
 * Boots the app, then wires GPS, motion sensors, the speedometer, the map,
 * trip/odometer tracking, settings, and navigation between views.
 */

import { runBootSequence } from './boot.js';
import { GPSManager } from './gps.js';
import { MotionManager } from './motion.js';
import { Speedometer } from './speedometer.js';
import { TripManager } from './trip.js';
import { BluetoothStatus } from './bluetooth.js';
import { MapManager, searchPlaces, searchCategory, CATEGORY_EMOJI } from './map.js';
import { SettingsManager } from './settings.js';
import { storage } from './storage.js';
import {
  startClock, setGpsChip, setBtChip, initNetworkStatus, initBatteryStatus,
  switchView, showToast, fmtKm, compassLabel, gpsStatusLabel, debounce, throttle,
} from './ui.js';

let userLat = null;
let userLng = null;
let currentHeading = null;
let pendingDestination = null;
let activeCategory = null;

const gps = new GPSManager();
const motion = new MotionManager();
const speedo = new Speedometer({ unit: storage.getSettings().unit || 'kmh' });
const trip = new TripManager();
const bt = new BluetoothStatus();
const map = new MapManager('map-container');

/* ---------------- GPS wiring (Smart GPS Engine) ---------------- */
const gpsBanner = document.getElementById('gps-banner');
const gpsBannerText = document.getElementById('gps-banner-text');
const qualityEl = document.getElementById('val-gps-quality');

function renderGpsStatus(status, quality) {
  setGpsChip(status, quality);
  const showBanner = status === 'searching' || status === 'weak' || status === 'lost' || status === 'denied' || status === 'unsupported';
  gpsBanner.hidden = !showBanner;
  if (showBanner) {
    gpsBanner.dataset.status = status;
    gpsBannerText.textContent = gpsStatusLabel(status);
  }
}

gps.on((data) => {
  if (data.kind === 'status') {
    renderGpsStatus(data.status, gps.quality);
    return;
  }

  renderGpsStatus(data.status, data.quality);

  // "predicted" ticks (dead-reckoning between real fixes) only move the map
  // marker smoothly — they must never touch trip/odometer or hit the DOM
  // heavily, to keep this at rAF rate without layout thrashing.
  if (data.kind === 'predicted') {
    map.setMyLocation(data.latitude, data.longitude, data.heading, data.accuracy, data.isMoving);
    return;
  }

  // Real "fix": a usable position is either a clean ('active') or a noisy
  // but still valid ('weak') reading — both update trip/UI, just flagged
  // differently in the status chip/banner above.
  if (data.status !== 'active' && data.status !== 'weak') return;

  userLat = data.latitude;
  userLng = data.longitude;

  speedo.setSpeedKmh(data.speedKmh);
  trip.update(data.latitude, data.longitude, data.accuracy);
  map.setMyLocation(data.latitude, data.longitude, data.heading, data.accuracy, data.isMoving);

  document.getElementById('val-altitude').textContent =
    data.altitude !== null ? `${Math.round(data.altitude)} m` : '-- m';
  document.getElementById('val-accuracy').textContent =
    data.accuracy !== null ? `± ${Math.round(data.accuracy)} m` : '± -- m';
  document.getElementById('val-satellites').textContent =
    data.satelliteEstimate !== null ? String(data.satelliteEstimate) : '--';
  qualityEl.textContent = data.quality ? data.quality[0].toUpperCase() + data.quality.slice(1) : '--';
  qualityEl.dataset.quality = data.quality || '';

  if (currentHeading === null && data.heading !== null) {
    updateHeadingUI(data.heading);
  }
});

/* ---------------- Motion (compass + lean) wiring ---------------- */
function updateHeadingUI(heading) {
  currentHeading = heading;
  document.getElementById('val-heading').textContent = `${compassLabel(heading)} ${Math.round(heading)}°`;
}

motion.on((evt) => {
  if (evt.type === 'heading') {
    updateHeadingUI(evt.heading);
  } else if (evt.type === 'lean') {
    renderLean(evt.roll, evt.pitch);
  }
});

function renderLean(roll, pitch) {
  const panel = document.getElementById('lean-panel');
  const rollEl = document.getElementById('val-roll');
  const pitchEl = document.getElementById('val-pitch');
  const rollDirEl = document.getElementById('val-roll-dir');
  const pitchDirEl = document.getElementById('val-pitch-dir');
  const bikeGroup = document.getElementById('lean-bike-group');

  const absRoll = Math.abs(roll);
  rollEl.textContent = `${absRoll.toFixed(0)}°`;
  pitchEl.textContent = `${Math.abs(pitch).toFixed(0)}°`;

  rollDirEl.textContent = roll > 3 ? 'KANAN' : roll < -3 ? 'KIRI' : 'SEIMBANG';
  pitchDirEl.textContent = pitch > 3 ? 'NAIK' : pitch < -3 ? 'TURUN' : 'DATAR';

  let state = 'safe';
  if (absRoll >= 30) state = 'danger';
  else if (absRoll >= 15) state = 'warn';
  panel.dataset.state = state;

  const clampedRoll = Math.max(-45, Math.min(45, roll));
  bikeGroup.style.transform = `rotate(${clampedRoll}deg)`;
}

/* ---------------- Trip / odometer wiring ---------------- */
function renderTrip(state) {
  document.getElementById('val-odometer').textContent = fmtKm(state.odometerKm);
  document.getElementById('val-tripa').textContent = fmtKm(state.tripAKm);
  document.getElementById('val-tripb').textContent = fmtKm(state.tripBKm);
}
trip.on(renderTrip);
renderTrip(trip.getState());

document.getElementById('btn-reset-tripa').addEventListener('click', async () => {
  await trip.resetTripA();
  showToast('Trip A direset');
});
document.getElementById('btn-reset-tripb').addEventListener('click', async () => {
  await trip.resetTripB();
  showToast('Trip B direset');
});

/* ---------------- Bluetooth status ---------------- */
bt.on((state) => setBtChip(state));

/* ---------------- Map: search (with autocomplete, riwayat & favorit) ---------------- */
const searchInput = document.getElementById('map-search-input');
const searchResultsEl = document.getElementById('map-search-results');

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function selectPlace(name, lat, lon) {
  pendingDestination = { lat, lon, name };
  map.setDestination(lat, lon);
  map.flyTo(lat, lon);
  searchResultsEl.classList.remove('show');
  searchInput.value = name;
  storage.addSearchHistory({ name, lat, lon });
  showToast(`Tujuan: ${name}`);
}

/** Shown when the search box is focused and empty: quick access to recent
 *  searches and saved favorites (persisted via storage.js). */
function renderSuggestions() {
  const history = storage.getSearchHistory();
  const favorites = storage.getFavorites();
  if (!history.length && !favorites.length) {
    searchResultsEl.classList.remove('show');
    return;
  }
  const rowsHtml = (items, favSet) => items.map((p) => {
    const isFav = favSet.has(`${p.lat},${p.lon}`);
    return `<div class="map-search__result" data-lat="${p.lat}" data-lon="${p.lon}" data-name="${escapeHtml(p.name)}">
      <span class="map-search__result-text">${escapeHtml(p.name)}</span>
      <button type="button" class="map-search__star ${isFav ? 'active' : ''}" data-fav-name="${escapeHtml(p.name)}">★</button>
    </div>`;
  }).join('');

  const favKeySet = new Set(favorites.map((f) => `${f.lat},${f.lon}`));
  let html = '';
  if (favorites.length) html += `<div class="map-search__section-title">Favorit</div>${rowsHtml(favorites, favKeySet)}`;
  if (history.length) html += `<div class="map-search__section-title">Riwayat Pencarian</div>${rowsHtml(history, favKeySet)}`;
  searchResultsEl.innerHTML = html;
  searchResultsEl.classList.add('show');
  bindResultRows();
}

function renderSearchResults(results) {
  if (!results.length) {
    searchResultsEl.innerHTML = '<div class="map-search__result"><span class="map-search__result-text">Tidak ada hasil</span></div>';
    searchResultsEl.classList.add('show');
    return;
  }
  const favorites = storage.getFavorites();
  const favKeySet = new Set(favorites.map((f) => `${f.lat},${f.lon}`));
  searchResultsEl.innerHTML = results.map((r) => {
    const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
    const name = r.display_name.split(',')[0];
    const isFav = favKeySet.has(`${lat},${lon}`);
    return `<div class="map-search__result" data-lat="${lat}" data-lon="${lon}" data-name="${escapeHtml(name)}">
      <span class="map-search__result-text">${escapeHtml(name)}<small>${escapeHtml(r.display_name)}</small></span>
      <button type="button" class="map-search__star ${isFav ? 'active' : ''}" data-fav-name="${escapeHtml(name)}">★</button>
    </div>`;
  }).join('');
  searchResultsEl.classList.add('show');
  bindResultRows();
}

function bindResultRows() {
  searchResultsEl.querySelectorAll('.map-search__result[data-lat]').forEach((el) => {
    const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon), name = el.dataset.name;
    el.querySelector('.map-search__result-text')?.addEventListener('click', () => selectPlace(name, lat, lon));
    el.querySelector('.map-search__star')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const nowFav = storage.toggleFavorite({ name, lat, lon });
      e.currentTarget.classList.toggle('active', nowFav);
      showToast(nowFav ? `Ditambahkan ke favorit` : `Dihapus dari favorit`);
    });
  });
}

const runSearch = debounce(async (q) => {
  const results = await searchPlaces(q, { lat: userLat, lng: userLng });
  renderSearchResults(results);
}, 350);

searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim();
  if (q.length < 3) {
    if (q.length === 0) renderSuggestions();
    else searchResultsEl.classList.remove('show');
    return;
  }
  runSearch(q);
});

searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim().length === 0) renderSuggestions();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.map-search')) searchResultsEl.classList.remove('show');
});

/* ---------------- Map: category chips ---------------- */
const runCategorySearch = throttle(async (cat) => {
  if (userLat === null) {
    showToast('Menunggu sinyal GPS...');
    return;
  }
  map.clearPois();
  showToast(`Mencari ${cat}...`);
  const results = await searchCategory(cat, userLat, userLng);
  if (!results.length) {
    showToast(`Tidak ditemukan ${cat} di sekitar`);
    return;
  }
  results.forEach((p) => map.addPoiMarker(p.lat, p.lon, p.name, CATEGORY_EMOJI[cat]));
  showToast(`${results.length} ${cat} ditemukan`);
}, 1200);

document.getElementById('map-categories').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  const cat = btn.dataset.cat;

  document.querySelectorAll('#map-categories .chip').forEach((c) => c.classList.toggle('active', c === btn && activeCategory !== cat));

  if (activeCategory === cat) {
    activeCategory = null;
    map.clearPois();
    btn.classList.remove('active');
    return;
  }
  activeCategory = cat;
  runCategorySearch(cat);
});

/* ---------------- Map: controls (Follow GPS + Kembali Ikuti) ---------------- */
document.getElementById('btn-zoom-in').addEventListener('click', () => map.zoomIn());
document.getElementById('btn-zoom-out').addEventListener('click', () => map.zoomOut());

const locateBtn = document.getElementById('btn-locate');
const resumeFollowBtn = document.getElementById('btn-resume-follow');

locateBtn.addEventListener('click', () => {
  map.toggleFollow(!map.isFollowing());
});

resumeFollowBtn.addEventListener('click', () => {
  map.toggleFollow(true);
});

// Single source of truth for the Follow GPS UI: the map emits this whenever
// following starts/stops, whether triggered by a button or by the user
// dragging/zooming/rotating the map themselves.
map.on((evt) => {
  if (evt.type !== 'follow-change') return;
  locateBtn.classList.toggle('active', evt.following);
  resumeFollowBtn.hidden = evt.following;
  if (userLat !== null) showToast(evt.following ? 'Mengikuti lokasi GPS' : 'Berhenti mengikuti lokasi');
});

/* ---------------- Bottom navigation ---------------- */
document.querySelectorAll('.bottomnav__item').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view, { onEnter: onViewEnter });
  });
});

async function onViewEnter(view) {
  if (view === 'navigasi') {
    const textEl = document.getElementById('nav-instructions-text');
    if (pendingDestination && userLat !== null) {
      textEl.textContent = `Menghitung rute ke ${pendingDestination.name}...`;
      const route = await map.drawRoute(userLat, userLng, pendingDestination.lat, pendingDestination.lon);
      if (route) {
        const km = (route.distance / 1000).toFixed(1);
        const min = Math.round(route.duration / 60);
        textEl.textContent = `${pendingDestination.name} — ${km} km · ${min} menit`;
      } else {
        textEl.textContent = 'Rute tidak ditemukan. Coba lagi.';
      }
    } else {
      textEl.textContent = 'Cari tujuan untuk memulai navigasi';
    }
  } else if (view === 'riwayat') {
    renderHistoryView();
  }
}

async function renderHistoryView() {
  const state = trip.getState();
  document.getElementById('hist-odometer').textContent = fmtKm(state.odometerKm);
  document.getElementById('hist-tripa').textContent = fmtKm(state.tripAKm);
  document.getElementById('hist-tripb').textContent = fmtKm(state.tripBKm);

  const list = document.getElementById('history-list');
  const entries = await storage.getHistory();
  if (!entries.length) {
    list.innerHTML = '<li class="history-list__empty">Belum ada riwayat perjalanan tersimpan.</li>';
    return;
  }
  list.innerHTML = entries.map((e) => {
    const date = new Date(e.ts);
    const dateStr = date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
    return `<li><div><div class="h-dist">${e.label}</div><div class="h-date">${dateStr}, ${timeStr}</div></div><div class="h-dist">${e.distanceKm.toFixed(1)} km</div></li>`;
  }).join('');
}

/* ---------------- Settings ---------------- */
const settings = new SettingsManager({
  onUnitChange: (unit) => speedo.setUnit(unit),
  onResetOdometer: () => trip.resetOdometer(),
  onClearHistory: async () => { await storage.clearHistory(); renderHistoryView(); },
});

/* ---------------- Sensor bootstrap ---------------- */
function startSensors() {
  gps.start();
  bt.start();
  speedo.start();
}

function initMotionGate() {
  if (motion.needsPermission) {
    const gate = () => {
      motion.requestPermission().then((granted) => {
        if (granted) motion.start();
        else showToast('Izin sensor kemiringan & kompas ditolak');
      });
      document.removeEventListener('click', gate);
      document.removeEventListener('touchstart', gate);
    };
    document.addEventListener('click', gate, { once: true });
    document.addEventListener('touchstart', gate, { once: true });
    showToast('Ketuk layar untuk mengaktifkan sensor kompas & kemiringan');
  } else {
    motion.start();
  }
}

/* ---------------- Service worker ---------------- */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW register failed', e));
    });
  }
}

/* ---------------- Boot ---------------- */
(async function main() {
  startClock();
  initNetworkStatus();
  initBatteryStatus();
  registerServiceWorker();

  await runBootSequence({ durationMs: 2600 });

  startSensors();
  initMotionGate();
})();
