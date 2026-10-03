/* Updating itself from GitHub.
 *
 * The app is not signed by Apple, and macOS will not let an unsigned bundle
 * replace itself through Squirrel: the updater checks the running app's code
 * signature before it will swap anything, and there is nothing to check. So the
 * usual electron-updater route is closed unless a paid developer account is in
 * the picture.
 *
 * What is open is that the whole interface and every effect is plain HTML, CSS
 * and JavaScript with no build step. That source can be replaced on disk and
 * picked up on the next launch, which covers the overwhelming majority of
 * changes and downloads in about a second rather than 150MB.
 *
 * So: on launch, ask GitHub what the current source version is. If it is newer,
 * fetch that tag's tarball, unpack the source into the app's data directory,
 * and serve those files in front of the bundled ones from then on. Anything
 * that changes this file, the preload, or a native dependency raises minShell
 * in the manifest, and the app tells the user to download a new build instead
 * of quietly running source its shell cannot support.
 *
 * Every launch that uses an overlay leaves a marker behind until the renderer
 * reports it is alive. Finding that marker still there on the next launch means
 * the overlay broke the app, so it is thrown away and the version blocked.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

const REPO = 'aditya31Sharma/apparel-designer';
const BRANCH = 'main';
const RELEASES = 'https://github.com/' + REPO + '/releases/latest';

/* The test suite serves a manifest and a tarball of its own, because the only
 * way to know this works is to run the whole download-unpack-promote path
 * rather than to read it. The override is restricted to a loopback address:
 * anyone able to set it could already run anything on this machine, but it
 * should not be a way to point a shipped app at somewhere on the internet. */
const LOCAL = /^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.APPAREL_UPDATE_ORIGIN || '')
  ? process.env.APPAREL_UPDATE_ORIGIN : null;

const MANIFEST_URL = LOCAL ? LOCAL + '/app-version.json'
  : 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/app-version.json';
const TARBALL = (tag) => LOCAL ? LOCAL + '/' + tag + '.tar.gz'
  : 'https://codeload.github.com/' + REPO + '/tar.gz/refs/tags/' + tag;

/* Only these come from GitHub. The main process, the preload and anything
 * native stay whatever the installed build shipped, because replacing those
 * from the internet is a different and much sharper tool. */
const OVERLAY = ['index.html', 'style.css', 'src'];

const NET_TIMEOUT = 15000;
const MAX_TARBALL = 64 * 1024 * 1024;

/* ---------- version arithmetic ---------- */

function parts(v) {
  return String(v || '0').split('.').map((n) => parseInt(n, 10) || 0);
}

function cmp(a, b) {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/* ---------- small state files ---------- */

function dirs(userData) {
  const base = path.join(userData, 'source');
  return {
    base: base,
    versions: path.join(base, 'versions'),
    active: path.join(base, 'active.json'),
    pending: path.join(base, 'pending.json'),
    booting: path.join(base, 'booting.json'),
    blocked: path.join(base, 'blocked.json')
  };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function looksComplete(dir) {
  return fs.existsSync(path.join(dir, 'index.html')) &&
         fs.existsSync(path.join(dir, 'style.css')) &&
         fs.existsSync(path.join(dir, 'src', 'app.js'));
}

/* ---------- what to run, decided before the window opens ---------- */

/* Returns { dir, version, recovered } where dir is null for the bundled
 * source. Synchronous on purpose: the answer is needed before the first
 * request reaches the static server, and it is three small file reads. */
function resolveOverlay(userData, shellVersion) {
  const d = dirs(userData);
  let blocked = readJson(d.blocked, []);
  let recovered = null;

  // A marker left over from last time means that launch never reported in.
  const stale = readJson(d.booting, null);
  if (stale && stale.version) {
    if (blocked.indexOf(stale.version) < 0) blocked.push(stale.version);
    writeJson(d.blocked, blocked);
    try { fs.unlinkSync(d.active); } catch (e) { /* already gone */ }
    try { fs.rmSync(path.join(d.versions, stale.version), { recursive: true, force: true }); }
    catch (e) { /* already gone */ }
    recovered = stale.version;
  }
  try { fs.unlinkSync(d.booting); } catch (e) { /* nothing to clear */ }

  // A download that finished on an earlier run becomes the active source now.
  const pending = readJson(d.pending, null);
  if (pending && pending.version && blocked.indexOf(pending.version) < 0 &&
      cmp(pending.minShell || '0', shellVersion) <= 0 &&
      looksComplete(path.join(d.versions, pending.version))) {
    writeJson(d.active, pending);
  }
  try { fs.unlinkSync(d.pending); } catch (e) { /* nothing to promote */ }

  const active = readJson(d.active, null);
  if (!active || !active.version || blocked.indexOf(active.version) >= 0) {
    return { dir: null, version: shellVersion, recovered: recovered };
  }
  const dir = path.join(d.versions, active.version);
  // A downloaded source no newer than this shell is what a fresh download
  // replaced. Serving it would put the old interface in front of the new app.
  if (cmp(active.version, shellVersion) <= 0 ||
      !looksComplete(dir) || cmp(active.minShell || '0', shellVersion) > 0) {
    try { fs.unlinkSync(d.active); } catch (e) { /* already gone */ }
    return { dir: null, version: shellVersion, recovered: recovered };
  }
  return { dir: dir, version: active.version, recovered: recovered };
}

/* Called once the renderer has actually finished starting up. Until this runs,
 * the launch counts as failed. */
function markAlive(userData) {
  try { fs.unlinkSync(dirs(userData).booting); } catch (e) { /* fine */ }
}

function markBooting(userData, version) {
  if (!version) return;
  writeJson(dirs(userData).booting, { version: version, at: Date.now() });
}

/* ---------- fetching ---------- */

function get(url, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    const agent = url.startsWith('http://') ? http : https;
    const req = agent.get(url, {
      headers: { 'User-Agent': 'ApparelDesigner', 'Accept': '*/*' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, url).toString(), redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_TARBALL) {
          req.destroy();
          return reject(new Error('response larger than expected'));
        }
        chunks.push(c);
      });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(NET_TIMEOUT, () => req.destroy(new Error('timed out reaching GitHub')));
    req.on('error', reject);
  });
}

