/**
 * maneuver.js — Navigation / Maneuver Engine (pure logic, no DOM except icon strings)
 *
 * Turns OSRM `steps` into a flat maneuver list, maps every maneuver onto the
 * route geometry (single distance source, shared with route progress), and
 * runs the per-maneuver state machine:
 *
 *   PENDING ─▶ NEXT_MANEUVER (the one after the active one, shown as preview)
 *           ─▶ CURRENT       (the active maneuver, still far)
 *           ─▶ APPROACHING   (inside the announce window)
 *           ─▶ TURN_NOW      (inside the turn window)
 *           ─▶ PASSED        (we are beyond it; engine advances to the next)
 *
 * Maneuver shape:
 *   { id, type, modifier, distanceM, duration, streetName, coordinate,
 *     bearingBefore, bearingAfter, offsetM, exit, state, instruction }
 *   - distanceM : length of the leg that STARTS at this maneuver (OSRM semantic)
 *   - offsetM   : where along the route geometry the maneuver happens
 */

import { matchToRoute } from './geo.js';

export const MANEUVER_STATE = Object.freeze({
  PENDING: 'PENDING',
  CURRENT: 'CURRENT',
  APPROACHING: 'APPROACHING',
  TURN_NOW: 'TURN_NOW',
  PASSED: 'PASSED',
  NEXT_MANEUVER: 'NEXT_MANEUVER',
});

export const MANEUVER_TYPE = Object.freeze({
  STRAIGHT: 'straight',
  LEFT: 'left',
  RIGHT: 'right',
  SLIGHT_LEFT: 'slight-left',
  SLIGHT_RIGHT: 'slight-right',
  SHARP_LEFT: 'sharp-left',
  SHARP_RIGHT: 'sharp-right',
  UTURN: 'uturn',
  ROUNDABOUT: 'roundabout',
  DESTINATION: 'destination',
});

const MODIFIER_TO_TYPE = {
  'uturn': MANEUVER_TYPE.UTURN,
  'sharp right': MANEUVER_TYPE.SHARP_RIGHT,
  'right': MANEUVER_TYPE.RIGHT,
  'slight right': MANEUVER_TYPE.SLIGHT_RIGHT,
  'straight': MANEUVER_TYPE.STRAIGHT,
  'slight left': MANEUVER_TYPE.SLIGHT_LEFT,
  'left': MANEUVER_TYPE.LEFT,
  'sharp left': MANEUVER_TYPE.SHARP_LEFT,
};

// OSRM step types that are informational only (no driver action).
const SKIP_TYPES = new Set(['depart', 'new name', 'notification', 'exit roundabout', 'exit rotary']);

const TURN_ANGLE = {
  [MANEUVER_TYPE.STRAIGHT]: 0,
  [MANEUVER_TYPE.SLIGHT_RIGHT]: 40,
  [MANEUVER_TYPE.RIGHT]: 90,
  [MANEUVER_TYPE.SHARP_RIGHT]: 135,
  [MANEUVER_TYPE.SLIGHT_LEFT]: -40,
  [MANEUVER_TYPE.LEFT]: -90,
  [MANEUVER_TYPE.SHARP_LEFT]: -135,
};

/** Map an OSRM maneuver to one of our simplified types. */
export function classifyManeuver(osrmType, modifier, exit) {
  if (osrmType === 'arrive') return MANEUVER_TYPE.DESTINATION;
  if (osrmType === 'roundabout' || osrmType === 'rotary') return MANEUVER_TYPE.ROUNDABOUT;
  if (osrmType === 'roundabout turn') return MODIFIER_TO_TYPE[modifier] || MANEUVER_TYPE.ROUNDABOUT;
  if (osrmType === 'merge' || osrmType === 'fork' || osrmType === 'on ramp' || osrmType === 'off ramp' ||
      osrmType === 'end of road' || osrmType === 'turn' || osrmType === 'continue') {
    return MODIFIER_TO_TYPE[modifier] || MANEUVER_TYPE.STRAIGHT;
  }
  return MODIFIER_TO_TYPE[modifier] || MANEUVER_TYPE.STRAIGHT;
}

/** Signed turn angle of a type (right positive), used by the icon generator. */
export function turnAngleOf(type) { return TURN_ANGLE[type] ?? 0; }

/**
 * Build the maneuver list for one OSRM route.
 * @param {object} osrmRoute  route with legs[].steps[]
 * @param {object} routeIndex output of geo.buildRouteIndex (same geometry!)
 */
