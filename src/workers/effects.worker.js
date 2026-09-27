/* The effect stack, off the main thread.
 *
 * Results go back as typed arrays and path-data strings only where a string is
 * unavoidable. Halftone plates are pure numbers, so they transfer with zero
 * copying and the main thread turns them into a Path2D without parsing.
 *
 * Every job carries a generation number. Dragging a slider fires faster than
 * the work completes, so anything that finishes after a newer job has started
 * is dropped rather than drawn.
 */
/* global importScripts, Halftone */
'use strict';

importScripts(
  '../engine/warp.js',
  '../engine/grunge.js',
  '../engine/halftone.js',
  '../engine/geom.js',
  '../engine/raster.js',
  '../doc/effects.js',
  '../doc/register-effects.js'
);

var generation = 0;
var sources = {};               // layer id -> pixels, so a photo crosses once


/* ---------- the erosion pool ---------- */

/* The pixel pass over the distance field is the most expensive thing the app
 * does, and it is perfectly splittable by rows: every pixel reads only the
 * field and its own coordinates. With shared memory each band costs nothing to
 * hand over, so this is close to a straight divide by core count.
 *
 * Falls back to running in place when SharedArrayBuffer is not available, which
 * is what happens in the plain web build on a host that cannot set the
 * isolation headers. */
var CORES = Math.max(1, Math.min(8, (self.navigator && self.navigator.hardwareConcurrency) || 4));
var BANDS = Math.max(1, CORES - 1);
var canShare = typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated !== false;
var band = [];
var jobSeq = 0;
var poolProblem = null;
var lastPoolSize = 1;
var breakdown = {};

/* One worker, with its handlers closed over that worker and no other.
 * Building these in a plain loop with `var` gives every handler the same
 * binding, which is the last worker created, so replies land on the wrong
 * promise and most of them never settle at all. */
function makeBandWorker() {
  var w = new Worker('erode.worker.js');
  w.busy = null;
  w.failed = null;
  w.onmessage = function () {
    var pend = w.busy;
    w.busy = null;
    if (pend) pend();
  };
  w.onerror = function (err) {
    poolProblem = 'worker: ' + ((err && err.message) || 'failed to start');
    canShare = false;
    if (w.failed) w.failed(poolProblem);
  };
  return w;
}

function ensureBands() {
  if (!canShare) return false;
  while (band.length < BANDS) {
    try {
      band.push(makeBandWorker());
    } catch (err) {
      canShare = false;
      return false;
    }
  }
  return true;
}

