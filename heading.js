/**
 * heading.js — Heading Fusion
 * Single source of truth for the motorcycle's direction: `vehicleHeading`.
 *
 *   GPS bearing  ┐
 *   Compass      ├─ weighted by speed + confidence ─> circular smoothing ─> vehicleHeading
 *   Speed        ┘
 *
 * Rules
 *  - Moving with a valid GPS bearing  -> GPS bearing dominates.
 *  - Stopped / slow                   -> compass dominates (GPS bearing is noise).
 *  - GPS bearing invalid              -> compass only.
 *  - Low total confidence             -> heading is HELD (never driven by junk)
 *                                        and its confidence decays with time.
 *  - The compass is corrected by a bias that is LEARNED from the GPS bearing
 *    while riding fast, per screen orientation. This absorbs magnetic
 *    declination, local magnetic interference and any platform quirk in how a
 *    given browser reports landscape, and it is what makes an un-anchored
 *    (non-absolute) orientation stream usable: it is only trusted once it has
 *    been validated against GPS.
 *
 * Consumers: map arrow, compass UI, map bearing (Heading Up), dead reckoning,
 * route matching and turn-by-turn orientation all read this one value.
 */

import { normDeg, angleDiff, toRad, toDeg, clamp } from './geo.js';

const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const GPS_MIN_SPEED_KMH = 4;     // below this a GPS bearing is meaningless
const GPS_FULL_SPEED_KMH = 14;   // at/above this GPS bearing is fully trusted
const GPS_STALE_MS = 2500;
const GPS_DEAD_MS = 6000;
const COMPASS_STALE_MS = 1500;
const COMPASS_DEAD_MS = 4000;
const MIN_USABLE_WEIGHT = 0.12;
const VALID_CONFIDENCE = 0.15;
const LEARN_MIN_SPEED_KMH = 15;
const ANCHORED_MIN_SAMPLES = 3;

export class HeadingFusion {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.gps = null;      // { heading|null, speedKmh, accuracy, t }
    this.compass = null;  // { heading, confidence, source, angleKey, t }
    this.bias = {};       // angleKey -> { angle, n }
    this.heading = null;
    this.confidence = 0;
    this.source = 'none';
    this.gpsWeight = 0;
    this.compassWeight = 0;
    this._lastUpdate = null;
    this._lastLearnGpsT = null;
    this._lastEmitted = null;
    this._timer = null;
    this.listeners = new Set();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(state) { this.listeners.forEach((fn) => fn(state)); }

