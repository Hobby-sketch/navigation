/**
 * orientation.js — pure sensor math (no DOM events, no state beyond the
 * filter classes). Pipeline used by motion.js:
 *
 *   raw sensor (device frame)
 *     -> screen correction  (screen.orientation.angle -> screen right/up/out axes)
 *     -> mount correction   (phone orientation relative to the motorcycle)
 *     -> motorcycle frame   (vehicle roll / pitch / heading)
 *
 * Conventions
 *  - Earth frame ENU: x = East, y = North, z = Up.
 *  - Device frame (W3C DeviceOrientation): x = right edge, y = top edge,
 *    z = out of the screen (toward the viewer).
 *  - Screen frame: same axes but rotated by the screen angle so that
 *    "up" is what the rider sees as the top of the screen.
 *    screen.orientation.angle is the CCW rotation of the device from its
 *    natural orientation (90 = landscape-primary).
 *  - Motorcycle frame: the phone is mounted with the screen facing the rider
 *    (default mount), so forward = -screenOut, up = screenUp, right = screenRight.
 *    Mount calibration replaces that default by measuring the real gravity
 *    direction in the screen frame while the bike stands upright.
 *  - Roll  > 0  = leaning RIGHT.   Pitch > 0 = nose UP.
 */

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const G = 9.80665;

