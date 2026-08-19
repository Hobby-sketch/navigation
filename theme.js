/**
 * theme.js — Theme Engine
 * Premium day/night ("Siang"/"Malam") theme switching.
 *
 * - Manual: user picks Malam or Siang directly (segmented control in
 *   Pengaturan, or the quick-toggle chip in the status bar).
 * - Otomatis: theme is derived from the *real* sunrise/sunset time at the
 *   rider's current GPS position (NOAA simplified solar calculation, no
 *   network call needed — consistent with this app's zero-backend design).
 *   Until a GPS fix arrives it falls back to a simple 06:00–18:00 heuristic,
 *   then refines itself automatically once coordinates are available.
 *
 * This module only touches things it owns: the `data-theme` attribute on
 * <html>, the `#status-theme` chip, and the `#setting-theme` segmented
 * control. It reads GPS coordinates only through the explicit `setLatLng()`
 * call app.js already forwards from the GPS Engine — it does not import or
 * depend on gps.js directly, keeping the "one engine, one file" contract
 * intact.
 */

import { storage } from './storage.js';
import { showToast } from './ui.js';

const MODES = ['night', 'day', 'auto'];
const MODE_LABEL = { night: 'Malam', day: 'Siang', auto: 'Otomatis' };
const TRANSITION_MS = 480;
const RECHECK_INTERVAL_MS = 60 * 1000;
const META_THEME_COLOR = { night: '#0a0a0a', day: '#eef0f2' };

function isDaytimeFallback(date = new Date()) {
  const h = date.getHours();
  return h >= 6 && h < 18;
}

/**
 * Approximate sunrise/sunset for a given lat/lon/date using the standard
 * simplified NOAA solar position formula. Returns { sunrise, sunset } as
 * local Date objects, or null for edge cases (e.g. polar day/night) where
 * the caller should fall back to the hour heuristic.
 */
function computeSunTimes(lat, lon, date = new Date()) {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getFullYear(), 0, 0);
  const now = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const dayOfYear = Math.round((now - start) / 86400000);
  const zenith = 90.833; // official sunrise/sunset zenith (accounts for refraction + solar radius)
  const lngHour = lon / 15;

  function calcUtcHours(isSunrise) {
    const t = dayOfYear + ((isSunrise ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;

    let RA = Math.atan(0.91764 * Math.tan(L * rad)) / rad;
    RA = ((RA % 360) + 360) % 360;
    const Lquadrant = Math.floor(L / 90) * 90;
    const RAquadrant = Math.floor(RA / 90) * 90;
    RA = (RA + (Lquadrant - RAquadrant)) / 15;

    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null; // sun never rises/sets at this lat/date

    let H = isSunrise ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad;
    H /= 15;

    const T = H + RA - 0.06571 * t - 6.622;
    return ((T - lngHour) % 24 + 24) % 24; // UTC hours
  }

  const sunriseUtc = calcUtcHours(true);
  const sunsetUtc = calcUtcHours(false);
  if (sunriseUtc === null || sunsetUtc === null) return null;

  const toLocalDate = (utcHours) => {
    const h = Math.floor(utcHours);
    const m = Math.floor((utcHours - h) * 60);
    return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), h, m));
  };

  return { sunrise: toLocalDate(sunriseUtc), sunset: toLocalDate(sunsetUtc) };
}

export class ThemeManager {
  constructor() {
    const saved = storage.getSettings();
    this.mode = MODES.includes(saved.themeMode) ? saved.themeMode : 'auto'; // premium default: follows real sunrise/sunset
    this.lat = null;
    this.lon = null;
    this.active = 'night';
    this._transitionTimer = null;

    this._bindSegmented();
    this._bindQuickToggle();
    this._apply(this.mode === 'auto' ? this._computeAutoTheme() : this.mode, { silent: true, force: true });

    // Re-check every minute so Otomatis flips right around sunrise/sunset
    // without requiring a page reload.
    setInterval(() => { if (this.mode === 'auto') this._apply(this._computeAutoTheme()); }, RECHECK_INTERVAL_MS);
  }

  /** Called by app.js with each real GPS fix so Otomatis can use the rider's
   *  actual sunrise/sunset instead of the generic hour fallback. */
  setLatLng(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || Number.isNaN(lat) || Number.isNaN(lon)) return;
    const moved = this.lat === null || Math.abs(lat - this.lat) > 0.01 || Math.abs(lon - this.lon) > 0.01;
    this.lat = lat;
    this.lon = lon;
    if (this.mode === 'auto' && moved) this._apply(this._computeAutoTheme());
  }

  _computeAutoTheme() {
    if (this.lat !== null && this.lon !== null) {
      const times = computeSunTimes(this.lat, this.lon);
      if (times) {
        const now = new Date();
        return now >= times.sunrise && now < times.sunset ? 'day' : 'night';
      }
    }
    return isDaytimeFallback() ? 'day' : 'night';
  }

  _apply(theme, { silent = false, force = false } = {}) {
    if (theme === this.active && !force) {
      this._syncUI();
      return;
    }
    this.active = theme;

    const root = document.documentElement;
    root.classList.add('theme-transitioning');
    if (theme === 'day') root.dataset.theme = 'day';
    else delete root.dataset.theme; // "night" is the default, attribute-less look

    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', META_THEME_COLOR[theme]);

    clearTimeout(this._transitionTimer);
    this._transitionTimer = setTimeout(() => root.classList.remove('theme-transitioning'), TRANSITION_MS);

    this._syncUI();
    if (!silent) {
      const suffix = this.mode === 'auto' ? ' (Otomatis)' : '';
      showToast(`Mode Tampilan: ${theme === 'day' ? 'Siang' : 'Malam'}${suffix}`);
    }
  }

  _syncUI() {
    const chip = document.getElementById('status-theme');
    if (chip) {
      chip.dataset.active = this.active;
      chip.dataset.auto = this.mode === 'auto' ? 'true' : 'false';
      chip.title = `Mode Tampilan: ${MODE_LABEL[this.mode]}`;
    }
    const group = document.getElementById('setting-theme');
    if (group) {
      group.querySelectorAll('.segmented__btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.themeMode === this.mode);
      });
    }
  }

  _setMode(mode) {
    if (!MODES.includes(mode)) return;
    this.mode = mode;
    storage.updateSetting('themeMode', mode);
    this._apply(mode === 'auto' ? this._computeAutoTheme() : mode);
  }

  _bindSegmented() {
    const group = document.getElementById('setting-theme');
    if (!group) return;
    group.querySelectorAll('.segmented__btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeMode === this.mode);
      btn.addEventListener('click', () => this._setMode(btn.dataset.themeMode));
    });
  }

  _bindQuickToggle() {
    const chip = document.getElementById('status-theme');
    if (!chip) return;
    chip.addEventListener('click', () => {
      const next = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
      this._setMode(next);
    });
  }
}
