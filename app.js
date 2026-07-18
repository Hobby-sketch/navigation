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
  switchView, showToast, fmtKm, compassLabel,
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

/* ---------------- GPS wiring ---------------- */
gps.on((data) => {
  setGpsChip(data.status);
  if (data.status !== 'active') return;

  userLat = data.latitude;
  userLng = data.longitude;

  speedo.setSpeedKmh(data.speedKmh);
  trip.update(data.latitude, data.longitude, data.accuracy);
  map.setMyLocation(data.latitude, data.longitude, currentHeading);

  document.getElementById('val-altitude').textContent =
    data.altitude !== null ? `${Math.round(data.altitude)} m` : '-- m';
  document.getElementById('val-accuracy').textContent =
    data.accuracy !== null ? `± ${Math.round(data.accuracy)} m` : '± -- m';
  document.getElementById('val-satellites').textContent =
    data.satelliteEstimate !== null ? String(data.satelliteEstimate) : '--';

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

/* ---------------- Map: search ---------------- */
const searchInput = document.getElementById('map-search-input');
const searchResultsEl = document.getElementById('map-search-results');
let searchDebounce = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  if (q.length < 3) {
    searchResultsEl.classList.remove('show');
    return;
  }
  searchDebounce = setTimeout(async () => {
    const results = await searchPlaces(q, { lat: userLat, lng: userLng });
    renderSearchResults(results);
  }, 350);
});

function renderSearchResults(results) {
  if (!results.length) {
    searchResultsEl.innerHTML = '<div class="map-search__result">Tidak ada hasil</div>';
    searchResultsEl.classList.add('show');
    return;
  }
  searchResultsEl.innerHTML = results
    .map((r, i) => `<div class="map-search__result" data-idx="${i}">${escapeHtml(r.display_name.split(',')[0])}<small>${escapeHtml(r.display_name)}</small></div>`)
    .join('');
  searchResultsEl.classList.add('show');
  searchResultsEl.querySelectorAll('.map-search__result').forEach((el, i) => {
    el.addEventListener('click', () => {
      const r = results[i];
      const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
      pendingDestination = { lat, lon, name: r.display_name.split(',')[0] };
      map.setDestination(lat, lon);
      map.flyTo(lat, lon);
      searchResultsEl.classList.remove('show');
      searchInput.value = r.display_name.split(',')[0];
      showToast(`Tujuan: ${pendingDestination.name}`);
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* ---------------- Map: category chips ---------------- */
document.getElementById('map-categories').addEventListener('click', async (e) => {
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
});

/* ---------------- Map: controls ---------------- */
document.getElementById('btn-zoom-in').addEventListener('click', () => map.zoomIn());
document.getElementById('btn-zoom-out').addEventListener('click', () => map.zoomOut());

const locateBtn = document.getElementById('btn-locate');
locateBtn.addEventListener('click', () => {
  const enabled = !locateBtn.classList.contains('active');
  locateBtn.classList.toggle('active', enabled);
  map.toggleFollow(enabled);
  showToast(enabled ? 'Mengikuti lokasi GPS' : 'Berhenti mengikuti lokasi');
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
