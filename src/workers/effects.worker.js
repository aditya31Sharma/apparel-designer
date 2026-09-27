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
  '../engine/raster.js',
  '../doc/effects.js',
  '../doc/register-effects.js'
);

var generation = 0;
var sources = {};               // layer id -> pixels, so a photo crosses once

self.onmessage = function (e) {
  var msg = e.data;

  if (msg.kind === 'cancel') { generation = msg.generation; return; }
  if (msg.kind !== 'run') return;

  generation = msg.generation;
  var t0 = performance.now();

  try {
    if (msg.pixels) sources[msg.sourceId] = msg.pixels;

    var input = {
      items: msg.items,
      bbox: msg.bbox,
      matte: msg.matte || null,
      pixels: sources[msg.sourceId] || null
    };

    var ctx = {
      quality: msg.quality,
      textureImage: msg.textureImage || null,
      rasterize: self.Raster.rasterize,
      traceImage: self.Raster.traceImage,
      maskFromPaths: self.Grunge.maskFromPaths
    };

    var layer = { effects: msg.effects };
    var run = self.Effects.runStack(layer, input, ctx);
    var out = run.result;

    if (msg.generation !== generation) return;   // a newer job already started

    var transfer = [];
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
      ms: Math.round(performance.now() - t0)
    }, transfer);
  } catch (err) {
    self.postMessage({
      kind: 'error',
      generation: msg.generation,
      message: (err && err.message) || String(err),
      stack: err && err.stack
    });
  }
};
