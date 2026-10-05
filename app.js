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
import { TrafficEngine, TRAFFIC_PROVIDERS } from './traffic.js';
import { WeatherEngine } from './weather.js';
import { NavigationEngine, NAV_STATE, formatEta, formatClockTime } from './navigation.js';
import { HeadingFusion } from './heading.js';
import { VoiceGuidance } from './voice.js';
import { maneuverIconSvg, formatDistance, voiceText, describeManeuver, MANEUVER_TYPE, MANEUVER_STATE } from './maneuver.js';
import { ThemeManager } from './theme.js';
import { storage } from './storage.js';
import {
  startClock, setGpsChip, setBtChip, initNetworkStatus, initBatteryStatus,
  switchView, showToast, fmtKm, compassLabel, gpsStatusLabel, debounce, throttle,
} from './ui.js';

let userLat = null;
let userLng = null;
let currentHeading = null;          // unified vehicleHeading (deg) — see heading.js
let vehicleHeadingState = { heading: null, confidence: 0, valid: false, source: 'none' };
let lastSpeedKmh = 0;
let lastAlongM = 0;
let pendingDestination = null;
let activeCategory = null;

const gps = new GPSManager();
const motion = new MotionManager();
const speedo = new Speedometer({ unit: storage.getSettings().unit || 'kmh' });
const trip = new TripManager();
const bt = new BluetoothStatus();
const map = new MapManager('map-container');
const traffic = new TrafficEngine(map);
const weather = new WeatherEngine();
const navEngine = new NavigationEngine(map);
const theme = new ThemeManager();
const fusion = new HeadingFusion();   // GPS bearing + compass + speed + confidence -> vehicleHeading
const voice = new VoiceGuidance();
const panelMapEl = document.querySelector('.panel--map');

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
    map.setMyLocation(data.latitude, data.longitude, data.heading, data.accuracy, data.isMoving, data.speedKmh);
    return;
  }

  // Real "fix": a usable position is either a clean ('active') or a noisy
  // but still valid ('weak') reading — both update trip/UI, just flagged
  // differently in the status chip/banner above.
  if (data.status !== 'active' && data.status !== 'weak') return;

  userLat = data.latitude;
  userLng = data.longitude;
  theme.setLatLng(data.latitude, data.longitude);

  lastSpeedKmh = data.speedKmh;
  // Raw GPS bearing goes to the fusion layer (null while stationary / invalid).
  fusion.setGps({ headingDeg: data.gpsBearing, speedKmh: data.speedKmh, accuracyM: data.accuracy, timestampMs: Date.now() });

  speedo.setSpeedKmh(data.speedKmh);
  trip.update(data.latitude, data.longitude, data.accuracy, data.speedKmh, data.isMoving);
  map.setMyLocation(data.latitude, data.longitude, data.heading, data.accuracy, data.isMoving, data.speedKmh);

  weather.maybeRefresh(data.latitude, data.longitude);
  navEngine.update(data.latitude, data.longitude, data.speedKmh, {
    accuracy: data.accuracy,
    heading: vehicleHeadingState.heading,
    headingConfidence: vehicleHeadingState.confidence,
    headingValid: vehicleHeadingState.valid,
  });
  const navSpeedEl = document.getElementById('nav-speed');
  if (navSpeedEl) navSpeedEl.textContent = String(Math.round(speedo.unit === 'mph' ? data.speedKmh * 0.621371 : data.speedKmh));
  traffic.onMotionUpdate(data.isMoving);

  document.getElementById('val-altitude').textContent =
    data.altitude !== null ? `${Math.round(data.altitude)} m` : '-- m';
  document.getElementById('val-accuracy').textContent =
    data.accuracy !== null ? `± ${Math.round(data.accuracy)} m` : '± -- m';
  document.getElementById('val-satellites').textContent =
    data.satelliteEstimate !== null ? String(data.satelliteEstimate) : '--';
  qualityEl.textContent = data.quality ? data.quality[0].toUpperCase() + data.quality.slice(1) : '--';
  qualityEl.dataset.quality = data.quality || '';
});

