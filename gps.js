/**
 * gps.js
 * Wraps the Geolocation API (watchPosition) and exposes a clean, smoothed
 * stream of speed / heading / altitude / accuracy / satellite-count data.
 *
 * NOTE ON SATELLITES: the standard browser Geolocation API does NOT expose
 * satellite count (that data lives inside the OS GNSS chip and is not part
 * of the W3C spec). We estimate a "signal quality" indicator from reported
 * accuracy instead, and label it honestly as an estimate.
 */

const EARTH_RADIUS_M = 6371000;

function toRad(deg) { return (deg * Math.PI) / 180; }

export function haversineDistance(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c; // meters
}

export class GPSManager {
  constructor() {
    this.watchId = null;
    this.lastFix = null;
    this.smoothedSpeedKmh = 0;
    this.listeners = new Set();
    this.supported = 'geolocation' in navigator;
    this.status = 'searching'; // searching | active | denied | unsupported
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(data) { this.listeners.forEach((fn) => fn(data)); }

  start() {
    if (!this.supported) {
      this.status = 'unsupported';
      this.emit({ status: this.status });
      return;
    }
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._handlePosition(pos),
      (err) => this._handleError(err),
      { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 }
    );
  }

  stop() {
    if (this.watchId !== null) {
      navigator.geolocation.clearWatch(this.watchId);
      this.watchId = null;
    }
  }

  _handleError(err) {
    this.status = err.code === err.PERMISSION_DENIED ? 'denied' : 'searching';
    this.emit({ status: this.status, error: err.message });
  }

  _handlePosition(pos) {
    const { latitude, longitude, altitude, accuracy, heading, speed } = pos.coords;
    const now = pos.timestamp || Date.now();

    let speedKmh = null;
    if (typeof speed === 'number' && !Number.isNaN(speed) && speed >= 0) {
      // Browser-reported speed (m/s) — most accurate when available.
      speedKmh = speed * 3.6;
    } else if (this.lastFix) {
      // Fallback: derive speed from distance / time between fixes.
      const distM = haversineDistance(
        this.lastFix.latitude, this.lastFix.longitude, latitude, longitude
      );
      const dtS = (now - this.lastFix.timestamp) / 1000;
      if (dtS > 0.2) {
        speedKmh = (distM / dtS) * 3.6;
      }
    }

    if (speedKmh === null) speedKmh = this.smoothedSpeedKmh;
    // Low-pass smoothing so the needle doesn't jitter with every GPS fix.
    const alpha = 0.35;
    this.smoothedSpeedKmh = this.smoothedSpeedKmh + alpha * (speedKmh - this.smoothedSpeedKmh);
    if (this.smoothedSpeedKmh < 0.4) this.smoothedSpeedKmh = 0;

    let derivedHeading = heading;
    if ((derivedHeading === null || Number.isNaN(derivedHeading)) && this.lastFix && this.smoothedSpeedKmh > 3) {
      derivedHeading = this._bearing(this.lastFix.latitude, this.lastFix.longitude, latitude, longitude);
    }

    this.status = 'active';
    this.lastFix = { latitude, longitude, timestamp: now };

    this.emit({
      status: 'active',
      latitude,
      longitude,
      altitude: typeof altitude === 'number' ? altitude : null,
      accuracy: typeof accuracy === 'number' ? accuracy : null,
      heading: typeof derivedHeading === 'number' && !Number.isNaN(derivedHeading) ? derivedHeading : null,
      speedKmh: this.smoothedSpeedKmh,
      satelliteEstimate: this._estimateSatellites(accuracy),
      timestamp: now,
    });
  }

  _bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x =
      Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    return (toRad(Math.atan2(y, x) * 180 / Math.PI) * 180 / Math.PI + 360) % 360;
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
