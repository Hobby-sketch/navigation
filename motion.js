/**
 * motion.js — Motion Engine (compass + lean angle)
 *
 * Pipeline:  raw sensor -> screen correction -> mount correction ->
 *            motorcycle frame -> filtered vehicle roll / pitch / heading
 *
 *  - Screen correction uses screen.orientation.angle (fallback
 *    window.orientation) as a real coordinate transform of the sensor axes
 *    (see orientation.js), never a hard-coded +90/-90. Portrait, landscape
 *    left/right and live rotation therefore give the same heading, roll and
 *    pitch for the same physical motorcycle pose.
 *  - Heading: ONE orientation stream is consumed at a time, by priority
 *      1. iOS webkitCompassHeading (anchoring our own tilt/screen-aware geometry)
 *      2. deviceorientationabsolute / absolute deviceorientation
 *      3. relative deviceorientation (only a relative yaw: it is reported with
 *         source 'relative' and is ignored by heading.js until GPS validated it)
 *      4. nothing valid -> no compass sample is emitted (last heading is kept
 *         by the fusion layer with decaying confidence)
 *  - Lean: complementary filter on accelerometer + gyroscope (+ OS orientation
 *    as a weak absolute reference), then low-pass, deadband and hysteresis.
 *  - Mount calibration stores the phone's mounting relative to the bike.
 *
 * Emits: {type:'compass'}, {type:'heading'} (legacy, smoothed raw compass),
 *        {type:'lean'}, {type:'calibration'}.
 */