export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const scale = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export function normalize(a) {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const normDeg = (a) => ((a % 360) + 360) % 360;

/* ---------------------------- screen orientation --------------------------- */

/** Snap any reported angle to 0 / 90 / 180 / 270. */
export function snapScreenAngle(angle) {
  const a = Number.isFinite(angle) ? angle : 0;
  return ((Math.round(a / 90) * 90) % 360 + 360) % 360;
}

/** Current screen angle: Screen Orientation API first, window.orientation as fallback. */
export function readScreenAngle() {
  try {
    if (typeof screen !== 'undefined' && screen.orientation && typeof screen.orientation.angle === 'number') {
      return snapScreenAngle(screen.orientation.angle);
    }
    if (typeof window !== 'undefined' && typeof window.orientation === 'number') {
      return snapScreenAngle(window.orientation);
    }
  } catch (e) { /* sandboxed / unsupported */ }
  return 0;
}

/** Rotation matrix (device -> earth) from W3C alpha/beta/gamma in degrees. */
export function rotationMatrix(alphaDeg, betaDeg, gammaDeg) {
  const a = alphaDeg * D2R, b = betaDeg * D2R, g = gammaDeg * D2R;
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  return [
    [cA * cG - sA * sB * sG, -cB * sA, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG, sB, cB * cG],
  ];
}

/** Earth "up" expressed in device coordinates = third row of R. */
export function gravityUpFromMatrix(R) { return [R[2][0], R[2][1], R[2][2]]; }

/**
 * Screen axes (right / up / out) expressed in EARTH coordinates.
 * Screen-up in device coords is (sinθ, cosθ, 0), screen-right is (cosθ, -sinθ, 0).
 */
export function screenAxesInEarth(R, thetaDeg) {
  const th = thetaDeg * D2R;
  const s = Math.sin(th), c = Math.cos(th);
  const col1 = [R[0][0], R[1][0], R[2][0]]; // device x in earth
  const col2 = [R[0][1], R[1][1], R[2][1]]; // device y in earth
  const col3 = [R[0][2], R[1][2], R[2][2]]; // device z in earth
  return {
    right: add(scale(col1, c), scale(col2, -s)),
    up: add(scale(col1, s), scale(col2, c)),
    out: col3,
  };
}

/** Gravity-up vector from device frame -> screen frame. */
export function deviceToScreen(vec, thetaDeg) {
  const th = thetaDeg * D2R;
  const s = Math.sin(th), c = Math.cos(th);
  return [vec[0] * c - vec[1] * s, vec[0] * s + vec[1] * c, vec[2]];
}

/* ------------------------------ mount / vehicle ----------------------------- */

export const DEFAULT_MOUNT_UP = [0, 1, 0];

/**
 * Vehicle axes expressed in SCREEN coordinates for a given mount.
 * mountUp = direction of earth-up in the screen frame while the bike was upright.
 */
export function vehicleFrame(mountUp = DEFAULT_MOUNT_UP) {
  const up = normalize(mountUp);
  let right = sub([1, 0, 0], scale(up, up[0]));
  if (len(right) < 0.2) right = sub([0, 1, 0], scale(up, up[1]));
  right = normalize(right);
  const fwd = normalize(cross(up, right));
  return { up, right, fwd };
}

/** Roll/pitch (degrees) of the vehicle from the gravity-up vector in the screen frame. */
export function rollPitch(gravityScreen, frame) {
  const g = normalize(gravityScreen);
  const gu = dot(g, frame.up);
  const gr = dot(g, frame.right);
  const gf = dot(g, frame.fwd);
  return {
    roll: -Math.atan2(gr, gu) * R2D,
    pitch: Math.atan2(gf, Math.hypot(gr, gu)) * R2D,
  };
}

/**
 * Vehicle heading (degrees clockwise from north) from the screen axes in earth
 * coordinates. The horizontal projection of the vehicle's forward axis is used;
 * when that axis is nearly vertical (phone lying flat) the projection of the
 * vehicle's up axis (= screen top) takes over, blended smoothly.
 * @returns {{heading:number, quality:number}} quality in 0..1
 */
export function vehicleHeading(axes, frame, calibrated) {
  const toEarth = (v) => add(add(scale(axes.right, v[0]), scale(axes.up, v[1])), scale(axes.out, v[2]));
  const fwdE = toEarth(frame.fwd);
  let hx = fwdE[0], hy = fwdE[1];
  const mF = Math.hypot(hx, hy);
  // Only borrow the "screen up" direction when forward is nearly vertical
  // (phone lying flat). For an upright phone the weight is 0, so leaning the
  // bike into a corner never bends the heading.
  const wUp = calibrated ? (mF < 0.25 ? 1 : 0) : Math.min(1, Math.max(0, (0.6 - mF) / 0.6));
  if (wUp > 0) {
    const upE = toEarth(frame.up);
    hx += wUp * upE[0];
    hy += wUp * upE[1];
  }
  const mag = Math.hypot(hx, hy);
  return { heading: normDeg(Math.atan2(hx, hy) * R2D), quality: clamp(mag, 0, 1) };
}

/* ----------------------- complementary gravity filter ----------------------- */

/**
 * Lightweight sensor fusion of accelerometer + gyroscope (+ the OS fused
 * orientation as a weak absolute reference), tracking the earth-up vector in
 * the DEVICE frame:
 *   predict : g' = g - (w x g) dt          (gyro, short-term accurate)
 *   correct : g  = normalize((1-k) g + k a_hat)   (accelerometer, long-term)
 * The accelerometer is trusted less when |a| deviates from 1 g (braking,
 * cornering, bumps), which is exactly when it would corrupt the lean angle.
 */
export class GravityFilter {
  constructor() {
    this.g = null;
    this.lastGyroT = null;
    this.hasGyro = false;
    this.accelSign = 1;
    this._signVotes = 0;
    this._signLocked = false;
    this.accelTrust = 0;
    this.lastAccelMag = G;
    this._mismatch = 0;
  }

  reset() {
    this.g = null;
    this.lastGyroT = null;
  }

  get value() { return this.g ? [...this.g] : null; }

  /** omega in rad/s, device frame [x, y, z]; tSec monotonic seconds. */
  gyroPredict(omega, tSec) {
    if (!this.g) return;
    if (this.lastGyroT === null) { this.lastGyroT = tSec; return; }
    const dt = clamp(tSec - this.lastGyroT, 0, 0.05);
    this.lastGyroT = tSec;
    if (dt <= 0) return;
    const wxg = cross(omega, this.g);
    this.g = normalize(sub(this.g, scale(wxg, dt)));
    this.hasGyro = true;
  }

  /** Accelerometer including gravity, m/s^2, device frame. */
  accelCorrect(a, orientationUp = null) {
    const mag = len(a);
    if (mag < 1) return;
    this.lastAccelMag = mag;

    // Some platforms report this vector with the opposite sign; learn it once
    // by comparing with the OS orientation's gravity direction.
    if (orientationUp && !this._signLocked) {
      this._signVotes += dot(normalize(a), orientationUp) > 0 ? 1 : -1;
      if (Math.abs(this._signVotes) >= 12) {
        this.accelSign = this._signVotes > 0 ? 1 : -1;
        this._signLocked = true;
      }
    }
    if (!this._signLocked && orientationUp) return; // wait until the sign is known

    const aHat = scale(normalize(a), this.accelSign);
    const dev = mag - G;
    this.accelTrust = Math.exp(-((dev / 2.5) ** 2));
    if (!this.g) { this.g = aHat; return; }
    const base = this.hasGyro ? 0.02 : 0.15;
    const k = base * this.accelTrust;
    this.g = normalize(add(scale(this.g, 1 - k), scale(aHat, k)));
  }

  /**
   * Correction from the OS-fused orientation (unit earth-up in device frame).
   * Normally a weak pull. Large disagreements are the case a plain linear
   * blend handles worst (two nearly opposite unit vectors average to ~0), so:
   *   > 8°  : stronger pull;   > 25° for a few samples in a row : hard re-sync.
   */
  orientationCorrect(up) {
    if (!this.g) { this.g = [...up]; return; }
    const d = clamp(dot(this.g, up), -1, 1);
    if (d < Math.cos(25 * D2R)) {
      // Big disagreement: hold the (gyro-tracked) state and wait for a few consecutive
      // confirmations before jumping — pulling partially would shrink the error below the
      // threshold and the re-sync would never trigger.
      this._mismatch += 1;
      if (this._mismatch >= 3) { this.g = [...up]; this._mismatch = 0; }
      return;
    }
    this._mismatch = 0;
    const trust = this.accelTrust || 0.5;
    let k = (this.hasGyro ? 0.03 : 0.2) * Math.max(0.15, trust);
    if (d < Math.cos(8 * D2R)) k = Math.max(k, 0.25);
    else if (d < Math.cos(2.5 * D2R)) k = Math.max(k, 0.1);
    this.g = normalize(add(scale(this.g, 1 - k), scale(up, k)));
  }

  /** 0..1 sensor confidence for the lean estimate. */
  confidence(orientationAgeMs = 0) {
    if (!this.g) return 0;
    let c = 0.35;
    if (this.hasGyro) c += 0.25;
    c += 0.3 * this.accelTrust;
    if (orientationAgeMs < 500) c += 0.1;
    return clamp(c, 0, 1);
  }
}

/* ------------------------------- lean filter ------------------------------- */

/**
 * Adaptive low-pass (heavy smoothing for jitter, fast for real lean changes),
 * a deadband around 0° and hysteresis for the KIRI / KANAN decision:
 *   enter RIGHT > +4°, stay until < +2°;  enter LEFT < -4°, stay until > -2°.
 */
export class LeanFilter {
  constructor({ lowAlpha = 0.1, highAlpha = 0.55, fastDeg = 7, deadband = 1.0, enter = 4, exit = 2 } = {}) {
    Object.assign(this, { lowAlpha, highAlpha, fastDeg, deadband, enter, exit });
    this.roll = 0; this.pitch = 0;
    this.rollDir = 'level'; this.pitchDir = 'level';
    this._init = false;
    this._rollZero = true; this._pitchZero = true;
  }

  _alpha(err, dtSec) {
    const k = clamp((Math.abs(err) - 1) / (this.fastDeg - 1), 0, 1);
    const a = this.lowAlpha + (this.highAlpha - this.lowAlpha) * k;
    return 1 - Math.pow(1 - a, clamp(dtSec, 0.005, 0.2) * 60);
  }

  _dir(prev, v, pos, neg) {
    if (prev === pos) return v < this.exit ? (v < -this.enter ? neg : 'level') : pos;
    if (prev === neg) return v > -this.exit ? (v > this.enter ? pos : 'level') : neg;
    if (v > this.enter) return pos;
    if (v < -this.enter) return neg;
    return 'level';
  }

  _dead(v, wasZero) {
    const thr = wasZero ? this.deadband + 0.5 : this.deadband;
    return Math.abs(v) < thr ? [0, true] : [v, false];
  }

  push(rollRaw, pitchRaw, dtSec = 1 / 60) {
    if (!this._init) {
      this.roll = rollRaw; this.pitch = pitchRaw; this._init = true;
    } else {
      this.roll += this._alpha(rollRaw - this.roll, dtSec) * (rollRaw - this.roll);
      this.pitch += this._alpha(pitchRaw - this.pitch, dtSec) * (pitchRaw - this.pitch);
    }
    this.rollDir = this._dir(this.rollDir, this.roll, 'right', 'left');
    this.pitchDir = this._dir(this.pitchDir, this.pitch, 'up', 'down');
    let r, p;
    [r, this._rollZero] = this._dead(this.roll, this._rollZero);
    [p, this._pitchZero] = this._dead(this.pitch, this._pitchZero);
    return { roll: r, pitch: p, rollDir: this.rollDir, pitchDir: this.pitchDir, rollSmooth: this.roll, pitchSmooth: this.pitch };
  }
}

export const SENSOR_CONSTANTS = { G };
