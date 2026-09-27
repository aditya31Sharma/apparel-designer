/* Wiring the three engines into the registry.
 *
 * Each one only knows about geometry. None of them reads the layer's transform,
 * paint or opacity, so all of those survive whatever the stack does.
 */
(function (root) {
  'use strict';

  var E = root.Effects, W = root.Warp, G = root.Grunge, H = root.Halftone;

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
    run: function (input, p) {
      var corners = p.corners || W.DEFAULT_CORNERS;
      var opts = {
        preset: p.preset, strength: p.strength, smooth: p.smooth, corners: corners
      };
      var items = [], n = 0;
      input.items.forEach(function (it) {
        var parts = W.warp([it.d], input.bbox, opts);
        if (!parts.length) return;
        items.push(Object.assign({}, it, { d: parts.join(' ') }));
        n++;
      });
      if (!items.length) return null;
      return {
        items: items,
        bbox: W.bounds(items.map(function (i) { return i.d; })),
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
      preset: ''
    },
    run: function (input, p, ctx) {
      if (!ctx.maskFromPaths) return null;
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
        meltRadius: p.meltRadius * s, meltCut: p.meltCut,
        detail: p.detail, minArea: 2.2, smooth: 1, seed: p.seed,
        pxPerUnit: p.pxPerUnit * (ctx.quality === undefined ? 1 : ctx.quality)
      };
      var items = [], kept = 0, points = 0;
      input.items.forEach(function (it) {
        var bb = W.bounds([it.d]);
        if (!bb.width || !bb.height) return;
        // Keep the working bitmap sane however far Detail is pushed.
        var px = Math.min(o.pxPerUnit, 2600 / Math.max(bb.width, bb.height));
        var r = G.fromPaths([it.d], bb, Object.assign({}, o, { pxPerUnit: px }));
        if (!r.d) return;
        kept += r.stats.kept; points += r.stats.points;
        items.push(Object.assign({}, it, { d: r.d }));
      });
      if (!items.length) return null;
      return {
        items: items,
        bbox: W.bounds(items.map(function (i) { return i.d; })),
        matte: input.matte,
        stats: { shapes: kept, points: points }
      };
    }
  });

  /* ---------- halftone ---------- */

  E.register({
    id: 'halftone',
    label: 'Halftone',
    icon: 'halftone',
    tip: 'Screen the artwork into a CMYK dot pattern, as real vectors',
    defaults: {
      frequency: 90,
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
      paper: '#ffffff',                          // ground the ink multiplies onto
      sampleScale: 1,                            // raster resolution multiplier
      preset: ''
    },
    run: function (input, p, ctx) {
      if (!ctx.rasterize) return null;

      // Halftone needs pixels. An imported bitmap gives them directly; vector
      // artwork gets rendered once, at a resolution tied to the screen pitch so
      // each cell still has something to average over.
      var px = ctx.rasterize(input, p, ctx);
      if (!px || !px.w || !px.h) return null;

      var channels = channelsFor(p);
      var res = H.screen(px.data, px.w, px.h, {
        frequency: p.frequency, pattern: p.pattern, inkDensity: p.inkDensity,
        dotGain: p.dotGain, roughness: p.roughness, fuzziness: p.fuzziness,
        paperFibre: p.paperFibre, inkTexture: p.inkTexture,
        gcr: p.mode === 'mono' ? 1 : p.gcr,
        minDot: p.minDot, seed: p.seed,
        angles: p.angles, channels: channels
      });

      // Dots come back in bitmap pixels; put them back into artwork units.
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
                 pitch: res.stats.spacing * k }
      };
    }
  });

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
