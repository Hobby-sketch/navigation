/**
 * trip.js — Ride Engine
 * Accumulates distance travelled from consecutive GPS fixes (haversine),
 * maintaining: Odometer Total (never resets except via Pengaturan), Trip A,
 * Trip B (both resettable from the dashboard), and — the Ride Engine layer —
 * live session analytics (avg/max speed, moving/stopped time, duration),
 * daily trip totals, and a persisted ride-history log.
 *
 * Backward compatible: `update(lat, lon, accuracy)` still works exactly as
 * before; `speedKmh`/`isMoving` are optional extra parameters that unlock
 * the session analytics without breaking existing callers.
 */

import { haversineDistance } from './gps.js';
import { storage } from './storage.js';

const MIN_ACCURACY_M = 40;      // ignore fixes noisier than this
const MIN_MOVE_M = 1.2;         // ignore GPS jitter smaller than this
const MAX_JUMP_M = 300;         // ignore implausible teleport jumps (lost fix)
const MIN_SESSION_KM_TO_LOG = 0.05; // don't log a "ride" for GPS noise

export class TripManager {
  constructor() {
    this.odometerKm = storage.getOdometer();
    this.tripAKm = storage.getTripA();
    this.tripBKm = storage.getTripB();
    this._lastPoint = null;
    this.listeners = new Set();
    this._saveTimer = null;

    this.session = this._freshSession();
    this._bindAutoEndSession();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() {
    this.listeners.forEach((fn) => fn({
      odometerKm: this.odometerKm,
      tripAKm: this.tripAKm,
      tripBKm: this.tripBKm,
      todayKm: storage.getTodayTripKm(),
    }));
  }

  /** Feed a new GPS fix. `speedKmh`/`isMoving` are optional (Ride Engine session stats). */
  update(lat, lon, accuracy, speedKmh, isMoving) {
    this._tickSession(speedKmh, isMoving);

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
    this.session.distanceKm += distKm;
    storage.addDailyDistance(distKm);
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
    return {
      odometerKm: this.odometerKm,
      tripAKm: this.tripAKm,
      tripBKm: this.tripBKm,
      todayKm: storage.getTodayTripKm(),
    };
  }

  /* ============================================================
   * Ride Engine — live session analytics
   * ============================================================ */
  _freshSession() {
    const now = Date.now();
    return {
      startedAt: now,
      distanceKm: 0,
      maxSpeedKmh: 0,
      speedSampleSum: 0,
      speedSampleCount: 0,
      movingMs: 0,
      stoppedMs: 0,
      _lastTickAt: now,
    };
  }

  _tickSession(speedKmh, isMoving) {
    const now = Date.now();
    const dtMs = Math.min(5000, Math.max(0, now - this.session._lastTickAt)); // cap to avoid huge gaps (tab backgrounded) skewing totals
    this.session._lastTickAt = now;

    if (typeof isMoving === 'boolean') {
      if (isMoving) this.session.movingMs += dtMs;
      else this.session.stoppedMs += dtMs;
    }
    if (typeof speedKmh === 'number' && !Number.isNaN(speedKmh)) {
      this.session.maxSpeedKmh = Math.max(this.session.maxSpeedKmh, speedKmh);
      this.session.speedSampleSum += speedKmh;
      this.session.speedSampleCount += 1;
    }
  }

  /** Snapshot of the current (in-progress) ride session. */
  getSessionStats() {
    const s = this.session;
    return {
      startedAt: s.startedAt,
      durationSec: (Date.now() - s.startedAt) / 1000,
      movingSec: s.movingMs / 1000,
      stoppedSec: s.stoppedMs / 1000,
      distanceKm: s.distanceKm,
      maxSpeedKmh: s.maxSpeedKmh,
      avgSpeedKmh: s.speedSampleCount ? s.speedSampleSum / s.speedSampleCount : 0,
    };
  }

  /** Persist the current session to Ride History (if it's substantial) and
   *  start a fresh one. Called automatically when the app is closed/hidden
   *  for a while, or can be triggered manually (e.g. a future "Selesai
   *  Berkendara" button). */
  async endSession() {
    const stats = this.getSessionStats();
    if (stats.distanceKm >= MIN_SESSION_KM_TO_LOG) {
      await storage.addRideSession({
        startedAt: stats.startedAt,
        endedAt: Date.now(),
        distanceKm: stats.distanceKm,
        avgSpeedKmh: stats.avgSpeedKmh,
        maxSpeedKmh: stats.maxSpeedKmh,
        movingSec: stats.movingSec,
        stoppedSec: stats.stoppedSec,
      });
    }
    this.session = this._freshSession();
    return stats;
  }

  async getRideHistory(limit = 30) {
    return storage.getRideSessions(limit);
  }

  async clearRideHistory() {
    return storage.clearRideSessions();
  }

  /** A ride that goes quiet for a while (app backgrounded/closed) should be
   *  filed to history rather than silently lost or artificially continued
   *  across an unrelated future ride. */
  _bindAutoEndSession() {
    const maybeEnd = () => {
      if (document.visibilityState === 'hidden') this.endSession();
    };
    document.addEventListener('visibilitychange', maybeEnd);
    window.addEventListener('pagehide', maybeEnd);
  }
}
