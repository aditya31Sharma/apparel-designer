/* The download path, end to end, against a local server standing in for GitHub.
 *
 * The decision logic is covered next door in update.test.js. This covers the
 * part that talks to the network and writes to disk: fetch the manifest, pull
 * the tarball, unpack it, keep only the source, and queue it for the next
 * launch. Reading that code is not the same as running it, and a bug in it
 * lands on every installed copy at once.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const queue = [];
function t(name, fn) { queue.push([name, fn]); }

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apparel-net-test-'));
}

/* A tarball shaped exactly the way GitHub shapes one: everything inside a
 * single directory named for the repo and the tag. */
function buildTarball(dir, name, files) {
  const stage = path.join(dir, name);
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(stage, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  const tgz = path.join(dir, name + '.tar.gz');
  execFileSync('/usr/bin/tar', ['-czf', tgz, '-C', dir, name]);
  return fs.readFileSync(tgz);
}

const GOOD_SOURCE = {
  'index.html': '<!doctype html><title>updated</title>',
  'style.css': 'body{}',
  'src/app.js': '/* updated */',
  'src/view/icons.js': '/* icons */',
  // Present in the repo, and deliberately not something an update may replace.
  'electron/main.js': 'process.exit(1)',
  'package.json': '{"name":"apparel-designer"}'
};

function serve(routes) {
  const server = http.createServer((req, res) => {
    const body = routes[req.url];
    if (body === undefined) { res.writeHead(404); res.end('no'); return; }
    if (typeof body === 'number') { res.writeHead(body); res.end('status'); return; }
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1',
    () => r({ server: server, origin: 'http://127.0.0.1:' + server.address().port })));
}

/* update.js reads the override once, at require time, so each case gets a
 * fresh copy of the module pointed at its own server. */
function updaterFor(origin) {
  const key = require.resolve('../electron/update.js');
  delete require.cache[key];
  process.env.APPAREL_UPDATE_ORIGIN = origin;
  const mod = require('../electron/update.js');
  delete require.cache[key];
  return mod;
}

function readJson(ud, name) {
  const f = path.join(ud, 'source', name);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/* ---------- the happy path ---------- */

t('a newer version is fetched, unpacked and queued', async () => {
  const tmp = sandbox(), ud = sandbox();
  const tar = buildTarball(tmp, 'apparel-designer-2.2.0', GOOD_SOURCE);
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({
      version: '2.2.0', minShell: '2.1.0', tag: 'v2.2.0', notes: 'Sharper dots' })),
    '/v2.2.0.tar.gz': tar
  });
  try {
    const U = updaterFor(origin);
    const res = await U.check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(res.state, 'ready', 'got ' + JSON.stringify(res));
    assert.strictEqual(res.version, '2.2.0');
    assert.strictEqual(res.notes, 'Sharper dots');

    const dir = path.join(ud, 'source', 'versions', '2.2.0');
    assert.ok(fs.existsSync(path.join(dir, 'index.html')));
    assert.ok(fs.existsSync(path.join(dir, 'src', 'view', 'icons.js')));
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'), '/* updated */');

    // The things an update is not allowed to touch.
    assert.strictEqual(fs.existsSync(path.join(dir, 'electron')), false,
      'the main process must never come from a download');
    assert.strictEqual(fs.existsSync(path.join(dir, 'package.json')), false);

    assert.deepStrictEqual(readJson(ud, 'pending.json'), { version: '2.2.0', minShell: '2.1.0' });
    assert.strictEqual(readJson(ud, 'active.json'), null, 'it applies on the next launch, not now');

    // ...and the next launch runs it.
    const picked = U.resolveOverlay(ud, '2.1.0');
    assert.strictEqual(picked.dir, dir);
  } finally { server.close(); }
});

t('a second check does not download the same version twice', async () => {
  const tmp = sandbox(), ud = sandbox();
  const tar = buildTarball(tmp, 'apparel-designer-2.2.0', GOOD_SOURCE);
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/app-version.json') {
      const b = Buffer.from(JSON.stringify({ version: '2.2.0', minShell: '2.1.0', tag: 'v2.2.0' }));
      res.writeHead(200, { 'Content-Length': b.length }); return res.end(b);
    }
    hits++;
    res.writeHead(200, { 'Content-Length': tar.length }); res.end(tar);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const U = updaterFor('http://127.0.0.1:' + server.address().port);
    await U.check(ud, '2.1.0', '2.1.0');
    await U.check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(hits, 1, 'the tarball should be fetched once');
  } finally { server.close(); }
});

/* ---------- the ways it should decline ---------- */

t('the same version is left alone', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '2.1.0', tag: 'v2.1.0' }))
  });
  try {
    const res = await updaterFor(origin).check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(res.state, 'current');
    assert.strictEqual(readJson(ud, 'pending.json'), null);
  } finally { server.close(); }
});

