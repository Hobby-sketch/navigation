/**
 * trip.js
 * Accumulates distance travelled from consecutive GPS fixes (haversine),
 * maintaining: Odometer Total (never resets except via Pengaturan), Trip A,
 * Trip B (both resettable from the dashboard). Persists via storage.js so
 * totals survive app close/reopen, and logs a history entry each time a
 * trip counter is reset.
 */

import { haversineDistance } from './gps.js';
import { storage } from './storage.js';

const MIN_ACCURACY_M = 40;      // ignore fixes noisier than this
const MIN_MOVE_M = 1.2;         // ignore GPS jitter smaller than this
const MAX_JUMP_M = 300;         // ignore implausible teleport jumps (lost fix)

export class TripManager {
  constructor() {
    this.odometerKm = storage.getOdometer();
    this.tripAKm = storage.getTripA();
    this.tripBKm = storage.getTripB();
    this._lastPoint = null;
    this.listeners = new Set();
    this._saveTimer = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() {
    this.listeners.forEach((fn) => fn({
      odometerKm: this.odometerKm,
      tripAKm: this.tripAKm,
      tripBKm: this.tripBKm,
    }));
  }

  /** Feed a new GPS fix. */
  update(lat, lon, accuracy) {
    if (typeof accuracy === 'number' && accuracy > MIN_ACCURACY_M) {
      // Still track the point so we don't create one giant jump once accuracy improves.
      this._lastPoint = { lat, lon };
      return;
    }
    if (!this._lastPoint) {
      this._lastPoint = { lat, lon };
      return;
    }
    const distM = haversineDistance(this._lastPoint.lat, this._lastPoint.lon, lat, lon);
    this._lastPoint = { lat, lon };

    if (distM < MIN_MOVE_M || distM > MAX_JUMP_M) return;

    const distKm = distM / 1000;
    this.odometerKm += distKm;
    this.tripAKm += distKm;
    this.tripBKm += distKm;
    this._emit();
    this._scheduleSave();
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      storage.setOdometer(this.odometerKm);
      storage.setTripA(this.tripAKm);
      storage.setTripB(this.tripBKm);
      this._saveTimer = null;
    }, 3000);
  }

  _saveNow() {
    storage.setOdometer(this.odometerKm);
    storage.setTripA(this.tripAKm);
    storage.setTripB(this.tripBKm);
  }

  async resetTripA() {
    if (this.tripAKm > 0.01) {
      await storage.addHistoryEntry({ label: 'Trip A', distanceKm: this.tripAKm });
    }
    this.tripAKm = 0;
    this._saveNow();
    this._emit();
  }

  async resetTripB() {
    if (this.tripBKm > 0.01) {
      await storage.addHistoryEntry({ label: 'Trip B', distanceKm: this.tripBKm });
    }
    this.tripBKm = 0;
    this._saveNow();
    this._emit();
  }

  /** Only reachable via Pengaturan (settings) with explicit confirmation. */
  resetOdometer() {
    this.odometerKm = 0;
    this._saveNow();
    this._emit();
  }

  getState() {
    return { odometerKm: this.odometerKm, tripAKm: this.tripAKm, tripBKm: this.tripBKm };
  }
}
