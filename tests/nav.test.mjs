import assert from 'node:assert/strict';
import { buildRouteIndex, matchToRoute, destinationPoint, haversineM } from '../geo.js';
import { NavigationEngine, NAV_STATE } from '../navigation.js';
import { ManeuverTracker, MANEUVER_STATE, MANEUVER_TYPE, voiceText, speakDistance, formatDistance, maneuverIconSvg } from '../maneuver.js';
import { makeRoute, walk, fakeMap, stubFetch, rng, gauss } from './helpers.mjs';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m}: got ${a} expected ${b} ±${tol}`);

/* ---------- 1. nearest point on SEGMENT, not nearest vertex ---------- */
{
  const a = [106.8, -6.2];
  const b = destinationPoint(-6.2, 106.8, 90, 1000);
  const idx = buildRouteIndex([a, [b.lon, b.lat]]);
  const mid = destinationPoint(-6.2, 106.8, 90, 500);
  const off = destinationPoint(mid.lat, mid.lon, 0, 10); // 10 m north of mid-segment
  const m = matchToRoute(off.lat, off.lon, idx);
  near(m.distFromRouteM, 10, 0.2, 'lateral distance to a 1 km segment (vertices are 500 m away)');
  near(m.alongM, 500, 1, 'cumulative distance from the projection point');
  const beyond = destinationPoint(-6.2, 106.8, 270, 50);
  const m2 = matchToRoute(beyond.lat, beyond.lon, idx);
  near(m2.alongM, 0, 0.5, 'point before start clamps to start');
  near(m2.distFromRouteM, 50, 0.5, 'distance to clamped endpoint');
}

/* ---------- 2. route is self-consistent: one distance source ---------- */
const R = makeRoute();
{
  const idx = buildRouteIndex(R.coords);
  near(idx.totalM, 1300, 3, 'geometry length of synthetic route');
  const eng = new NavigationEngine(fakeMap());
  const route = eng._normalizeRoute(R.osrm);
  ok(route.distanceM === route.totalM, 'route.distanceM is the geometry length');
  ok(route.osrmDistanceM !== route.distanceM, 'OSRM distance kept only as metadata');
  ok(route.maneuvers.length === 3, `3 maneuvers (right, left, destination), got ${route.maneuvers.length}`);
  const [m1, m2, m3] = route.maneuvers;
  ok(m1.type === MANEUVER_TYPE.RIGHT && m2.type === MANEUVER_TYPE.LEFT && m3.type === MANEUVER_TYPE.DESTINATION, 'maneuver types');
  near(m1.offsetM, 600, 3, 'maneuver 1 offset'); near(m2.offsetM, 1000, 3, 'maneuver 2 offset'); near(m3.offsetM, idx.totalM, 0.5, 'destination offset');
  ok(m1.streetName === 'Jl. MH Thamrin', 'street name = road after the turn');
  ok(['type', 'modifier', 'distanceM', 'duration', 'streetName', 'coordinate', 'bearingBefore', 'bearingAfter'].every((k) => k in m1), 'required maneuver fields');
}

/* ---------- 3. maneuver tracker states ---------- */
{
  const eng = new NavigationEngine(fakeMap());
  const route = eng._normalizeRoute(R.osrm);
  const t = new ManeuverTracker(route.maneuvers);
  let v = t.update(100, 11);
  ok(v.state === MANEUVER_STATE.CURRENT && v.current.id === 0, 'far = CURRENT');
  ok(route.maneuvers[1].state === MANEUVER_STATE.NEXT_MANEUVER, 'following maneuver = NEXT_MANEUVER');
  v = t.update(600 - 120, 11);
  ok(v.state === MANEUVER_STATE.APPROACHING, '120 m before = APPROACHING');
  v = t.update(600 - 15, 11);
  ok(v.state === MANEUVER_STATE.TURN_NOW, '15 m before = TURN_NOW');
  v = t.update(600 + 25, 11);
  ok(v.passed.length === 1 && v.current.id === 1, 'maneuver PASSED then auto advance');
  ok(route.maneuvers[0].state === MANEUVER_STATE.PASSED, 'state PASSED recorded');
  ok(v.state === MANEUVER_STATE.CURRENT, 'next maneuver is CURRENT again');
}

/* ---------- 4. full noisy ride: turn-by-turn, announcements once, no false reroute, arrival ---------- */
{
  const calls = stubFetch(R.osrm);
  const fm = fakeMap();
  const eng = new NavigationEngine(fm);
  const events = [];
  eng.on((e) => events.push(e));
  await eng.startTo(R.dest.lat, R.dest.lon, 'Tujuan', R.start.lat, R.start.lon);
  ok(calls[0].includes('steps=true'), 'routing request uses steps=true');
  ok(events.some((e) => e.type === 'route-ready'), 'route-ready emitted');

  const rand = rng(7);
  const fixes = walk(R.coords, 11);
  let t = Date.now();
  const log = [];
  for (const f of fixes) {
    t += 1000;
    const n1 = destinationPoint(f.lat, f.lon, rand() * 360, Math.abs(gauss(rand)) * 5); // ~5 m noise
    const slowing = f.along > 1180; // the rider brakes for the destination
    eng.update(n1.lat, n1.lon, slowing ? 8 : 40, { accuracy: 8, heading: null, headingValid: false, now: t });
    log.push(f.along);
    if (eng.state === NAV_STATE.IDLE) break;
  }
  // rider stops at the destination: GPS keeps reporting fixes
  for (let i = 0; i < 4 && eng.state !== NAV_STATE.IDLE; i++) {
    t += 1000;
    const n1 = destinationPoint(R.dest.lat, R.dest.lon, rand() * 360, 3);
    eng.update(n1.lat, n1.lon, 1, { accuracy: 8, now: t });
  }
  const announces = events.filter((e) => e.type === 'announce').map((e) => `${e.maneuver.id}:${e.stage}`);
  ok(announces.join() === '0:far,0:near,0:now,1:far,1:near,1:now', `announcements once each, in order: ${announces.join()}`);
  ok(!events.some((e) => e.type === 'rerouting'), 'GPS noise did not trigger a reroute');
  ok(events.filter((e) => e.type === 'maneuver-passed').length === 2, 'both turns completed');
  const ia = events.findIndex((e) => e.type === 'approaching-destination');
  const ib = events.findIndex((e) => e.type === 'arrived');
  ok(ia >= 0 && ib > ia, 'APPROACHING_DESTINATION happens before ARRIVED');
  const lastProg = events.filter((e) => e.type === 'progress').slice(-1)[0];
  ok(lastProg.state === NAV_STATE.ARRIVED, 'final progress carries ARRIVED');
  const approachProg = events.filter((e) => e.type === 'progress' && e.state === NAV_STATE.APPROACHING_DESTINATION);
  ok(approachProg.length >= 1 && approachProg[0].remainingM > 60, 'approaching starts well before the destination');
  // remaining distance must be monotonically non-increasing (within noise) and consistent with geometry
  const rem = events.filter((e) => e.type === 'progress').map((e) => e.remainingM);
  let worst = 0; for (let i = 1; i < rem.length; i++) worst = Math.max(worst, rem[i] - rem[i - 1]);
  ok(worst < 25, `remaining distance never jumps backwards (max +${worst.toFixed(1)} m)`);
  ok(fm.state.cleared >= 1, 'route cleared after arrival');
}

/* ---------- 5. arrival is NOT triggered by passing within 25 m at speed / single fix ---------- */
{
  stubFetch(R.osrm);
  const eng = new NavigationEngine(fakeMap());
  const events = []; eng.on((e) => events.push(e));
  await eng.startTo(R.dest.lat, R.dest.lon, 'T', R.start.lat, R.start.lon);
  let t = Date.now();
  const tail = walk(R.coords, 11, 1000);
  for (const f of tail.slice(0, -1)) { t += 1000; eng.update(f.lat, f.lon, 60, { accuracy: 6, now: t }); }
  ok(!events.some((e) => e.type === 'arrived'), 'no arrival while still doing 60 km/h before the end');
  // a single in-radius fix must not arrive; two slow ones must
  t += 1000; eng.update(R.dest.lat, R.dest.lon, 3, { accuracy: 6, now: t });
  ok(!events.some((e) => e.type === 'arrived'), 'one fix is not enough');
  t += 1000; eng.update(R.dest.lat, R.dest.lon, 2, { accuracy: 6, now: t });
  ok(events.some((e) => e.type === 'arrived'), 'two consecutive slow fixes at destination arrive');
}

/* ---------- 6. adaptive + validated off-route ---------- */
async function offRouteScenario(fn) {
  const calls = stubFetch(R.osrm);
  const eng = new NavigationEngine(fakeMap());
  const events = []; eng.on((e) => events.push(e));
  await eng.startTo(R.dest.lat, R.dest.lon, 'T', R.start.lat, R.start.lon);
  eng.routeStartedAt = Date.now() - 60000; // past the grace window
  const base = walk(R.coords, 11, 200, 260)[0];
  const side = (m) => destinationPoint(base.lat, base.lon, 0, m);
  let t = Date.now();
  const step = (m, acc = 8, speed = 40, dt = 1000) => { t += dt; const p = side(m); eng.update(p.lat, p.lon, speed, { accuracy: acc, now: t }); };
  await fn({ eng, events, step, calls, side });
}
await offRouteScenario(async ({ eng, events, step, calls }) => {
  step(0); step(0);
  step(130, 40);          // one terrible fix
  step(0); step(0);
  ok(!events.some((e) => e.type === 'rerouting'), 'a single bad GPS reading never reroutes');
  ok(calls.length === 1, 'no second routing request after one bad fix');
});
await offRouteScenario(async ({ eng, events, step, calls }) => {
  for (let i = 0; i < 10; i++) step(110, 90);   // very poor accuracy: ignored entirely
  ok(!events.some((e) => e.type === 'rerouting'), 'fixes with accuracy > 60 m are ignored for off-route');
});
await offRouteScenario(async ({ eng, events, step, calls }) => {
  for (let i = 0; i < 4; i++) step(70, 10);     // 70 m away but heading back soon
  step(40, 10); step(20, 10); step(5, 10);
  ok(!events.some((e) => e.type === 'rerouting'), 'converging back to the route cancels the suspicion');
  ok(events.some((e) => e.type === 'off-route-suspect'), 'suspect state was entered');
});
await offRouteScenario(async ({ eng, events, step, calls }) => {
  for (let i = 0; i < 8; i++) step(110, 8);     // steadily 110 m away
  ok(events.filter((e) => e.type === 'rerouting').length === 1, 'sustained deviation reroutes exactly once');
  await new Promise((r) => setTimeout(r, 10));
  ok(calls.length === 2, 'one extra routing request');
  for (let i = 0; i < 6; i++) step(110, 8);
  ok(events.filter((e) => e.type === 'rerouting').length === 1, 'cooldown prevents reroute ping-pong');
});
await offRouteScenario(async ({ eng, events, step }) => {
  for (let i = 0; i < 10; i++) step(110, 8, 0);  // parked with drift: no reroute
  ok(!events.some((e) => e.type === 'rerouting'), 'stationary GPS drift never reroutes');
});
{
  // threshold adapts to accuracy, speed and corners (never a flat 60 m)
  const eng = new NavigationEngine(fakeMap());
  const m = { nearVertexDeflection: 0, segBearing: 90 };
  const a = eng._offRouteThreshold(m, 5, 20, false, null);
  const b = eng._offRouteThreshold(m, 30, 20, false, null);
  const c = eng._offRouteThreshold(m, 5, 90, false, null);
  const d = eng._offRouteThreshold({ ...m, nearVertexDeflection: 90 }, 5, 20, false, null);
  ok(b > a && c > a && d > a, `threshold grows with accuracy (${a.toFixed(0)}->${b.toFixed(0)}), speed (->${c.toFixed(0)}) and corners (->${d.toFixed(0)})`);
  ok(a >= 35 && a !== 60, `minimum threshold honoured (${a.toFixed(0)} m)`);
  const wrong = eng._offRouteThreshold(m, 5, 40, true, 270);
  const right = eng._offRouteThreshold(m, 5, 40, true, 90);
  ok(wrong < right, 'wrong-direction heading tightens the threshold');
}

/* ---------- 7. voice text + helpers ---------- */
{
  const m = { type: MANEUVER_TYPE.RIGHT, exit: null };
  ok(voiceText(m, 'far', 200) === '200 meter lagi, belok kanan.', voiceText(m, 'far', 200));
  ok(voiceText(m, 'near', 50) === '50 meter lagi, belok kanan.', 'near phrase');
  ok(voiceText(m, 'now') === 'Belok kanan sekarang.', 'now phrase');
  ok(speakDistance(1240) === '1,2 kilometer', speakDistance(1240));
  ok(formatDistance(195) === '200 m' && formatDistance(1840) === '1,8 km', 'formatDistance');
  ['straight', 'left', 'right', 'slight-left', 'slight-right', 'sharp-left', 'sharp-right', 'uturn', 'roundabout', 'destination']
    .forEach((t) => ok(maneuverIconSvg(t).startsWith('<svg') && !/NaN/.test(maneuverIconSvg(t)), `icon ${t}`));
}

console.log(`nav.test: ${passed} assertions passed`);
