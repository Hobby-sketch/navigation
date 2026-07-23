/**
 * navigation.js — Navigation Engine
 * Sits on top of the Map Engine (map.js) and adds turn-by-turn-style trip
 * intelligence: route alternatives, ETA/remaining distance/arrival time,
 * off-route detection with auto-reroute, and smart camera behavior — all
 * without touching map.js's own rendering contract (it reuses the same
 * 'route' GeoJSON source map.js already manages).
 *
 * Routing stays on OSRM's public demo router (no key needed, matches the
 * "tetap gunakan OpenStreetMap/MapLibre" requirement). If a Traffic Engine
 * provider with routing support is configured later, this is the seam
 * where a traffic-aware ETA multiplier would plug in (see `etaTrafficFactor`).
 */

import { haversineDistance } from './gps.js';
import { easeOutCubic } from './map.js';

const OSRM_BASE = 'https://router.project-osrm.org/route/v1/driving';
const MAX_ALTERNATIVES = 2;
const OFF_ROUTE_THRESHOLD_M = 60;
const OFF_ROUTE_TRIGGER_MS = 8000;
const REROUTE_COOLDOWN_MS = 20000;
const PROGRESS_MIN_INTERVAL_MS = 1500; // throttle progress recompute — cheap but no need for 60fps

export class NavigationEngine {
  /** @param {import('./map.js').MapManager} mapManager */
  constructor(mapManager) {
    this.mapManager = mapManager;
    this.map = mapManager.map;
    this.route = null;
    this.alternatives = [];
    this.destination = null;
    this.listeners = new Set();
    this.offRouteSince = null;
    this.lastRerouteAt = 0;
    this.lastProgressAt = 0;
    this.autoRerouteEnabled = true;
    /** Optional traffic-aware ETA multiplier (1 = no adjustment). A future
     *  Traffic Engine adapter with speed data can update this. */
    this.etaTrafficFactor = 1;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(evt) { this.listeners.forEach((fn) => fn(evt)); }

  async startTo(destLat, destLon, destName, fromLat, fromLon) {
    this.destination = { lat: destLat, lon: destLon, name: destName };
    this._emit({ type: 'routing-start' });
    const routes = await this._fetchRoutes(fromLat, fromLon, destLat, destLon);
    if (!routes.length) {
      this._emit({ type: 'routing-failed' });
      return null;
    }
    this._setActiveRoute(routes[0]);
    this.alternatives = routes.slice(1, 1 + MAX_ALTERNATIVES);
    this._emit({ type: 'route-ready', route: this.route, alternatives: this.alternatives });
    return this.route;
  }

  /** Switch to one of the alternative routes offered after startTo(). */
  selectAlternative(index) {
    const alt = this.alternatives[index];
    if (!alt) return;
    const previousPrimary = this.route;
    this._setActiveRoute(alt);
    this.alternatives[index] = previousPrimary;
    this._emit({ type: 'route-ready', route: this.route, alternatives: this.alternatives });
  }

  async _fetchRoutes(fromLat, fromLon, toLat, toLon) {
    try {
      const url = `${OSRM_BASE}/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson&alternatives=true&steps=false`;
      const res = await fetch(url);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.routes || []).map((r) => this._normalizeRoute(r));
    } catch (e) {
      console.warn('Navigation Engine: route fetch failed', e);
      return [];
    }
  }

  /** Precomputes cumulative distance at every vertex once, so per-fix
   *  progress lookups (below) are a cheap O(n) scan, not O(n) haversine calls. */
  _normalizeRoute(osrmRoute) {
    const coords = osrmRoute.geometry.coordinates; // [lon,lat][]
    const cumulative = [0];
    for (let i = 1; i < coords.length; i++) {
      const [lon1, lat1] = coords[i - 1];
      const [lon2, lat2] = coords[i];
      cumulative.push(cumulative[i - 1] + haversineDistance(lat1, lon1, lat2, lon2));
    }
    return { coordinates: coords, cumulative, distanceM: osrmRoute.distance, durationS: osrmRoute.duration };
  }

  _setActiveRoute(route) {
    this.route = route;
    this.offRouteSince = null;
    const source = this.map.getSource('route');
    if (source) {
      source.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: route.coordinates } });
    }
    const bounds = route.coordinates.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(route.coordinates[0], route.coordinates[0])
    );
    this.map.fitBounds(bounds, { padding: 70, duration: 800, easing: easeOutCubic });
  }

  /** Feed every live GPS fix here — internally throttled so it's cheap
   *  even at high GPS update rates. */
  update(lat, lon, speedKmh) {
    if (!this.route) return;
    const now = Date.now();
    if (now - this.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) return;
    this.lastProgressAt = now;

    const { distFromRouteM, cumulativeM } = this._nearestPointOnRoute(lat, lon);
    const remainingM = Math.max(0, this.route.distanceM - cumulativeM);
    const remainingKm = remainingM / 1000;

    const avgRouteSpeedKmh = (this.route.distanceM / this.route.durationS) * 3.6;
    const speedForEta = (speedKmh > 3 ? speedKmh : avgRouteSpeedKmh) * this.etaTrafficFactor;
    const etaSec = speedForEta > 0 ? (remainingKm / speedForEta) * 3600 : this.route.durationS;
    const arrival = new Date(now + etaSec * 1000);
    const isOffRoute = distFromRouteM > OFF_ROUTE_THRESHOLD_M;

    this._emit({ type: 'progress', remainingKm, etaSec, arrival, offRoute: isOffRoute });

    if (remainingM < 25) {
      this._emit({ type: 'arrived' });
      this.stop();
      return;
    }
    this._handleOffRoute(isOffRoute, lat, lon);
  }

  _handleOffRoute(isOffRoute, lat, lon) {
    if (!this.autoRerouteEnabled) return;
    const now = Date.now();
    if (!isOffRoute) { this.offRouteSince = null; return; }
    if (!this.offRouteSince) { this.offRouteSince = now; return; }

    const offLongEnough = now - this.offRouteSince > OFF_ROUTE_TRIGGER_MS;
    const cooldownOk = now - this.lastRerouteAt > REROUTE_COOLDOWN_MS;
    if (offLongEnough && cooldownOk && this.destination) {
      this.lastRerouteAt = now;
      this.offRouteSince = null;
      this._emit({ type: 'rerouting' });
      this.startTo(this.destination.lat, this.destination.lon, this.destination.name, lat, lon)
        .then((route) => { if (route) this._emit({ type: 'rerouted' }); });
    }
  }

  /** Cheap nearest-point-on-polyline scan using a flat-earth (equirectangular)
   *  approximation — accurate enough at city/ride scale and much lighter
   *  than a haversine call per vertex per GPS fix. */
  _nearestPointOnRoute(lat, lon) {
    const coords = this.route.coordinates;
    const latRad = (lat * Math.PI) / 180;
    const mPerDegLat = 111320;
    const mPerDegLon = 111320 * Math.cos(latRad);

    let bestDist = Infinity, bestCumulative = 0;
    for (let i = 0; i < coords.length; i++) {
      const [clon, clat] = coords[i];
      const dx = (clon - lon) * mPerDegLon;
      const dy = (clat - lat) * mPerDegLat;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist) { bestDist = d; bestCumulative = this.route.cumulative[i]; }
    }
    return { distFromRouteM: bestDist, cumulativeM: bestCumulative };
  }

  stop() {
    this.route = null;
    this.alternatives = [];
    this.destination = null;
    this.offRouteSince = null;
    this.mapManager.clearRoute();
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
