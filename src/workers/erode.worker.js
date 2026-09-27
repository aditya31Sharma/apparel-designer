/* One band of the erosion.
 *
 * The distance field and the output both live in shared memory, so a band costs
 * nothing to hand over and nothing to hand back. Every pixel depends only on
 * that field and its own coordinates, so the bands together produce exactly
 * what one thread would have, bit for bit.
 */
/* global importScripts */
'use strict';

importScripts('../engine/grunge.js');

self.onmessage = function (e) {
  var m = e.data;
  try {
    var d = new Float32Array(m.dist);
    var out = new Uint8Array(m.out);
    self.Grunge.erodePixels(d, out, m.w, m.h, m.opts, m.y0, m.y1);
    self.postMessage({ id: m.id, ok: true });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, message: (err && err.message) || String(err) });
  }
};
