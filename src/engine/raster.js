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

    var data;
    if (input.pixels) {
      /* Straight from the numbers. Routing a photo through a canvas only to
       * read it back again cost a hundred and ninety milliseconds a frame:
       * drawing puts the surface on the GPU and getImageData then has to stall
       * the pipeline to drag it back. The pixels are already here, so resample
       * them where they are and never touch a canvas. */
      data = resample(input.pixels, w, h);
    } else {
      var c = canvasOf(w, h);
      var g = c.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, w, h);
      g.save();
      g.scale(scale, scale);
      g.translate(-b.x, -b.y);
      if (input.bitmap) {
        g.drawImage(input.bitmap, b.x, b.y, b.width, b.height);
      } else {
        input.items.forEach(function (it) {
          var p = root.Geom ? root.Geom.itemPath2D(it) : new Path2D(it.d);
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
      data = g.getImageData(0, 0, w, h).data;
    }

    // A matte from background removal knocks the background back to paper, so
    // the screen genuinely stops putting ink there.
    if (input.matte) applyMatte(data, w, h, input.matte);

    return { data: data, w: w, h: h, scale: scale, x: b.x, y: b.y };
  }

  /* Box-filter a photo down to the working size, compositing onto white so a
   * transparent edge does not drag its colour in. Every source pixel is read
   * exactly once, so the cost is the source size and nothing else. */
  function resample(px, w, h) {
    var src = px.data, sw = px.w, sh = px.h;
    var out = new Uint8ClampedArray(w * h * 4);
    var acc = new Float32Array(w * h * 4);
    var cnt = new Uint32Array(w * h);

    var xs = w / sw, ys = h / sh;
    for (var sy = 0; sy < sh; sy++) {
      var dy = (sy * ys) | 0;
      if (dy >= h) dy = h - 1;
      var srow = sy * sw * 4, drow = dy * w;
      for (var sx = 0; sx < sw; sx++) {
        var dx = (sx * xs) | 0;
        if (dx >= w) dx = w - 1;
        var si = srow + sx * 4, di = (drow + dx) * 4;
        var a = src[si + 3] / 255;
        acc[di] += src[si] * a + 255 * (1 - a);
        acc[di + 1] += src[si + 1] * a + 255 * (1 - a);
        acc[di + 2] += src[si + 2] * a + 255 * (1 - a);
        cnt[drow + dx]++;
      }
    }
    for (var i = 0, n = w * h; i < n; i++) {
      var k = cnt[i] || 1;
      var o = i * 4;
      out[o] = acc[o] / k;
      out[o + 1] = acc[o + 1] / k;
      out[o + 2] = acc[o + 2] / k;
      out[o + 3] = 255;
    }
    return out;
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

  /* A photo into outlines, so the erosion has something with an edge to chew.
   * Split into tone bands, threshold each, trace with the same marching-squares
   * pass the dither already uses. */
  /* Tracing a photo into outlines depends only on the photo and the two tone
   * controls, not on anything the dither does, so doing it again on every
   * slider tick was costing thirty-odd milliseconds of every preview for a
   * result that had not changed. */
  var traceCache = { key: null, items: null };

  function traceImage(input, p) {
    var px = input.pixels;
    if (!px) return input.items;

    var key = [input.sourceId || 'x', px.w, px.h, p.imageCut, p.imageLevels,
               input.matte ? input.matte.w + 'x' + input.matte.h : 'none'].join('|');
    if (traceCache.key === key) return traceCache.items;
    var G = root.Grunge;
    if (!G || !G.traceRings) return input.items;

    var maxPx = 1400;
    var sc = Math.min(1, maxPx / Math.max(px.w, px.h));
    var w = Math.max(8, Math.round(px.w * sc)), h = Math.max(8, Math.round(px.h * sc));
    var data = resample(px, w, h);

    if (input.matte) applyMatte(data, w, h, input.matte);

    var lum = new Float32Array(w * h);
    for (var i = 0, q = 0; i < lum.length; i++, q += 4) {
      lum[i] = (0.2126 * data[q] + 0.7152 * data[q + 1] + 0.0722 * data[q + 2]) / 255;
    }

    var b = input.bbox;
    var kx = b.width / w, ky = b.height / h;
    var levels = Math.max(1, Math.min(4, Math.round(p.imageLevels || 1)));
    var cut = p.imageCut === undefined ? 0.55 : p.imageCut;
    var items = [];

    for (var k = 0; k < levels; k++) {
      var t = cut * (k + 1) / levels;
      var mask = new Uint8Array(w * h);
      var on = 0;
      for (i = 0; i < mask.length; i++) { if (lum[i] <= t) { mask[i] = 1; on++; } }
      if (!on) continue;
      var rings = G.traceRings(mask, w, h);
      var d = '';
      for (var r = 0; r < rings.length; r++) {
        if (Math.abs(G.ringArea(rings[r])) < 6) continue;
        var simp = G.rdp(rings[r], 0.8);
        if (simp.length < 3) continue;
        d += G.ringsToPath([simp], { scale: 1, ox: 0, oy: 0 });
      }
      if (!d) continue;
      // ringsToPath works in mask pixels; move it into artwork units.
      items.push({ d: scalePath(d, kx, ky, b.x, b.y), fill: '#000000',
                   stroke: 'none', strokeWidth: 0 });
    }
    var result = items.length ? items : input.items;
    traceCache.key = key;
    traceCache.items = result;
    return result;
  }

  function scalePath(d, kx, ky, ox, oy) {
    return d.replace(/([ML])(-?[\d.]+) (-?[\d.]+)/g, function (_, cmd, x, y) {
      return cmd + (Math.round((+x * kx + ox) * 100) / 100) + ' ' +
             (Math.round((+y * ky + oy) * 100) / 100);
    });
  }

  root.Raster = {
    traceImage: traceImage,
    canvasOf: canvasOf,
    rasterize: rasterize,
    resample: resample,
    applyMatte: applyMatte,
    levelsFromBitmap: levelsFromBitmap
  };
})(typeof self !== 'undefined' ? self : this);
