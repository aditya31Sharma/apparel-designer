/* The outro's printed monochrome treatment, shared by preview and export. */
(function (root) {
  'use strict';

  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  var DEFAULTS = { outroContrast: 3, outroGrain: 0.038, outroDarken: 0.4, seed: 82031 };

  function clamp(v) { return Math.max(0, Math.min(1, v)); }

  function noise(w, h, random) {
    var data = new Float32Array(w * h);
    for (var i = 0; i < data.length; i++) {
      data[i] = Math.sqrt(-2 * Math.log(Math.max(1e-9, random()))) *
        Math.cos(2 * Math.PI * random());
    }
    return data;
  }

  function process(px, params, matte, invert) {
    var p = Object.assign({}, DEFAULTS, params);
    var state = p.seed | 0;
    function random() {
      state = (Math.imul(state, 1664525) + 1013904223) | 0;
      return (state >>> 0) / 4294967296;
    }
    var w = px.w, h = px.h, src = px.data;
    var data = new Uint8ClampedArray(src.length);
    var fw = Math.ceil(w / 2), cw = Math.ceil(w / 8) + 1;
    var fine = noise(fw, Math.ceil(h / 2), random);
    var coarse = noise(cw, Math.ceil(h / 8) + 1, random);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        var lum = (0.2126 * src[i] + 0.7152 * src[i + 1] + 0.0722 * src[i + 2]) / 255;
        if (invert) lum = 1 - lum;
        // The reel's 4x4 ordered screen uses two-pixel cells and three inks.
        var threshold = BAYER[((y >> 1) % 4) * 4 + ((x >> 1) % 4)] / 16 - 0.5;
        var ink = Math.floor(clamp(lum + threshold * 0.30) * 3 + 0.5) / 3;
        var tone = lum * 0.15 + (0.02 + 0.92 * ink) * 0.85;
        var cx = x >> 3, cy = y >> 3, fx = (x % 8) / 8, fy = (y % 8) / 8;
        var q = cy * cw + cx;
        var soft = (coarse[q] * (1 - fx) + coarse[q + 1] * fx) * (1 - fy) +
          (coarse[q + cw] * (1 - fx) + coarse[q + cw + 1] * fx) * fy;
        tone += p.outroGrain * (fine[(y >> 1) * fw + (x >> 1)] + soft * 0.6);
        if (y % 7 === 0) tone -= 0.035 * 0.85;
        // Keep both clipping stages: this is the Studio outro's filter order.
        tone = clamp((clamp(tone) - 0.5) * p.outroContrast + 0.5);
        tone = clamp((tone - 0.5) * 1.5 + 0.5) * (1 - p.outroDarken);
        var alpha = src[i + 3];
        if (matte) {
          var mx = Math.min(matte.w - 1, Math.floor(x * matte.w / w));
          var my = Math.min(matte.h - 1, Math.floor(y * matte.h / h));
          alpha *= matte.mask[my * matte.w + mx] / 255;
        }
        data[i] = data[i + 1] = data[i + 2] = alpha ? Math.round(tone * 255) : 0;
        data[i + 3] = alpha;
      }
    }
    return { data: data, w: w, h: h };
  }

  function run(input, params, ctx) {
    var px = input.pixels, matte = input.matte;
    var frame = !input.items.length || input.items.every(function (it) { return it.frame; });
    if (!px || !frame) {
      // A preceding warp has replaced the source photo with real outlines.
      px = ctx.rasterize(input, { frequency: Math.min(2600, input.bbox.width) / 6,
        sampleScale: 1, mode: 'cmyk' }, ctx);
      matte = null; // rasterize already applied it
    }
    if (!px) return null;
    var photo = process(px, params, matte, input.invert);
    return { items: [], bbox: input.bbox, pixels: photo, photo: photo,
      stats: { width: photo.w, height: photo.h } };
  }

  function thumbnail() {
    var w = 120, h = 38, data = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = (y * w + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = 255 * x / (w - 1);
        data[i + 3] = 255;
      }
    }
    var px = process({ data: data, w: w, h: h });
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(px.data, w, h), 0, 0);
    return '<svg viewBox="0 0 120 38"><image width="120" height="38" href="' +
      c.toDataURL('image/png') + '"/></svg>';
  }

  root.TenzenOutro = { defaults: DEFAULTS, process: process, run: run, thumbnail: thumbnail };
})(typeof module !== 'undefined' ? module.exports : self);
