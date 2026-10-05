import assert from 'node:assert/strict';
import {
  rotationMatrix, screenAxesInEarth, deviceToScreen, vehicleFrame, rollPitch, vehicleHeading,
  gravityUpFromMatrix, GravityFilter, LeanFilter, normalize, DEFAULT_MOUNT_UP, snapScreenAngle,
} from '../orientation.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sc = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const angDiff = (a, b) => ((b - a + 540) % 360) - 180;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: got ${a.toFixed(2)} expected ${b} ±${tol}`);

/** Build the earth-frame rotation matrix of a phone mounted (default mount) on a bike
 *  with given heading/roll/pitch, with the screen rotated by thetaDeg. */
function phoneR({ heading, roll, pitch }, thetaDeg) {
  const psi = heading * D2R;
  let f = [Math.sin(psi), Math.cos(psi), 0];
  let u = [0, 0, 1];
  let r = [Math.cos(psi), -Math.sin(psi), 0];
  // Tait-Bryan yaw -> pitch -> roll: roll is about the bike's own forward axis (applied last).
  const th = pitch * D2R;
  const f2 = add(sc(f, Math.cos(th)), sc(u, Math.sin(th)));
  const u2 = add(sc(u, Math.cos(th)), sc(f, -Math.sin(th)));
  const phi = roll * D2R;
  const u1 = add(sc(u2, Math.cos(phi)), sc(r, Math.sin(phi)));
  const r1 = add(sc(r, Math.cos(phi)), sc(u2, -Math.sin(phi)));
  const sRight = r1, sUp = u1, sOut = sc(f2, -1);
  const t = thetaDeg * D2R;
  const xd = add(sc(sRight, Math.cos(t)), sc(sUp, Math.sin(t)));
  const yd = add(sc(sRight, -Math.sin(t)), sc(sUp, Math.cos(t)));
  const zd = sOut;
  return [[xd[0], yd[0], zd[0]], [xd[1], yd[1], zd[1]], [xd[2], yd[2], zd[2]]];
}

const frame = vehicleFrame(DEFAULT_MOUNT_UP);

// 1. rotationMatrix: orthonormal + flat phone convention (alpha=0 -> top points north)
{
  const R = rotationMatrix(30, 20, -15);
  const col = (i) => [R[0][i], R[1][i], R[2][i]];
  for (let i = 0; i < 3; i++) near(Math.hypot(...col(i)), 1, 1e-9, 'unit column');
  near(col(0)[0] * col(1)[0] + col(0)[1] * col(1)[1] + col(0)[2] * col(1)[2], 0, 1e-9, 'orthogonal');
  const flat = rotationMatrix(0, 0, 0);
  near(flat[1][1], 1, 1e-9, 'alpha=0 flat: device top -> north');
  const west = rotationMatrix(90, 0, 0);
  near(west[0][1], -1, 1e-9, 'alpha=90 flat: device top -> west (CCW)');
}

// 2. Heading is invariant to screen angle, for every heading, roll and pitch
for (const theta of [0, 90, 180, 270]) {
  for (const hdg of [0, 45, 90, 180, 270, 315]) {
    for (const roll of [-30, 0, 15]) {
      for (const pitch of [0, 8]) {
        const R = phoneR({ heading: hdg, roll, pitch }, theta);
        const axes = screenAxesInEarth(R, theta);
        const vh = vehicleHeading(axes, frame, false);
        near(Math.abs(angDiff(vh.heading, hdg)), 0, 0.01, `heading θ=${theta} ψ=${hdg} φ=${roll} p=${pitch}`);
      }
    }
  }
}

// 3. Roll/pitch acceptance tests: same value in portrait and both landscapes
for (const theta of [0, 90, 180, 270]) {
  for (const [roll, pitch] of [[0, 0], [15, 0], [-15, 0], [0, 7], [30, 0], [-45, 0], [15, 6], [-20, -5]]) {
    const R = phoneR({ heading: 123, roll, pitch }, theta);
    const g = deviceToScreen(gravityUpFromMatrix(R), theta);
    const rp = rollPitch(g, frame);
    near(rp.roll, roll, 0.01, `roll θ=${theta}`);
    near(rp.pitch, pitch, 0.01, `pitch θ=${theta}`);
  }
}

