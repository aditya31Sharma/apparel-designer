/* Background removal, in a plain Node process.
 *
 * onnxruntime-node loads inside Electron but crashes the moment it runs, on
 * every threading setting tried, so inference happens out here instead. Running
 * it in its own process also means a fault in native code cannot take the app
 * down with it.
 *
 * Reads a raw RGBA frame from a file, writes a single-channel matte back.
 * Arguments: <modelPath> <inputFile> <width> <height> <outputFile>
 */
'use strict';

const fs = require('fs');
const path = require('path');

const INPUT = 1024;                              // the model's fixed input size
const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

function note(stage) { process.stdout.write(stage + '\n'); }

/* Nearest-neighbour into the square the network wants, with the ImageNet
 * normalisation it was trained under. */
function toTensor(rgba, w, h) {
  const data = new Float32Array(3 * INPUT * INPUT);
  const plane = INPUT * INPUT;
  for (let y = 0; y < INPUT; y++) {
    const sy = Math.min(h - 1, Math.floor(y * h / INPUT));
    for (let x = 0; x < INPUT; x++) {
      const sx = Math.min(w - 1, Math.floor(x * w / INPUT));
      const i = (sy * w + sx) * 4;
      const o = y * INPUT + x;
      const a = rgba[i + 3] / 255;
      // Composite onto white first, so a transparent source does not read as black.
      const r = (rgba[i] * a + 255 * (1 - a)) / 255;
      const g = (rgba[i + 1] * a + 255 * (1 - a)) / 255;
      const b = (rgba[i + 2] * a + 255 * (1 - a)) / 255;
      data[o] = (r - MEAN[0]) / STD[0];
      data[plane + o] = (g - MEAN[1]) / STD[1];
      data[plane * 2 + o] = (b - MEAN[2]) / STD[2];
    }
  }
  return data;
}

/* Logits to a matte at the picture's own size, bilinear so the edge is not
 * blocky. Some exports come out already squashed to 0..1 and some do not, so
 * stretch whatever arrives. */
function toMask(pred, w, h) {
  const prob = new Float32Array(INPUT * INPUT);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < prob.length; i++) {
    const v = pred[i] >= 0 && pred[i] <= 1 ? pred[i] : 1 / (1 + Math.exp(-pred[i]));
    prob[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo;
  if (span > 1e-6 && (lo > 0.02 || hi < 0.98)) {
    for (let i = 0; i < prob.length; i++) prob[i] = (prob[i] - lo) / span;
  }

  const mask = Buffer.alloc(w * h);
  for (let y = 0; y < h; y++) {
    const fy = (y + 0.5) * INPUT / h - 0.5;
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(INPUT - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = (x + 0.5) * INPUT / w - 0.5;
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(INPUT - 1, x0 + 1);
      const tx = fx - x0;
      const a = prob[y0 * INPUT + x0], b = prob[y0 * INPUT + x1];
      const c = prob[y1 * INPUT + x0], d = prob[y1 * INPUT + x1];
      const top = a + (b - a) * tx, bot = c + (d - c) * tx;
      mask[y * w + x] = Math.max(0, Math.min(255, Math.round((top + (bot - top) * ty) * 255)));
    }
  }
  return mask;
}

async function main() {
  const [modelPath, inputFile, wStr, hStr, outFile] = process.argv.slice(2);
  const w = parseInt(wStr, 10), h = parseInt(hStr, 10);
  if (!modelPath || !inputFile || !w || !h || !outFile) {
    process.stderr.write('usage: bgworker <model> <input> <w> <h> <out>\n');
    process.exit(2);
  }

  note('Loading the background model');
  const ort = require(path.join(__dirname, '..', 'node_modules', 'onnxruntime-node'));
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all'
  });

  note('Separating the subject');
  const rgba = fs.readFileSync(inputFile);
  const feeds = {};
  feeds[session.inputNames[0]] =
    new ort.Tensor('float32', toTensor(rgba, w, h), [1, 3, INPUT, INPUT]);

  const out = await session.run(feeds);
  // BiRefNet exports several supervision heads; the last is the refined map.
  const names = session.outputNames;
  const picked = out[names[names.length - 1]] || out[names[0]];

  fs.writeFileSync(outFile, toMask(picked.data, w, h));
  note('done');
}

main().catch((err) => {
  process.stderr.write((err && err.stack || String(err)) + '\n');
  process.exit(1);
});