/* Paths in, the same { points, offsets, stats } fromPaths would have given. */
function erodePaths(d, bbox, options) {
  var G = self.Grunge;
  var tMask = performance.now();
  var px = options.pxPerUnit || 2;
  var pad = Math.ceil((options.roughness || 0) + (options.spatterRange || 7) +
                      (options.spread || 0) + (options.meltRadius || 0) * 3 + 6);
  var R = G.maskFromPaths([d], bbox, px, pad);
  breakdown = { mask: Math.round(performance.now() - tMask), size: R.w + 'x' + R.h };
  var place = { scale: 1 / px, ox: bbox.x - pad / px, oy: bbox.y - pad / px };

  // Small jobs are not worth the round trip.
  var pixels = R.w * R.h;
  if (options.noPool || pixels < 400000 || !ensureBands()) {
    lastPoolSize = 1;
    var res = G.erode(R.mask, R.w, R.h, options);
    return Promise.resolve(finishUp(res, place));
  }

  lastPoolSize = BANDS + 1;
  var tA = performance.now();
  var dist = G.sdf(R.mask, R.w, R.h);
  breakdown.sdf = Math.round(performance.now() - tA);
  var distSab = new Float32Array(new SharedArrayBuffer(dist.length * 4));
  distSab.set(dist);
  var outSab = new Uint8Array(new SharedArrayBuffer(R.w * R.h));

  var n = BANDS + 1;                       // the bands plus this thread
  var rows = R.h;
  var edges = [];
  for (var i = 0; i <= n; i++) edges.push(Math.round(i * rows / n));

  var waits = band.map(function (w, k) {
    return new Promise(function (resolve) {
      var done = false;
      var settle = function (why) {
        if (done) return;
        done = true;
        resolve(why);
      };
      w.busy = function () { settle(null); };
      w.failed = settle;
      // A band that never answers must not wedge the app. Give it a generous
      // ceiling, then take the rows back and do them here.
      setTimeout(function () { settle('timeout'); }, 8000);
      w.postMessage({
        id: ++jobSeq, dist: distSab.buffer, out: outSab.buffer,
        w: R.w, h: R.h, opts: options, y0: edges[k], y1: edges[k + 1]
      });
    });
  });
  // This thread takes the last band rather than sitting idle waiting.
  self.Grunge.erodePixels(distSab, outSab, R.w, R.h, options, edges[n - 1], edges[n]);

  var tB = performance.now();
  return Promise.all(waits).then(function (results) {
    breakdown.bands = Math.round(performance.now() - tB);
    var broken = results.filter(Boolean);
    if (broken.length) {
      // Redo the rows nobody reported on, in this thread, and stop using the
      // pool for the rest of the session.
      poolProblem = broken[0];
      canShare = false;
      band.forEach(function (w) { try { w.terminate(); } catch (e) {} });
      band.length = 0;
      self.Grunge.erodePixels(distSab, outSab, R.w, R.h, options, 0, edges[n - 1]);
    }
    var tC = performance.now();
    var res = self.Grunge.finish(outSab, R.w, R.h, options);
    breakdown.trace = Math.round(performance.now() - tC);
    var tD = performance.now();
    var done = finishUp(res, place);
    breakdown.arrays = Math.round(performance.now() - tD);
    return done;
  });
}

function finishUp(res, place) {
  if (res.points) return res;                     // came from fromPaths
  var arr = self.Grunge.ringsToArrays(res.rings, place);
  return { points: arr.points, offsets: arr.offsets, stats: res.stats };
}

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.kind === 'cancel') { generation = msg.generation; return; }

  if (msg.kind !== 'run') return;

  generation = msg.generation;
  msg.startedAt = performance.now();

  try {
    if (msg.pixels) sources[msg.sourceId] = msg.pixels;

    var input = {
      items: msg.items,
      bbox: msg.bbox,
      matte: msg.matte || null,
      pixels: sources[msg.sourceId] || null,
      sourceId: msg.sourceId
    };

    var ctx = {
      quality: msg.quality,
      textureImage: msg.textureImage || null,
      erodePaths: erodePaths,
      noPool: msg.noPool,
      rasterize: self.Raster.rasterize,
      traceImage: self.Raster.traceImage,
      maskFromPaths: self.Grunge.maskFromPaths
    };

    var layer = { effects: msg.effects };
    self.Effects.runStack(layer, input, ctx).then(function (run) {
      send(msg, run);
    }).catch(function (err) {
      self.postMessage({
        kind: 'error', generation: msg.generation,
        message: (err && err.message) || String(err), stack: err && err.stack
      });
    });
    return;
  } catch (err) {
    self.postMessage({
      kind: 'error',
      generation: msg.generation,
      message: (err && err.message) || String(err),
      stack: err && err.stack
    });
  }
};

function send(msg, run) {
    var out = run.result;
    var t0 = performance.now();
    if (msg.generation !== generation) return;   // a newer job already started

    var transfer = self.Geom ? self.Geom.transferables(out.items || []) : [];
    var plates = (out.plates || []).map(function (pl) {
      transfer.push(pl.dots.buffer);
      return { key: pl.key, label: pl.label, colour: pl.colour, dots: pl.dots };
    });

    self.postMessage({
      kind: 'done',
      generation: msg.generation,
      items: out.items || [],
      plates: plates,
      paper: out.paper,
      pattern: out.pattern,
      fuzziness: out.fuzziness,
      seed: out.seed,
      bbox: out.bbox,
      stats: run.stats,
      pool: lastPoolSize,
      breakdown: breakdown,
      poolProblem: poolProblem,
      ms: msg.startedAt ? Math.round(performance.now() - msg.startedAt) : undefined
    }, transfer);
}
