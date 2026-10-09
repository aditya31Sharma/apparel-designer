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
      // Measured on real photographs rather than picked: 0.55 floods anything
      // with dark clothing or shadow into one solid mass, which is what made
      // the dither look like a blob instead of a print.
      imageCut: 0.4, imageLevels: 1,
      preset: ''
    },
    run: function (input, p, ctx) {
      if (!ctx.maskFromPaths) return null;
      if (p.preset === 'tenzenOutro') return root.TenzenOutro.run(input, p, ctx);
      // A photo has no outline to erode, so trace its dark areas into one first.
      // Without this the dither would faithfully erode the bounding rectangle.
      var traced = needsTrace(input, ctx);
      var items = traced ? ctx.traceImage(input, p) : input.items;
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
        textureStep: 0,
        noPool: !!ctx.noPool,
        meltRadius: p.meltRadius * s, meltCut: p.meltCut,
        detail: p.detail, minArea: 2.2, smooth: 1, seed: p.seed,
        // Every size above is in mask pixels, so this is what decides how big
        // the grain, the spatter and the spread come out in the artwork.
        // Scaling it down for a preview does not make a rougher version of the
        // same picture, it makes a different picture with much bigger grain.
        pxPerUnit: p.pxPerUnit
      };
      var out = [], kept = 0, points = 0;
      // erodePaths is supplied by whoever runs the stack: a pool of workers
      // inside the worker, or the plain single-threaded call on the main
      // thread. Either way it hands back the same numbers.
      var erode = ctx.erodePaths || function (d, bb, opt) {
        return Promise.resolve(G.fromPaths([d], bb, opt));
      };

      /* Tone steps. A photo traced at several thresholds gives nested bands,
       * darkest first, and drawing them all in the same ink used to add up to
       * exactly what the widest band alone would have looked like: more work,
       * no difference. One ink cannot print grey, but it can print broken, so
       * each lighter band is chewed harder than the one inside it. The dark
       * core stays solid and the midtones break up towards the paper, which is
       * how a one colour print carries more than one tone. */
      function forBand(idx) {
        if (!traced || items.length < 2) return o;
        var lift = idx / (items.length - 1);
        return Object.assign({}, o, {
          roughness: o.roughness * (1 + lift * 1.4) + lift * 1.8,
          pit: Math.min(0.45, o.pit + lift * 0.14),
          spatter: Math.min(1, o.spatter + lift * 0.08),
          blotchAmount: Math.min(1, o.blotchAmount + lift * 0.08)
        });
      }

      return items.reduce(function (chain, it, idx) {
        return chain.then(function () {
          var bb = Geom.itemBounds(it);
          if (!bb.width || !bb.height) return;
          var band = forBand(idx);
          // Keep the working bitmap sane however far Detail is pushed.
          var px = Math.min(band.pxPerUnit, 2600 / Math.max(bb.width, bb.height));
          return erode(Geom.itemPathData(it), bb,
            Object.assign({}, band, { pxPerUnit: px })).then(function (r) {
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

  /* The engine has eleven knobs and every one of them does something, but
   * nobody could tell which five of them mattered from a panel of twenty
   * controls. So the panel has five, and this is where they become what the
   * engine takes. Four of the engine's knobs are flavours of the same thing,
   * a dot that is not quite where or what it should be, and they move together
   * under one Grit dial. The rest are settled here because moving them never
   * helped. */
  function halftoneOptions(p, freq) {
    var grit = Math.max(0, Math.min(1, p.grit || 0));
    var a = p.angle === undefined ? 45 : p.angle;
    return {
      frequency: freq,
      pattern: p.pattern || 'round',
      // Fill scales every dot; Weight bends the midtones. Both close the gap
      // between dots, and they are different tools for it.
      inkDensity: p.fill === undefined ? 1 : p.fill,
      dotGain: p.gain || 0,
      roughness: grit * 0.4,
      fuzziness: grit * 0.45,
      paperFibre: grit * 0.45,
      inkTexture: grit * 0.4,
      gcr: p.mode === 'cmyk' ? (p.gcr === undefined ? 0.9 : p.gcr) : 1,
      minDot: p.minDot === undefined ? 0.05 : p.minDot,
      seed: p.seed || 1,
      // Thirty degrees apart is what keeps four screens from forming a moire,
      // and yellow sits where the eye forgives it. One number turns them all.
      angles: { k: a, c: a - 30, m: a + 30, y: a - 45 },
      channels: { c: 1, m: 1, y: 1, k: 1 },
      mode: p.mode || 'mono',
      duotoneSplit: p.split === undefined ? 0.45 : p.split
    };
  }

  E.register({
    id: 'halftone',
    label: 'Halftone',
    icon: 'halftone',
    tip: 'Screen the artwork into a dot pattern, as real vectors',
    engineOptions: halftoneOptions,
    defaults: {
      /* Dot pitch in artwork pixels, not cells across the artwork.
       *
       * Cells-across is what the screening engine wants, but it is relative to
       * the artwork, so a preset tuned on a 400px logo puts 76px dots on a
       * 2600px photo. Pitch is what a designer actually means by "a five pixel
       * dot", and it holds whatever the artwork is. Frequency is derived from
       * it at run time. */
      pitch: 6,
      pattern: 'round',
      fill: 1,                    // how much of its cell each dot fills; up closes the gap
      gain: 0.3,                  // heavier or lighter than the picture asks for
      /* Zero: a clean arc per dot. Any grit at all turns every dot into a
       * polygon of up to twenty nine points, which is three to four times
       * the file and the draw time, so it is something you turn up rather
       * than something you start with. */
      grit: 0,
      minDot: 0.05,               // dots smaller than this fraction of a cell are dropped
      angle: 45,                  // the screen angle; the others follow it
      mode: 'mono',               // mono | duotone | cmyk
      ink2: '#e5352b',            // the second ink, in duotone
      split: 0.45,                // where the dark ink comes in, in duotone
      gcr: 0.9,                   // black generation, four colour only
      seed: 1,                    // re-rolls where grit puts each dot
      preset: 'onecolour'         // the defaults are the first tile, and it says so
    },
    run: function (input, p, ctx) {
      if (!ctx.rasterize) return null;

      /* The screen frequency is the effect. Coarsening it for a preview moves
       * every dot, so the thing on screen while the slider is held has to be
       * screened at the frequency the file will be. */
      var freq = frequencyOf(p, input.bbox);
      var o = halftoneOptions(p, freq);

      // Halftone needs pixels. An imported bitmap gives them directly; vector
      // artwork gets rendered once, at a resolution tied to the screen pitch so
      // each cell still has something to average over.
      var tR = now();
      var px = ctx.rasterize(input, { frequency: freq, mode: o.mode, sampleScale: 1 }, ctx);
      if (!px || !px.w || !px.h) return null;
      var msRaster = Math.round(now() - tR);

      var tS = now();
      var res = H.screen(px.data, px.w, px.h, Object.assign({ invert: !!input.invert }, o));
      var msScreen = Math.round(now() - tS);

      // Dots come back in bitmap pixels; put them back into artwork units.
      var tM = now();
      var k = 1 / px.scale;
      // Ink on the page as a share of the bitmap, so a harness can see that a
      // control which is meant to close the gap between dots closed it.
      var inkArea = 0;
      var plates = res.channels.map(function (ch) {
        var d = ch.dots, out = new Float32Array(d.length);
        for (var q = 0; q < d.length; q += H.STRIDE) {
          out[q] = px.x + d[q] * k;
          out[q + 1] = px.y + d[q + 1] * k;
          out[q + 2] = d[q + 2] * k;
          out[q + 3] = d[q + 3];
          inkArea += Math.PI * d[q + 2] * d[q + 2];
        }
        return { key: ch.key, label: ch.label, colour: inkColour(p, ch.key), dots: out };
      });

      return {
        items: [],
        plates: plates,
        mode: o.mode,
        pattern: o.pattern,
        fuzziness: o.fuzziness,
        seed: o.seed,
        bbox: input.bbox,
        matte: input.matte,
        stats: { dots: res.stats.dots, plates: plates.length,
                 pitch: res.stats.spacing * k,
                 ink: inkArea / (px.w * px.h),
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

  /* Process inks carry their own colours. A one or two colour screen prints in
   * the layer's ink, which an effect never sees: the plate goes out marked and
   * the app paints it, so changing the ink is a repaint and not a screen. */
  function inkColour(p, key) {
    if (p.mode === 'duotone' && key === 'm') return p.ink2 || '#e5352b';
    if (p.mode !== 'cmyk') return '#000000';
    var found = H.CHANNELS.filter(function (c) { return c.key === key; })[0];
    return found ? found.colour : '#000000';
  }

  root.registerEffects = function () { return E.ids(); };
})(typeof module !== 'undefined' ? module.exports : self);
