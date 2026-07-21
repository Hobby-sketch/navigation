/**
 * gps.js — Smart GPS Engine
 * Wraps the Geolocation API (watchPosition) and turns raw, jittery fixes into
 * a stable, premium-feeling stream of position/speed/heading data:
 *
 *   raw fix -> validation -> outlier rejection -> Kalman filter (position)
 *            -> EMA (speed) -> circular EMA (heading) -> movement detection
 *            -> drift compensation (stationary lock) -> adaptive-rate emit
 *            -> rAF prediction/dead-reckoning loop (smooth marker between fixes)
 *
 * Emitted events keep the original field names used by trip.js / app.js
 * (status, latitude, longitude, altitude, accuracy, heading, speedKmh,
 * satelliteEstimate) so existing consumers keep working unmodified, plus new
 * additive fields: kind, quality, isMoving.
 *
 * NOTE ON SATELLITES: the browser Geolocation API does not expose GNSS
 * satellite count (OS/hardware level data, outside the W3C spec). The value
 * shown is an ESTIMATE derived from reported accuracy.
 */

const EARTH_RADIUS_M = 6371000;

const REJECT_ACCURACY_M = 150;    // fixes noisier than this are dropped entirely
const LOST_TIMEOUT_MS = 7000;     // no fix for this long while active/weak -> "lost"
const MAX_PLAUSIBLE_KMH = 220;    // discard fixes implying an impossible speed jump
const STATIONARY_SPEED_KMH = 1.5; // below this we consider the vehicle stopped
const STATIONARY_HOLD_MS = 4000;  // how long stopped before drift-lock engages
const PREDICT_MAX_SEC = 2.5;      // cap on dead-reckoning extrapolation
const PREDICT_EMIT_MS = 50;       // ~20fps emit rate for the prediction loop (perf)
const STATIONARY_EMIT_MS = 2000;  // throttle "fix" emits while parked

function toRad(deg) { return (deg * Math.PI) / 180; }
function toDeg(rad) { return (rad * 180) / Math.PI; }

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c; // meters
}

export function accuracyToQuality(accuracy) {
  if (typeof accuracy !== 'number' || Number.isNaN(accuracy)) return null;
  if (accuracy <= 5) return 'excellent';
  if (accuracy <= 10) return 'good';
  if (accuracy <= 20) return 'fair';
  return 'poor';
}

function isValidCoordinate(lat, lon) {
  return (
    typeof lat === 'number' && typeof lon === 'number' &&
    !Number.isNaN(lat) && !Number.isNaN(lon) &&
    Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0) // (0,0) almost always means "no fix" glitch
  );
}

/** Minimal circular-mean exponential smoother for angles that wrap at 360°. */
export class CircularSmoother {
  constructor(alpha) {
    this.alpha = alpha;
    this._sin = null;
    this._cos = null;
  }
  push(angleDeg) {
    const rad = toRad(angleDeg);
    const s = Math.sin(rad), c = Math.cos(rad);
    if (this._sin === null) {
      this._sin = s; this._cos = c;
    } else {
      this._sin += this.alpha * (s - this._sin);
      this._cos += this.alpha * (c - this._cos);
    }
    return (toDeg(Math.atan2(this._sin, this._cos)) + 360) % 360;
  }
  get value() {
    if (this._sin === null) return null;
    return (toDeg(Math.atan2(this._sin, this._cos)) + 360) % 360;
  }
}

/**
 * Simplified 1D Kalman filter for GPS lat/lng (the well-known approach used
 * in most mobile GPS-smoothing implementations): position variance grows
 * over time (process noise Q, modelled as a plausible drift speed in m/s),
 * and each measurement pulls the estimate toward it proportional to how much
 * more confident the measurement is than the current estimate.
 */
class GeoKalmanFilter {
  constructor(processNoiseMs = 3) {
    this.processNoiseMs = processNoiseMs; // assumed max "unmodeled" drift speed
    this.lat = null;
    this.lng = null;
    this.variance = -1;
    this.lastTimeMs = null;
  }
  reset(lat, lng, accuracy, timeMs) {
    this.lat = lat; this.lng = lng;
    this.variance = accuracy * accuracy;
    this.lastTimeMs = timeMs;
  }
  update(lat, lng, accuracy, timeMs) {
    const measVariance = Math.max(accuracy, 1) ** 2;
    if (this.variance < 0) {
      this.reset(lat, lng, accuracy, timeMs);
      return { lat, lng, variance: this.variance };
    }
    const dtSec = Math.max(0, (timeMs - this.lastTimeMs) / 1000);
    if (dtSec > 0) {
      this.variance += dtSec * this.processNoiseMs * this.processNoiseMs;
    }
    const k = this.variance / (this.variance + measVariance);
    this.lat += k * (lat - this.lat);
    this.lng += k * (lng - this.lng);
    this.variance *= (1 - k);
    this.lastTimeMs = timeMs;
    return { lat: this.lat, lng: this.lng, variance: this.variance };
  }
}