/* ---------------- Heading Fusion + Motion (compass + lean) wiring ---------------- */
const headingEl = document.getElementById('val-heading');

function updateHeadingUI(heading, valid = true) {
  currentHeading = heading;
  headingEl.textContent = heading === null ? '--' : `${compassLabel(heading)} ${Math.round(heading)}°`;
  headingEl.dataset.conf = valid ? 'ok' : 'low';
}

// vehicleHeading is THE heading: map arrow, compass UI, Heading-Up bearing,
// dead reckoning and navigation all read it from here.
fusion.on((state) => {
  vehicleHeadingState = state;
  if (state.heading === null) return;
  updateHeadingUI(state.heading, state.valid);
  map.setVehicleHeading(state.heading, state.valid);
  gps.setVehicleHeading({ heading: state.heading, confidence: state.confidence, valid: state.valid });
});
fusion.start(66);

motion.on((evt) => {
  if (evt.type === 'compass') {
    fusion.setCompass({
      headingDeg: evt.heading,
      confidence: evt.confidence,
      source: evt.source === 'relative' ? 'relative' : 'absolute',
      screenAngle: evt.screenAngle,
    });
  } else if (evt.type === 'lean') {
    renderLean(evt);
  } else if (evt.type === 'calibration') {
    renderCalibrationState();
  }
});

const leanEls = {
  panel: document.getElementById('lean-panel'),
  roll: document.getElementById('val-roll'),
  pitch: document.getElementById('val-pitch'),
  rollDir: document.getElementById('val-roll-dir'),
  pitchDir: document.getElementById('val-pitch-dir'),
  bike: document.getElementById('lean-bike-group'),
};
const ROLL_LABEL = { right: 'KANAN', left: 'KIRI', level: 'SEIMBANG' };
const PITCH_LABEL = { up: 'NAIK', down: 'TURUN', level: 'DATAR' };

function renderLean(evt) {
  const { roll, pitch } = evt;
  const absRoll = Math.abs(roll);
  leanEls.roll.textContent = `${absRoll.toFixed(0)}°`;
  leanEls.pitch.textContent = `${Math.abs(pitch).toFixed(0)}°`;
  // Direction text comes from the filter's hysteresis (enter ±4°, leave ±2°), so it never flickers.
  leanEls.rollDir.textContent = ROLL_LABEL[evt.rollDir] || 'SEIMBANG';
  leanEls.pitchDir.textContent = PITCH_LABEL[evt.pitchDir] || 'DATAR';

  // Indicator of vehicle inclination only — not an absolute safety claim.
  let state = 'safe';
  if (absRoll >= 30) state = 'danger';
  else if (absRoll >= 15) state = 'warn';
  leanEls.panel.dataset.state = state;
  leanEls.panel.dataset.conf = evt.confidence < 0.4 ? 'low' : 'ok';
  leanEls.panel.dataset.cal = evt.calibrated ? 'true' : 'false';

  // Rotation pivot (tyre contact point) is set in CSS on #lean-bike-group.
  leanEls.bike.style.transform = `rotate(${Math.max(-45, Math.min(45, roll)).toFixed(1)}deg)`;
}

/* ---- mount calibration ---- */
const calStatusEl = document.getElementById('cal-status');
function renderCalibrationState() {
  const cal = motion.getCalibration();
  leanEls.panel.dataset.cal = motion.isCalibrated() ? 'true' : 'false';
  if (!calStatusEl) return;
  if (cal) {
    const d = new Date(cal.ts);
    calStatusEl.textContent = `Terkalibrasi · ${d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`;
    calStatusEl.dataset.ok = 'true';
  } else {
    calStatusEl.textContent = 'Belum dikalibrasi';
    calStatusEl.dataset.ok = 'false';
  }
}

