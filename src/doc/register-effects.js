/* Wiring the three engines into the registry.
 *
 * Each one only knows about geometry. None of them reads the layer's transform,
 * paint or opacity, so all of those survive whatever the stack does.
 */
(function (root) {
  'use strict';

  var E = root.Effects, W = root.Warp, G = root.Grunge, H = root.Halftone;
  var Geom = root.Geom;
  var now = function () {
    return (typeof performance !== 'undefined' ? performance.now() : Date.now());
  };

  /* ---------- warp ---------- */

  E.register({
    id: 'warp',
    label: 'Warp',
    icon: 'warp',
    tip: 'Bend the artwork with a preset and four corner handles',
    defaults: {
      preset: 'arc',
      strength: 45,
      smooth: true,
      corners: null            // null means the untouched rectangle
    },
    run: function (input, p, ctx) {
      // A photo carries a placeholder rectangle, not an outline, so bending it
      // would just bend the frame. Trace the picture first and bend that.
      var items = needsTrace(input, ctx) ? ctx.traceImage(input, p) : input.items;
      if (!items || !items.length) return null;
      var corners = p.corners || W.DEFAULT_CORNERS;
      var opts = {
        preset: p.preset, strength: p.strength, smooth: p.smooth, corners: corners
      };
      var out = [], n = 0;
      items.forEach(function (it) {
        var parts = W.warp([Geom.itemPathData(it)], input.bbox, opts);
        if (!parts.length) return;
        out.push({
          d: parts.join(' '), fill: it.fill, stroke: it.stroke,
          strokeWidth: it.strokeWidth
        });
        n++;
      });
      if (!out.length) return null;
      return {
        items: out,
        bbox: W.bounds(out.map(function (i) { return i.d; })),
        matte: input.matte,
        stats: { shapes: n }
      };
    }
  });

  /* ---------- dither ---------- */

  E.register({
    id: 'dither',
    label: 'Dither',
    icon: 'dither',
    tip: 'Erode the outline into ink spatter, as real vectors',
    defaults: {
      grain: 1.6, roughness: 7, bias: 0, blotchAmount: 0.85,
      spatter: 0.45, pit: 0.14,
      spread: 0, spreadDensity: 0.55,
      texture: 'none', textureAmount: 0, textureScale: 3, textureInvert: false,
      meltRadius: 0, meltCut: 0.5,
      scale: 1,
      pxPerUnit: 2, detail: 0.45, seed: 1,
      imageCut: 0.55, imageLevels: 1,
      preset: ''
    },
    run: function (input, p, ctx) {
      if (!ctx.maskFromPaths) return null;
      // A photo has no outline to erode, so trace its dark areas into one first.
      // Without this the dither would faithfully erode the bounding rectangle.
      var items = needsTrace(input, ctx) ? ctx.traceImage(input, p) : input.items;
      if (!items || !items.length) return null;
      var s = p.scale || 1;
      var o = {
        grain: p.grain * s, roughness: p.roughness * s, bias: p.bias * s,
        blotchAmount: p.blotchAmount, blotch: 90 * s,
        spatter: p.spatter, spatterRange: 7 * s,
        pit: p.pit, pitDepth: 6 * s,
        spread: p.spread * s, spreadDensity: p.spreadDensity,
        texture: p.texture, textureAmount: p.textureAmount,
        textureScale: p.textureScale * s, textureInvert: p.textureInvert,
        textureImage: ctx.textureImage || null,
        // Interpolating the texture field costs about a third of the fine
        // speckle, which is invisible in a reduced-resolution preview and not
        // acceptable in the version that gets exported.
        textureStep: (ctx.quality === undefined || ctx.quality >= 1) ? 0 : 0.6,
        noPool: !!ctx.noPool,
        meltRadius: p.meltRadius * s, meltCut: p.meltCut,
        detail: p.detail, minArea: 2.2, smooth: 1, seed: p.seed,
        pxPerUnit: p.pxPerUnit * (ctx.quality === undefined ? 1 : ctx.quality)
      };
      var out = [], kept = 0, points = 0;
      // erodePaths is supplied by whoever runs the stack: a pool of workers
      // inside the worker, or the plain single-threaded call on the main
      // thread. Either way it hands back the same numbers.
      var erode = ctx.erodePaths || function (d, bb, opt) {
        return Promise.resolve(G.fromPaths([d], bb, opt));
      };

      return items.reduce(function (chain, it) {
        return chain.then(function () {
          var bb = Geom.itemBounds(it);
          if (!bb.width || !bb.height) return;
          // Keep the working bitmap sane however far Detail is pushed.
          var px = Math.min(o.pxPerUnit, 2600 / Math.max(bb.width, bb.height));
          return erode(Geom.itemPathData(it), bb,
            Object.assign({}, o, { pxPerUnit: px })).then(function (r) {
            if (!r || !r.points || !r.points.length) return;
            kept += r.stats.kept; points += r.stats.points;
            // Outlines leave as numbers. The string is built only on export.
            out.push({
              points: r.points, offsets: r.offsets,
              fill: it.fill, stroke: it.stroke, strokeWidth: it.strokeWidth
            });
          });
        });
      }, Promise.resolve()).then(function () {
        if (!out.length) return null;
        return {
          items: out,
          bbox: Geom.unionBounds(out),
          matte: input.matte,
          stats: { shapes: kept, points: points }
        };
      });
    }
  });

  /* ---------- halftone ---------- */

  E.register({
    id: 'halftone',
    label: 'Halftone',
    icon: 'halftone',
    tip: 'Screen the artwork into a CMYK dot pattern, as real vectors',
    defaults: {
      /* Dot pitch in artwork pixels, not cells across the artwork.
       *
       * Cells-across is what the screening engine wants, but it is relative to
       * the artwork, so a preset tuned on a 400px logo puts 76px dots on a
       * 2600px photo. Pitch is what a designer actually means by "a five pixel
       * dot", and it holds whatever the artwork is. Frequency is derived from
       * it at run time. */
      pitch: 5,
      pattern: 'round',
      inkDensity: 0.9,
      dotGain: 0,
      roughness: 0,
      fuzziness: 0,
      paperFibre: 0,
      inkTexture: 0,
      gcr: 1,
      minDot: 0.06,
      seed: 1,
      mode: 'cmyk',                              // cmyk | duotone | mono
      anglePreset: 'classic',
      angles: { c: 15, m: 75, y: 0, k: 45 },
      channels: { c: true, m: true, y: true, k: true },
      duotone: ['#1b1b1b', '#e5352b'],
      duotoneSplit: 0.45,
      paper: '#ffffff',                          // ground the ink multiplies onto
      sampleScale: 1,                            // raster resolution multiplier
      preset: ''
    },
    run: function (input, p, ctx) {
      if (!ctx.rasterize) return null;

      // Halftone needs pixels. An imported bitmap gives them directly; vector
      // artwork gets rendered once, at a resolution tied to the screen pitch so
      // each cell still has something to average over.
      var tR = now();
      var px = ctx.rasterize(input, Object.assign({}, p,
        { frequency: frequencyOf(p, input.bbox) }), ctx);
      if (!px || !px.w || !px.h) return null;
      var msRaster = Math.round(now() - tR);

      var tS = now();
      var channels = channelsFor(p);

      /* A reduced-quality preview has to reduce the number of dots, not just
       * how finely the picture is sampled. The dot count is what the outlines
       * and the drawing both scale with, and it does not fall when the sampling
       * does. Frequency scales as the square root because dots go as its
       * square, so a 42% pass really is about 42% of the work. Full quality
       * follows the moment the slider is let go. */
      var freq = frequencyOf(p, input.bbox);
      if (ctx.quality !== undefined && ctx.quality < 1) {
        freq = Math.max(8, Math.round(freq * Math.sqrt(ctx.quality)));
      }

      var res = H.screen(px.data, px.w, px.h, {
        frequency: freq, pattern: p.pattern, inkDensity: p.inkDensity,
        dotGain: p.dotGain, roughness: p.roughness, fuzziness: p.fuzziness,
        paperFibre: p.paperFibre, inkTexture: p.inkTexture,
        gcr: p.mode === 'mono' ? 1 : p.gcr,
        minDot: p.minDot, seed: p.seed,
        angles: p.angles, channels: channels,
        mode: p.mode, duotoneSplit: p.duotoneSplit
      });

      var msScreen = Math.round(now() - tS);

      // Dots come back in bitmap pixels; put them back into artwork units.
      var tM = now();
      var k = 1 / px.scale;
      var plates = res.channels.map(function (ch) {
        var d = ch.dots, out = new Float32Array(d.length);
        for (var o = 0; o < d.length; o += H.STRIDE) {
          out[o] = px.x + d[o] * k;
          out[o + 1] = px.y + d[o + 1] * k;
          out[o + 2] = d[o + 2] * k;
          out[o + 3] = d[o + 3];
        }
        return { key: ch.key, label: ch.label, colour: inkColour(p, ch.key), dots: out };
      });

      return {
        items: [],
        plates: plates,
        paper: p.paper,
        pattern: p.pattern,
        fuzziness: p.fuzziness,
        seed: p.seed,
        bbox: input.bbox,
        matte: input.matte,
        stats: { dots: res.stats.dots, plates: plates.length,
                 pitch: res.stats.spacing * k,
                 raster: msRaster, screen: msScreen,
                 map: Math.round(now() - tM), bitmap: px.w + 'x' + px.h }
      };
    }
  });

  /* True while the layer is still carrying the placeholder rectangle a photo
   * arrives with. Once any effect has traced or bent it, the items are real
   * outlines and must not be thrown away and re-traced. */
  function needsTrace(input, ctx) {
    return !!(input.pixels && ctx && ctx.traceImage &&
              input.items.length && input.items.every(function (i) { return i.frame; }));
  }

  /* Pitch to screen cells across the artwork, which is what the engine screens
   * on. Clamped so a tiny pitch on a huge canvas cannot ask for ten million
   * dots and a huge pitch cannot ask for none. */
  function frequencyOf(p, bbox) {
    var pitch = Math.max(0.8, p.pitch || 5);
    var w = (bbox && bbox.width) || 1000;
    return Math.max(6, Math.min(900, Math.round(w / pitch)));
  }

  /* Only meaningful in CMYK. Mono and duotone build their own planes from
   * perceptual tone, because the black plate of a saturated colour is empty and
   * a red logo would print as blank paper. */
  function channelsFor(p) {
    if (p.mode === 'mono') return { c: 0, m: 0, y: 0, k: 1 };
    if (p.mode === 'duotone') return { c: 0, m: 1, y: 0, k: 1 };
    return {
      c: p.channels.c ? 1 : 0, m: p.channels.m ? 1 : 0,
      y: p.channels.y ? 1 : 0, k: p.channels.k ? 1 : 0
    };
  }

  function inkColour(p, key) {
    if (p.mode === 'mono') return p.duotone[0];
    if (p.mode === 'duotone') return key === 'k' ? p.duotone[0] : p.duotone[1];
    var found = H.CHANNELS.filter(function (c) { return c.key === key; })[0];
    return found ? found.colour : '#000000';
  }

  root.registerEffects = function () { return E.ids(); };
})(typeof module !== 'undefined' ? module.exports : self);