export class GPSManager {
  constructor() {
    this.watchId = null;
    this.listeners = new Set();
    this.supported = 'geolocation' in navigator;
    this.status = 'searching'; // searching | active | weak | lost | denied | unsupported
    this.quality = null;
    this.isMoving = false;

    this._kalman = new GeoKalmanFilter(3);
    this._speedSmoothed = 0;
    this._headingSmoother = new CircularSmoother(0.25);
    this._lastRawPoint = null;      // {lat, lon, timestamp} — for fallback speed/bearing
    this._lastAccuracy = null;
    this._lastAltitude = null;
    this._lastEmittedFixAt = 0;
    this._lostTimer = null;
    this._moveSince = null;
    this._stillSince = null;
    this._stationaryAnchor = null;

    this._predictRafId = null;
    this._lastPredictEmit = 0;
    this._lastConfirmed = null; // {lat, lon, timestampMs, speedKmh, heading, accuracy}
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(data) { this.listeners.forEach((fn) => fn(data)); }

  start() {
    if (!this.supported) {
      this.status = 'unsupported';
      this.emit({ kind: 'status', status: this.status });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._handlePosition(pos),
      (err) => this._handleError(err),
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
    );
    this.emit({ kind: 'status', status: this.status });
    this._startPredictionLoop();
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
    this._stopPredictionLoop();
    clearTimeout(this._lostTimer);
  }

  _handleError(err) {
    this.status = err.code === err.PERMISSION_DENIED ? 'denied' : 'searching';
    this.emit({ kind: 'status', status: this.status, error: err.message });
  }

  _armLostWatchdog() {
    clearTimeout(this._lostTimer);
    this._lostTimer = setTimeout(() => {
      if (this.status === 'active' || this.status === 'weak') {
        this.status = 'lost';
        this.emit({ kind: 'status', status: 'lost' });
      }
    }, LOST_TIMEOUT_MS);
  }

  _handlePosition(pos) {
    const { latitude, longitude, altitude, accuracy, heading, speed } = pos.coords;
    const now = pos.timestamp || Date.now();

    // --- Coordinate validation & noise filtering ---------------------------
    if (!isValidCoordinate(latitude, longitude)) return;
    if (typeof accuracy === 'number' && accuracy > REJECT_ACCURACY_M) return;

    if (this._lastRawPoint) {
      const distM = haversineDistance(this._lastRawPoint.lat, this._lastRawPoint.lon, latitude, longitude);
      const dtS = Math.max(0.1, (now - this._lastRawPoint.timestamp) / 1000);
      const impliedKmh = (distM / dtS) * 3.6;
      if (impliedKmh > MAX_PLAUSIBLE_KMH) return; // outlier: GPS glitch / teleport
    }

    // --- Kalman filter (position) ------------------------------------------
    const filtered = this._kalman.update(latitude, longitude, accuracy || 15, now);

    // --- Speed: browser-reported when available, else derived, then EMA'd --
    let rawSpeedKmh = null;
    if (typeof speed === 'number' && !Number.isNaN(speed) && speed >= 0) {
      rawSpeedKmh = speed * 3.6;
    } else if (this._lastRawPoint) {
      const distM = haversineDistance(this._lastRawPoint.lat, this._lastRawPoint.lon, latitude, longitude);
      const dtS = (now - this._lastRawPoint.timestamp) / 1000;
      if (dtS > 0.2) rawSpeedKmh = (distM / dtS) * 3.6;
    }
    if (rawSpeedKmh === null) rawSpeedKmh = this._speedSmoothed;

    // Adaptive smoothing: trust cleaner fixes more, noisy fixes less.
    const acc = typeof accuracy === 'number' ? accuracy : 20;
    const speedAlpha = Math.min(0.5, Math.max(0.15, 0.55 - acc / 100));
    this._speedSmoothed += speedAlpha * (rawSpeedKmh - this._speedSmoothed);
    if (this._speedSmoothed < 0.4) this._speedSmoothed = 0;

    // --- Movement detection (hysteresis to avoid state flicker) -----------
    if (this._speedSmoothed > STATIONARY_SPEED_KMH) {
      this._moveSince = this._moveSince || now;
      this._stillSince = null;
      if (now - this._moveSince > 500) this.isMoving = true;
    } else {
      this._stillSince = this._stillSince || now;
      this._moveSince = null;
      if (now - this._stillSince > 800) this.isMoving = false;
    }

    // --- Heading: GPS-reported/derived bearing, circularly smoothed --------
    let bearing = typeof heading === 'number' && !Number.isNaN(heading) ? heading : null;
    if (bearing === null && this._lastRawPoint && this.isMoving) {
      bearing = this._bearing(this._lastRawPoint.lat, this._lastRawPoint.lon, latitude, longitude);
    }
    const smoothedHeading = bearing !== null ? this._headingSmoother.push(bearing) : this._headingSmoother.value;

    // --- Drift compensation: lock the dot when truly stationary -----------
    let outLat = filtered.lat, outLng = filtered.lng;
    if (!this.isMoving) {
      if (!this._stationaryAnchor) {
        this._stationaryAnchor = { lat: filtered.lat, lng: filtered.lng, since: now };
      } else if (now - this._stationaryAnchor.since > STATIONARY_HOLD_MS) {
        const lockAlpha = 0.04; // very slow crawl, kills residual jitter
        this._stationaryAnchor.lat += lockAlpha * (filtered.lat - this._stationaryAnchor.lat);
        this._stationaryAnchor.lng += lockAlpha * (filtered.lng - this._stationaryAnchor.lng);
        outLat = this._stationaryAnchor.lat;
        outLng = this._stationaryAnchor.lng;
      }
    } else {
      this._stationaryAnchor = null;
    }

    this._lastRawPoint = { lat: latitude, lon: longitude, timestamp: now };
    this._lastAccuracy = accuracy ?? null;
    this._lastAltitude = typeof altitude === 'number' ? altitude : null;
    this.quality = accuracyToQuality(accuracy);
    this.status = this.quality === 'poor' ? 'weak' : 'active';
    this._armLostWatchdog();

    this._lastConfirmed = {
      lat: outLat, lon: outLng, timestampMs: now,
      speedKmh: this._speedSmoothed, heading: smoothedHeading, accuracy,
    };

    // --- Adaptive update rate: throttle emits while parked to save CPU ----
    const minInterval = this.isMoving ? 0 : STATIONARY_EMIT_MS;
    if (now - this._lastEmittedFixAt < minInterval) return;
    this._lastEmittedFixAt = now;

    this.emit({
      kind: 'fix',
      status: this.status,
      latitude: outLat,
      longitude: outLng,
      altitude: this._lastAltitude,
      accuracy: this._lastAccuracy,
      heading: smoothedHeading,
      speedKmh: this._speedSmoothed,
      satelliteEstimate: this._estimateSatellites(accuracy),
      quality: this.quality,
      isMoving: this.isMoving,
      timestamp: now,
    });
  }

  /** rAF loop: interpolates/dead-reckons position between real fixes so the
   *  map marker glides smoothly instead of snapping once per GPS update. */
  _startPredictionLoop() {
    const tick = (ts) => {
      this._predictRafId = requestAnimationFrame(tick);
      if (!this._lastConfirmed || this.status === 'lost' || this.status === 'searching') return;
      if (ts - this._lastPredictEmit < PREDICT_EMIT_MS) return;
      this._lastPredictEmit = ts;

      const now = Date.now();
      const dtSec = Math.min(PREDICT_MAX_SEC, Math.max(0, (now - this._lastConfirmed.timestampMs) / 1000));

      let lat = this._lastConfirmed.lat, lon = this._lastConfirmed.lon;
      if (this.isMoving && typeof this._lastConfirmed.heading === 'number' && dtSec > 0.05) {
        const distM = (this._lastConfirmed.speedKmh / 3.6) * dtSec;
        const headingRad = toRad(this._lastConfirmed.heading);
        const dLat = (distM * Math.cos(headingRad)) / EARTH_RADIUS_M;
        const dLon = (distM * Math.sin(headingRad)) / (EARTH_RADIUS_M * Math.cos(toRad(lat)));
        lat += toDeg(dLat);
        lon += toDeg(dLon);
      }

      this.emit({
        kind: 'predicted',
        status: this.status,
        latitude: lat,
        longitude: lon,
        heading: this._lastConfirmed.heading,
        speedKmh: this._lastConfirmed.speedKmh,
        accuracy: this._lastConfirmed.accuracy,
        quality: this.quality,
        isMoving: this.isMoving,
        timestamp: now,
      });
    };
    this._predictRafId = requestAnimationFrame(tick);
  }

  _stopPredictionLoop() {
    if (this._predictRafId) cancelAnimationFrame(this._predictRafId);
    this._predictRafId = null;
  }

  _bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Rough heuristic mapping GPS accuracy (meters) to an "estimated" satellite
  // count purely for dashboard flavor — not a real GNSS reading.
  _estimateSatellites(accuracy) {
    if (typeof accuracy !== 'number') return null;
    if (accuracy <= 5) return 12;
    if (accuracy <= 10) return 10;
    if (accuracy <= 20) return 8;
    if (accuracy <= 35) return 6;
    if (accuracy <= 60) return 4;
    return 3;
  }
}