t('an older version is never installed over a newer one', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '2.0.0', tag: 'v2.0.0' }))
  });
  try {
    assert.strictEqual((await updaterFor(origin).check(ud, '2.1.0', '2.1.0')).state, 'current');
  } finally { server.close(); }
});

t('source needing a newer shell asks for a download instead', async () => {
  const tmp = sandbox(), ud = sandbox();
  const tar = buildTarball(tmp, 'apparel-designer-3.0.0', GOOD_SOURCE);
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({
      version: '3.0.0', minShell: '3.0.0', tag: 'v3.0.0' })),
    '/v3.0.0.tar.gz': tar
  });
  try {
    const res = await updaterFor(origin).check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(res.state, 'needs-download');
    assert.ok(res.url.indexOf('releases') > 0);
    assert.strictEqual(readJson(ud, 'pending.json'), null, 'nothing should have been unpacked');
  } finally { server.close(); }
});

t('a blocked version is not downloaded again', async () => {
  const tmp = sandbox(), ud = sandbox();
  fs.mkdirSync(path.join(ud, 'source'), { recursive: true });
  fs.writeFileSync(path.join(ud, 'source', 'blocked.json'), JSON.stringify(['2.2.0']));
  const tar = buildTarball(tmp, 'apparel-designer-2.2.0', GOOD_SOURCE);
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '2.2.0', tag: 'v2.2.0' })),
    '/v2.2.0.tar.gz': tar
  });
  try {
    assert.strictEqual((await updaterFor(origin).check(ud, '2.1.0', '2.1.0')).state, 'current');
  } finally { server.close(); }
});

/* ---------- the ways the network fails ---------- */

t('no server at all is reported as offline, not as a crash', async () => {
  const ud = sandbox();
  const res = await updaterFor('http://127.0.0.1:1').check(ud, '2.1.0', '2.1.0');
  assert.strictEqual(res.state, 'offline');
  assert.ok(res.reason);
});

t('a 404 on the manifest is offline', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({});
  try {
    assert.strictEqual((await updaterFor(origin).check(ud, '2.1.0', '2.1.0')).state, 'offline');
  } finally { server.close(); }
});

t('a manifest that is not JSON is offline', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({ '/app-version.json': Buffer.from('<html>oops') });
  try {
    assert.strictEqual((await updaterFor(origin).check(ud, '2.1.0', '2.1.0')).state, 'offline');
  } finally { server.close(); }
});

t('a version string that is not a version is refused', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '../../etc/passwd' }))
  });
  try {
    const res = await updaterFor(origin).check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(res.state, 'offline');
    assert.strictEqual(fs.existsSync(path.join(ud, 'source', 'versions')), false);
  } finally { server.close(); }
});

t('a missing tarball leaves nothing queued', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '2.2.0', tag: 'v2.2.0' }))
  });
  try {
    const res = await updaterFor(origin).check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(res.state, 'offline');
    assert.strictEqual(readJson(ud, 'pending.json'), null);
  } finally { server.close(); }
});

t('a tarball missing the app source is rejected', async () => {
  const tmp = sandbox(), ud = sandbox();
  const tar = buildTarball(tmp, 'apparel-designer-2.2.0', { 'README.md': 'nothing here' });
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '2.2.0', tag: 'v2.2.0' })),
    '/v2.2.0.tar.gz': tar
  });
  try {
    const res = await updaterFor(origin).check(ud, '2.1.0', '2.1.0');
    assert.strictEqual(res.state, 'offline');
    assert.strictEqual(readJson(ud, 'pending.json'), null);
  } finally { server.close(); }
});

t('something that is not a tarball is rejected', async () => {
  const ud = sandbox();
  const { server, origin } = await serve({
    '/app-version.json': Buffer.from(JSON.stringify({ version: '2.2.0', tag: 'v2.2.0' })),
    '/v2.2.0.tar.gz': Buffer.from('this is not gzip')
  });
  try {
    assert.strictEqual((await updaterFor(origin).check(ud, '2.1.0', '2.1.0')).state, 'offline');
  } finally { server.close(); }
});

/* ---------- the real manifest in this repo ---------- */

t('app-version.json here agrees with package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'app-version.json'), 'utf8'));
  assert.strictEqual(man.version, pkg.version,
    'installed copies read app-version.json; a mismatch means they update to a tag that is not there');
  assert.strictEqual(man.tag, 'v' + pkg.version);
  assert.ok(man.minShell, 'minShell has to be set or old shells run source they cannot support');
});

(async function main() {
  for (const [name, fn] of queue) {
    try { await fn(); pass++; }
    catch (e) { fail++; console.error('FAIL ' + name + '\n  ' + (e && e.message)); }
  }
  console.log('update-network: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