export function buildManeuvers(osrmRoute, routeIndex) {
  const steps = (osrmRoute.legs || []).flatMap((l) => l.steps || []);
  const list = [];
  let hint = 0;
  let lastOffset = 0;

  steps.forEach((step, idx) => {
    const m = step.maneuver || {};
    const isArrive = m.type === 'arrive';
    if (idx === 0 && m.type === 'depart') return;
    if (SKIP_TYPES.has(m.type)) return;
    // "continue straight" with no choice to make is noise.
    if (m.type === 'continue' && (!m.modifier || m.modifier === 'straight') && !isArrive) return;

    const [lon, lat] = m.location || [];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    let offsetM;
    if (isArrive) {
      offsetM = routeIndex.totalM;
    } else {
      const match = matchToRoute(lat, lon, routeIndex, { hintIndex: hint });
      offsetM = match ? match.alongM : lastOffset;
      if (match) hint = match.segIndex;
    }
    offsetM = Math.max(offsetM, lastOffset);
    lastOffset = offsetM;

    const type = classifyManeuver(m.type, m.modifier, m.exit);
    const mv = {
      id: list.length,
      type,
      osrmType: m.type,
      modifier: m.modifier || null,
      distanceM: step.distance || 0,
      duration: step.duration || 0,
      streetName: (step.name || '').trim(),
      coordinate: { lat, lon },
      bearingBefore: Number.isFinite(m.bearing_before) ? m.bearing_before : null,
      bearingAfter: Number.isFinite(m.bearing_after) ? m.bearing_after : null,
      exit: Number.isFinite(m.exit) ? m.exit : null,
      offsetM,
      state: MANEUVER_STATE.PENDING,
    };
    mv.instruction = describeManeuver(mv);
    list.push(mv);
  });

  // Guarantee a destination maneuver exists even if the router omitted 'arrive'.
  if (!list.length || list[list.length - 1].type !== MANEUVER_TYPE.DESTINATION) {
    const last = routeIndex.coords[routeIndex.coords.length - 1];
    const mv = {
      id: list.length, type: MANEUVER_TYPE.DESTINATION, osrmType: 'arrive', modifier: null,
      distanceM: 0, duration: 0, streetName: '', coordinate: { lat: last[1], lon: last[0] },
      bearingBefore: null, bearingAfter: null, exit: null, offsetM: routeIndex.totalM,
      state: MANEUVER_STATE.PENDING,
    };
    mv.instruction = describeManeuver(mv);
    list.push(mv);
  }
  return list;
}

/* ------------------------------ instruction text ------------------------------ */

const VERB_ID = {
  [MANEUVER_TYPE.STRAIGHT]: 'lurus',
  [MANEUVER_TYPE.LEFT]: 'belok kiri',
  [MANEUVER_TYPE.RIGHT]: 'belok kanan',
  [MANEUVER_TYPE.SLIGHT_LEFT]: 'belok sedikit ke kiri',
  [MANEUVER_TYPE.SLIGHT_RIGHT]: 'belok sedikit ke kanan',
  [MANEUVER_TYPE.SHARP_LEFT]: 'belok tajam ke kiri',
  [MANEUVER_TYPE.SHARP_RIGHT]: 'belok tajam ke kanan',
  [MANEUVER_TYPE.UTURN]: 'putar balik',
  [MANEUVER_TYPE.ROUNDABOUT]: 'masuk bundaran',
  [MANEUVER_TYPE.DESTINATION]: 'tiba di tujuan',
};