let calibrating = false;
async function runCalibration() {
  if (calibrating) return;
  if (lastSpeedKmh > 5) { showToast('Berhenti dulu untuk kalibrasi'); return; }
  calibrating = true;
  showToast('Kalibrasi... tahan HP & tegakkan motor 1 detik', 1500);
  const res = await motion.calibrate();
  calibrating = false;
  if (res.ok) showToast('Kalibrasi tersimpan');
  else if (res.reason === 'moving') showToast('Motor bergerak — diamkan lalu coba lagi');
  else if (res.reason === 'no-sensor' || res.reason === 'no-data') showToast('Sensor belum siap. Pastikan izin sensor aktif');
}
document.getElementById('btn-calibrate').addEventListener('click', runCalibration);
document.getElementById('btn-calibrate-settings').addEventListener('click', runCalibration);
document.getElementById('btn-reset-calibration').addEventListener('click', () => {
  motion.resetCalibration();
  showToast('Kalibrasi direset');
});
renderCalibrationState();

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

/* ---------------- Weather Engine ---------------- */
const weatherEls = {
  icon: document.getElementById('weather-icon'),
  temp: document.getElementById('weather-temp'),
  label: document.getElementById('weather-label'),
  wind: document.getElementById('weather-wind'),
  rain: document.getElementById('weather-rain'),
};
weather.on((evt) => {
  if (evt.type !== 'update') return;
  const w = evt.weather;
  weatherEls.icon.textContent = w.icon;
  weatherEls.temp.textContent = `${w.tempC}°`;
  weatherEls.label.textContent = w.label;
  weatherEls.wind.textContent = w.windKmh;
  weatherEls.rain.textContent = w.rainChance !== null ? w.rainChance : '--';
});

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