// 4. Mount calibration: phone leaned back 25° in the holder; after calibrating upright, readings are 0 and roll still right
{
  const tilt = 25 * D2R;
  // earth-up in screen coords when the screen is tilted back by 'tilt'
  const mountUp = normalize([0, Math.cos(tilt), Math.sin(tilt)]);
  const fr = vehicleFrame(mountUp);
  const gUpright = mountUp;
  const rp0 = rollPitch(gUpright, fr);
  near(rp0.roll, 0, 1e-6, 'calibrated upright roll');
  near(rp0.pitch, 0, 1e-6, 'calibrated upright pitch');
  const uncal = rollPitch(gUpright, frame);
  near(Math.abs(uncal.pitch), 25, 0.01, 'uncalibrated shows the mount tilt as pitch');
  // lean right 20° about the bike's forward axis, phone tilted back
  const b = fr;
  const phi = 20 * D2R;
  const gLean = normalize(add(sc(b.up, Math.cos(phi)), sc(b.right, -Math.sin(phi))));
  const rp = rollPitch(gLean, fr);
  near(rp.roll, 20, 0.01, 'calibrated lean right');
  near(rp.pitch, 0, 0.01, 'calibrated lean leaves pitch alone');
}

// 5. Flat-mounted phone (screen up, top = forward): heading from screen top
{
  const frFlat = vehicleFrame([0, 0, 1]);
  for (const hdg of [0, 90, 200]) {
    // flat phone, top pointing along heading: alpha such that top -> hdg => alpha = 360 - hdg
    const R = rotationMatrix((360 - hdg) % 360, 0, 0);
    const axes = screenAxesInEarth(R, 0);
    const vh = vehicleHeading(axes, frFlat, true);
    near(Math.abs(angDiff(vh.heading, hdg)), 0, 0.01, `flat-mount heading ${hdg}`);
    const rp = rollPitch(deviceToScreen(gravityUpFromMatrix(R), 0), frFlat);
    near(rp.roll, 0, 1e-6, 'flat mount roll'); near(rp.pitch, 0, 1e-6, 'flat mount pitch');
  }
}

// 6. Rotating portrait -> landscape keeps every value (no jump)
{
  const pose = { heading: 77, roll: 12, pitch: 3 };
  const out = [0, 90, 270, 180].map((th) => {
    const R = phoneR(pose, th);
    const axes = screenAxesInEarth(R, th);
    const rp = rollPitch(deviceToScreen(gravityUpFromMatrix(R), th), frame);
    return { h: vehicleHeading(axes, frame, false).heading, ...rp };
  });
  out.forEach((o) => {
    near(Math.abs(angDiff(o.h, 77)), 0, 0.01, 'rotate heading');
    near(o.roll, 12, 0.01, 'rotate roll');
    near(o.pitch, 3, 0.01, 'rotate pitch');
  });
}

// 7. GravityFilter: gyro integration tracks a rotation that the accelerometer lags on
{
  const gf = new GravityFilter();
  gf.orientationCorrect([0, 1, 0]);
  // rotate about device z by 30 deg/s for 1 s at 100 Hz: earth-up in device frame turns about z
  const w = 30 * D2R;
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 0.01; gf.gyroPredict([0, 0, w], t); }
  const g = gf.value;
  const ang = Math.atan2(g[0], g[1]) * R2D; // angle of gravity in device x-y plane
  near(Math.abs(ang), 30, 1.0, 'gyro integrates 30deg in 1 s');
  // sign convention: device turning CCW about +z (seen from the viewer) moves earth-up toward +x of the device
  ok(g[0] > 0, 'gyro sign: positive z-rate moves gravity toward +x in the device frame');
}