export function describeManeuver(m) {
  if (m.type === MANEUVER_TYPE.ROUNDABOUT && m.exit) return `masuk bundaran, ambil jalan keluar ke-${m.exit}`;
  return VERB_ID[m.type] || 'lurus';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** "200 meter" / "1,2 kilometer" for speech, rounded to natural steps. */
export function speakDistance(m) {
  if (m < 1000) {
    const step = m >= 200 ? 50 : 10;
    const r = Math.max(10, Math.round(m / step) * step);
    return `${r} meter`;
  }
  const km = Math.round(m / 100) / 10;
  return `${String(km).replace('.', ',')} kilometer`;
}

/** Compact distance for the UI: "200 m" / "1,2 km". */
export function formatDistance(m) {
  if (!Number.isFinite(m)) return '--';
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

/** Voice phrases for each announcement stage (distance only matters for 'far'). */
export function voiceText(m, stage, distanceM = 200) {
  const verb = describeManeuver(m);
  if (m.type === MANEUVER_TYPE.DESTINATION) return 'Anda telah tiba.';
  if (stage === 'far') return `${cap(speakDistance(distanceM))} lagi, ${verb}.`;
  if (stage === 'near') return `${cap(speakDistance(50))} lagi, ${verb}.`;
  return `${cap(verb)} sekarang.`;
}

/* ------------------------------- state machine ------------------------------- */

/**
 * Tracks which maneuver is active and its state from route progress.
 * Pure: feed (alongM, speedKmh) and read back `view`.
 */
export class ManeuverTracker {
  constructor(maneuvers) {
    this.maneuvers = maneuvers;
    this.index = 0;
    this.passedCount = 0;
    this._apply();
  }

  /** Active maneuver or null when the list is exhausted. */
  get current() { return this.maneuvers[this.index] || null; }
  get next() { return this.maneuvers[this.index + 1] || null; }

  static thresholds(speedKmh) {
    const v = Math.max(0, speedKmh) / 3.6;
    return {
      turnNowM: Math.min(45, Math.max(20, v * 2.2)),
      approachM: Math.max(120, Math.min(260, v * 12)),
      passedM: 18,
    };
  }

  /**
   * @returns {{changed:boolean, passed:object[], current:object|null, next:object|null,
   *            distanceM:number|null, state:string|null, thresholds:object}}
   */
  update(alongM, speedKmh = 0) {
    const th = ManeuverTracker.thresholds(speedKmh);
    const passed = [];

    // Advance past maneuvers we've clearly gone beyond (never the destination).
    while (this.current && this.current.type !== MANEUVER_TYPE.DESTINATION && alongM > this.current.offsetM + th.passedM) {
      this.current.state = MANEUVER_STATE.PASSED;
      passed.push(this.current);
      this.index += 1;
      this.passedCount += 1;
    }

    const cur = this.current;
    const distanceM = cur ? Math.max(0, cur.offsetM - alongM) : null;
    let state = null;
    if (cur) {
      state = distanceM <= th.turnNowM ? MANEUVER_STATE.TURN_NOW
        : distanceM <= th.approachM ? MANEUVER_STATE.APPROACHING
          : MANEUVER_STATE.CURRENT;
    }
    const before = this.maneuvers.map((m) => m.state).join();
    this._apply(state);
    const changed = passed.length > 0 || before !== this.maneuvers.map((m) => m.state).join();
    return { changed, passed, current: cur, next: this.next, distanceM, state, thresholds: th };
  }

  _apply(activeState = MANEUVER_STATE.CURRENT) {
    this.maneuvers.forEach((m, i) => {
      if (i < this.index) m.state = MANEUVER_STATE.PASSED;
      else if (i === this.index) m.state = activeState || MANEUVER_STATE.CURRENT;
      else if (i === this.index + 1) m.state = MANEUVER_STATE.NEXT_MANEUVER;
      else m.state = MANEUVER_STATE.PENDING;
    });
  }

  /** Re-sync after a (re)route or when jumping far ahead. */
  reset() { this.index = 0; this.passedCount = 0; this._apply(); }
}

/* ---------------------------------- icons ---------------------------------- */

/**
 * Inline SVG arrow for a maneuver (32x32 box, currentColor stroke, no external
 * assets so it works offline and re-colors with the theme).
 */
export function maneuverIconSvg(type, { size = 32 } = {}) {
  const open = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${size}" height="${size}" class="mv-icon" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round">`;
  const head = (x, y, angleDeg) => {
    const a = (angleDeg * Math.PI) / 180;
    const dx = Math.sin(a), dy = -Math.cos(a);
    const px = -dy, py = dx;
    const tip = [x + dx * 5, y + dy * 5];
    const b1 = [x - dx * 2 + px * 6, y - dy * 2 + py * 6];
    const b2 = [x - dx * 2 - px * 6, y - dy * 2 - py * 6];
    return `<polygon points="${tip.map((n) => n.toFixed(1)).join(',')} ${b1.map((n) => n.toFixed(1)).join(',')} ${b2.map((n) => n.toFixed(1)).join(',')}" fill="currentColor" stroke="none"/>`;
  };

  if (type === MANEUVER_TYPE.DESTINATION) {
    return `${open}<path d="M9 28V5"/><path d="M9 6h15l-4 5 4 5H9" fill="currentColor" stroke-width="2"/></svg>`;
  }
  if (type === MANEUVER_TYPE.UTURN) {
    return `${open}<path d="M10 28V13a6 6 0 0 1 12 0v6"/>${head(22, 19, 180)}</svg>`;
  }
  if (type === MANEUVER_TYPE.ROUNDABOUT) {
    return `${open}<circle cx="16" cy="19" r="6.5" stroke-width="2.6"/><path d="M16 28v-2.5" /><path d="M16 12.5V6"/>${head(16, 7, 0)}</svg>`;
  }
  const ang = turnAngleOf(type);
  const r = 11;
  const rad = (ang * Math.PI) / 180;
  const ex = 16 + r * Math.sin(rad), ey = 17 - r * Math.cos(rad);
  const stem = `<path d="M16 28V17${ang === 0 ? '' : ` L${ex.toFixed(1)} ${ey.toFixed(1)}`}${ang === 0 ? ' V8' : ''}"/>`;
  const hx = ang === 0 ? 16 : ex, hy = ang === 0 ? 8 : ey;
  return `${open}${stem}${head(hx, hy, ang)}</svg>`;
}
