/* The updater's decision logic.
 *
 * Worth testing hard and in isolation: this code runs before the window opens
 * and decides which copy of the app the user is about to see. Getting it wrong
 * is the one bug class that cannot be fixed by shipping an update.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const U = require('../electron/update.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; console.error('FAIL ' + name + '\n  ' + e.message); }
}

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apparel-update-test-'));
}

function put(dir, rel, body) {
  const f = path.join(dir, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body === undefined ? 'x' : body);
}

function plantSource(userData, version) {
  const dir = path.join(userData, 'source', 'versions', version);
  put(dir, 'index.html');
  put(dir, 'style.css');
  put(dir, path.join('src', 'app.js'));
  return dir;
}

function state(userData, name, value) {
  put(path.join(userData, 'source'), name, JSON.stringify(value));
}

function readState(userData, name) {
  const f = path.join(userData, 'source', name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/* ---------- version comparison ---------- */

t('cmp orders by number, not by string', () => {
  assert.strictEqual(U.cmp('2.10.0', '2.9.0'), 1);
  assert.strictEqual(U.cmp('2.9.0', '2.10.0'), -1);
});
t('cmp treats equal versions as equal', () => {
  assert.strictEqual(U.cmp('2.1.0', '2.1.0'), 0);
});
t('cmp pads missing components with zero', () => {
  assert.strictEqual(U.cmp('2.1', '2.1.0'), 0);
  assert.strictEqual(U.cmp('2.1.1', '2.1'), 1);
});
t('cmp survives rubbish', () => {
  assert.strictEqual(U.cmp('', '0.0.0'), 0);
  assert.strictEqual(U.cmp(undefined, '0'), 0);
});

/* ---------- what gets run ---------- */

t('a fresh install runs the bundled source', () => {
  const ud = sandbox();
  const r = U.resolveOverlay(ud, '2.1.0');
  assert.strictEqual(r.dir, null);
  assert.strictEqual(r.version, '2.1.0');
});

t('a downloaded update is promoted on the next launch', () => {
  const ud = sandbox();
  const dir = plantSource(ud, '2.2.0');
  state(ud, 'pending.json', { version: '2.2.0', minShell: '2.1.0' });
  const r = U.resolveOverlay(ud, '2.1.0');
  assert.strictEqual(r.dir, dir);
  assert.strictEqual(r.version, '2.2.0');
  assert.deepStrictEqual(readState(ud, 'active.json'), { version: '2.2.0', minShell: '2.1.0' });
  assert.strictEqual(readState(ud, 'pending.json'), null, 'pending should be consumed');
});

t('an active update keeps being used on later launches', () => {
  const ud = sandbox();
  const dir = plantSource(ud, '2.2.0');
  state(ud, 'active.json', { version: '2.2.0', minShell: '2.1.0' });
  assert.strictEqual(U.resolveOverlay(ud, '2.1.0').dir, dir);
  assert.strictEqual(U.resolveOverlay(ud, '2.1.0').dir, dir);
});

t('a half-unpacked update is ignored', () => {
  const ud = sandbox();
  const dir = path.join(ud, 'source', 'versions', '2.2.0');
  put(dir, 'index.html');           // no style.css, no src/app.js
  state(ud, 'active.json', { version: '2.2.0' });
  const r = U.resolveOverlay(ud, '2.1.0');
  assert.strictEqual(r.dir, null);
  assert.strictEqual(readState(ud, 'active.json'), null, 'the bad pointer should be cleared');
});

t('source needing a newer shell is not run', () => {
  const ud = sandbox();
  plantSource(ud, '3.0.0');
  state(ud, 'active.json', { version: '3.0.0', minShell: '3.0.0' });
  assert.strictEqual(U.resolveOverlay(ud, '2.1.0').dir, null);
});

t('pending source needing a newer shell is not promoted', () => {
  const ud = sandbox();
  plantSource(ud, '3.0.0');
  state(ud, 'pending.json', { version: '3.0.0', minShell: '3.0.0' });
  assert.strictEqual(U.resolveOverlay(ud, '2.1.0').dir, null);
  assert.strictEqual(readState(ud, 'active.json'), null);
});

/* ---------- recovering from an update that does not start ---------- */

t('a launch that never reported in blocks that version and falls back', () => {
  const ud = sandbox();
  const dir = plantSource(ud, '2.2.0');
  state(ud, 'active.json', { version: '2.2.0' });
  state(ud, 'booting.json', { version: '2.2.0', at: Date.now() });

  const r = U.resolveOverlay(ud, '2.1.0');
  assert.strictEqual(r.dir, null, 'must fall back to the bundled source');
  assert.strictEqual(r.recovered, '2.2.0');
  assert.deepStrictEqual(readState(ud, 'blocked.json'), ['2.2.0']);
  assert.strictEqual(fs.existsSync(dir), false, 'the bad source should be deleted');
  assert.strictEqual(readState(ud, 'booting.json'), null);
});

t('a blocked version is never picked up again', () => {
  const ud = sandbox();
  plantSource(ud, '2.2.0');
  state(ud, 'blocked.json', ['2.2.0']);
  state(ud, 'pending.json', { version: '2.2.0' });
  assert.strictEqual(U.resolveOverlay(ud, '2.1.0').dir, null);
});

t('a good launch clears the marker', () => {
  const ud = sandbox();
  U.markBooting(ud, '2.2.0');
  assert.ok(readState(ud, 'booting.json'));
  U.markAlive(ud);
  assert.strictEqual(readState(ud, 'booting.json'), null);
  // ...so the next launch keeps the update rather than blocking it.
  plantSource(ud, '2.2.0');
  state(ud, 'active.json', { version: '2.2.0' });
  assert.ok(U.resolveOverlay(ud, '2.1.0').dir);
});

t('running the bundled source leaves no marker to trip over', () => {
  const ud = sandbox();
  U.markBooting(ud, null);
  assert.strictEqual(readState(ud, 'booting.json'), null);
});

t('markAlive on a fresh profile does not throw', () => {
  U.markAlive(sandbox());
});

/* ---------- going back ---------- */

t('revert drops both pointers and keeps the files', () => {
  const ud = sandbox();
  const dir = plantSource(ud, '2.2.0');
  state(ud, 'active.json', { version: '2.2.0' });
  state(ud, 'pending.json', { version: '2.3.0' });
  U.revert(ud);
  assert.strictEqual(readState(ud, 'active.json'), null);
  assert.strictEqual(readState(ud, 'pending.json'), null);
  assert.ok(fs.existsSync(dir), 'revert is not a delete');
  assert.strictEqual(U.resolveOverlay(ud, '2.1.0').dir, null);
});

/* ---------- the overlay list ---------- */

t('only the renderer source is ever replaced from the internet', () => {
  assert.deepStrictEqual(U.OVERLAY, ['index.html', 'style.css', 'src']);
  assert.ok(U.OVERLAY.indexOf('electron') < 0, 'the main process must not be updatable');
  assert.ok(U.OVERLAY.indexOf('node_modules') < 0);
});

t('the repo it updates from is fixed in code, not taken from a file', () => {
  assert.ok(/^[\w.-]+\/[\w.-]+$/.test(U.REPO));
  assert.ok(U.RELEASES.startsWith('https://github.com/'));
});

console.log('update: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
