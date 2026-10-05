import assert from 'node:assert/strict';
import { HeadingFusion } from '../heading.js';

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
const near = (a, b, tol, m) => ok(Math.abs(angDiff(a, b)) <= tol, `${m}: got ${a?.toFixed?.(1)} expected ${b} ±${tol}`);

function sim() {
  let t = 1_000_000;
  const hf = new HeadingFusion({ now: () => t });
  return {
    hf,
    advance(ms, tick = 66) { const end = t + ms; while (t < end) { t += tick; hf.update(t); } },
    gps(h, speed, acc = 6) { hf.setGps({ headingDeg: h, speedKmh: speed, accuracyM: acc, timestampMs: t }); },
    compass(h, conf = 0.85, source = 'absolute', screenAngle = 0) { hf.setCompass({ headingDeg: h, confidence: conf, source, screenAngle, timestampMs: t }); },
    now: () => t,
  };
}

// 1. Stopped: compass drives the heading, junk GPS bearing is ignored
{
  const s = sim();
  for (let i = 0; i < 40; i++) { s.compass(90 + Math.sin(i) * 2); s.gps(250 + i * 3, 0.5); s.advance(100); }
  near(s.hf.heading, 90, 6, 'stopped -> compass 90°');
  ok(s.hf.compassWeight > 0.5 && s.hf.gpsWeight < 0.05, 'compass dominates when stopped');
}

// 2. Moving fast: GPS bearing dominates even if compass disagrees (e.g. interference)
{
  const s = sim();
  for (let i = 0; i < 40; i++) { s.compass(60); s.gps(100, 45); s.advance(100); }
  near(s.hf.heading, 100, 12, 'moving -> mostly GPS 100°');
  ok(s.hf.gpsWeight > s.hf.compassWeight * 3, 'GPS weight >> compass weight at speed');
}

// 3. GPS bearing invalid (null) while moving -> compass only
{
  const s = sim();
  for (let i = 0; i < 30; i++) { s.compass(200); s.gps(null, 40); s.advance(100); }
  near(s.hf.heading, 200, 3, 'GPS invalid -> compass');
  ok(s.hf.source === 'compass', `source = ${s.hf.source}`);
}

// 4. Low-confidence data is never used: heading is HELD, confidence decays
{
  const s = sim();
  for (let i = 0; i < 30; i++) { s.compass(45); s.advance(100); }
  const held = s.hf.heading;
  for (let i = 0; i < 50; i++) { s.compass(300, 0.03); s.advance(100); } // junk, near-zero confidence
  near(s.hf.heading, held, 0.5, 'junk compass does not move the heading');
  const c0 = s.hf.confidence;
  s.advance(20000);
  ok(s.hf.confidence < c0 * 0.3, `confidence decays while holding (${c0.toFixed(2)} -> ${s.hf.confidence.toFixed(2)})`);
  near(s.hf.heading, held, 0.5, 'last heading retained');
  ok(s.hf.snapshot().valid === false, 'snapshot marked invalid after long hold');
  ok(['hold', 'none'].includes(s.hf.source), 'source reports hold');
}

// 5. Relative (non-absolute) orientation is NOT trusted as true north until GPS validates it
{
  const s = sim();
  for (let i = 0; i < 30; i++) { s.compass(10, 0.6, 'relative'); s.advance(100); }
  ok(s.hf.heading === null, 'relative orientation alone produces no heading');
  // ride at 40 km/h heading 130° while the relative yaw reads 10°: bias gets learned
  for (let i = 0; i < 60; i++) { s.compass(10, 0.6, 'relative'); s.gps(130, 40); s.advance(100); }
  near(s.hf.heading, 130, 5, 'follows GPS while learning');
  s.gps(null, 0); // stop: now only the validated relative compass
  for (let i = 0; i < 80; i++) { s.compass(10, 0.6, 'relative'); s.advance(100); }
  near(s.hf.heading, 130, 8, 'after GPS validation the relative compass is usable (bias learned)');
}

// 6. Smoothing: no lag in real turns, little jitter when steady
{
  const s = sim();
  for (let i = 0; i < 30; i++) { s.compass(0); s.gps(0, 40); s.advance(100); }
  // 90° right turn over 2 s
  let reached = null; const t0 = s.now();
  for (let i = 0; i < 60; i++) { const h = Math.min(90, i * 4.5); s.compass(h); s.gps(h, 40); s.advance(100); if (reached === null && Math.abs(angDiff(s.hf.heading, 90)) < 10) reached = s.now() - t0; }
  ok(reached !== null && reached < 3200, `turn tracked within ${reached} ms`);
  // jitter: ±3° noise at standstill
  const s2 = sim(); let seed = 3; const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < 50; i++) { s2.compass(180 + (r() - 0.5) * 6); s2.advance(100); }
  let maxStep = 0, prev = s2.hf.heading;
  for (let i = 0; i < 100; i++) { s2.compass(180 + (r() - 0.5) * 6); s2.advance(100); maxStep = Math.max(maxStep, Math.abs(angDiff(prev, s2.hf.heading))); prev = s2.hf.heading; }
  ok(maxStep < 1.5, `steady heading jitter ${maxStep.toFixed(2)}° per update (<1.5°)`);
}

// 7. Wrap-around at north is handled (350 -> 10)
{
  const s = sim();
  for (let i = 0; i < 30; i++) { s.compass(355); s.advance(100); }
  for (let i = 0; i < 30; i++) { s.compass(5); s.advance(100); }
  const h = s.hf.heading; ok(h > 350 || h < 15, `wraps correctly: ${h.toFixed(1)}`);
}

// 8. Same physical heading, portrait vs landscape bias slots are independent
{
  const s = sim();
  for (let i = 0; i < 60; i++) { s.compass(80, 0.85, 'absolute', 0); s.gps(90, 40); s.advance(100); }
  const b0 = s.hf.getBias('0');
  near(b0.angle, 10, 3, 'portrait bias learned (+10°)');
  ok(s.hf.getBias('90').n === 0, 'landscape slot untouched');
}

console.log(`heading.test: ${passed} assertions passed`);
