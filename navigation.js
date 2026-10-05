/**
 * navigation.js — Navigation Engine
 * Sits on top of the Map Engine (map.js) and owns trip intelligence:
 *
 *   GPS fix
 *     -> nearest ROUTE SEGMENT (projection, not nearest vertex)
 *     -> projection point + distance from route + cumulative distance (alongM)
 *     -> route progress / remaining distance / ETA   (ONE distance source:
 *        the route geometry; OSRM's own distance is kept only as metadata)
 *     -> maneuver tracking (turn-by-turn state machine, see maneuver.js)
 *     -> adaptive + validated off-route detection -> reroute
 *     -> destination state machine: NAVIGATING -> APPROACHING_DESTINATION -> ARRIVED
 *
 * Routing stays on OSRM's public router (no key). `steps=true` provides the
 * maneuvers. If a traffic-aware provider is added later, `etaTrafficFactor`
 * is the seam for it.
 *
 * Events (via on()):
 *   routing-start, route-ready{route,alternatives,reroute}, routing-failed,
 *   progress{...}, maneuver{...}, maneuver-passed{maneuver}, announce{stage,maneuver,distanceM},
 *   off-route-suspect, rerouting, rerouted, approaching-destination, arrived, cancelled
 */

import { haversineM, buildRouteIndex, matchToRoute, angleDiff, clamp } from './geo.js';
import { easeOutCubic } from './map.js';
import { buildManeuvers, ManeuverTracker, MANEUVER_TYPE, MANEUVER_STATE } from './maneuver.js';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const MAX_ALTERNATIVES = 2;

const PROGRESS_MIN_INTERVAL_MS = 400;
const REROUTE_COOLDOWN_MS = 20000;
const REROUTE_GRACE_MS = 10000;      // after a (re)route, don't judge off-route immediately

// Off-route validation
const OFF_MIN_THRESHOLD_M = 35;
const OFF_MAX_THRESHOLD_M = 160;
const OFF_CONFIRM_FIXES = 3;
const OFF_CONFIRM_MS = 5000;
const OFF_FAST_FIXES = 2;            // when clearly far away with a clean fix
const OFF_FAST_MS = 2500;
const OFF_MIN_SPEED_KMH = 2;
const OFF_IGNORE_ACCURACY_M = 60;    // fixes worse than this neither confirm nor clear off-route

// Announcements
const FAR_ANNOUNCE_M = 220;
const NEAR_ANNOUNCE_M = 65;
const FAR_SKIP_IF_CLOSER_M = 90;

// Destination
const APPROACH_DEST_M = 200;
const APPROACH_DEST_CLEAR_M = 320;
const ARRIVE_CONFIRM_FIXES = 2;
const ARRIVE_MAX_SPEED_KMH = 15;

export const NAV_STATE = Object.freeze({
  IDLE: 'IDLE',
  NAVIGATING: 'NAVIGATING',
  APPROACHING_DESTINATION: 'APPROACHING_DESTINATION',
  ARRIVED: 'ARRIVED',
});

export class NavigationEngine {
  /** @param {import('./map.js').MapManager} mapManager */
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.map = mapManager ? mapManager.map : null;
    this.route = null;
    this.alternatives = [];
    this.destination = null;
    this.listeners = new Set();
    this.state = NAV_STATE.IDLE;
    this.tracker = null;
    this.autoRerouteEnabled = true;
    /** Optional traffic-aware ETA multiplier (1 = no adjustment). */
    this.etaTrafficFactor = 1;

