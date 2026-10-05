import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };

const jsFiles = fs.readdirSync(root).filter((f) => f.endsWith('.js') && f !== 'service-worker.js');

// 1. every relative import resolves, and every named import is exported by the target
const exportsOf = (src) => {
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|class|const|let|var)\s+([A-Za-z0-9_$]+)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach((n) => set.add(n.trim().split(/\s+as\s+/).pop()));
  return set;
};
for (const f of jsFiles) {
  const src = read(f);
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/g)) {
    const target = m[2].replace('./', '');
    ok(fs.existsSync(path.join(root, target)), `${f}: import target ${target} exists`);
    const ex = exportsOf(read(target));
    m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((name) => ok(ex.has(name), `${f}: '${name}' is exported by ${target}`));
  }
}

// 2. every getElementById in JS exists in index.html
const html = read('index.html');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
for (const f of jsFiles) {
  // 'brightness-overlay' is created on demand by ui.js (original design), so it is not in the HTML.
  for (const m of read(f).matchAll(/getElementById\('([^']+)'\)/g)) if (m[1] !== 'brightness-overlay') ok(ids.has(m[1]), `${f}: #${m[1]} exists in index.html`);
}

// 3. every CSS var() is defined somewhere
const css = read('style.css');
const defined = new Set([...css.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]));
for (const m of css.matchAll(/var\(--([\w-]+)/g)) ok(defined.has(m[1]), `CSS var --${m[1]} defined`);
ok(css.split('{').length === css.split('}').length, 'CSS braces balanced');

// 4. HTML local references exist
for (const m of html.matchAll(/(?:src|href)="(?!https?:|#|data:)([^"?#]+)"/g)) ok(fs.existsSync(path.join(root, m[1])), `index.html reference ${m[1]} exists`);

// 5. manifest icons + shortcuts exist
const manifest = JSON.parse(read('manifest.json'));
for (const i of manifest.icons) ok(fs.existsSync(path.join(root, i.src)), `manifest icon ${i.src} exists`);
for (const s of manifest.shortcuts) for (const i of s.icons || []) ok(fs.existsSync(path.join(root, i.src)), `shortcut icon ${i.src} exists`);

// 6. service worker precache: every entry exists; every app module + stylesheet is precached
const sw = read('service-worker.js');
const shell = [...sw.slice(sw.indexOf('APP_SHELL'), sw.indexOf('];', sw.indexOf('APP_SHELL'))).matchAll(/'(\.\/[^']*)'/g)].map((m) => m[1]);
for (const e of shell) if (e !== './') ok(fs.existsSync(path.join(root, e)), `precache entry ${e} exists`);
for (const f of [...jsFiles, 'style.css', 'index.html', 'manifest.json']) ok(shell.includes(`./${f}`), `${f} is precached`);
for (const i of manifest.icons) ok(shell.includes(`./${i.src}`), `icon ${i.src} is precached`);
ok(/allSettled/.test(sw), 'precache cannot fail as a whole');

// 7. loading screen untouched vs the original upload
const orig = process.env.ORIG_DIR;
if (orig && fs.existsSync(orig)) {
  const seg = (s, a, b) => s.slice(s.indexOf(a), s.indexOf(b));
  ok(seg(fs.readFileSync(path.join(orig, 'index.html'), 'utf8'), 'BOOT SCREEN', 'APP SHELL') === seg(html, 'BOOT SCREEN', 'APP SHELL'), 'boot HTML identical to original');
  ok(fs.readFileSync(path.join(orig, 'boot.js'), 'utf8') === read('boot.js'), 'boot.js identical to original');
  const bootCss = (s) => s.slice(s.indexOf('\n.boot-screen {'), s.indexOf('.boot-dots'));
  ok(bootCss(fs.readFileSync(path.join(orig, 'style.css'), 'utf8')) === bootCss(css), 'boot CSS identical to original');
}
console.log(`static.test: ${passed} assertions passed`);
