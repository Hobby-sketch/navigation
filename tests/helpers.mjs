import { destinationPoint, haversineM } from '../geo.js';

/** Seeded PRNG so noisy-GPS tests are reproducible. */
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

/**
 * Synthetic city route: east 600 m, RIGHT turn (south) 400 m, LEFT turn (east) 300 m.
 * Returns { coords:[lon,lat][], osrm:{...routes[0] shaped like OSRM}, start:{lat,lon}, dest:{lat,lon} }.
 */
export function makeRoute({ stepM = 20 } = {}) {
  const start = { lat: -6.2, lon: 106.8 };
  const legs = [[90, 600], [180, 400], [90, 300]];
  const pts = [[start.lon, start.lat]];
  const vertices = [{ lat: start.lat, lon: start.lon }];
  let cur = { ...start };
  legs.forEach(([brg, len]) => {
    const n = Math.round(len / stepM);
    for (let i = 1; i <= n; i++) {
      const p = destinationPoint(cur.lat, cur.lon, brg, (len / n) * i);
      pts.push([p.lon, p.lat]);
    }
    cur = destinationPoint(cur.lat, cur.lon, brg, len);
    vertices.push({ ...cur });
  });
  const dest = vertices[vertices.length - 1];
  const step = (type, modifier, v, dist, name, before, after) => ({
    maneuver: { type, modifier, location: [v.lon, v.lat], bearing_before: before, bearing_after: after },
    name, distance: dist, duration: dist / 11,
  });
  const steps = [
    step('depart', 'right', vertices[0], 600, 'Jl. Sudirman', 0, 90),
    step('turn', 'right', vertices[1], 400, 'Jl. MH Thamrin', 90, 180),
    step('turn', 'left', vertices[2], 300, 'Jl. Gatot Subroto', 180, 90),
    step('arrive', null, vertices[3], 0, 'Jl. Gatot Subroto', 90, 0),
  ];
  const total = 1300;
  return {
    coords: pts, start, dest, vertices,
    osrm: { distance: total * 1.003, duration: total / 11, geometry: { type: 'LineString', coordinates: pts }, legs: [{ steps }] },
  };
}

/** Walk the route at `speedMs`, one fix per second; returns [{lat,lon,t,along}] */
export function walk(coords, speedMs = 11, from = 0, to = Infinity) {
  const out = [];
  let acc = 0;
  const segs = [];
  for (let i = 1; i < coords.length; i++) {
    const d = haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    segs.push({ a: coords[i - 1], b: coords[i], d, start: acc });
    acc += d;
  }
  const total = acc;
  for (let s = from; s <= Math.min(total, to); s += speedMs) {
    const seg = segs.find((g) => s >= g.start && s <= g.start + g.d + 1e-6) || segs[segs.length - 1];
    const t = seg.d > 0 ? (s - seg.start) / seg.d : 0;
    out.push({ lat: seg.a[1] + (seg.b[1] - seg.a[1]) * t, lon: seg.a[0] + (seg.b[0] - seg.a[0]) * t, along: s });
  }
  return out;
}

export function fakeMap() {
  const state = { cleared: 0, data: null, fit: 0 };
  return {
    state,
    map: { getSource: () => ({ setData: (d) => { state.data = d; } }), fitBounds: () => { state.fit++; } },
    clearRoute: () => { state.cleared++; },
  };
}

export function stubFetch(routeJson) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({ routes: [routeJson] }) };
  };
  return calls;
}