    this.lastRerouteAt = 0;
    this.lastProgressAt = 0;
    this.routeStartedAt = 0;
    this._hint = null;
    this._announced = new Set();
    this._resetOffRoute();
    this._arriveFixes = 0;
    this._routeUid = 0;
    this._rerouting = false;
    this._lastMatch = null;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => { try { fn(evt); } catch (e) { console.warn('nav listener failed', e); } }); }

  get isActive() { return !!this.route; }

  _resetOffRoute() {
    this._offCount = 0;
    this._offFirstAt = null;
    this._offDists = [];
    this._suspectEmitted = false;
  }

  /* ------------------------------- routing ------------------------------- */

  async startTo(destLat, destLon, destName, fromLat, fromLon, { reroute = false } = {}) {
    this.destination = { lat: destLat, lon: destLon, name: destName };
    this._emit({ type: 'routing-start', reroute });
    const routes = await this._fetchRoutes(fromLat, fromLon, destLat, destLon);
    if (!routes.length) {
      this._emit({ type: 'routing-failed', reroute });
      return null;
    }
    this._setActiveRoute(routes[0], { fit: !reroute });
    this.alternatives = routes.slice(1, 1 + MAX_ALTERNATIVES);
    this._emit({ type: 'route-ready', route: this.route, alternatives: this.alternatives, reroute });
    this._emitManeuver(null);
    return this.route;
  }

  /** Switch to one of the alternative routes offered after startTo(). */
  selectAlternative(index) {
    const alt = this.alternatives[index];
    if (!alt) return;
    const previousPrimary = this.route;
    this._setActiveRoute(alt, { fit: true });
    this.alternatives[index] = previousPrimary;
    this._emit({ type: 'route-ready', route: this.route, alternatives: this.alternatives, reroute: false });
    this._emitManeuver(null);
  }

  async _fetchRoutes(fromLat, fromLon, toLat, toLon) {
    try {
      const url = `${OSRM_BASE}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson&alternatives=true&steps=true`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.routes || []).map((r) => this._normalizeRoute(r)).filter(Boolean);
    } catch (e) {
      console.warn('Navigation Engine: route fetch failed', e);
      return [];
    }
  }

  /**
   * Everything derived from the geometry is computed once here: per-segment
   * length/bearing, cumulative distance, corner deflection and the maneuver
   * list positioned on that very same geometry.
   */
  _normalizeRoute(osrmRoute) {
    const coords = osrmRoute?.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;
    const index = buildRouteIndex(coords);
    const maneuvers = buildManeuvers(osrmRoute, index);
    return {
      uid: ++this._routeUid,
      coordinates: coords,
      index,
      cumulative: Array.from(index.cum),
      totalM: index.totalM,
      distanceM: index.totalM,            // single source of truth for distance
      osrmDistanceM: osrmRoute.distance,  // metadata only
      durationS: osrmRoute.duration,
      maneuvers,
    };
  }

  _setActiveRoute(route, { fit = true } = {}) {
    this.route = route;
    this.tracker = new ManeuverTracker(route.maneuvers);
    this.state = NAV_STATE.NAVIGATING;
    this._hint = null;
    this._lastMatch = null;
    this._announced = new Set();
    this._arriveFixes = 0;
    this._resetOffRoute();
    this.routeStartedAt = Date.now();
    this.lastProgressAt = 0;

    const source = this.map?.getSource?.('route');
    if (source) {
      source.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coordinates } });
    }
    if (fit && this.map && typeof maplibregl !== 'undefined') {
      const bounds = route.coordinates.reduce(
        (b, c) => b.extend(c),
        new maplibregl.LngLatBounds(route.coordinates[0], route.coordinates[0])
      );
      this.map.fitBounds(bounds, { padding: 70, duration: 800, easing: easeOutCubic });
    }
  }

  /* ------------------------------ live update ------------------------------ */

  /**
   * Feed every live GPS fix here (internally throttled).
   * @param {number} lat
   * @param {number} lon
   * @param {number} speedKmh
   * @param {{accuracy?:number, heading?:number|null, headingConfidence?:number, headingValid?:boolean, now?:number}} ctx
   */
  update(lat, lon, speedKmh, ctx = {}) {
    if (!this.route || !this.destination) return;
    const now = ctx.now ?? Date.now();
    if (now - this.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
    this.lastProgressAt = now;

    const accuracy = Number.isFinite(ctx.accuracy) ? ctx.accuracy : 15;
    const route = this.route;
    const heading = Number.isFinite(ctx.heading) ? ctx.heading : null;
    const headingValid = !!ctx.headingValid && (ctx.headingConfidence ?? 0) >= 0.4;

    const match = matchToRoute(lat, lon, route.index, {
      hintIndex: this._hint, heading, headingValid: headingValid && speedKmh > 6,
    });
    if (!match) return;
    this._hint = match.segIndex;
    this._lastMatch = match;

    const threshold = this._offRouteThreshold(match, accuracy, speedKmh, headingValid, heading);
    const onRoute = match.distFromRouteM <= threshold;

    // ---- progress: distance, remaining, ETA (all from the same geometry) ----
    const alongM = match.alongM;
    const remainingM = Math.max(0, route.totalM - alongM);
    // Time left = OSRM duration scaled by the share of geometry still ahead (factor > 1 = faster than OSRM thinks).
    const baselineS = (route.durationS * (route.totalM > 0 ? remainingM / route.totalM : 0)) / Math.max(0.2, this.etaTrafficFactor);
    let etaSec = baselineS;
    if (speedKmh > 8) {
      const live = remainingM / (speedKmh / 3.6);
      etaSec = clamp(0.5 * baselineS + 0.5 * live, baselineS * 0.5, baselineS * 2.5 + 30);
    }
    const arrival = new Date(now + etaSec * 1000);

    // ---- off-route validation (before emitting, so UI sees confirmed state) ----
    const offState = this._validateOffRoute({ match, threshold, onRoute, accuracy, speedKmh, now });

    // ---- destination state machine ----
    if (this._handleDestination({ lat, lon, remainingM, accuracy, speedKmh, now, onRoute })) return;

    // ---- maneuvers ----
    if (match.distFromRouteM <= threshold * 1.5) {
      const view = this.tracker.update(alongM, speedKmh);
      view.passed.forEach((m) => this._emit({ type: 'maneuver-passed', maneuver: m }));
      this._announce(view);
      this._emitManeuver(view);
    }

    this._emit({
      type: 'progress',
      state: this.state,
      remainingM,
      remainingKm: remainingM / 1000,
      etaSec,
      arrival,
      alongM,
      progressPct: route.totalM > 0 ? clamp((alongM / route.totalM) * 100, 0, 100) : 0,
      distFromRouteM: match.distFromRouteM,
      thresholdM: threshold,
      onRoute,
      offRoute: offState !== 'on',     // suspect or confirmed
      offRouteState: offState,         // 'on' | 'suspect' | 'confirmed'
    });

    if (offState === 'confirmed') this._reroute(lat, lon, now);
  }

  /**
   * Adaptive off-route threshold. Never a flat 60 m:
   *   max(minimum, GPS accuracy x factor, speed term) + geometry allowance,
   *   adjusted by heading agreement when the heading is trustworthy.
   */
  _offRouteThreshold(match, accuracy, speedKmh, headingValid, heading) {
    const speedMs = Math.max(0, speedKmh) / 3.6;
    let t = Math.max(OFF_MIN_THRESHOLD_M, accuracy * 2.0, speedMs * 1.5 + 15);
    // Corners & junctions: GPS smoothing cuts the corner, allow more slack.
    if (match.nearVertexDeflection > 35) t += clamp((match.nearVertexDeflection - 35) / 4, 0, 20);
    if (headingValid && heading !== null && speedKmh > 8) {
      const diff = Math.abs(angleDiff(match.segBearing, heading));
      if (diff < 35) t *= 1.05;          // clearly following the route direction
      else if (diff > 120) t *= 0.85;    // heading the wrong way: be more sensitive
    }
    return clamp(t, OFF_MIN_THRESHOLD_M, OFF_MAX_THRESHOLD_M);
  }

  /**
   * Requires several consecutive bad fixes spread over time, ignores very poor
   * fixes, ignores a stationary vehicle (drift) and a vehicle that is already
   * converging back to the route. Returns 'on' | 'suspect' | 'confirmed'.
   */
  _validateOffRoute({ match, threshold, onRoute, accuracy, speedKmh, now }) {
    if (!this.autoRerouteEnabled || this._rerouting) return this._offCount > 0 ? 'suspect' : 'on';
    if (now - this.routeStartedAt < REROUTE_GRACE_MS) return 'on';
    if (accuracy > OFF_IGNORE_ACCURACY_M) return this._offCount > 0 ? 'suspect' : 'on';

    if (onRoute) { this._resetOffRoute(); return 'on'; }
    if (speedKmh < OFF_MIN_SPEED_KMH) return this._offCount > 0 ? 'suspect' : 'on';

    this._offCount += 1;
    if (!this._offFirstAt) this._offFirstAt = now;
    this._offDists.push(match.distFromRouteM);
    if (this._offDists.length > 4) this._offDists.shift();
    if (!this._suspectEmitted) {
      this._suspectEmitted = true;
      this._emit({ type: 'off-route-suspect', distFromRouteM: match.distFromRouteM, thresholdM: threshold });
    }

    const elapsed = now - this._offFirstAt;
    const d = this._offDists;
    const converging = d.length >= 3 && d[d.length - 1] < d[d.length - 3] - 8;
    const minRecent = Math.min(...d.slice(-3));
    const cooldownOk = now - this.lastRerouteAt > REROUTE_COOLDOWN_MS;

    const steady = this._offCount >= OFF_CONFIRM_FIXES && elapsed >= OFF_CONFIRM_MS && minRecent > threshold && !converging;
    const clearlyAway = this._offCount >= OFF_FAST_FIXES && elapsed >= OFF_FAST_MS && minRecent > threshold * 2.5 && accuracy <= 25 && !converging;
    if ((steady || clearlyAway) && cooldownOk && this.destination) return 'confirmed';
    return 'suspect';
  }

  _reroute(lat, lon, now) {
    if (this._rerouting) return;
    this._rerouting = true;
    this.lastRerouteAt = now;
    this._resetOffRoute();
    this._emit({ type: 'rerouting' });
    const dest = this.destination;
    this.startTo(dest.lat, dest.lon, dest.name, lat, lon, { reroute: true })
      .then((route) => { if (route) this._emit({ type: 'rerouted' }); })
      .catch(() => { /* startTo already reports failure */ })
      .finally(() => { this._rerouting = false; });
  }

  /* ------------------------------ destination ------------------------------ */

  /** @returns {boolean} true when navigation finished (ARRIVED) and update() should stop. */
  _handleDestination({ lat, lon, remainingM, accuracy, speedKmh, now, onRoute }) {
    const end = this.route.coordinates[this.route.coordinates.length - 1];
    const destDist = Math.min(
      haversineM(lat, lon, this.destination.lat, this.destination.lon),
      haversineM(lat, lon, end[1], end[0])
    );

    if (this.state === NAV_STATE.NAVIGATING && onRoute && (remainingM <= APPROACH_DEST_M || destDist <= APPROACH_DEST_M + 20)) {
      this.state = NAV_STATE.APPROACHING_DESTINATION;
      this._emit({ type: 'approaching-destination', remainingM, destDist });
    } else if (this.state === NAV_STATE.APPROACHING_DESTINATION && remainingM > APPROACH_DEST_CLEAR_M && destDist > APPROACH_DEST_CLEAR_M) {
      this.state = NAV_STATE.NAVIGATING; // moved away (e.g. wrong way / long detour)
      this._arriveFixes = 0;
    }

    if (this.state !== NAV_STATE.APPROACHING_DESTINATION) return false;

    const radius = clamp(Math.max(20, accuracy * 1.2), 20, 45);
    const closeEnough = destDist <= radius && remainingM <= 60;
    const slowEnough = speedKmh <= ARRIVE_MAX_SPEED_KMH || destDist <= 10 || remainingM <= 8;
    if (closeEnough && slowEnough) this._arriveFixes += 1;
    else this._arriveFixes = Math.max(0, this._arriveFixes - 1);

    if (this._arriveFixes >= ARRIVE_CONFIRM_FIXES) {
      this.state = NAV_STATE.ARRIVED;
      this._emit({ type: 'progress', state: this.state, remainingM: 0, remainingKm: 0, etaSec: 0, arrival: new Date(now), alongM: this.route.totalM, progressPct: 100, distFromRouteM: 0, thresholdM: radius, onRoute: true, offRoute: false, offRouteState: 'on' });
      this._emit({ type: 'arrived' });
      this.stop();
      return true;
    }
    return false;
  }

  /* ------------------------------ maneuver view ------------------------------ */

  _announce(view) {
    const m = view.current;
    if (!m || m.type === MANEUVER_TYPE.DESTINATION || view.distanceM === null) return;
    const key = (stage) => `${this.route.uid}:${m.id}:${stage}`;
    const mark = (stage) => this._announced.add(key(stage));
    const done = (stage) => this._announced.has(key(stage));
    const d = view.distanceM;

    if (view.state === MANEUVER_STATE.TURN_NOW) {
      mark('far'); mark('near');
      if (!done('now') && m.type !== MANEUVER_TYPE.STRAIGHT) { mark('now'); this._emit({ type: 'announce', stage: 'now', maneuver: m, distanceM: d }); }
      return;
    }
    if (d <= NEAR_ANNOUNCE_M) {
      mark('far');
      if (!done('near') && m.type !== MANEUVER_TYPE.STRAIGHT) { mark('near'); this._emit({ type: 'announce', stage: 'near', maneuver: m, distanceM: d }); }
      return;
    }
    if (d <= FAR_ANNOUNCE_M && !done('far')) {
      mark('far');
      if (d >= FAR_SKIP_IF_CLOSER_M && m.type !== MANEUVER_TYPE.STRAIGHT) this._emit({ type: 'announce', stage: 'far', maneuver: m, distanceM: d });
    }
  }

  _emitManeuver(view) {
    if (!this.tracker) return;
    const v = view || {
      current: this.tracker.current, next: this.tracker.next,
      distanceM: this.tracker.current ? this.tracker.current.offsetM : null,
      state: MANEUVER_STATE.CURRENT, passed: [],
    };
    this._emit({
      type: 'maneuver',
      current: v.current,
      next: v.next,
      distanceM: v.distanceM,
      state: v.state,
      navState: this.state,
    });
  }

  /** Snapshot for UI code that needs the current guidance outside of events. */
  getGuidance() {
    if (!this.route || !this.tracker) return null;
    const m = this.tracker.current;
    return { current: m, next: this.tracker.next, state: m ? m.state : null, navState: this.state, match: this._lastMatch };
  }

  /* -------------------------------- lifecycle -------------------------------- */

  /** User pressed "Akhiri Navigasi". */
  cancel() {
    if (!this.route && this.state === NAV_STATE.IDLE) return;
    this._emit({ type: 'cancelled' });
    this.stop();
  }

  stop() {
    this.route = null;
    this.tracker = null;
    this.alternatives = [];
    this.destination = null;
    this.state = NAV_STATE.IDLE;
    this._hint = null;
    this._announced = new Set();
    this._arriveFixes = 0;
    this._rerouting = false;
    this._resetOffRoute();
    this.mapManager?.clearRoute?.();
  }
}

/* ---------------- Navigation-specific formatting helpers ---------------- */
export function formatEta(etaSec) {
  if (!Number.isFinite(etaSec)) return '--';
  const min = Math.round(etaSec / 60);
  if (min < 1) return '<1 menit';
  if (min < 60) return `${min} menit`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h} jam ${m} menit`;
}

export function formatClockTime(date) {
  return date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}