/** Select the place AND start navigating to it right away. */
function routeToPlace(name, lat, lon) {
  selectPlace(name, lat, lon);
  if (userLat === null) {
    showToast('Menunggu sinyal GPS untuk memulai rute...');
    return;
  }
  switchView('navigasi', { onEnter: onViewEnter });
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
  bindResultRows(true);
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

/** `direct` rows (history / favourites) start routing immediately on tap;
 *  regular search results keep the existing select-then-navigate behaviour. */
function bindResultRows(direct = false) {
  searchResultsEl.querySelectorAll('.map-search__result[data-lat]').forEach((el) => {
    const lat = parseFloat(el.dataset.lat), lon = parseFloat(el.dataset.lon), name = el.dataset.name;
    el.querySelector('.map-search__result-text')?.addEventListener('click', () => {
      if (direct) routeToPlace(name, lat, lon);
      else selectPlace(name, lat, lon);
    });
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
  if (evt.type === 'follow-change') {
    locateBtn.classList.toggle('active', evt.following);
    resumeFollowBtn.hidden = evt.following;
    if (userLat !== null) showToast(evt.following ? 'Mengikuti lokasi GPS' : 'Berhenti mengikuti lokasi');
  } else if (evt.type === 'pick-destination') {
    // Map tap or POI popup -> "Jadikan Tujuan"
    selectPlace(evt.name, evt.lat, evt.lon);
    if (navEngine.isActive && userLat !== null) {
      switchView('navigasi', { onEnter: onViewEnter }); // already navigating: re-route to the new target
    } else {
      showToast(`Tujuan: ${evt.name} — ketuk Navigasi untuk mulai`);
    }
  } else if (evt.type === 'navmode-change') {
    renderNavModeUi(evt.mode);
  } else if (evt.type === 'bearing') {
    renderCompassButton();
  }
});

/* ---- North Up / Heading Up ---- */
const navModeBtn = document.getElementById('btn-navmode');
const compassArrow = document.getElementById('compass-arrow');
const compassLabelEl = document.getElementById('compass-label');
const navModeGroup = document.getElementById('setting-navmode');

function renderCompassButton() {
  // The arrow always shows where NORTH is relative to the screen.
  compassArrow.style.transform = `rotate(${(-map.map.getBearing()).toFixed(1)}deg)`;
}
function renderNavModeUi(mode) {
  navModeBtn.dataset.mode = mode;
  compassLabelEl.textContent = mode === 'heading' ? 'H' : 'N';
  navModeBtn.setAttribute('aria-label', mode === 'heading' ? 'Heading Up (ketuk untuk North Up)' : 'North Up (ketuk untuk Heading Up)');
  navModeGroup.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('active', b.dataset.navmode === mode));
  renderCompassButton();
}
function applyNavMode(mode) {
  map.setNavMode(mode);
  storage.updateSetting('navMode', mode);
  showToast(mode === 'heading' ? 'Heading Up: peta mengikuti arah motor' : 'North Up: utara di atas');
}
navModeBtn.addEventListener('click', () => applyNavMode(map.navMode === 'north' ? 'heading' : 'north'));
navModeGroup.querySelectorAll('.segmented__btn').forEach((btn) => {
  btn.addEventListener('click', () => applyNavMode(btn.dataset.navmode));
});

// Restore saved preferences without moving the camera.
(function restoreNavPrefs() {
  const saved = storage.getSettings();
  map.setNavMode(saved.navMode === 'heading' ? 'heading' : 'north', { engage: false });
  renderNavModeUi(map.navMode);
  const autoZoomToggle = document.getElementById('setting-autozoom');
  map.setAutoZoom(saved.autoZoom !== false);
  autoZoomToggle.checked = saved.autoZoom !== false;
  autoZoomToggle.addEventListener('change', () => {
    map.setAutoZoom(autoZoomToggle.checked);
    storage.updateSetting('autoZoom', autoZoomToggle.checked);
  });
  const voiceToggle = document.getElementById('setting-voice');
  voiceToggle.checked = voice.enabled;
  voiceToggle.addEventListener('change', () => {
    voice.setEnabled(voiceToggle.checked);
    if (voiceToggle.checked) voice.say('Panduan suara aktif.', { urgent: true });
  });
})();

// Speech needs a user gesture on iOS/Safari: unlock on the first tap anywhere.
document.addEventListener('pointerdown', () => voice.unlock(), { once: true });

/* ---------------- Traffic Engine ---------------- */
const trafficBtn = document.getElementById('btn-traffic');
const trafficLegend = document.getElementById('traffic-legend');
const trafficEnabledToggle = document.getElementById('setting-traffic-enabled');
const trafficProviderGroup = document.getElementById('setting-traffic-provider');
const trafficApiKeyInput = document.getElementById('setting-traffic-apikey');

function currentTrafficProvider() {
  return trafficProviderGroup.querySelector('.segmented__btn.active')?.dataset.provider || TRAFFIC_PROVIDERS[0];
}

async function applyTrafficState(enabled) {
  const settings = storage.getTrafficSettings();
  if (enabled && !traffic.hasAnyProviderConfigured(settings.apiKeys)) {
    showToast('Isi API key provider traffic di Pengaturan dulu');
    trafficEnabledToggle.checked = false;
    settings.enabled = false;
    storage.setTrafficSettings(settings);
    return;
  }
  if (enabled) await traffic.enable(settings.apiKeys);
  else traffic.disable();
}

trafficBtn.addEventListener('click', () => {
  const settings = storage.getTrafficSettings();
  const next = !traffic.enabled;
  settings.enabled = next;
  storage.setTrafficSettings(settings);
  trafficEnabledToggle.checked = next;
  applyTrafficState(next);
});

trafficEnabledToggle.addEventListener('change', () => {
  const settings = storage.getTrafficSettings();
  settings.enabled = trafficEnabledToggle.checked;
  storage.setTrafficSettings(settings);
  applyTrafficState(trafficEnabledToggle.checked);
});

trafficProviderGroup.querySelectorAll('.segmented__btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    trafficProviderGroup.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('active', b === btn));
    const settings = storage.getTrafficSettings();
    settings.provider = btn.dataset.provider;
    storage.setTrafficSettings(settings);
    trafficApiKeyInput.value = settings.apiKeys?.[btn.dataset.provider] || '';
  });
});

