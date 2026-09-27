/* Rasterising, for the effects that need pixels rather than outlines.
 *
 * Works on the main thread and inside a worker, because the halftone screen has
 * to run off the main thread and a worker has no document.
 */
(function (root) {
  'use strict';

  var hasCanvas = typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';
  if (!hasCanvas) { root.Raster = null; return; }

  function canvasOf(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* Halftone input. Vector artwork gets drawn once at a resolution tied to the
   * screen pitch, so every cell still has real pixels to average. An imported
   * bitmap is used as it came in, scaled to the same rule.
   *
   * Returns { data, w, h, scale, x, y } where scale is bitmap px per artwork
   * unit and x,y is the artwork-space origin of the bitmap.
   */
  function rasterize(input, params, ctx) {
    var b = input.bbox;
    if (!b || !b.width || !b.height) return null;

    // Aim for about 6 bitmap pixels across each screen cell: fewer and the cell
    // average gets noisy, more is paying for detail the screen throws away.
    var cells = Math.max(1, params.frequency);
    var want = (cells * 6) / b.width;
    var scale = Math.max(0.25, want * (params.sampleScale || 1) *
                                (ctx.quality === undefined ? 1 : ctx.quality));
    var cap = 3600 / Math.max(b.width, b.height);
    if (scale > cap) scale = cap;

    var w = Math.max(4, Math.round(b.width * scale));
    var h = Math.max(4, Math.round(b.height * scale));
    var c = canvasOf(w, h);
    var g = c.getContext('2d', { willReadFrequently: true });

    // White paper under everything, so transparent areas take no ink.
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.save();
    g.scale(scale, scale);
    g.translate(-b.x, -b.y);

    if (input.bitmap) {
      g.drawImage(input.bitmap, b.x, b.y, b.width, b.height);
    } else {
      input.items.forEach(function (it) {
        var p = it.path2d || new Path2D(it.d);
        if (it.fill && it.fill !== 'none') { g.fillStyle = it.fill; g.fill(p); }
        else if (!it.stroke || it.stroke === 'none') { g.fillStyle = '#000000'; g.fill(p); }
        if (it.stroke && it.stroke !== 'none' && it.strokeWidth > 0) {
          g.strokeStyle = it.stroke; g.lineWidth = it.strokeWidth;
          g.lineJoin = 'round'; g.lineCap = 'round';
          g.stroke(p);
        }
      });
    }
    g.restore();

    var img = g.getImageData(0, 0, w, h);

    // A matte from background removal knocks the background back to paper, so
    // the screen genuinely stops putting ink there.
    if (input.matte) applyMatte(img.data, w, h, input.matte);

    return { data: img.data, w: w, h: h, scale: scale, x: b.x, y: b.y };
  }

  /* The matte is stored at its own resolution; sample it nearest-neighbour. */
  function applyMatte(data, w, h, matte) {
    var mw = matte.w, mh = matte.h, m = matte.mask;
    for (var y = 0; y < h; y++) {
      var my = Math.min(mh - 1, (y * mh / h) | 0);
      for (var x = 0; x < w; x++) {
        var mx = Math.min(mw - 1, (x * mw / w) | 0);
        var a = m[my * mw + mx] / 255;
        if (a >= 0.999) continue;
        var i = (y * w + x) * 4;
        data[i] = data[i] * a + 255 * (1 - a);
        data[i + 1] = data[i + 1] * a + 255 * (1 - a);
        data[i + 2] = data[i + 2] * a + 255 * (1 - a);
      }
    }
  }

  /* Bitmap to flat paths, for tracing a photo into vector ink. */
  function levelsFromBitmap(bitmap, maxPx, levels, threshold) {
    var scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    var w = Math.max(8, Math.round(bitmap.width * scale));
    var h = Math.max(8, Math.round(bitmap.height * scale));
    var c = canvasOf(w, h);
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, w, h);
    var data = g.getImageData(0, 0, w, h).data;

    var lum = new Float32Array(w * h);
    for (var i = 0, p = 0; i < lum.length; i++, p += 4) {
      var a = data[p + 3] / 255;
      var l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
      lum[i] = l * a + (1 - a);
    }
    var out = [];
    for (var k = 0; k < levels; k++) {
      var cut = threshold * (k + 1) / levels;
      var m = new Uint8Array(w * h);
      for (i = 0; i < m.length; i++) m[i] = lum[i] <= cut ? 1 : 0;
      out.push(m);
    }
    return { masks: out, w: w, h: h };
  }

  root.Raster = {
    canvasOf: canvasOf,
    rasterize: rasterize,
    applyMatte: applyMatte,
    levelsFromBitmap: levelsFromBitmap
  };
})(typeof self !== 'undefined' ? self : this);
