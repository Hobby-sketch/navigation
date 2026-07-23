/**
 * weather.js — Weather Engine
 * Minimal weather panel data source, powered by Open-Meteo (free, no API
 * key, ToS-friendly for a static GitHub Pages app — unlike the Traffic
 * Engine's providers, this one needs zero setup from the user).
 * Location always follows the current GPS fix.
 *
 * Refresh is deliberately conservative (time-based AND distance-based) to
 * respect the "Optimasi" goals: a moving vehicle doesn't need a weather
 * re-fetch every few meters, and a stationary one doesn't need it every
 * few seconds.
 */

import { haversineDistance } from './gps.js';

const REFRESH_MS = 15 * 60 * 1000; // 15 minutes
const REFRESH_DISTANCE_M = 5000;   // or after moving 5km, whichever comes first

// WMO weather codes -> label + emoji (condensed to the ranges that matter for a ride dashboard)
const WMO_MAP = [
  { max: 0, label: 'Cerah', icon: '☀️' },
  { max: 1, label: 'Cerah Berawan', icon: '🌤️' },
  { max: 2, label: 'Berawan Sebagian', icon: '⛅' },
  { max: 3, label: 'Berawan', icon: '☁️' },
  { max: 48, label: 'Berkabut', icon: '🌫️' },
  { max: 57, label: 'Gerimis', icon: '🌦️' },
  { max: 67, label: 'Hujan', icon: '🌧️' },
  { max: 77, label: 'Salju', icon: '🌨️' },
  { max: 82, label: 'Hujan Lebat', icon: '🌧️' },
  { max: 86, label: 'Hujan Salju', icon: '🌨️' },
  { max: 99, label: 'Badai Petir', icon: '⛈️' },
];

function describeWmoCode(code) {
  const entry = WMO_MAP.find((e) => code <= e.max);
  return entry || { label: '--', icon: '🌡️' };
}

export class WeatherEngine {
  constructor() {
    this.listeners = new Set();
    this.lastFetchAt = 0;
    this.lastFetchPoint = null;
    this.current = null; // { tempC, windKmh, rainChance, label, icon }
    this._pending = false;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => fn(evt)); }

  /** Call this on every GPS fix — it self-throttles by time + distance. */
  maybeRefresh(lat, lon) {
    if (this._pending) return;
    const now = Date.now();
    const dueByTime = now - this.lastFetchAt > REFRESH_MS;
    const dueByDistance = this.lastFetchPoint
      ? haversineDistance(this.lastFetchPoint.lat, this.lastFetchPoint.lon, lat, lon) > REFRESH_DISTANCE_M
      : true;
    if (!dueByTime && !dueByDistance) return;
    this.refresh(lat, lon);
  }

  async refresh(lat, lon) {
    this._pending = true;
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&current_weather=true&hourly=precipitation_probability&timezone=auto`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
      const data = await res.json();

      const cw = data.current_weather;
      if (!cw) throw new Error('No current_weather in response');

      let rainChance = null;
      if (Array.isArray(data.hourly?.time) && Array.isArray(data.hourly?.precipitation_probability)) {
        const idx = this._nearestHourIndex(data.hourly.time, cw.time);
        if (idx >= 0) rainChance = data.hourly.precipitation_probability[idx];
      }

      const desc = describeWmoCode(cw.weathercode);
      this.current = {
        tempC: Math.round(cw.temperature),
        windKmh: Math.round(cw.windspeed),
        rainChance,
        label: desc.label,
        icon: desc.icon,
        fetchedAt: Date.now(),
      };
      this.lastFetchAt = Date.now();
      this.lastFetchPoint = { lat, lon };
      this._emit({ type: 'update', weather: this.current });
    } catch (e) {
      console.warn('Weather fetch failed', e);
      this._emit({ type: 'error', error: e });
    } finally {
      this._pending = false;
    }
  }

  _nearestHourIndex(times, targetIso) {
    if (!targetIso) return times.length ? 0 : -1;
    const target = new Date(targetIso).getTime();
    let bestIdx = -1, bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(new Date(times[i]).getTime() - target);
      if (diff < bestDiff) { bestDiff = diff; bestIdx = i; }
    }
    return bestIdx;
  }
}