trafficApiKeyInput.addEventListener('change', () => {
  storage.setTrafficApiKey(currentTrafficProvider(), trafficApiKeyInput.value.trim());
  if (traffic.enabled) applyTrafficState(true); // re-enable with the fresh key
});

traffic.on((evt) => {
  if (evt.type === 'enabled') {
    trafficBtn.classList.add('active');
    trafficLegend.hidden = false;
    showToast(`Traffic aktif (${evt.provider.toUpperCase()}${evt.fallback ? ' — fallback' : ''})`);
  } else if (evt.type === 'disabled') {
    trafficBtn.classList.remove('active');
    trafficLegend.hidden = true;
  } else if (evt.type === 'error') {
    trafficBtn.classList.remove('active');
    trafficLegend.hidden = true;
    trafficEnabledToggle.checked = false;
    showToast(evt.reason === 'no-provider'
      ? 'Belum ada API key traffic yang diisi'
      : 'Semua provider traffic gagal dimuat');
  }
});

// Restore persisted traffic settings on boot.
(function restoreTrafficSettings() {
  const settings = storage.getTrafficSettings();
  const provider = settings.provider || TRAFFIC_PROVIDERS[0];
  trafficProviderGroup.querySelectorAll('.segmented__btn').forEach((b) => b.classList.toggle('active', b.dataset.provider === provider));
  trafficApiKeyInput.value = settings.apiKeys?.[provider] || '';
  trafficEnabledToggle.checked = !!settings.enabled;
})();

