/* Background removal, locally.
 *
 * BiRefNet-lite through onnxruntime-node. MIT licensed, which matters because
 * BRIA's RMBG-2.0 scores a few points higher but ships under a licence that
 * needs a paid agreement for commercial use, and this is used on work that
 * gets printed and sold.
 *
 * The model is about 180MB and is fetched once into the app's data directory on
 * first use, never bundled, so the app download stays small. Nothing is ever
 * uploaded: the image does not leave the machine.
 */
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const https = require('https');

const MODEL = {
  file: 'birefnet-lite.onnx',
  // onnx-community's export of BiRefNet_lite, standard operators only.
  url: 'https://huggingface.co/onnx-community/BiRefNet_lite/resolve/main/onnx/model_quantized.onnx',
  size: 1024 * 1024 * 40,        // rough, only used for the progress figure
  input: 1024                    // the resolution the network expects
};

let session = null;
let loading = null;

function modelPath(userData) {
  return path.join(userData, 'models', MODEL.file);
}

async function modelStatus(userData) {
  const p = modelPath(userData);
  try {
    const st = await fsp.stat(p);
    return { ready: st.size > 1024 * 1024, bytes: st.size, path: p };
  } catch (e) {
    return { ready: false, path: p };
  }
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));
    https.get(url, { headers: { 'User-Agent': 'ApparelDesigner' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('model download failed: HTTP ' + res.statusCode));
      }
      const total = parseInt(res.headers['content-length'] || MODEL.size, 10);
      let got = 0;
      // Write to a temporary name so a half-finished download is never mistaken
      // for a usable model on the next launch.
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (c) => {
        got += c.length;
        if (onProgress) onProgress('Downloading model ' + Math.round(got / total * 100) + '%');
      });
      res.pipe(out);
      out.on('finish', () => out.close(() => fs.rename(tmp, dest, (err) => {
        if (err) reject(err); else resolve(dest);
      })));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function getSession(userData, onProgress) {
  if (session) return session;
  if (loading) return loading;

  loading = (async () => {
    const ort = require('onnxruntime-node');
    const p = modelPath(userData);
    await fsp.mkdir(path.dirname(p), { recursive: true });

    const st = await modelStatus(userData);
    if (!st.ready) {
      if (onProgress) onProgress('Fetching the background model, one time only');
      await download(MODEL.url, p, onProgress);
    }
    if (onProgress) onProgress('Loading model');
    session = await ort.InferenceSession.create(p, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all'
    });
    return session;
  })();

  try { return await loading; } finally { loading = null; }
}

/* Nearest-neighbour resize into the square the network wants, with the
 * ImageNet normalisation it was trained under. */
function toTensor(rgba, w, h, size) {
  const data = new Float32Array(3 * size * size);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / size));
      const i = (sy * w + sx) * 4;
      const o = y * size + x;
      data[o] = (rgba[i] / 255 - mean[0]) / std[0];
      data[plane + o] = (rgba[i + 1] / 255 - mean[1]) / std[1];
      data[plane * 2 + o] = (rgba[i + 2] / 255 - mean[2]) / std[2];
    }
  }
  return data;
}

/* The network gives back logits at its own resolution. Squash them and scale
 * back up to the picture, bilinearly, so the edge does not come out blocky. */
function toMask(pred, size, w, h) {
  const prob = new Float32Array(size * size);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < prob.length; i++) {
    const v = 1 / (1 + Math.exp(-pred[i]));
    prob[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  // Some exports come out already in 0..1, some do not. Stretch either way.
  const span = hi - lo;
  if (span > 1e-6 && (lo > 0.02 || hi < 0.98)) {
    for (let i = 0; i < prob.length; i++) prob[i] = (prob[i] - lo) / span;
  }

  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * size / h - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(size - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * size / w - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(size - 1, x0 + 1);
      const tx = fx - x0;
      const a = prob[y0 * size + x0], b = prob[y0 * size + x1];
      const c = prob[y1 * size + x0], d = prob[y1 * size + x1];
      const v = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
      mask[y * w + x] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  return mask;
}

async function removeBackground(payload, userData, onProgress) {
  const { data, width, height } = payload;
  const rgba = new Uint8ClampedArray(data);

  const sess = await getSession(userData, onProgress);
  const ort = require('onnxruntime-node');
  const size = MODEL.input;

  if (onProgress) onProgress('Separating subject');
  const input = new ort.Tensor('float32', toTensor(rgba, width, height, size),
    [1, 3, size, size]);

  const feeds = {};
  feeds[sess.inputNames[0]] = input;
  const out = await sess.run(feeds);

  // BiRefNet exports several supervision heads; the last one is the refined map.
  const keys = sess.outputNames;
  const pick = out[keys[keys.length - 1]] || out[keys[0]];
  const mask = toMask(pick.data, size, width, height);

  return {
    mask: mask.buffer,
    width: width,
    height: height,
    source: 'birefnet'
  };
}

module.exports = { removeBackground, modelStatus, MODEL };
