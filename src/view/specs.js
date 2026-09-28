/* What every panel contains.
 *
 * The spec is the single source for a control's icon, its name, its tooltip and
 * the parameter it drives, so a control physically cannot reach the screen
 * without a name attached to it.
 *
 * Fewer controls than the engines have knobs, on purpose. A panel of twenty
 * sliders where five matter is a panel where none of them do, because nobody
 * can tell which five. Each effect shows the handful that change the picture;
 * the rest are settled by the style you pick.
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

  /* Halftone tiles: screen a real gradient with the real settings, so the tile
   * shows the true dot. One and two inks are drawn in the tile's own colour and
   * the second ink; four colour keeps its process inks on white, since that is
   * the only ground it is for. */
  var htThumbCache = {};
  function halftoneThumb(id) {
    if (htThumbCache[id]) return htThumbCache[id];
    var p = HALFTONE_PRESETS[id].params;
    var four = p.mode === 'cmyk';
    var w = 120, h = 38;
    var px = new Uint8ClampedArray(w * h * 4);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var t = x / (w - 1);
        var i = (y * w + x) * 4;
        if (four) {
          // A sweep with colour in it, or a separation has nothing to show.
          px[i] = Math.round(255 * (1 - t * 0.85));
          px[i + 1] = Math.round(120 * (1 - t));
          px[i + 2] = Math.round(60 + 180 * t);
        } else {
          px[i] = px[i + 1] = px[i + 2] = Math.round(255 * (1 - t * 0.92));
        }
        px[i + 3] = 255;
      }
    }
    var freq = Math.max(10, Math.min(26, Math.round(w / Math.max(2, p.pitch * 1.6))));
    var o = root.Effects.get('halftone').engineOptions(p, freq);
    o.seed = 3;
    var res = H.screen(px, w, h, o);
    var paths = res.channels.map(function (ch) {
      var fill = four ? ch.colour : ch.key === 'm' ? (p.ink2 || '#e5352b') : 'currentColor';
      return '<path d="' + H.channelPath(ch, o) + '" fill="' + fill + '"' +
        (four ? ' style="mix-blend-mode:multiply"' : '') + '/>';
    }).join('');
    htThumbCache[id] = '<svg viewBox="0 0 ' + w + ' ' + h + '">' + paths + '</svg>';
    return htThumbCache[id];
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

  /* Six, each a different thing, because fifteen that differed by a slider
   * were fifteen ways of not being able to tell. A style carries its texture,
   * so choosing a style is the whole choice; the sliders under it tune it.
   *
   * Every style sets `imageCut` as well. It decides how a photo is cut into
   * ink before any of the edge work happens, so leaving it out meant every
   * style inherited one threshold, and on anything with dark clothing or
   * shadow that threshold filled the picture in. */
  var DITHER_PRESETS = {
    stencil: { label: 'One colour', tip: 'One ink, clean edges, detail kept. The place to start on a photo', params: { imageCut: 0.38, imageLevels: 1, grain: 1.2, roughness: 1.4, bias: 0, blotchAmount: 0.35, spatter: 0.08, pit: 0.03, spread: 0, spreadDensity: 0.5, texture: 'none', textureAmount: 0, textureScale: 3, textureInvert: false, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    screenprint: { label: 'Screen print', tip: 'The same read, with the edge and the mottle a pulled screen actually leaves', params: { imageCut: 0.4, imageLevels: 1, grain: 1.7, roughness: 4.5, bias: 0.4, blotchAmount: 0.7, spatter: 0.28, pit: 0.12, spread: 1.5, spreadDensity: 0.5, texture: 'rough', textureAmount: 0.26, textureScale: 3.2, textureInvert: false, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    distressed: { label: 'Distressed', tip: 'Chewed and patchy, with crusty holes. Worn into the garment', params: { imageCut: 0.42, imageLevels: 1, grain: 2.6, roughness: 5.5, bias: -0.2, blotchAmount: 0.85, spatter: 0.4, pit: 0.16, spread: 2.5, spreadDensity: 0.45, texture: 'crust', textureAmount: 0.4, textureScale: 5, textureInvert: false, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    drybrush: { label: 'Dry brush', tip: 'Long streaks pulled through the shape by a starved brush', params: { imageCut: 0.42, imageLevels: 1, grain: 1.2, roughness: 4, bias: 0, blotchAmount: 0.7, spatter: 0.25, pit: 0.06, spread: 1.5, spreadDensity: 0.5, texture: 'fibre', textureAmount: 0.55, textureScale: 2.6, textureInvert: false, meltRadius: 0, meltCut: 0.5, scale: 1 } },
    photocopy: { label: 'Photocopy', tip: 'Banded and blown out, the way a tired copier prints', params: { imageCut: 0.42, imageLevels: 1, grain: 1, roughness: 3, bias: 0.4, blotchAmount: 0.5, spatter: 0.15, pit: 0.05, spread: 1, spreadDensity: 0.6, texture: 'scan', textureAmount: 0.4, textureScale: 3.4, textureInvert: false, meltRadius: 1.2, meltCut: 0.42, scale: 1 } },
    cracked: { label: 'Cracked', tip: 'Thin branching splits running through the ink', params: { imageCut: 0.42, imageLevels: 1, grain: 1.8, roughness: 4, bias: 0.5, blotchAmount: 0.6, spatter: 0.2, pit: 0.08, spread: 1, spreadDensity: 0.6, texture: 'crack', textureAmount: 0.6, textureScale: 4.5, textureInvert: false, meltRadius: 0, meltCut: 0.5, scale: 1 } }
  };

  function ditherTiles() {
    return Object.keys(DITHER_PRESETS).map(function (k) {
      return { value: k, label: DITHER_PRESETS[k].label,
               thumb: ditherThumb(k), tip: DITHER_PRESETS[k].tip };
    });
  }

  /* ---------- halftone styles ---------- */

  /* Five, and every one is a different kind of screen rather than a different
   * dot size: the dot size is a slider. Chosen by screening real photographs
   * and looking at the results, not by reasoning about them. */
  var HALFTONE_PRESETS = {
    onecolour: { label: 'One colour', tip: 'One ink, clean dots, fine enough to hold a face. The place to start', params: { mode: 'mono', pattern: 'round', pitch: 6, gain: 0.3, grit: 0, minDot: 0.05, angle: 45 } },
    twocolour: { label: 'Two colour', tip: 'Your ink for the shadows, a second for the rest. A riso or a two screen print', params: { mode: 'duotone', pattern: 'round', pitch: 7, gain: 0.2, grit: 0.3, minDot: 0.06, angle: 45, ink2: '#ff5a3c', split: 0.45 } },
    fourcolour: { label: 'Four colour', tip: 'Full process separation at a pitch that still prints. For white stock', params: { mode: 'cmyk', pattern: 'round', pitch: 5, gain: 0.12, grit: 0.1, minDot: 0.05, angle: 45 } },
    lines: { label: 'Line screen', tip: 'Bars instead of dots, the old gravure look', params: { mode: 'mono', pattern: 'line', pitch: 9, gain: 0.1, grit: 0, minDot: 0.05, angle: 45 } },
    photocopy: { label: 'Photocopy', tip: 'One ink, blown out, dirty. Every dot a little wrong', params: { mode: 'mono', pattern: 'round', pitch: 5, gain: 0.55, grit: 1, minDot: 0.06, angle: 45 } }
  };

  function halftoneTiles() {
    return Object.keys(HALFTONE_PRESETS).map(function (k) {
      return { value: k, label: HALFTONE_PRESETS[k].label,
               thumb: halftoneThumb(k), tip: HALFTONE_PRESETS[k].tip,
               paper: HALFTONE_PRESETS[k].params.mode === 'cmyk' };
    });
  }

  /* ---------- specs ---------- */

  var SPECS = {
    /* The top of the panel, above whichever effect is showing: the two
     * colours, and what a photo needs. Everything else about the layer sits
     * below the effect, because it is what you reach for less. */
    layer: function () {
      return [
        {
          title: 'Colour', id: 'colour',
          rows: [
            { kind: 'colour', id: 'paint.fill', label: 'Ink', icon: 'fill',
              tip: 'The one colour the artwork prints in. Every effect uses it: the ' +
                   'dither, the warp, and a one or two colour halftone' },
            { kind: 'colour', id: 'canvas', label: 'Canvas', icon: 'canvas',
              tip: 'The colour behind the artwork, like the garment it will go on. ' +
                   'Not saved into the file' },
            { kind: 'toggle', id: 'paint.useSourceColours', label: 'Source colours', icon: 'image',
              showIf: 'vector',
              tip: 'Keep the colours the file arrived with instead of the ink above. ' +
                   'Changing the ink switches this off' }
          ]
        },
        {
          title: 'Photo', id: 'photo', showIf: 'photo',
          rows: [
            { kind: 'button', id: 'hasMatte', label: 'Remove background',
              altLabel: 'Restore background', icon: 'cutBg', buttonIcon: 'cutBg',
              tip: 'Cuts the subject out of the photo so the effects stop putting ink ' +
                   'on the background. Runs on this machine; nothing is uploaded',
              action: function () { root.App.toggleBackground(); } },
            { kind: 'progress', id: 'bgProgress', icon: 'cutBg' },
            { kind: 'toggle', id: 'invert', label: 'Invert', icon: 'invert',
              tip: 'Ink the light parts of the picture instead of the dark. For a ' +
                   'photograph printed in a light ink on a dark garment' }
          ]
        }
      ];
    },

    more: function () {
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
          title: 'Outline and opacity', id: 'appearance',
          rows: [
            { kind: 'toggle', id: 'paint.fillOn', label: 'Filled', icon: 'fill',
              tip: 'Turn the fill off to leave only the outline' },
            { kind: 'colour', id: 'paint.stroke', label: 'Outline', icon: 'stroke',
              tip: 'Outline colour' },
            { kind: 'number', id: 'paint.strokeWidth', label: 'Weight', icon: 'stroke',
              min: 0, max: 400, scrub: 0.25, tip: 'Outline thickness. Zero means no outline' },
            { kind: 'range', id: 'paint.opacity', label: 'Opacity', icon: 'opacity',
              min: 0, max: 1, step: 0.01,
              fmt: function (v) { return Math.round(v * 100) + '%'; },
              tip: 'How transparent the whole layer is. Survives every effect' }
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
          rows: [
            { kind: 'tiles', id: 'preset', items: function () { return ditherTiles(); } },
            { kind: 'note', text: 'Pick one, then tune it below. A style is a starting ' +
              'point, not a lock.' }
          ]
        },
        {
          title: 'Photo',
          showIf: 'photo',
          rows: [
            { kind: 'range', id: 'imageCut', label: 'Threshold', icon: 'cutoff',
              min: 0.1, max: 0.85, step: 0.01, fmt: pct,
              tip: 'How much of the photo becomes ink. This is the dial to reach ' +
                   'for when a picture comes out as a solid blob' },
            { kind: 'range', id: 'imageLevels', label: 'Tone steps', icon: 'tone',
              min: 1, max: 4, step: 1, fmt: function (v) { return String(Math.round(v)); },
              tip: 'One is a clean stencil. More cuts the picture into bands and ' +
                   'chews the lighter ones harder, so one ink carries more than one tone' }
          ]
        },
        {
          title: 'Edge',
          rows: [
            { kind: 'range', id: 'roughness', label: 'Erosion', icon: 'erosion', min: 0, max: 20, step: 0.1,
              tip: 'How far the outline is eaten away. The main dial' },
            { kind: 'range', id: 'grain', label: 'Grain', icon: 'grain', min: 0.4, max: 8, step: 0.1,
              tip: 'Size of the bites. Small is a fine spray, large tears in chunks' },
            { kind: 'range', id: 'spatter', label: 'Spatter', icon: 'spatter', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'Loose specks thrown clear of the edge' },
            { kind: 'range', id: 'spread', label: 'Spread', icon: 'spread', min: 0, max: 25, step: 0.1,
              tip: 'Ink carried out past the edge, dissolving as it goes. The stacked ' +
                   'drop shadows, as real geometry' }
          ]
        },
        {
          title: 'Texture',
          rows: [
            { kind: 'note', text: 'This style prints solid inside the edge.', showIf: 'notexture' },
            { kind: 'range', id: 'textureAmount', label: 'Amount', icon: 'texAmt', min: 0, max: 1, step: 0.01,
              fmt: pct, showIf: 'texture', tip: 'How much of the style’s texture knocks ink out' },
            { kind: 'button', id: 'ownTexture', label: 'Use an image of yours', icon: 'image',
              buttonIcon: 'open',
              tip: 'A scan, a photo of a wall, anything: its light and dark become the texture',
              action: function () { document.getElementById('textureFile').click(); } }
          ]
        }
      ];
    },

    halftone: function () {
      return [
        {
          title: 'Halftone', id: 'halftoneHead', toggleId: '__on',
          rows: [
            { kind: 'note', text: 'Screens the artwork into a dot pattern. Each ink ' +
              'exports as one compound path.' }
          ]
        },
        {
          title: 'Style',
          rows: [
            { kind: 'tiles', id: 'preset', items: function () { return halftoneTiles(); } },
            { kind: 'note', text: 'Pick one, then tune it below. A screen is a starting ' +
              'point, not a lock.' }
          ]
        },
        {
          title: 'Screen',
          rows: [
            { kind: 'segment', id: 'mode', label: 'Inks', icon: 'mode',
              options: [
                { value: 'mono', label: 'One', tip: 'One ink, in the layer colour. What most garment prints are' },
                { value: 'duotone', label: 'Two', tip: 'The layer colour for the shadows and a second ink for the rest' },
                { value: 'cmyk', label: 'Four', tip: 'Cyan, magenta, yellow and black, separated. For white stock' }
              ],
              tip: 'How many inks the screen separates into' },
            { kind: 'segment', id: 'pattern', label: 'Dot', icon: 'dot',
              options: [
                { value: 'round', label: 'Round', icon: 'dot', tip: 'The standard dot' },
                { value: 'square', label: 'Square', icon: 'dotSq', tip: 'Hard cells, reads as digital' },
                { value: 'ellipse', label: 'Ellipse', icon: 'dotEl', tip: 'Chain dots, smoother midtones' },
                { value: 'line', label: 'Line', icon: 'dotLn', tip: 'Bars instead of dots' },
                { value: 'cross', label: 'Cross', icon: 'dotX', tip: 'A plus shape, reads as woven' },
                { value: 'diamond', label: 'Diamond', icon: 'dotDi', tip: 'Rotated squares' }
              ],
              tip: 'The shape of each dot' },
            { kind: 'range', id: 'pitch', label: 'Dot size', icon: 'freq', min: 1.5, max: 60, step: 0.1,
              fmt: function (v) { return v.toFixed(1) + 'px'; },
              tip: 'Spacing between dot centres, in artwork pixels. Small is a fine screen ' +
                   'and far more dots. Independent of how big the artwork is' },
            { kind: 'range', id: 'gain', label: 'Weight', icon: 'gain', min: -1, max: 1, step: 0.01,
              fmt: pct, tip: 'Heavier or lighter than the picture asks for. Positive fattens ' +
                   'the midtones, the way real paper does' },
            { kind: 'range', id: 'grit', label: 'Grit', icon: 'patchy', min: 0, max: 1, step: 0.01,
              fmt: pct, tip: 'How far from a clean dot. Zero is exact; up, the dots drift, ' +
                   'fray and the paper starves them in patches' },
            { kind: 'range', id: 'minDot', label: 'Smallest dot', icon: 'dot', min: 0, max: 0.3, step: 0.005,
              fmt: pct, tip: 'Drop dots smaller than this share of a cell. Raise it to stop ' +
                   'highlights turning into dust a screen cannot hold' },
            { kind: 'range', id: 'angle', label: 'Angle', icon: 'rotate', min: 0, max: 90, step: 1,
              fmt: function (v) { return Math.round(v) + '°'; },
              tip: 'The screen angle. Forty five is the classic; the other inks sit ' +
                   'thirty degrees apart from it so they never moire' }
          ]
        },
        {
          title: 'Second ink',
          showIf: 'duotone',
          rows: [
            { kind: 'colour', id: 'ink2', label: 'Colour', icon: 'inkDrop',
              tip: 'The second ink. It carries the whole range; the layer colour comes in for the shadows' },
            { kind: 'range', id: 'split', label: 'Split', icon: 'gcr',
              min: 0.1, max: 0.85, step: 0.01, fmt: pct,
              tip: 'Where the dark ink starts. Low and the shadows fill early; high and the second ink carries most of the picture' }
          ]
        }
      ];
    }
  };

  function pct(v) { return Math.round(v * 100) + '%'; }

  root.SPECS = SPECS;
  root.DITHER_PRESETS = DITHER_PRESETS;
  root.HALFTONE_PRESETS = HALFTONE_PRESETS;
})(window);