/* ---------------- Navigation Engine wiring (turn-by-turn UI + voice) ---------------- */
const navEls = {
  banner: document.getElementById('nav-banner'),
  icon: document.getElementById('nav-icon'),
  dist: document.getElementById('nav-dist'),
  street: document.getElementById('nav-street'),
  then: document.getElementById('nav-then'),
  thenIcon: document.getElementById('nav-then-icon'),
  status: document.getElementById('nav-status'),
  alt: document.getElementById('nav-alternatives'),
  bar: document.getElementById('nav-bar'),
  nextIcon: document.getElementById('nav-next-icon'),
  nextDist: document.getElementById('nav-next-dist'),
  nextStreet: document.getElementById('nav-next-street'),
  remaining: document.getElementById('nav-remaining'),
  eta: document.getElementById('nav-eta'),
  arrival: document.getElementById('nav-arrival'),
  endBtn: document.getElementById('btn-end-nav'),
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
let arrivedTimer = null;

function setNavUiActive(active) {
  panelMapEl.classList.toggle('nav-active', active);
  document.body.classList.toggle('is-navigating', active);
  navEls.bar.hidden = !active;
  map.setNavigating(active);
}

function setNavStatus(text, tone = 'ok') {
  if (!text) { navEls.status.hidden = true; return; }
  navEls.status.hidden = false;
  navEls.status.textContent = text;
  navEls.status.dataset.tone = tone;
}

function resetNavUi(message = 'Cari tujuan untuk memulai navigasi') {
  clearTimeout(arrivedTimer);
  setNavUiActive(false);
  navEls.banner.dataset.state = 'idle';
  navEls.icon.innerHTML = '';
  navEls.dist.textContent = '--';
  navEls.street.textContent = message;
  navEls.then.hidden = true;
  navEls.alt.hidden = true;
  navEls.alt.innerHTML = '';
  setNavStatus('');
}

function renderAlternatives() {
  if (!navEngine.alternatives.length) { navEls.alt.hidden = true; navEls.alt.innerHTML = ''; return; }
  navEls.alt.hidden = false;
  navEls.alt.innerHTML = navEngine.alternatives.map((alt, i) => {
    const km = (alt.distanceM / 1000).toFixed(1);
    const min = Math.round(alt.durationS / 60);
    return `<button type="button" class="nav-alternatives__btn" data-idx="${i}">Rute ${i + 2} · ${km} km · ${min} mnt</button>`;
  }).join('');
  navEls.alt.querySelectorAll('.nav-alternatives__btn').forEach((btn) => {
    btn.addEventListener('click', () => navEngine.selectAlternative(Number(btn.dataset.idx)));
  });
}

/** Banner + "next turn" cell from the maneuver engine state. */
function renderManeuver(evt) {
  const m = evt.current;
  if (!m) return;
  const turnNow = evt.state === MANEUVER_STATE.TURN_NOW;
  const verb = cap(describeManeuver(m));
  navEls.banner.dataset.state = evt.navState === NAV_STATE.ARRIVED ? 'arrived' : (turnNow ? 'TURN_NOW' : 'on');
  navEls.icon.innerHTML = maneuverIconSvg(m.type, { size: 40 });

  if (m.type === MANEUVER_TYPE.DESTINATION) {
    navEls.dist.textContent = turnNow ? 'Tiba' : formatDistance(evt.distanceM);
    navEls.street.textContent = pendingDestination?.name || 'Tujuan Anda';
  } else {
    navEls.dist.textContent = turnNow ? 'Sekarang' : formatDistance(evt.distanceM);
    navEls.street.textContent = turnNow
      ? `${verb} sekarang`
      : (m.streetName ? `${verb} ke ${m.streetName}` : verb);
  }

  // "Lalu ..." preview when the following maneuver is close behind this one
  const nx = evt.next;
  if (nx && nx.type !== MANEUVER_TYPE.DESTINATION && nx.offsetM - m.offsetM < 300) {
    navEls.then.hidden = false;
    navEls.thenIcon.innerHTML = maneuverIconSvg(nx.type, { size: 20 });
  } else {
    navEls.then.hidden = true;
  }

  // bottom bar: NEXT TURN = the maneuver after the active one (or the active one if it is last)
  const target = nx || m;
  navEls.nextIcon.innerHTML = maneuverIconSvg(target.type, { size: 26 });
  navEls.nextDist.textContent = formatDistance(Math.max(0, target.offsetM - lastAlongM));
  navEls.nextStreet.textContent = target.type === MANEUVER_TYPE.DESTINATION ? 'Tujuan' : (target.streetName || cap(describeManeuver(target)));

  map.setNextManeuverDistance(evt.distanceM);
}

navEngine.on((evt) => {
  switch (evt.type) {
    case 'routing-start':
      if (!evt.reroute) {
        navEls.banner.dataset.state = 'idle';
        navEls.street.textContent = `Menghitung rute ke ${pendingDestination?.name || 'tujuan'}...`;
      }
      break;

    case 'route-ready': {
      clearTimeout(arrivedTimer);
      setNavUiActive(true);
      const km = (evt.route.distanceM / 1000).toFixed(1);
      const min = Math.round(evt.route.durationS / 60);
      navEls.remaining.textContent = formatDistance(evt.route.distanceM);
      navEls.eta.textContent = formatEta(evt.route.durationS);
      navEls.arrival.textContent = formatClockTime(new Date(Date.now() + evt.route.durationS * 1000));
      setNavStatus('DALAM RUTE', 'ok');
      renderAlternatives();
      lastAlongM = 0;
      if (!evt.reroute) {
        voice.reset();
        // overview first (fitBounds in the engine), then settle into the follow camera
        setTimeout(() => { if (navEngine.isActive && !map.isFollowing()) map.toggleFollow(true); }, 2200);
        showToast(`${km} km · ${min} menit`);
      }
      break;
    }

    case 'routing-failed':
      if (evt.reroute) {
        showToast('Gagal menghitung ulang rute');
      } else {
        resetNavUi('Rute tidak ditemukan. Coba lagi.');
      }
      break;

    case 'maneuver':
      renderManeuver(evt);
      break;

    case 'progress': {
      lastAlongM = evt.alongM;
      navEls.remaining.textContent = formatDistance(evt.remainingM);
      navEls.eta.textContent = formatEta(evt.etaSec);
      navEls.arrival.textContent = formatClockTime(evt.arrival);
      if (evt.state === NAV_STATE.ARRIVED) break;
      if (evt.offRouteState === 'confirmed') { setNavStatus('MENGHITUNG ULANG...', 'bad'); navEls.banner.dataset.state = 'off'; }
      else if (evt.offRouteState === 'suspect') { setNavStatus('MENJAUH DARI RUTE', 'warn'); }
      else if (evt.state === NAV_STATE.APPROACHING_DESTINATION) { setNavStatus('HAMPIR TIBA', 'ok'); }
      else { setNavStatus('DALAM RUTE', 'ok'); if (navEls.banner.dataset.state === 'off') navEls.banner.dataset.state = 'on'; }
      break;
    }

    case 'announce':
      voice.say(voiceText(evt.maneuver, evt.stage, evt.distanceM), {
        key: `${navEngine.route?.uid ?? 0}:${evt.maneuver.id}:${evt.stage}`,
        urgent: evt.stage === 'now',
      });
      break;

    case 'rerouting':
      showToast('Keluar dari rute — menghitung ulang...');
      voice.say('Anda keluar dari rute. Menghitung ulang.', { key: `reroute:${Date.now()}`, urgent: true });
      break;

    case 'rerouted':
      showToast('Rute diperbarui');
      break;

    case 'approaching-destination':
      voice.say('Anda hampir tiba.', { key: `${navEngine.route?.uid ?? 0}:approach` });
      break;

    case 'arrived':
      voice.say('Anda telah tiba.', { key: `arrived:${Date.now()}`, urgent: true });
      showToast('Anda telah tiba di tujuan');
      navEls.banner.dataset.state = 'arrived';
      navEls.dist.textContent = 'Tiba';
      navEls.street.textContent = pendingDestination?.name || 'Tujuan Anda';
      setNavStatus('SAMPAI', 'ok');
      pendingDestination = null;
      arrivedTimer = setTimeout(() => { resetNavUi(); switchView('home', { onEnter: onViewEnter }); }, 6000);
      break;

    case 'cancelled':
      voice.cancel();
      pendingDestination = null;
      resetNavUi();
      break;

    default:
      break;
  }
});

navEls.endBtn.addEventListener('click', () => {
  navEngine.cancel();
  switchView('home', { onEnter: onViewEnter });
  showToast('Navigasi diakhiri');
});

/* ---------------- Bottom navigation ---------------- */
document.querySelectorAll('.bottomnav__item').forEach((btn) => {
  btn.addEventListener('click', () => {
    switchView(btn.dataset.view, { onEnter: onViewEnter });
  });
});

async function onViewEnter(view) {
  if (view === 'navigasi') {
    if (pendingDestination && userLat !== null) {
      await navEngine.startTo(pendingDestination.lat, pendingDestination.lon, pendingDestination.name, userLat, userLng);
    } else if (!navEngine.isActive) {
      navEls.street.textContent = pendingDestination ? 'Menunggu sinyal GPS...' : 'Cari tujuan untuk memulai navigasi';
    }
  } else if (view === 'riwayat') {
    renderHistoryView();
  }
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

async function renderHistoryView() {
  const state = trip.getState();
  document.getElementById('hist-odometer').textContent = fmtKm(state.odometerKm);
  document.getElementById('hist-tripa').textContent = fmtKm(state.tripAKm);
  document.getElementById('hist-tripb').textContent = fmtKm(state.tripBKm);
  document.getElementById('hist-today').textContent = fmtKm(state.todayKm);

  const session = trip.getSessionStats();
  document.getElementById('hist-avgspeed').textContent = `${session.avgSpeedKmh.toFixed(0)} km/h`;
  document.getElementById('hist-maxspeed').textContent = `${session.maxSpeedKmh.toFixed(0)} km/h`;
  document.getElementById('hist-duration').textContent = formatDuration(session.durationSec);
  document.getElementById('hist-moving').textContent = formatDuration(session.movingSec);
  document.getElementById('hist-stopped').textContent = formatDuration(session.stoppedSec);

  const list = document.getElementById('history-list');
  const entries = await storage.getHistory();
  if (!entries.length) {
    list.innerHTML = '<li class="history-list__empty">Belum ada riwayat perjalanan tersimpan.</li>';
  } else {
    list.innerHTML = entries.map((e) => {
      const date = new Date(e.ts);
      const dateStr = date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      return `<li><div><div class="h-dist">${e.label}</div><div class="h-date">${dateStr}, ${timeStr}</div></div><div class="h-dist">${e.distanceKm.toFixed(1)} km</div></li>`;
    }).join('');
  }

  const rideList = document.getElementById('ride-history-list');
  const rides = await trip.getRideHistory();
  if (!rides.length) {
    rideList.innerHTML = '<li class="history-list__empty">Belum ada sesi berkendara tersimpan.</li>';
  } else {
    rideList.innerHTML = rides.map((r) => {
      const date = new Date(r.ts);
      const dateStr = date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
      const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      return `<li><div><div class="h-dist">${r.distanceKm.toFixed(1)} km · avg ${r.avgSpeedKmh.toFixed(0)} km/h</div><div class="h-date">${dateStr}, ${timeStr}</div></div><div class="h-dist">${formatDuration(r.movingSec + r.stoppedSec)}</div></li>`;
    }).join('');
  }
}

/* ---------------- Settings ---------------- */
const settings = new SettingsManager({
  onUnitChange: (unit) => speedo.setUnit(unit),
  onResetOdometer: () => trip.resetOdometer(),
  onClearHistory: async () => { await storage.clearHistory(); renderHistoryView(); },
});

document.getElementById('btn-end-session').addEventListener('click', async () => {
  const stats = await trip.endSession();
  if (stats.distanceKm >= 0.05) showToast(`Sesi disimpan: ${stats.distanceKm.toFixed(1)} km`);
  else showToast('Sesi terlalu pendek untuk disimpan');
  renderHistoryView();
});

document.getElementById('btn-clear-ride-history').addEventListener('click', async () => {
  const ok = window.confirm('Hapus semua riwayat berkendara?');
  if (ok) {
    await trip.clearRideHistory();
    showToast('Riwayat berkendara dihapus');
    renderHistoryView();
  }
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
        if (!granted) showToast('Izin sensor kemiringan & kompas ditolak');
        // Listeners are passive: attaching them is harmless when denied and makes
        // browsers that expose requestPermission() but still stream events (newer Chrome) work.
        motion.start();
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

/* ---------------- Orientation / resize: keep the map canvas in sync ---------------- */
const resizeMap = debounce(() => map.map.resize(), 120);
window.addEventListener('resize', resizeMap);
window.addEventListener('orientationchange', () => { resizeMap(); setTimeout(() => map.map.resize(), 400); });

/* ---------------- Service worker ---------------- */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW register failed', e));
    });
  }
}

/* Diagnostics handle (read-only use): lets tests / the console inspect live engine state. */
window.__beat = { gps, motion, fusion, map, navEngine, voice, theme };

/* ---------------- Boot ---------------- */
(async function main() {
  startClock();
  initNetworkStatus();
  initBatteryStatus();
  registerServiceWorker();

  await runBootSequence({ durationMs: 2600 });

  startSensors();
  initMotionGate();

  // PWA shortcuts (manifest.json) open ./index.html?view=navigasi | riwayat
  const shortcutView = new URLSearchParams(location.search).get('view');
  if (['navigasi', 'riwayat', 'pengaturan', 'cari'].includes(shortcutView)) switchView(shortcutView, { onEnter: onViewEnter });

  const trafficSettings = storage.getTrafficSettings();
  if (trafficSettings.enabled && traffic.hasAnyProviderConfigured(trafficSettings.apiKeys)) {
    traffic.enable(trafficSettings.apiKeys);
  }
})();
