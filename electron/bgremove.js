/* Background removal, locally.
 *
 * BiRefNet-lite through onnxruntime-node. MIT licensed, which matters because
 * BRIA's RMBG-2.0 scores a few points higher but ships under a licence that
 * needs a paid agreement for commercial use, and this gets used on work that
 * is printed and sold.
 *
 * The model is about 213MB and is fetched once into the app's data directory on
 * first use, never bundled, so the app download stays small. Nothing is ever
 * uploaded: the image does not leave the machine.
 *
 * Inference runs in a separate Node process. onnxruntime-node loads inside
 * Electron quite happily and then crashes the instant it runs, on every
 * threading and optimisation setting tried, so the work is handed out to a
 * plain Node. Running it outside also means a fault in native code cannot take
 * the window down with it.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');
const os = require('os');
const { execFile, spawn } = require('child_process');

const MODEL = {
  file: 'birefnet-lite.onnx',
  // onnx-community's ONNX export of BiRefNet_lite. MIT.
  url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model.onnx',
  size: 213 * 1024 * 1024
};

/* ---------- the model on disk ---------- */

function modelPath(userData) {
  return path.join(userData, 'models', MODEL.file);
}

async function modelStatus(userData) {
  const p = modelPath(userData);
  try {
    const st = await fsp.stat(p);
    // Anything much short of the expected size is a truncated download.
    const ready = st.size > MODEL.size * 0.9;
    if (!ready) await fsp.unlink(p).catch(() => {});
    return { ready: ready, bytes: st.size, path: p };
  } catch (e) {
    return { ready: false, path: p };
  }
}

function download(url, dest, onProgress, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'ApparelDesigner' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        // Hugging Face answers with a relative Location, which https.get rejects
        // outright as an invalid URL. Resolve it against the request it came from.
        return resolve(download(new URL(res.headers.location, url).toString(),
          dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('model download failed: HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || MODEL.size, 10);
      let got = 0, lastPct = -1;
      // Write under a temporary name, so a half-finished download is never
      // mistaken for a usable model on the next launch.
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        const pct = Math.round(got / total * 100);
        if (onProgress && pct !== lastPct) {
          lastPct = pct;
          onProgress('Fetching the background model, ' + pct + '% of ' +
            Math.round(total / 1048576) + 'MB. One time only.');
        }
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => fs.rename(tmp, dest, (err) => {
        if (err) reject(err); else resolve(dest);
      })));
      out.on('error', reject);
    }).on('error', reject);
  });
}

/* ---------- finding a Node to run it in ---------- */

const NODE_CANDIDATES = [
  '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node',
  path.join(os.homedir(), '.nvm/versions/node')
];

let cachedNode;

function findNode() {
  if (cachedNode !== undefined) return Promise.resolve(cachedNode);
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-lc', 'command -v node || true'], { timeout: 5000 },
      (err, stdout) => {
        const found = String(stdout || '').trim().split('\n')[0];
        if (found && fs.existsSync(found)) { cachedNode = found; return resolve(found); }
        for (const c of NODE_CANDIDATES) {
          if (c.endsWith('versions/node')) {
            try {
              for (const v of fs.readdirSync(c).sort().reverse()) {
                const p = path.join(c, v, 'bin', 'node');
                if (fs.existsSync(p)) { cachedNode = p; return resolve(p); }
              }
            } catch (e) { /* no nvm on this machine */ }
          } else if (fs.existsSync(c)) {
            cachedNode = c; return resolve(c);
          }
        }
        cachedNode = null;
        resolve(null);
      });
  });
}

function runWorker(nodeBin, args, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [path.join(__dirname, 'bgworker.js')].concat(args), {
      // A stray ELECTRON_RUN_AS_NODE in the environment would send this straight
      // back through Electron's own runtime, which is the thing that crashes.
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '' }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let errText = '';
    child.stdout.on('data', (d) => {
      String(d).split('\n').forEach((line) => {
        if (line.trim() && line.trim() !== 'done' && onProgress) onProgress(line.trim());
      });
    });
    child.stderr.on('data', (d) => { errText += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(errText.trim().split('\n').slice(-2).join(' ') ||
        ('background worker exited ' + code)));
    });
  });
}

/* ---------- the call ---------- */

async function removeBackground(payload, userData, onProgress) {
  const data = payload.data, width = payload.width, height = payload.height;

  const nodeBin = await findNode();
  if (!nodeBin) {
    return { error: 'no Node runtime on this machine to run the background model' };
  }

  const p = modelPath(userData);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const st = await modelStatus(userData);
  if (!st.ready) {
    if (onProgress) onProgress('Fetching the background model, one time only');
    await download(MODEL.url, p, onProgress);
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apparel-bg-'));
  const inFile = path.join(dir, 'frame.rgba');
  const outFile = path.join(dir, 'matte.gray');
  try {
    await fsp.writeFile(inFile, Buffer.from(data));
    await runWorker(nodeBin, [p, inFile, String(width), String(height), outFile], onProgress);
    const mask = await fsp.readFile(outFile);
    const copy = new Uint8Array(mask.byteLength);
    copy.set(mask);
    return { mask: copy.buffer, width: width, height: height, source: 'birefnet' };
  } finally {
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { removeBackground, modelStatus, findNode, MODEL };
