/**
 * geo.js — pure geometry helpers (no DOM, no state).
 * Shared by navigation.js, maneuver.js, heading.js and gps.js consumers.
 *
 * Route matching works on LINE SEGMENTS (projection of the GPS point onto
 * every candidate segment), not on the nearest vertex, so progress and
 * off-route distance stay accurate on long straight segments.
 */

export const EARTH_R = 6371000;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const toRad = (d) => d * D2R;
export const toDeg = (r) => r * R2D;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Normalize an angle to [0, 360). */
export function normDeg(a) { return ((a % 360) + 360) % 360; }

/** Signed shortest rotation from a to b, in (-180, 180]. */
export function angleDiff(a, b) {
  let d = normDeg(b - a);
  if (d > 180) d -= 360;
  return d;
}

export function haversineM(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return normDeg(toDeg(Math.atan2(y, x)));
}

/** Point reached by travelling distM from (lat, lon) along a bearing. */
export function destinationPoint(lat, lon, bearing, distM) {
  const br = toRad(bearing);
  const dLat = (distM * Math.cos(br)) / EARTH_R;
  const dLon = (distM * Math.sin(br)) / (EARTH_R * Math.cos(toRad(lat)));
  return { lat: lat + toDeg(dLat), lon: lon + toDeg(dLon) };
}

/** Circular (vector) mean of angles with optional weights. */
export function circularMean(angles, weights) {
  let s = 0, c = 0;
  angles.forEach((a, i) => {
    const w = weights ? weights[i] : 1;
    s += Math.sin(toRad(a)) * w;
    c += Math.cos(toRad(a)) * w;
  });
  return { angle: normDeg(toDeg(Math.atan2(s, c))), magnitude: Math.hypot(s, c) };
}

/* ====================== Route index & segment matching ====================== */

/**
 * Precompute everything per-route once: per-segment length/bearing, the
 * cumulative distance at every vertex (single distance source for progress,
 * remaining, ETA and maneuver positions) and the deflection angle at every
 * vertex (used to relax off-route thresholds around sharp corners).
 * @param {number[][]} coords [lon, lat][]
 */
export function buildRouteIndex(coords) {
  const n = coords.length;
  const cum = new Float64Array(n);
  const seg = new Float64Array(Math.max(0, n - 1));
  const brg = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const d = haversineM(lat1, lon1, lat2, lon2);
    seg[i - 1] = d;
    cum[i] = cum[i - 1] + d;
    brg[i - 1] = d > 0.01 ? bearingDeg(lat1, lon1, lat2, lon2) : (i > 1 ? brg[i - 2] : 0);
  }
  const turn = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) turn[i] = Math.abs(angleDiff(brg[i - 1], brg[i]));
  return { coords, n, cum, seg, brg, turn, totalM: n ? cum[n - 1] : 0 };
}

/** Project (lat, lon) onto segment i of a route index. */
export function projectToSegment(lat, lon, route, i) {
  const [lon1, lat1] = route.coords[i];
  const [lon2, lat2] = route.coords[i + 1];
  const ky = 111320;
  const kx = 111320 * Math.cos(toRad(lat));
  const ax = (lon1 - lon) * kx, ay = (lat1 - lat) * ky;
  const bx = (lon2 - lon) * kx, by = (lat2 - lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(-(ax * dx + ay * dy) / len2, 0, 1) : 0;
  const px = ax + t * dx, py = ay + t * dy;
  return {
    dist: Math.hypot(px, py),
    t,
    lon: lon1 + (lon2 - lon1) * t,
    lat: lat1 + (lat2 - lat1) * t,
  };
}

/**
 * Match a GPS point to the route.
 *  1. project onto every segment in a window around the previous match
 *     (keeps progress monotonic on routes that overlap themselves),
 *  2. fall back to a full scan when the window result is far away,
 *  3. optionally prefer segments whose direction agrees with the heading.
 *
 * @returns {{segIndex, t, distFromRouteM, alongM, lat, lon, segBearing, nearVertexDeflection}}
 */
export function matchToRoute(lat, lon, route, { hintIndex = null, heading = null, headingValid = false } = {}) {
  if (route.n < 2) return null;
  const lastSeg = route.n - 2;

  const scan = (from, to) => {
    let best = null;
    for (let i = from; i <= to; i++) {
      const p = projectToSegment(lat, lon, route, i);
      let score = p.dist;
      if (headingValid && heading !== null && Math.abs(angleDiff(route.brg[i], heading)) > 100) score += 15;
      if (!best || score < best.score) best = { ...p, segIndex: i, score };
    }
    return best;
  };

  let best = null;
  if (hintIndex !== null && hintIndex >= 0) {
    best = scan(Math.max(0, hintIndex - 8), Math.min(lastSeg, hintIndex + 80));
  }
  if (!best || best.dist > 80) {
    const full = scan(0, lastSeg);
    if (!best || full.score < best.score - 20) best = full;
  }

  const i = best.segIndex;
  const alongM = route.cum[i] + best.t * route.seg[i];

  // Deflection of the closest vertex, if the projection sits near one.
  const distToStart = best.t * route.seg[i];
  const distToEnd = (1 - best.t) * route.seg[i];
  let nearVertexDeflection = 0;
  if (distToStart < 30) nearVertexDeflection = Math.max(nearVertexDeflection, route.turn[i] || 0);
  if (distToEnd < 30) nearVertexDeflection = Math.max(nearVertexDeflection, route.turn[i + 1] || 0);

  return {
    segIndex: i,
    t: best.t,
    distFromRouteM: best.dist,
    alongM,
    lat: best.lat,
    lon: best.lon,
    segBearing: route.brg[i],
    nearVertexDeflection,
  };
}
