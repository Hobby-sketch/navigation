/**
 * speedometer.js
 * Renders the circular analog gauge (0-200 km/h, 270° sweep) + big digital
 * readout in the center. All motion runs through a single requestAnimationFrame
 * loop with frame-rate-independent lerp smoothing for a fluid 60fps needle.
 */

const MIN_SPEED = 0;
const MAX_SPEED = 200;
const START_ANGLE = -135; // degrees, clockwise from 12 o'clock (top)
const END_ANGLE = 135;
const SWEEP = END_ANGLE - START_ANGLE; // 270
const CX = 150, CY = 150, ARC_R = 130;

function polar(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function describeArc(cx, cy, r, startDeg, endDeg) {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const largeArc = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
}

function speedToAngle(speed) {
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed));
  return START_ANGLE + (clamped / MAX_SPEED) * SWEEP;
}

export class Speedometer {
  constructor({ unit = 'kmh' } = {}) {
    this.svg = document.getElementById('speedo-svg');
    this.arcBg = document.getElementById('speedo-arc-bg');
    this.arcFill = document.getElementById('speedo-arc-fill');
    this.ticksGroup = document.getElementById('speedo-ticks');
    this.labelsGroup = document.getElementById('speedo-labels');
    this.needle = document.getElementById('speedo-needle');
    this.valueEl = document.getElementById('speed-value');
    this.unitEl = document.getElementById('speed-unit');

    this.unit = unit; // 'kmh' | 'mph'
    this.targetKmh = 0;
    this.currentKmh = 0;
    this._rafId = null;
    this._lastTs = 0;

    this._buildStaticScale();
    this.setUnit(unit);
    this._loop = this._loop.bind(this);
  }

  _buildStaticScale() {
    this.arcBg.setAttribute('d', describeArc(CX, CY, ARC_R, START_ANGLE, END_ANGLE));

    const majorStep = 20;
    const ticksHtml = [];
    const labelsHtml = [];
    for (let v = MIN_SPEED; v <= MAX_SPEED; v += 10) {
      const isMajor = v % majorStep === 0;
      const angle = speedToAngle(v);
      const outer = polar(CX, CY, 140, angle);
      const inner = polar(CX, CY, isMajor ? 120 : 128, angle);
      ticksHtml.push(
        `<line x1="${inner.x.toFixed(2)}" y1="${inner.y.toFixed(2)}" x2="${outer.x.toFixed(2)}" y2="${outer.y.toFixed(2)}" class="speedo__tick${isMajor ? ' speedo__tick--major' : ''}"/>`
      );
      if (isMajor) {
        const lp = polar(CX, CY, 104, angle);
        labelsHtml.push(
          `<text x="${lp.x.toFixed(2)}" y="${lp.y.toFixed(2)}" dominant-baseline="middle" class="speedo__label">${v}</text>`
        );
      }
    }
    this.ticksGroup.innerHTML = ticksHtml.join('');
    this.labelsGroup.innerHTML = labelsHtml.join('');
  }

  setUnit(unit) {
    this.unit = unit;
    this.unitEl.textContent = unit === 'mph' ? 'mph' : 'km/h';
  }

  /** Feed the latest raw speed (always in km/h) — smoothing happens internally. */
  setSpeedKmh(kmh) {
    this.targetKmh = Math.max(0, kmh);
    if (!this._rafId) this._rafId = requestAnimationFrame(this._loop);
  }

  start() {
    if (!this._rafId) this._rafId = requestAnimationFrame(this._loop);
  }

  stop() {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = null;
  }

  _loop(ts) {
    if (!this._lastTs) this._lastTs = ts;
    const dt = Math.min(0.1, (ts - this._lastTs) / 1000);
    this._lastTs = ts;

    // Frame-rate independent exponential smoothing.
    const smoothing = 1 - Math.pow(0.001, dt);
    this.currentKmh += (this.targetKmh - this.currentKmh) * smoothing;
    if (Math.abs(this.currentKmh - this.targetKmh) < 0.05) this.currentKmh = this.targetKmh;

    this._render(this.currentKmh);
    this._rafId = requestAnimationFrame(this._loop);
  }

  _render(kmh) {
    const displaySpeed = this.unit === 'mph' ? kmh * 0.621371 : kmh;
    const angle = speedToAngle(kmh);

    this.needle.style.transform = `rotate(${angle}deg)`;
    this.arcFill.setAttribute('d', describeArc(CX, CY, ARC_R, START_ANGLE, angle));
    this.valueEl.textContent = Math.round(displaySpeed);
  }
}