function untar(file, into) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/tar', ['-xzf', file, '-C', into], { timeout: 60000 },
      (err, _out, stderr) => {
        if (err) return reject(new Error(String(stderr || err.message).trim()));
        resolve();
      });
  });
}

/* ---------- the check ---------- */

/* Never throws. The app works offline; an update that cannot be reached is not
 * an error the user needs to see. */
async function check(userData, shellVersion, runningVersion) {
  const d = dirs(userData);
  try {
    const manifest = JSON.parse((await get(MANIFEST_URL)).toString('utf8'));
    const version = String(manifest.version || '');
    if (!/^\d+(\.\d+)*$/.test(version)) throw new Error('bad version in manifest');

    if (cmp(version, runningVersion) <= 0) {
      return { state: 'current', version: runningVersion };
    }
    if ((readJson(d.blocked, []) || []).indexOf(version) >= 0) {
      return { state: 'current', version: runningVersion };
    }
    // Source that needs a newer shell than this one cannot just be dropped in.
    if (cmp(manifest.minShell || '0', shellVersion) > 0) {
      return { state: 'needs-download', version: version, url: RELEASES,
               notes: manifest.notes || '' };
    }

    const already = readJson(d.pending, null);
    if (already && already.version === version &&
        looksComplete(path.join(d.versions, version))) {
      return { state: 'ready', version: version, notes: manifest.notes || '' };
    }

    const tag = manifest.tag || ('v' + version);
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'apparel-update-'));
    try {
      const tgz = path.join(tmp, 'source.tar.gz');
      await fsp.writeFile(tgz, await get(TARBALL(tag)));
      await untar(tgz, tmp);

      // GitHub wraps the tree in one directory named for the repo and tag.
      const entries = (await fsp.readdir(tmp, { withFileTypes: true }))
        .filter((e) => e.isDirectory());
      if (entries.length !== 1) throw new Error('unexpected archive layout');
      const unpacked = path.join(tmp, entries[0].name);
      if (!looksComplete(unpacked)) throw new Error('archive is missing the app source');

      const dest = path.join(d.versions, version);
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.mkdir(dest, { recursive: true });
      for (const name of OVERLAY) {
        await fsp.cp(path.join(unpacked, name), path.join(dest, name), { recursive: true });
      }
      if (!looksComplete(dest)) throw new Error('unpacked source is incomplete');

      writeJson(d.pending, { version: version, minShell: manifest.minShell || '0' });
      return { state: 'ready', version: version, notes: manifest.notes || '' };
    } finally {
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  } catch (err) {
    return { state: 'offline', reason: err.message || String(err) };
  }
}

/* Puts the app back on the source it was built with, for when an update turns
 * out to be worse than what it replaced. */
function revert(userData) {
  const d = dirs(userData);
  try { fs.unlinkSync(d.active); } catch (e) { /* already bundled */ }
  try { fs.unlinkSync(d.pending); } catch (e) { /* nothing queued */ }
}

module.exports = {
  REPO, RELEASES, OVERLAY, MANIFEST_URL,
  cmp, resolveOverlay, markBooting, markAlive, check, revert
};
