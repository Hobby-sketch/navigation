/**
 * motion.js
 * - Compass heading via DeviceOrientationEvent (absolute alpha, with iOS webkitCompassHeading fallback).
 * - Lean angle (roll = kiri/kanan, pitch = depan/belakang) derived from DeviceMotion's
 *   gravity vector (accelerationIncludingGravity), low-pass filtered for smoothness.
 * Handles the iOS 13+ permission-gate (DeviceMotionEvent.requestPermission()).
 */

export class MotionManager {
  constructor() {
    this.listeners = new Set();
    this.orientationSupported = 'DeviceOrientationEvent' in window;
    this.motionSupported = 'DeviceMotionEvent' in window;
    this.needsPermission =
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function';

    this._roll = 0;
    this._pitch = 0;
    this._heading = null;
    this._boundOrientation = this._handleOrientation.bind(this);
    this._boundMotion = this._handleMotion.bind(this);
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
      window.addEventListener('deviceorientationabsolute', this._boundOrientation, true);
      window.addEventListener('deviceorientation', this._boundOrientation, true);
    }
    if (this.motionSupported) {
      window.addEventListener('devicemotion', this._boundMotion, true);
    }
  }

  stop() {
    window.removeEventListener('deviceorientationabsolute', this._boundOrientation, true);
    window.removeEventListener('deviceorientation', this._boundOrientation, true);
    window.removeEventListener('devicemotion', this._boundMotion, true);
  }

  _handleOrientation(evt) {
    let heading = null;
    if (typeof evt.webkitCompassHeading === 'number') {
      // iOS Safari: already relative to true/magnetic north, no inversion needed.
      heading = evt.webkitCompassHeading;
    } else if (evt.absolute && typeof evt.alpha === 'number') {
      heading = 360 - evt.alpha;
    } else if (typeof evt.alpha === 'number') {
      heading = 360 - evt.alpha;
    }
    if (heading !== null) {
      heading = (heading + 360) % 360;
      this._heading = heading;
      this.emit({ type: 'heading', heading });
    }
  }

  _handleMotion(evt) {
    const g = evt.accelerationIncludingGravity;
    if (!g || g.x === null || g.y === null || g.z === null) return;

    // Roll: tilt left/right around the direction of travel axis.
    // Pitch: tilt forward/backward.
    const roll = Math.atan2(g.x, Math.sqrt(g.y * g.y + g.z * g.z)) * (180 / Math.PI);
    const pitch = Math.atan2(g.y, Math.sqrt(g.x * g.x + g.z * g.z)) * (180 / Math.PI);

    const alpha = 0.15; // low-pass smoothing
    this._roll = this._roll + alpha * (roll - this._roll);
    this._pitch = this._pitch + alpha * (pitch - this._pitch);

    this.emit({ type: 'lean', roll: this._roll, pitch: this._pitch });
  }

  static headingToCompass(heading) {
    if (heading === null || heading === undefined) return '--';
    const dirs = ['U', 'TL', 'T', 'TG', 'S', 'BD', 'B', 'BL'];
    const idx = Math.round(heading / 45) % 8;
    return dirs[idx];
  }
}