// 7b. Hard re-sync after a large disagreement (e.g. phone turned 180° while the gyro was silent)
{
  const gf = new GravityFilter();
  gf.orientationCorrect([0, 1, 0]);
  for (let i = 0; i < 4; i++) gf.orientationCorrect([0, -1, 0]); // antipodal: linear blending would stall near 0
  const g = gf.value;
  ok(g[1] < -0.99, `snaps to the new orientation instead of stalling (${g.map((v) => v.toFixed(2))})`);
  const gf2 = new GravityFilter();
  gf2.orientationCorrect([0, 1, 0]);
  for (let i = 0; i < 10; i++) gf2.orientationCorrect(normalize([Math.sin(15 * D2R), Math.cos(15 * D2R), 0]));
  ok(Math.atan2(gf2.value[0], gf2.value[1]) * R2D > 10, 'a 15° disagreement converges quickly');
}

// 8. GravityFilter: accel sign auto-detect (opposite-sign platform)
{
  const gf = new GravityFilter();
  for (let i = 0; i < 30; i++) {
    gf.orientationCorrect([0.2588, 0.9659, 0]);
    gf.accelCorrect([-2.538, -9.472, 0], [0.2588, 0.9659, 0]); // reversed sign reading
  }
  ok(gf.accelSign === -1, 'accel sign detected as reversed');
  const g = gf.value;
  near(g[0], 0.2588, 0.02, 'gravity x after sign fix');
}

// 9. LeanFilter hysteresis (+4 enter / +2 exit, -4 enter / -2 exit), deadband, no jitter flipping
{
  const lf = new LeanFilter({ lowAlpha: 1, highAlpha: 1 }); // disable smoothing to isolate the logic
  const dirAt = (r) => lf.push(r, 0, 0.05).rollDir;
  ok(dirAt(0) === 'level', 'start level');
  ok(dirAt(3.5) === 'level', '3.5 not enough to enter');
  ok(dirAt(4.5) === 'right', '4.5 enters right');
  ok(dirAt(3) === 'right', 'stays right at 3');
  ok(dirAt(2.2) === 'right', 'stays right at 2.2');
  ok(dirAt(1.9) === 'level', 'leaves right below 2');
  ok(dirAt(-3.9) === 'level', '-3.9 not enough for left');
  ok(dirAt(-4.2) === 'left', '-4.2 enters left');
  ok(dirAt(-3) === 'left', 'stays left at -3');
  ok(dirAt(-2.1) === 'left', 'stays left at -2.1');
  ok(dirAt(-1.8) === 'level', 'leaves left above -2');
  // noise around the threshold must not flip direction every sample
  let flips = 0, prev = dirAt(0);
  for (let i = 0; i < 200; i++) { const d = dirAt(4 + Math.sin(i * 1.7) * 0.8); if (d !== prev) flips++; prev = d; }
  ok(flips <= 2, `noise around +4 flips ${flips} times (<=2)`);
  // deadband
  const lf2 = new LeanFilter({ lowAlpha: 1, highAlpha: 1 });
  ok(lf2.push(0.6, 0.4, 0.05).roll === 0, 'deadband zeroes 0.6°');
  ok(lf2.push(2.5, 0, 0.05).roll === 2.5, '2.5° passes the deadband');
}

// 10. LeanFilter responsiveness: a real 20° lean is reached quickly
{
  const lf = new LeanFilter();
  let v = 0, n = 0;
  while (Math.abs(v - 20) > 1 && n < 400) { v = lf.push(20, 0, 1 / 20).rollSmooth; n++; }
  ok(n <= 14, `reaches ~20° within 0.7 s (took ${n} samples at 20 Hz)`);
}

ok(snapScreenAngle(88) === 90 && snapScreenAngle(-90) === 270 && snapScreenAngle(361) === 0, 'snap screen angle');

console.log(`orientation.test: ${passed} assertions passed`);