  start(intervalMs = 66) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      const s = this.update();
      const moved = this._lastEmitted === null || s.heading === null
        ? true
        : Math.abs(angleDiff(this._lastEmitted.heading ?? 0, s.heading)) >= 0.3
          || Math.abs(s.confidence - this._lastEmitted.confidence) > 0.05
          || s.source !== this._lastEmitted.source;
      if (moved) { this._lastEmitted = s; this._emit(s); }
    }, intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /* ------------------------------ inputs ------------------------------ */

  /** headingDeg may be null (browser gives no bearing while stationary). */
  setGps({ headingDeg, speedKmh, accuracyM, timestampMs }) {
    this.gps = {
      heading: Number.isFinite(headingDeg) ? normDeg(headingDeg) : null,
      speedKmh: Number.isFinite(speedKmh) ? speedKmh : 0,
      accuracy: Number.isFinite(accuracyM) ? accuracyM : 25,
      t: timestampMs ?? this.now(),
    };
  }

  setCompass({ headingDeg, confidence, source, screenAngle = 0, timestampMs }) {
    if (!Number.isFinite(headingDeg)) return;
    this.compass = {
      heading: normDeg(headingDeg),
      confidence: clamp(confidence ?? 0.5, 0, 1),
      source: source || 'absolute',
      angleKey: String(screenAngle),
      t: timestampMs ?? this.now(),
    };
  }

  /* --------------------------- bias handling --------------------------- */

  getBias(angleKey) { return this.bias[String(angleKey)] || { angle: 0, n: 0 }; }

  setBias(angleKey, angle, n = ANCHORED_MIN_SAMPLES) {
    this.bias[String(angleKey)] = { angle: normDeg(angle), n };
  }

  _learnBias(gps, compass, gpsConf, t) {
    if (gps.heading === null || gps.t === this._lastLearnGpsT) return;
    if (gps.speedKmh < LEARN_MIN_SPEED_KMH || gpsConf < 0.8) return;
    if (t - compass.t > COMPASS_STALE_MS || compass.confidence < 0.5) return;
    this._lastLearnGpsT = gps.t;

    const d = angleDiff(compass.heading, gps.heading); // what must be added to the compass
    const b = this.getBias(compass.angleKey);
    if (b.n === 0) {
      this.bias[compass.angleKey] = { angle: normDeg(d), n: 1 };
      return;
    }
    const err = angleDiff(b.angle, d);
    // Ignore turning transients once a bias exists; otherwise average slowly.
    if (b.n >= 5 && Math.abs(err) > 45) return;
    const alpha = Math.max(0.04, 1 / (b.n + 1));
    this.bias[compass.angleKey] = { angle: normDeg(b.angle + alpha * err), n: b.n + 1 };
  }

  /* ------------------------------ fusion ------------------------------ */

  _gpsConfidence(t) {
    const g = this.gps;
    if (!g || g.heading === null) return 0;
    const speedF = smoothstep(GPS_MIN_SPEED_KMH, GPS_FULL_SPEED_KMH, g.speedKmh);
    const accF = g.accuracy <= 10 ? 1 : g.accuracy >= 60 ? 0.25 : 1 - ((g.accuracy - 10) / 50) * 0.75;
    const age = t - g.t;
    const ageF = age < GPS_STALE_MS ? 1 : age > GPS_DEAD_MS ? 0 : 1 - (age - GPS_STALE_MS) / (GPS_DEAD_MS - GPS_STALE_MS);
    return speedF * accF * ageF;
  }

  _compassConfidence(t) {
    const c = this.compass;
    if (!c) return 0;
    const age = t - c.t;
    const ageF = age < COMPASS_STALE_MS ? 1 : age > COMPASS_DEAD_MS ? 0 : 1 - (age - COMPASS_STALE_MS) / (COMPASS_DEAD_MS - COMPASS_STALE_MS);
    let conf = c.confidence * ageF;
    // A relative (non-absolute) orientation has no north reference of its own:
    // it only counts once GPS has validated it for this screen orientation.
    if (c.source === 'relative' && this.getBias(c.angleKey).n < ANCHORED_MIN_SAMPLES) conf = 0;
    return conf;
  }

  /** Recompute vehicleHeading. Safe to call at any rate. */
  update(t = this.now()) {
    const dt = this._lastUpdate === null ? 0.066 : clamp((t - this._lastUpdate) / 1000, 0.001, 0.5);
    this._lastUpdate = t;

    const gpsConf = this._gpsConfidence(t);
    const compassConf = this._compassConfidence(t);
    if (this.gps && this.compass) this._learnBias(this.gps, this.compass, gpsConf, t);

    const speed = this.gps && t - this.gps.t < GPS_DEAD_MS ? this.gps.speedKmh : 0;
    const s = smoothstep(GPS_MIN_SPEED_KMH + 1, GPS_FULL_SPEED_KMH + 1, speed);
    const wg = gpsConf * (0.2 + 0.8 * s);
    const wc = compassConf * (1 - 0.8 * s);
    this.gpsWeight = wg;
    this.compassWeight = wc;

    const total = wg + wc;
    if (total < MIN_USABLE_WEIGHT) {
      // Not enough trustworthy data: hold the last heading, fade confidence.
      this.confidence *= Math.exp(-dt / 6);
      this.source = this.heading === null ? 'none' : 'hold';
      return this.snapshot();
    }

    let vx = 0, vy = 0;
    let compassCorrected = null;
    if (wg > 0) {
      vx += wg * Math.sin(toRad(this.gps.heading));
      vy += wg * Math.cos(toRad(this.gps.heading));
    }
    if (wc > 0) {
      compassCorrected = normDeg(this.compass.heading + this.getBias(this.compass.angleKey).angle);
      vx += wc * Math.sin(toRad(compassCorrected));
      vy += wc * Math.cos(toRad(compassCorrected));
    }
    const target = normDeg(toDeg(Math.atan2(vx, vy)));

    let conf = clamp(total, 0, 1);
    if (wg > 0.15 && wc > 0.1 && Math.abs(angleDiff(this.gps.heading, compassCorrected)) > 60) conf *= 0.6;

    if (this.heading === null) {
      this.heading = target;
    } else {
      // Fast on large errors (no lag in turns), slow on small ones (no jitter).
      const err = Math.abs(angleDiff(this.heading, target));
      const tau = 0.45 + (0.08 - 0.45) * clamp(err / 50, 0, 1);
      const alpha = 1 - Math.exp(-dt / tau);
      this.heading = normDeg(this.heading + alpha * angleDiff(this.heading, target));
    }
    // Confidence rises quickly, falls gradually.
    this.confidence = conf > this.confidence ? this.confidence + (conf - this.confidence) * 0.5 : this.confidence + (conf - this.confidence) * 0.15;
    this.source = wg > wc ? (wc > 0.05 ? 'gps+compass' : 'gps') : (wg > 0.05 ? 'compass+gps' : 'compass');
    return this.snapshot();
  }

  snapshot() {
    return {
      heading: this.heading,
      confidence: this.confidence,
      valid: this.heading !== null && this.confidence >= VALID_CONFIDENCE,
      source: this.source,
      gpsWeight: this.gpsWeight,
      compassWeight: this.compassWeight,
    };
  }
}
