/**
 * ui.js
 * Small DOM-glue helpers shared across the app: clock tick, status bar chips
 * (battery / network / brightness), bottom-nav view switching, and toasts.
 */

export function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    el.textContent = `${hh}:${mm}`;
  };
  tick();
  setInterval(tick, 1000 * 10);
}

export function setGpsChip(state) {
  const chip = document.getElementById('status-gps');
  chip.dataset.state = state; // searching | active | denied | unsupported
}

export function setBtChip(state) {
  const chip = document.getElementById('status-bt');
  chip.dataset.state = state === 'on' ? 'on' : 'off';
}

export async function initNetworkStatus() {
  const chip = document.getElementById('status-wifi');
  const update = () => {
    const online = navigator.onLine;
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const isWifi = conn ? conn.type === 'wifi' : online;
    chip.dataset.state = online ? (isWifi ? 'on' : 'active') : 'off';
  };
  update();
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  const conn = navigator.connection;
  if (conn && conn.addEventListener) conn.addEventListener('change', update);
}

export async function initBatteryStatus() {
  const valueEl = document.getElementById('battery-value');
  if (!('getBattery' in navigator)) {
    valueEl.textContent = 'N/A';
    return;
  }
  try {
    const battery = await navigator.getBattery();
    const render = () => {
      valueEl.textContent = `${Math.round(battery.level * 100)}%${battery.charging ? '⚡' : ''}`;
    };
    render();
    battery.addEventListener('levelchange', render);
    battery.addEventListener('chargingchange', render);
  } catch (e) {
    valueEl.textContent = 'N/A';
  }
}

/**
 * Browsers cannot read or set the physical screen brightness.
 * "AUTO" reflects ambient ok status; the slider in Pengaturan instead dims
 * the whole UI via a semi-transparent black overlay as a practical stand-in.
 */
export function applyBrightnessOverlay(percent) {
  let overlay = document.getElementById('brightness-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'brightness-overlay';
    document.body.appendChild(overlay);
  }
  const dim = Math.max(0, (100 - percent) / 100) * 0.75;
  overlay.style.opacity = String(dim);
  const valueEl = document.getElementById('brightness-value');
  valueEl.textContent = percent >= 100 ? 'AUTO' : `${percent}%`;
}

/* ---------------- View switching ---------------- */
const VIEW_IDS = ['home', 'riwayat', 'pengaturan'];

export function switchView(viewName, { onEnter } = {}) {
  document.querySelectorAll('.bottomnav__item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  if (viewName === 'cari') {
    showView('home');
    document.getElementById('map-search-input')?.focus();
    return;
  }
  if (viewName === 'navigasi') {
    showView('home');
    document.querySelector('.panel--map')?.classList.add('nav-mode');
    if (onEnter) onEnter('navigasi');
    return;
  }
  document.querySelector('.panel--map')?.classList.remove('nav-mode');
  showView(viewName);
  if (onEnter) onEnter(viewName);
}

function showView(viewName) {
  const homeEl = document.getElementById('view-home');
  const riwayatEl = document.getElementById('view-riwayat');
  const pengaturanEl = document.getElementById('view-pengaturan');
  homeEl.style.display = viewName === 'home' ? 'flex' : 'none';
  riwayatEl.hidden = viewName !== 'riwayat';
  pengaturanEl.hidden = viewName !== 'pengaturan';
}

/* ---------------- Toast ---------------- */
let toastTimer = null;
export function showToast(message, duration = 2200) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), duration);
}

/* ---------------- Formatting helpers ---------------- */
export function fmtKm(km) {
  return `${km.toFixed(1)} km`;
}

export function fmtHeading(heading) {
  if (heading === null || heading === undefined) return '-- --°';
  return `${Math.round(heading)}°`;
}

export function compassLabel(heading) {
  if (heading === null || heading === undefined) return '';
  const dirs = ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'];
  return dirs[Math.round(heading / 45) % 8];
}
