/* What every panel contains.
 *
 * The spec is the single source for a control's icon, its name, its tooltip and
 * the parameter it drives, so a control physically cannot reach the screen
 * without a name attached to it.
 */
(function (root) {
  'use strict';

  var ICON = root.ICON, W = root.Warp, G = root.Grunge, H = root.Halftone;

  /* ---------- thumbnails, drawn by the real engines ---------- */

  var BARS = 'M6 10H90V26H6ZM6 34H62V50H6ZM6 58H90V74H6Z';

  function warpThumb(id) {
    var opts = { preset: id, strength: 58, smooth: true };
    if (id === 'free') {
      opts.corners = [{ x: .16, y: 0 }, { x: 1, y: .14 }, { x: .84, y: 1 }, { x: 0, y: .86 }];
    }
    var d = W.warp([BARS], { x: 0, y: 0, width: 96, height: 80 }, opts).join(' ');
    var b = W.bounds([d]), pad = Math.max(b.width, b.height) * 0.05;
    return '<svg viewBox="' + (b.x - pad) + ' ' + (b.y - pad) + ' ' +
      (b.width + pad * 2) + ' ' + (b.height + pad * 2) +
      '"><path d="' + d + '" fill="currentColor"/></svg>';
  }

  /* Run the erosion on a slab so each style tile shows what it actually does. */
  var ditherThumbCache = {};
  function ditherThumb(id) {
    if (ditherThumbCache[id]) return ditherThumbCache[id];
    var p = DITHER_PRESETS[id].params;
    var bbox = { x: 0, y: 0, width: 46, height: 13 };
    var out;
    try {
      out = G.fromPaths(['M0 0H46V13H0Z'], bbox, Object.assign({}, {
        grain: p.grain, roughness: p.roughness, bias: p.bias,
        blotchAmount: p.blotchAmount, spatter: p.spatter, pit: p.pit,
        spread: p.spread, spreadDensity: p.spreadDensity,
        texture: p.texture, textureAmount: p.textureAmount, textureScale: p.textureScale,
        meltRadius: p.meltRadius, meltCut: p.meltCut,
        pxPerUnit: 3, detail: 0.35, minArea: 1, smooth: 1, seed: 6
      }));
    } catch (e) { out = null; }
    var d = (out && out.d) || 'M0 0H46V13H0Z';
    var svg = '<svg viewBox="-4 -4 54 21"><path d="' + d + '" fill="currentColor"/></svg>';
    ditherThumbCache[id] = svg;
    return svg;
  }

  /* Texture swatches: the field itself, at the tile's own proportions. */
  var texThumbCache = {};
  function textureThumb(name) {
    if (texThumbCache[name]) return texThumbCache[name];
    var w = 250, h = 76;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(w, h);
    var N = { a: G.makeNoise(3307), b: G.makeNoise(7717) };
    var fn = G.TEXTURES[name];
    var vals = new Float64Array(w * h);
    for (var i = 0, y = 0; y < h; y++) {
      for (var x = 0; x < w; x++, i++) vals[i] = fn(N, x * 0.09, y * 0.09);
    }
    var sorted = Float64Array.from(vals); sorted.sort();
    var cut = sorted[Math.floor(0.55 * (vals.length - 1))];
    for (i = 0; i < vals.length; i++) {
      var on = vals[i] > cut ? 0 : 214;
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = on;
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    var url = '<img alt="" src="' + c.toDataURL() + '">';
    texThumbCache[name] = url;
    return url;
  }

  /* Halftone tiles: screen a real gradient so the tile shows the true dot. */
  var htThumbCache = {};
  function halftoneThumb(id) {
    if (htThumbCache[id]) return htThumbCache[id];
    var p = HALFTONE_PRESETS[id].params;
    var w = 120, h = 38;
    var px = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var t = x / (w - 1);
        var v = Math.round(255 * (1 - t * 0.92));
        var i = (y * w + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
      }
    }
    var res = H.screen(px, w, h, {
      frequency: Math.max(10, Math.min(26, p.frequency / 4)),
      pattern: p.pattern, inkDensity: p.inkDensity, dotGain: p.dotGain,
      roughness: p.roughness, fuzziness: p.fuzziness, paperFibre: p.paperFibre,
      inkTexture: p.inkTexture, minDot: p.minDot, seed: 3,
      channels: { c: 0, m: 0, y: 0, k: 1 }
    });
    var d = H.channelPath(res.channels[0], p);
    htThumbCache[id] = '<svg viewBox="0 0 ' + w + ' ' + h + '"><path d="' + d +
      '" fill="currentColor"/></svg>';
    return htThumbCache[id];
  }

  function glyph(name) {
    return '<span class="glyph">' + (ICON[name] || '') + '</span>';
  }

  var WARP_TIPS = {
    free: 'No bend of its own. Drag the four corners',
    arc: 'Bends the whole lockup into a rainbow',
    peak: 'Like Arc but pointed at the centre',
    archUp: 'Domes the top edge, leaves the base flat',
    archDown: 'Domes the base, leaves the top flat',
    bulge: 'Fattens through the middle',
    squeeze: 'Pinches the middle',
    flag: 'Waves both edges together',
    wave: 'Waves the edges against each other',
    rise: 'Lifts one end in a straight ramp',
    slant: 'Shears sideways, like an italic',
    shear: 'Tilts the baseline',
    taperTop: 'Narrows the top into a trapezoid',
    taperBase: 'Narrows the base into a trapezoid',
    perspective: 'Trapezoid with a depth shift',
    inflate: 'Lens bulge through the centre',
    twist: 'Rotates the middle against the ends',
    fish: 'Squeezes the ends vertically'
  };

  /* ---------- dither styles ---------- */

  var DITHER_PRESETS = {
    spray: { label: 'Spray', tip: 'The base spray can look. Soft eroded edge with ink carrying past it', params: { grain: 1.6, roughness: 7, bias: 0, blotchAmount: 0.85, spatter: 0.45, pit: 0.14, spread: 4.5, spreadDensity: 0.55, texture: 'rough', textureAmount: 0.3, textureScale: 3, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    halo: { label: 'Halo', tip: 'Ink pushed far past the edge and left wispy. The stacked drop shadows', params: { grain: 1.3, roughness: 3, bias: 0, blotchAmount: 0.6, spatter: 0.3, pit: 0.04, spread: 11, spreadDensity: 0.28, texture: 'none', textureAmount: 0, textureScale: 3, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    charcoal: { label: 'Charcoal', tip: 'Coarse and patchy, like a stick dragged over rough paper', params: { grain: 4.2, roughness: 11, bias: -1, blotchAmount: 0.95, spatter: 0.5, pit: 0.22, spread: 3, spreadDensity: 0.4, texture: 'crust', textureAmount: 0.42, textureScale: 5.5, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    drybrush: { label: 'Dry brush', tip: 'Long streaks pulled through the shape by a starved brush', params: { grain: 1.2, roughness: 4, bias: 0, blotchAmount: 0.7, spatter: 0.25, pit: 0.06, spread: 1.5, spreadDensity: 0.5, texture: 'fibre', textureAmount: 0.55, textureScale: 2.6, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    photocopy: { label: 'Photocopy', tip: 'Banded and blown out, the way a tired copier prints', params: { grain: 1, roughness: 3, bias: 0.4, blotchAmount: 0.5, spatter: 0.15, pit: 0.05, spread: 1, spreadDensity: 0.6, texture: 'scan', textureAmount: 0.4, textureScale: 3.4, meltRadius: 1.2, meltCut: 0.42, scale: 1 } },
    bleed: { label: 'Bleed', tip: 'Ink spreading into the paper and fusing. Soft and heavy', params: { grain: 2.4, roughness: 5, bias: 1.2, blotchAmount: 0.6, spatter: 0.2, pit: 0, spread: 3, spreadDensity: 0.8, texture: 'none', textureAmount: 0, textureScale: 3, meltRadius: 3.4, meltCut: 0.38, scale: 1 } },
    sandpaper: { label: 'Sandpaper', tip: 'Fine even dust chewing at every edge', params: { grain: 0.9, roughness: 5, bias: -0.4, blotchAmount: 0.4, spatter: 0.6, pit: 0.28, spread: 2, spreadDensity: 0.45, texture: 'speckle', textureAmount: 0.35, textureScale: 1.4, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    stamp: { label: 'Rubber stamp', tip: 'Solid core, ragged rim, ink skipping in patches', params: { grain: 2.8, roughness: 4, bias: 0.6, blotchAmount: 0.9, spatter: 0.15, pit: 0.3, spread: 1, spreadDensity: 0.7, texture: 'crust', textureAmount: 0.3, textureScale: 6, meltRadius: 1.6, meltCut: 0.46, scale: 1 } },
    halftoneDots: { label: 'Dot screen', tip: 'A dot grid chewed straight out of the shape', params: { grain: 1.4, roughness: 2, bias: 0.8, blotchAmount: 0.3, spatter: 0.1, pit: 0, spread: 0, spreadDensity: 0.5, texture: 'halftone', textureAmount: 0.52, textureScale: 2.2, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    cracked: { label: 'Cracked', tip: 'Thin branching splits running through the ink', params: { grain: 1.8, roughness: 4, bias: 0.5, blotchAmount: 0.6, spatter: 0.2, pit: 0.08, spread: 1, spreadDensity: 0.6, texture: 'crack', textureAmount: 0.6, textureScale: 4.5, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    concrete: { label: 'Concrete', tip: 'Pitted and mineral, like ink printed onto a wall', params: { grain: 2.2, roughness: 6, bias: 0, blotchAmount: 0.8, spatter: 0.35, pit: 0.18, spread: 3, spreadDensity: 0.5, texture: 'concrete', textureAmount: 0.45, textureScale: 4, meltRadius: 0.8, meltCut: 0.5, scale: 1 } },
    melted: { label: 'Melted', tip: 'Everything fused into soft blobs. Detail gone on purpose', params: { grain: 3.4, roughness: 9, bias: 0, blotchAmount: 0.7, spatter: 0.4, pit: 0.1, spread: 4, spreadDensity: 0.6, texture: 'none', textureAmount: 0, textureScale: 3, meltRadius: 5.5, meltCut: 0.52, scale: 1 } }
  };

  var TEXTURE_TIPS = {
    none: 'No texture. The inside of the shape stays solid',
    rough: 'Mottled wear, the most generally useful one',
    crust: 'Big crusty patches with hard edges',
    speckle: 'Fine even dust',
    crack: 'Thin branching splits',
    scan: 'Horizontal banding, like a photocopier',
    fibre: 'Long diagonal strokes, like a dry brush',
    concrete: 'Pitted mineral surface',
    halftone: 'A regular dot grid',
    spray: 'Clustered droplets'
  };
  var TEXTURE_LABELS = {
    none: 'None', rough: 'Rough', crust: 'Crust', speckle: 'Speckle', crack: 'Cracks',
    scan: 'Scan lines', fibre: 'Fibre', concrete: 'Concrete', halftone: 'Halftone',
    spray: 'Spray', image: 'Import'
  };

  /* ---------- halftone styles ---------- */

  var HALFTONE_PRESETS = {
    newsprint: { label: 'Newsprint', tip: 'Coarse screen, heavy dot gain, grey paper', params: { frequency: 70, pattern: 'round', inkDensity: 0.92, dotGain: 0.35, roughness: 0.12, fuzziness: 0.1, paperFibre: 0.22, inkTexture: 0.12, gcr: 1, minDot: 0.07, mode: 'cmyk', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 } } },
    comic: { label: 'Comic', tip: 'Big clean dots on a wide screen. Ben Day', params: { frequency: 48, pattern: 'round', inkDensity: 1, dotGain: 0.1, roughness: 0, fuzziness: 0, paperFibre: 0, inkTexture: 0, gcr: 0.85, minDot: 0.1, mode: 'cmyk', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 } } },
    riso: { label: 'Risograph', tip: 'Two inks, slightly off register, grainy', params: { frequency: 85, pattern: 'round', inkDensity: 0.86, dotGain: 0.2, roughness: 0.3, fuzziness: 0.25, paperFibre: 0.3, inkTexture: 0.25, gcr: 1, minDot: 0.08, mode: 'duotone', anglePreset: 'reference', angles: { c: 15, m: -15, y: 0, k: 45 }, duotone: ['#1b1b1b', '#ff5a3c'] } },
    fine: { label: 'Fine art', tip: 'Tight screen, accurate tone, no distress', params: { frequency: 160, pattern: 'round', inkDensity: 0.95, dotGain: 0, roughness: 0, fuzziness: 0, paperFibre: 0, inkTexture: 0, gcr: 0.9, minDot: 0.04, mode: 'cmyk', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 } } },
    poster: { label: 'Coarse poster', tip: 'Very wide screen. The dots are the artwork', params: { frequency: 30, pattern: 'round', inkDensity: 1, dotGain: 0.15, roughness: 0.08, fuzziness: 0.05, paperFibre: 0.1, inkTexture: 0, gcr: 1, minDot: 0.12, mode: 'mono', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 }, duotone: ['#111111', '#e5352b'] } },
    copier: { label: 'Photocopy', tip: 'Black only, blown out, dirty', params: { frequency: 110, pattern: 'round', inkDensity: 1, dotGain: 0.55, roughness: 0.4, fuzziness: 0.45, paperFibre: 0.45, inkTexture: 0.4, gcr: 1, minDot: 0.06, mode: 'mono', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 }, duotone: ['#000000', '#e5352b'] } },
    lineScreen: { label: 'Line screen', tip: 'Bars instead of dots, the old gravure look', params: { frequency: 64, pattern: 'line', inkDensity: 0.95, dotGain: 0.1, roughness: 0, fuzziness: 0, paperFibre: 0.08, inkTexture: 0, gcr: 1, minDot: 0.05, mode: 'mono', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 }, duotone: ['#111111', '#e5352b'] } },
    square: { label: 'Square dot', tip: 'Hard square cells. Reads as digital', params: { frequency: 72, pattern: 'square', inkDensity: 0.95, dotGain: 0.05, roughness: 0, fuzziness: 0, paperFibre: 0, inkTexture: 0, gcr: 1, minDot: 0.06, mode: 'cmyk', anglePreset: 'classic', angles: { c: 15, m: 75, y: 0, k: 45 } } }
  };

  /* ---------- specs ---------- */

  var SPECS = {
    layer: function () {
      return [
        {
          title: 'Transform', id: 'transform',
          rows: [
            { kind: 'pair', id: 'pos', scrub: 1,
              a: { id: 'transform.x', label: 'X' }, b: { id: 'transform.y', label: 'Y' },
              tip: 'Position of the artwork in the document' },
            { kind: 'pair', id: 'size', scrub: 1, lock: 'lockRatio',
              a: { id: 'transform.width', label: 'W' }, b: { id: 'transform.height', label: 'H' },
              tip: 'Size of the frame. The effects run inside it' },
            { kind: 'number', id: 'transform.rotation', label: 'Rotate', icon: 'rotate',
              min: -360, max: 360, scrub: 0.5,
              tip: 'Turn the artwork. Shift while dragging a corner snaps to 15 degrees' },
            { kind: 'toggle', id: 'transform.flipX', label: 'Flip across', icon: 'flipH',
              tip: 'Mirror left to right' },
            { kind: 'toggle', id: 'transform.flipY', label: 'Flip down', icon: 'flipV',
              tip: 'Mirror top to bottom' }
          ]
        },
        {
          title: 'Appearance', id: 'appearance',
          rows: [
            { kind: 'toggle', id: 'paint.useSourceColours', label: 'Source colours', icon: 'image',
              tip: 'Keep the fills and strokes the file arrived with, instead of the ones below' },
            { kind: 'colour', id: 'paint.fill', label: 'Fill', icon: 'fill',
              tip: 'Colour of the artwork' },
            { kind: 'toggle', id: 'paint.fillOn', label: 'Filled', icon: 'fill',
              tip: 'Turn the fill off to leave only the stroke' },
            { kind: 'colour', id: 'paint.stroke', label: 'Stroke', icon: 'stroke',
              tip: 'Outline colour' },
            { kind: 'number', id: 'paint.strokeWidth', label: 'Weight', icon: 'stroke',
              min: 0, max: 400, scrub: 0.25, tip: 'Outline thickness. Zero means no outline' },
            { kind: 'range', id: 'paint.opacity', label: 'Opacity', icon: 'opacity',
              min: 0, max: 1, step: 0.01,
              fmt: function (v) { return Math.round(v * 100) + '%'; },
              tip: 'How transparent the whole layer is. Survives every effect' }
          ]
        },
        {
          title: 'Background', id: 'background',
          rows: [
            { kind: 'note', text: 'Cuts the subject out of an imported photo so the effects ' +
              'stop putting ink on the background.' },
            { kind: 'button', id: 'removeBgRow', label: 'Remove background', icon: 'cutBg',
              buttonIcon: 'cutBg', action: function () { document.getElementById('removeBg').click(); } }
          ]
        }
      ];
    },

    warp: function () {
      return [
        {
          title: 'Warp', id: 'warpHead', toggleId: '__on',
          rows: [
            { kind: 'note', text: 'Bends the outline. The four handles on the canvas stay ' +
              'live on every preset, and arrow keys nudge the selected one.' }
          ]
        },
        {
          title: 'Shape',
          rows: [{
            kind: 'tiles', id: 'preset',
            items: function () {
              return W.PRESETS.map(function (p) {
                return { value: p.id, label: p.label, thumb: warpThumb(p.id), tip: WARP_TIPS[p.id] || '' };
              });
            }
          }]
        },
        {
          rows: [
            { kind: 'range', id: 'strength', label: 'Strength', icon: 'strength',
              min: -100, max: 100, step: 1,
              tip: 'How hard the preset bends. Negative bends the other way' },
            { kind: 'toggle', id: 'smooth', label: 'Smooth', icon: 'smooth',
              tip: 'Refit the bent outline to curves. Off gives faceted edges' }
          ]
        }
      ];
    },

    dither: function () {
      return [
        {
          title: 'Dither', id: 'ditherHead', toggleId: '__on',
          rows: [
            { kind: 'note', text: 'Eats the outline into ink spatter. Real contours, so it ' +
              'stays vector at any size.' }
          ]
        },
        {
          title: 'Style',
          rows: [{
            kind: 'tiles', id: 'preset',
            items: function () {
              return Object.keys(DITHER_PRESETS).map(function (k) {
                return { value: k, label: DITHER_PRESETS[k].label,
                         thumb: ditherThumb(k), tip: DITHER_PRESETS[k].tip };
              });
            }
          }]
        },
        {
          title: 'Edge',
          rows: [
            { kind: 'range', id: 'grain', label: 'Grain', icon: 'grain', min: 0.4, max: 8, step: 0.1,
              tip: 'Size of the speckle. Small is a fine spray, large tears in chunks' },
            { kind: 'range', id: 'roughness', label: 'Erosion', icon: 'erosion', min: 0, max: 20, step: 0.1,
              tip: 'How far the outline is eaten away. The main dial' },
            { kind: 'range', id: 'bias', label: 'Weight', icon: 'weight', min: -6, max: 6, step: 0.1,
              tip: 'Push the whole outline in or out' },
            { kind: 'range', id: 'blotchAmount', label: 'Patchy', icon: 'patchy', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'How much the erosion varies across the artwork. Zero looks mechanical' },
            { kind: 'range', id: 'spatter', label: 'Spatter', icon: 'spatter', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'Loose specks thrown clear of the edge' },
            { kind: 'range', id: 'pit', label: 'Pits', icon: 'pits', min: 0, max: 0.45, step: 0.01,
              fmt: pct, tip: 'Holes opened up inside the strokes' }
          ]
        },
        {
          title: 'Spread',
          rows: [
            { kind: 'note', text: 'Ink pushed out past the edge, dissolving as it goes. ' +
              'The stacked drop shadows, as real geometry.' },
            { kind: 'range', id: 'spread', label: 'Spread', icon: 'spread', min: 0, max: 25, step: 0.1,
              tip: 'How far the ink carries past the original edge' },
            { kind: 'range', id: 'spreadDensity', label: 'Density', icon: 'density', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'Solid at the top of the range, a thin halo of droplets at the bottom' }
          ]
        },
        {
          title: 'Texture',
          rows: [
            { kind: 'tiles', id: 'texture',
              items: function () {
                var list = [{ value: 'none', label: 'None', thumb: glyph('none'), tip: TEXTURE_TIPS.none }];
                G.TEXTURE_NAMES.forEach(function (t) {
                  list.push({ value: t, label: TEXTURE_LABELS[t] || t,
                              thumb: textureThumb(t), tip: TEXTURE_TIPS[t] || '' });
                });
                list.push({ value: 'image', label: 'Import', thumb: glyph('image'),
                            tip: 'Use an image of your own as the texture' });
                return list;
              } },
            { kind: 'range', id: 'textureAmount', label: 'Amount', icon: 'texAmt', min: 0, max: 1, step: 0.01,
              fmt: pct, showIf: 'texture', tip: 'How much of the texture knocks ink out' },
            { kind: 'range', id: 'textureScale', label: 'Size', icon: 'texScale', min: 0.5, max: 14, step: 0.1,
              showIf: 'texture', tip: 'Size of the texture grain' },
            { kind: 'toggle', id: 'textureInvert', label: 'Invert', icon: 'invert',
              showIf: 'texture', tip: 'Swap which parts of the texture remove ink' }
          ]
        },
        {
          title: 'Melt',
          rows: [
            { kind: 'note', text: 'Blur the coverage then cut it again. Small specks dissolve, ' +
              'close neighbours fuse, edges go soft.' },
            { kind: 'range', id: 'meltRadius', label: 'Blur', icon: 'melt', min: 0, max: 8, step: 0.1,
              tip: 'How far the blur reaches before the outline is re-cut' },
            { kind: 'range', id: 'meltCut', label: 'Cutoff', icon: 'cutoff', min: 0.2, max: 0.8, step: 0.01,
              fmt: pct, tip: 'Where the blurred coverage is cut. Low fattens, high eats away' }
          ]
        },
        {
          title: 'Quality',
          rows: [
            { kind: 'range', id: 'scale', label: 'Effect scale', icon: 'gscale', min: 0.25, max: 4, step: 0.05,
              fmt: function (v) { return Math.round(v * 100) + '%'; },
              tip: 'Scales every distance at once, so the look holds on artwork of any size' },
            { kind: 'range', id: 'pxPerUnit', label: 'Detail', icon: 'detail', min: 1, max: 4.5, step: 0.1,
              tip: 'Working resolution. Higher resolves finer grain and costs more paths' },
            { kind: 'range', id: 'detail', label: 'Simplify', icon: 'simplify', min: 0.15, max: 1.5, step: 0.01,
              tip: 'Contour tolerance. Raise it to cut the number of paths' },
            { kind: 'number', id: 'seed', label: 'Seed', icon: 'seed', min: 1, max: 999999, scrub: 1,
              tip: 'Same seed, same result. Change it to re-roll the randomness' }
          ]
        }
      ];
    },

    halftone: function () {
      return [
        {
          title: 'Halftone', id: 'halftoneHead', toggleId: '__on',
          rows: [
            { kind: 'note', text: 'Screens the artwork into a real CMYK dot pattern. Every ' +
              'plate exports as one compound path, so the file opens as four objects.' }
          ]
        },
        {
          title: 'Style',
          rows: [{
            kind: 'tiles', id: 'preset',
            items: function () {
              return Object.keys(HALFTONE_PRESETS).map(function (k) {
                return { value: k, label: HALFTONE_PRESETS[k].label,
                         thumb: halftoneThumb(k), tip: HALFTONE_PRESETS[k].tip };
              });
            }
          }]
        },
        {
          title: 'Screen',
          rows: [
            { kind: 'segment', id: 'mode', label: 'Inks', icon: 'mode',
              options: [
                { value: 'cmyk', label: 'CMYK', tip: 'Full four colour separation' },
                { value: 'duotone', label: 'Duo', tip: 'Two inks. What most garment prints use' },
                { value: 'mono', label: 'Mono', tip: 'One ink' }
              ],
              tip: 'How many inks the screen separates into' },
            { kind: 'tiles', id: 'pattern',
              items: function () {
                return [
                  { value: 'round', label: 'Round', thumb: glyph('dot'), tip: 'The standard dot' },
                  { value: 'square', label: 'Square', thumb: glyph('dotSq'), tip: 'Hard cells, reads as digital' },
                  { value: 'ellipse', label: 'Ellipse', thumb: glyph('dotEl'), tip: 'Chain dots, smoother midtones' },
                  { value: 'line', label: 'Line', thumb: glyph('dotLn'), tip: 'Bars instead of dots' },
                  { value: 'cross', label: 'Cross', thumb: glyph('dotX'), tip: 'A plus shape, reads as woven' },
                  { value: 'diamond', label: 'Diamond', thumb: glyph('dotDi'), tip: 'Rotated squares' }
                ];
              } },
            { kind: 'range', id: 'frequency', label: 'Frequency', icon: 'freq', min: 12, max: 500, step: 1,
              tip: 'Screen cells across the artwork. The pitch in pixels is shown in the toolbar' },
            { kind: 'range', id: 'inkDensity', label: 'Ink density', icon: 'inkDrop', min: 0.2, max: 1.3, step: 0.01,
              fmt: pct, tip: 'Global multiplier on how much ink each dot carries' },
            { kind: 'range', id: 'dotGain', label: 'Dot gain', icon: 'gain', min: -1, max: 1, step: 0.01,
              fmt: pct, tip: 'Paper spreads ink, so midtones print heavier. Positive fattens them' },
            { kind: 'range', id: 'minDot', label: 'Min dot', icon: 'dot', min: 0, max: 0.3, step: 0.005,
              fmt: pct, tip: 'Drop dots smaller than this. Raise it to stop highlights turning into dust' },
            { kind: 'colour', id: 'paper', label: 'Paper', icon: 'paper',
              tip: 'The ground the ink prints onto. Travels with the exported file' }
          ]
        },
        {
          title: 'Paper and ink',
          rows: [
            { kind: 'range', id: 'roughness', label: 'Roughness', icon: 'patchy', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'Jitters each dot off its exact position and size' },
            { kind: 'range', id: 'fuzziness', label: 'Fuzziness', icon: 'grain', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'How ragged each dot outline is. Zero is a clean arc' },
            { kind: 'range', id: 'paperFibre', label: 'Paper fibre', icon: 'paper', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'A slow field that starves ink in patches, like absorbent stock' },
            { kind: 'range', id: 'inkTexture', label: 'Ink texture', icon: 'inkDrop', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'Mottling inside each dot' }
          ]
        },
        {
          title: 'Separation',
          rows: [
            { kind: 'range', id: 'gcr', label: 'Black gen', icon: 'gcr', min: 0, max: 1, step: 0.01,
              fmt: pct, showIf: 'cmyk',
              tip: 'How much of the common grey moves into the black plate. High keeps shadows clean' },
            { kind: 'select', id: 'anglePreset', label: 'Angles', icon: 'rotate',
              options: [
                { value: 'classic', label: 'Classic 15/75/0/45' },
                { value: 'reference', label: 'Offset 15/-15/0/45' },
                { value: 'flat', label: 'All zero' }
              ],
              tip: 'Screen angles. Thirty degrees apart is what stops a moire pattern forming' },
            { kind: 'number', id: 'angles.c', label: 'Cyan', icon: 'rotate', min: -90, max: 90, scrub: 0.5, showIf: 'cmyk' },
            { kind: 'number', id: 'angles.m', label: 'Magenta', icon: 'rotate', min: -90, max: 90, scrub: 0.5 },
            { kind: 'number', id: 'angles.y', label: 'Yellow', icon: 'rotate', min: -90, max: 90, scrub: 0.5, showIf: 'cmyk' },
            { kind: 'number', id: 'angles.k', label: 'Black', icon: 'rotate', min: -90, max: 90, scrub: 0.5 },
            { kind: 'toggle', id: 'channels.c', label: 'Cyan plate', icon: 'eye', showIf: 'cmyk' },
            { kind: 'toggle', id: 'channels.m', label: 'Magenta plate', icon: 'eye', showIf: 'cmyk' },
            { kind: 'toggle', id: 'channels.y', label: 'Yellow plate', icon: 'eye', showIf: 'cmyk' },
            { kind: 'toggle', id: 'channels.k', label: 'Black plate', icon: 'eye', showIf: 'cmyk' },
            { kind: 'colour', id: 'duotone.0', label: 'Ink one', icon: 'fill', showIf: 'duotone',
              tip: 'The dark ink' },
            { kind: 'colour', id: 'duotone.1', label: 'Ink two', icon: 'fill', showIf: 'duotone',
              tip: 'The second ink. Ignored in mono' }
          ]
        },
        {
          title: 'Quality',
          rows: [
            { kind: 'range', id: 'sampleScale', label: 'Sampling', icon: 'detail', min: 0.4, max: 2.5, step: 0.05,
              fmt: function (v) { return Math.round(v * 100) + '%'; },
              tip: 'How finely the artwork is measured before screening. Raise it if fine detail is lost' },
            { kind: 'number', id: 'seed', label: 'Seed', icon: 'seed', min: 1, max: 999999, scrub: 1,
              tip: 'Same seed, same result' }
          ]
        }
      ];
    }
  };

  function pct(v) { return Math.round(v * 100) + '%'; }

  root.SPECS = SPECS;
  root.DITHER_PRESETS = DITHER_PRESETS;
  root.HALFTONE_PRESETS = HALFTONE_PRESETS;
  root.TEXTURE_LABELS = TEXTURE_LABELS;
  root.textureThumb = textureThumb;
})(window);