import { CircularSmoother } from './gps.js';
import { storage } from './storage.js';
import {
  GravityFilter, LeanFilter, rotationMatrix, gravityUpFromMatrix, screenAxesInEarth,
  deviceToScreen, vehicleFrame, rollPitch, vehicleHeading, readScreenAngle,
  normalize, dot, add, DEFAULT_MOUNT_UP, normDeg,
} from './orientation.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EMIT_INTERVAL_MS = 50;       // ~20 Hz UI updates
const ORIENTATION_ALIVE_MS = 1500; // a better stream counts as alive for this long
const SCREEN_SETTLE_MS = 500;      // distrust the compass briefly after a rotation
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class MotionManager {
  constructor() {
    this.listeners = new Set();
    this.orientationSupported = 'DeviceOrientationEvent' in window;
    this.motionSupported = 'DeviceMotionEvent' in window;
    this.absoluteSupported = 'ondeviceorientationabsolute' in window;
    this.needsPermission =
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';

    this.screenAngle = readScreenAngle();
    this._screenChangedAt = 0;

    this.gf = new GravityFilter();
    this.leanFilter = new LeanFilter();
    this.mountUp = [...DEFAULT_MOUNT_UP];
    this.frame = vehicleFrame(this.mountUp);
    this.calibrated = false;
    this.calibration = null;
    this._calSamples = null;

    this._R = null;
    this._lastOrientUp = null;
    this._orientT = 0;
    this._lastAbsT = -1e9;
    this._lastIosT = -1e9;
    this._lastMotionT = -1e9;
    this._iosOffset = null; // circular offset between webkitCompassHeading and our own geometry
    this._headingSmoother = new CircularSmoother(0.2);
    this._lastLeanEmit = 0;
    this._lastCompassEmit = 0;
    this._lastLeanT = null;
    this._omega = null;
    this._heading = null;
    this._diag = { raw: {}, normalized: {}, fused: {}, confidence: 0, source: 'none' };

    this._onOrientation = this._onOrientation.bind(this);
    this._onMotion = this._onMotion.bind(this);
    this._onScreenChange = this._onScreenChange.bind(this);

    this._loadCalibration();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(data) { this.listeners.forEach((fn) => fn(data)); }

  /** Must be called from a user-gesture (e.g. a "Start" button tap) on iOS. */
  async requestPermission() {
    if (!this.needsPermission) return true;
    try {
      const [oResult, mResult] = await Promise.all([
        DeviceOrientationEvent.requestPermission?.() ?? Promise.resolve('granted'),
        DeviceMotionEvent.requestPermission?.() ?? Promise.resolve('granted'),
      ]);
      return oResult === 'granted' && mResult === 'granted';
    } catch (e) {
      return false;
    }
  }

  start() {
    if (this.orientationSupported) {
      window.addEventListener('deviceorientationabsolute', this._onOrientation, true);
      window.addEventListener('deviceorientation', this._onOrientation, true);
    }
    if (this.motionSupported) window.addEventListener('devicemotion', this._onMotion, true);
    try { screen.orientation?.addEventListener('change', this._onScreenChange); } catch (e) { /* unsupported */ }
    window.addEventListener('orientationchange', this._onScreenChange);
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._onOrientation, true);
    window.removeEventListener('deviceorientation', this._onOrientation, true);
    window.removeEventListener('devicemotion', this._onMotion, true);
    try { screen.orientation?.removeEventListener('change', this._onScreenChange); } catch (e) { /* unsupported */ }
    window.removeEventListener('orientationchange', this._onScreenChange);
  }

  /* ---------------------------- screen rotation ---------------------------- */

  _onScreenChange() { this._refreshScreenAngle(); }

  _refreshScreenAngle() {
    const a = readScreenAngle();
    if (a !== this.screenAngle) {
      this.screenAngle = a;
      this._screenChangedAt = nowMs();
    }
    return a;
  }

  _settleFactor(t) { return t - this._screenChangedAt < SCREEN_SETTLE_MS ? 0.4 : 1; }

  /* ------------------------------- orientation ------------------------------ */

  _onOrientation(evt) {
    const t = nowMs();
    const { alpha, beta, gamma } = evt;
    if (![alpha, beta, gamma].every(Number.isFinite)) return;

    // --- source arbitration: never run two orientation streams in parallel ---
    const iosOk = typeof evt.webkitCompassHeading === 'number' && Number.isFinite(evt.webkitCompassHeading) &&
      !(typeof evt.webkitCompassAccuracy === 'number' && evt.webkitCompassAccuracy < 0);
    const isAbs = evt.type === 'deviceorientationabsolute' || evt.absolute === true;
    let source;
    if (iosOk) { source = 'ios-compass'; this._lastIosT = t; }
    else if (isAbs) { source = 'absolute'; this._lastAbsT = t; }
    else {
      if (t - this._lastAbsT < ORIENTATION_ALIVE_MS || t - this._lastIosT < ORIENTATION_ALIVE_MS) return;
      source = 'relative';
    }

    const theta = this._refreshScreenAngle();
    const R = rotationMatrix(alpha, beta, gamma);
    this._R = R;
    this._orientT = t;
    const up = gravityUpFromMatrix(R);
    this._lastOrientUp = up;
    this.gf.orientationCorrect(up);

    // --- heading in the motorcycle frame ---
    const axes = screenAxesInEarth(R, theta);
    const vh = vehicleHeading(axes, this.frame, this.calibrated);
    let heading = vh.heading;
    let confidence;

    if (source === 'ios-compass') {
      // webkitCompassHeading is the only absolute reference on iOS. Our own
      // geometry supplies the screen/tilt-correct heading; the constant offset
      // between the two is learned while the phone is upright (where Safari's
      // heading is the direction the back of the phone faces == our forward).
      const uprightish = Math.abs(axes.out[2]) < 0.5;
      if (vh.quality > 0.6 && (theta === 0 || uprightish)) {
        const sample = normDeg(evt.webkitCompassHeading - vh.heading);
        if (this._iosOffset === null) this._iosOffset = sample;
        else {
          const d = ((sample - this._iosOffset + 540) % 360) - 180;
          this._iosOffset = normDeg(this._iosOffset + 0.1 * d);
        }
      }
      heading = this._iosOffset === null ? evt.webkitCompassHeading : normDeg(vh.heading + this._iosOffset);
      const acc = typeof evt.webkitCompassAccuracy === 'number' ? evt.webkitCompassAccuracy : 15;
      confidence = Math.max(0.3, 1 - acc / 45) * Math.min(1, vh.quality / 0.7);
    } else if (source === 'absolute') {
      confidence = 0.85 * Math.min(1, vh.quality / 0.7);
    } else {
      confidence = 0.6 * Math.min(1, vh.quality / 0.7);
    }
    confidence *= this._settleFactor(t);

    this._diag.raw.orientation = { alpha, beta, gamma, absolute: source !== 'relative' };
    this._diag.source = source;

    if (t - this._lastCompassEmit >= EMIT_INTERVAL_MS) {
      this._lastCompassEmit = t;
      this._heading = this._headingSmoother.push(heading);
      this.emit({ type: 'compass', heading, confidence, source, screenAngle: theta });
      this.emit({ type: 'heading', heading: this._heading });
    }

    // Orientation-only devices (no devicemotion) still get a lean estimate.
    if (t - this._lastMotionT > 500) this._emitLean(t);
  }

  /* ---------------------------------- lean ---------------------------------- */

  _onMotion(evt) {
    const t = nowMs();
    this._lastMotionT = t;

    const rr = evt.rotationRate;
    if (rr && [rr.alpha, rr.beta, rr.gamma].every(Number.isFinite)) {
      // W3C: beta = rate about x, gamma = about y, alpha = about z (deg/s).
      const omega = [rr.beta * D2R, rr.gamma * D2R, rr.alpha * D2R];
      this._omega = omega;
      this._diag.raw.gyro = [rr.beta, rr.gamma, rr.alpha];
      this.gf.gyroPredict(omega, t / 1000);
    }
    const a = evt.accelerationIncludingGravity;
    if (a && [a.x, a.y, a.z].every(Number.isFinite)) {
      this._diag.raw.accel = [a.x, a.y, a.z];
      this.gf.accelCorrect([a.x, a.y, a.z], this._lastOrientUp);
    }
    this._emitLean(t);
  }

  _emitLean(t) {
    const gDev = this.gf.value;
    if (!gDev) return;
    const theta = this._refreshScreenAngle();
    const gs = deviceToScreen(gDev, theta);

    if (this._calSamples) {
      const gyroMag = this._omega ? Math.hypot(...this._omega) * R2D : 0;
      this._calSamples.push({ gs, gyroMag });
    }

    if (t - this._lastLeanEmit < EMIT_INTERVAL_MS) return;
    const dt = this._lastLeanT === null ? 1 / 20 : (t - this._lastLeanT) / 1000;
    this._lastLeanT = t;
    this._lastLeanEmit = t;

    const rp = rollPitch(gs, this.frame);
    const f = this.leanFilter.push(rp.roll, rp.pitch, dt);
    const confidence = this.gf.confidence(t - this._orientT) * this._settleFactor(t);

    this._diag.normalized = { gravityScreen: gs, screenAngle: theta, rollRaw: rp.roll, pitchRaw: rp.pitch };
    this._diag.fused = { roll: f.roll, pitch: f.pitch, rollSmooth: f.rollSmooth, pitchSmooth: f.pitchSmooth };
    this._diag.confidence = confidence;

    this.emit({
      type: 'lean',
      roll: f.roll,
      pitch: f.pitch,
      rollDir: f.rollDir,
      pitchDir: f.pitchDir,
      rollRaw: rp.roll,
      pitchRaw: rp.pitch,
      confidence,
      calibrated: this.calibrated,
      screenAngle: theta,
    });
  }

  /* ------------------------------- calibration ------------------------------ */

  _loadCalibration() {
    try {
      const cal = storage.getSettings().mountCalibration;
      if (cal && Array.isArray(cal.up) && cal.up.length === 3 && cal.up.every(Number.isFinite)) {
        this.mountUp = normalize(cal.up);
        this.frame = vehicleFrame(this.mountUp);
        this.calibrated = true;
        this.calibration = cal;
      }
    } catch (e) { /* storage unavailable */ }
  }

  isCalibrated() { return this.calibrated; }
  getCalibration() { return this.calibration; }

  /**
   * Take the CURRENT pose (bike upright and still) as the baseline:
   * the measured gravity direction in the screen frame defines the bike's
   * vertical, which fixes roll and pitch offsets for any mounting angle.
   */
  async calibrate({ durationMs = 1200, yawOffsetDeg = 0 } = {}) {
    if (this._calSamples) return { ok: false, reason: 'busy' };
    if (!this.gf.value) return { ok: false, reason: 'no-sensor' };

    this._calSamples = [];
    await new Promise((resolve) => setTimeout(resolve, durationMs));
    const samples = this._calSamples || [];
    this._calSamples = null;
    if (samples.length < 8) return { ok: false, reason: 'no-data' };

    let mean = [0, 0, 0];
    samples.forEach((s) => { mean = add(mean, s.gs); });
    mean = normalize(mean);
    const maxDevDeg = Math.max(...samples.map((s) => Math.acos(Math.min(1, dot(s.gs, mean))) * R2D));
    const gyroRms = Math.sqrt(samples.reduce((acc, s) => acc + s.gyroMag * s.gyroMag, 0) / samples.length);
    if (maxDevDeg > 3 || gyroRms > 20) return { ok: false, reason: 'moving' };

    const before = rollPitch(mean, vehicleFrame(DEFAULT_MOUNT_UP));
    this.mountUp = mean;
    this.frame = vehicleFrame(mean);
    this.calibrated = true;
    this.leanFilter = new LeanFilter();
    this._lastLeanT = null;
    this.calibration = {
      up: mean,
      rollOffsetDeg: before.roll,
      pitchOffsetDeg: before.pitch,
      yawOffsetDeg,
      ts: Date.now(),
    };
    storage.updateSetting('mountCalibration', this.calibration);
    this.emit({ type: 'calibration', calibrated: true, calibration: this.calibration });
    return { ok: true, calibration: this.calibration };
  }

  resetCalibration() {
    this.mountUp = [...DEFAULT_MOUNT_UP];
    this.frame = vehicleFrame(this.mountUp);
    this.calibrated = false;
    this.calibration = null;
    this.leanFilter = new LeanFilter();
    this._lastLeanT = null;
    storage.updateSetting('mountCalibration', null);
    this.emit({ type: 'calibration', calibrated: false, calibration: null });
  }

  /** Raw sensor / normalized sensor / fused orientation / confidence snapshot. */
  getDiagnostics() { return JSON.parse(JSON.stringify(this._diag)); }

  static headingToCompass(heading) {
    if (heading === null || heading === undefined) return '--';
    const dirs = ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'];
    const idx = Math.round(heading / 45) % 8;
    return dirs[idx];
  }
}
