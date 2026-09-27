/* Warp - standalone tool. One pixel space: 1 SVG user unit = 1 px at 100% zoom. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  /* Readouts are inputs in the Figma-style panel, spans elsewhere. */
  function setVal(id, text) {
    var el = $(id);
    if (!el) return;
    if ('value' in el && el.tagName === 'INPUT') el.value = text;
    else el.textContent = text;
  }

  // Surface boot and runtime errors instead of failing silently to a blank page.
  window.addEventListener('error', function (e) {
    var box = $('err');
    if (!box) return;
    box.textContent = (e.message || 'error') + '  @' +
      String(e.filename || '').split('/').pop() + ':' + e.lineno;
    box.classList.add('on');
  });
  var SVGNS = 'http://www.w3.org/2000/svg';
  var NUDGE = 1, BIG = 10, SNAP_PX = 6, HANDLE_R = 5.5;

  var S = {
    items: [], paths: [], bbox: null, fill: '#ffffff', name: '',
    preset: 'arc', strength: 45, smooth: true,
    quad: null,            // four corners in world px
    selected: -1,
    view: { x: 0, y: 0, k: 1 },
    guides: [], out: [], seed: 1, grungeStats: null,
    texture: 'none', textureImage: null, textureName: '', gPreset: ''
  };

  /* ---------- geometry helpers ---------- */

  var toScreen = function (p) {
    return { x: (p.x - S.view.x) * S.view.k, y: (p.y - S.view.y) * S.view.k };
  };
  var toWorld = function (sx, sy) {
    return { x: sx / S.view.k + S.view.x, y: sy / S.view.k + S.view.y };
  };
  var defaultQuad = function (b) {
    return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y },
            { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
  };
  var normQuad = function () {
    var b = S.bbox;
    return S.quad.map(function (c) {
      return { x: (c.x - b.x) / b.width, y: (c.y - b.y) / b.height };
    });
  };
  var el = function (tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  /* ---------- the warp ---------- */

  /* Every length in the dither is in mask pixels, so one multiplier holds the
   * whole look together as the artwork changes size. Photoshop calls this
   * Scale Layer Effects. */
  function grungeOpts() {
    var k = +$('gScale').value / 100;
    return {
      grain: (+$('gGrain').value / 10) * k,
      roughness: (+$('gRough').value / 10) * k,
      bias: (+$('gBias').value / 10) * k,
      blotch: 90 * k,
      blotchAmount: +$('gBlotch').value / 100,
      spatter: +$('gSpatter').value / 100,
      spatterRange: 7 * k,
      pit: +$('gPit').value / 100,
      pitDepth: 6 * k,

      spread: (+$('gSpread').value / 10) * k,
      spreadDensity: +$('gSpreadD').value / 100,

      texture: S.texture,
      textureAmount: S.texture === 'none' ? 0 : +$('gTexAmt').value / 100,
      textureScale: (+$('gTexScale').value / 10) * k,
      textureInvert: $('gTexInv').checked,
      textureImage: S.textureImage,

      meltRadius: (+$('gMelt').value / 10) * k,
      meltCut: +$('gMeltCut').value / 100,

      pxPerUnit: +$('gRes').value / 10,
      detail: +$('gSimp').value / 100,
      minArea: 2.2,
      smooth: 1,
      seed: S.seed
    };
  }

  function compute() {
    if (!S.items.length) { S.out = []; return; }
    var opts = { preset: S.preset, strength: S.strength, smooth: S.smooth,
                 corners: normQuad() };
    S.out = [];
    S.items.forEach(function (it) {
      var parts = Warp.warp([it.d], S.bbox, opts);
      if (parts.length) S.out.push({ d: parts.join(' '), src: it });
    });

    // Grunge runs last, on the warped outline, so the erosion follows the bend.
    if ($('gOn').checked && S.out.length) {
      var go = grungeOpts();
      var total = { kept: 0, points: 0 };
      var t0 = performance.now();
      S.out = S.out.map(function (o) {
        var bb = Warp.bounds([o.d]);
        if (!bb.width || !bb.height) return o;
        // Keep the mask to a sane size however far the user pushes Detail.
        var px = Math.min(go.pxPerUnit, 2600 / Math.max(bb.width, bb.height));
        var r = Grunge.fromPaths([o.d], bb, Object.assign({}, go, { pxPerUnit: px }));
        if (!r.d) return o;
        total.kept += r.stats.kept; total.points += r.stats.points;
        return { d: r.d, src: o.src };
      });
      S.grungeStats = { ms: Math.round(performance.now() - t0),
                        rings: total.kept, points: total.points };
    } else {
      S.grungeStats = null;
    }
  }

  function allPaths() {
    return S.out.map(function (o) { return o.d; });
  }

  /* The panel's colours win only when "use source colours" is off. */
  function paintFor(item) {
    if ($('srcColours').checked) {
      return { fill: item.fill, stroke: item.stroke, sw: item.strokeWidth };
    }
    return {
      fill: $('fillOn').checked ? S.fill : 'none',
      stroke: (parseFloat($('strokeW').value) || 0) > 0 ? $('strokeC').value : 'none',
      sw: parseFloat($('strokeW').value) || 0
    };
  }

  /* ---------- drawing ---------- */

  function stageSize() {
    var r = $('stage').getBoundingClientRect();
    return { w: r.width, h: r.height };
  }

  /* Grid steps climb 1, 2, 5, 10, 20, 50 ... so a line is never closer than a
   * few screen pixels however far you zoom out. */
  function gridStep() {
    var target = 9 / S.view.k, pow = Math.pow(10, Math.floor(Math.log10(target)));
    var n = target / pow;
    return (n > 5 ? 10 : n > 2 ? 5 : n > 1 ? 2 : 1) * pow;
  }

  function drawGrid() {
    var g = $('grid');
    g.textContent = '';
    if (!$('showGrid').checked) return;
    var sz = stageSize(), step = gridStep(), k = S.view.k;
    var x0 = Math.floor(S.view.x / step) * step;
    var y0 = Math.floor(S.view.y / step) * step;
    var x1 = S.view.x + sz.w / k, y1 = S.view.y + sz.h / k;
    var frag = document.createDocumentFragment();

    for (var x = x0; x <= x1; x += step) {
      var sx = Math.round((x - S.view.x) * k) + 0.5;
      var major = Math.abs(x / (step * 10) - Math.round(x / (step * 10))) < 1e-6;
      frag.appendChild(el('line', {
        x1: sx, y1: 0, x2: sx, y2: sz.h,
        stroke: Math.abs(x) < 1e-9 ? 'var(--axis)' : (major ? 'var(--grid10)' : 'var(--grid)'),
        'stroke-width': 1
      }));
    }
    for (var y = y0; y <= y1; y += step) {
      var sy = Math.round((y - S.view.y) * k) + 0.5;
      var majorY = Math.abs(y / (step * 10) - Math.round(y / (step * 10))) < 1e-6;
      frag.appendChild(el('line', {
        x1: 0, y1: sy, x2: sz.w, y2: sy,
        stroke: Math.abs(y) < 1e-9 ? 'var(--axis)' : (majorY ? 'var(--grid10)' : 'var(--grid)'),
        'stroke-width': 1
      }));
    }
    g.appendChild(frag);
  }

  function draw() {
    drawGrid();
    var world = $('world');
    world.setAttribute('transform',
      'translate(' + (-S.view.x * S.view.k) + ',' + (-S.view.y * S.view.k) + ') scale(' + S.view.k + ')');

    var art = $('art');
    art.textContent = '';
    S.out.forEach(function (o) {
      var paint = paintFor(o.src);
      var attrs = { d: o.d, fill: paint.fill || 'none' };
      if (paint.stroke && paint.stroke !== 'none' && paint.sw > 0) {
        attrs.stroke = paint.stroke;
        attrs['stroke-width'] = paint.sw;
        attrs['stroke-linejoin'] = 'round';
        attrs['stroke-linecap'] = 'round';
      }
      art.appendChild(el('path', attrs));
    });

    var quad = $('quad');
    if (S.quad) {
      quad.setAttribute('points', S.quad.map(function (c) { return c.x + ',' + c.y; }).join(' '));
      quad.setAttribute('fill', 'none');
      quad.setAttribute('stroke', 'var(--accent)');
      quad.setAttribute('stroke-width', 1 / S.view.k);
      quad.setAttribute('stroke-dasharray', (3 / S.view.k) + ' ' + (3 / S.view.k));
      quad.setAttribute('opacity', '.75');
    } else {
      quad.removeAttribute('points');
    }

    drawHandles();
    drawGuides();
    hud();
  }

  function drawHandles() {
    var h = $('handles');
    h.textContent = '';
    if (!S.quad) return;
    S.quad.forEach(function (c, i) {
      var p = toScreen(c);
      var g = el('g', { class: 'handle', tabindex: '0', 'data-i': i,
        style: 'cursor:grab;outline:none' });
      g.appendChild(el('circle', {
        cx: p.x, cy: p.y, r: HANDLE_R + (S.selected === i ? 1.5 : 0),
        fill: S.selected === i ? '#fff' : 'var(--accent)',
        stroke: S.selected === i ? 'var(--accent)' : '#fff', 'stroke-width': 2
      }));
      h.appendChild(g);
    });
  }

  function drawGuides() {
    var g = $('guides');
    g.textContent = '';
    var sz = stageSize();
    S.guides.forEach(function (gd) {
      if (gd.axis === 'x') {
        var sx = Math.round((gd.v - S.view.x) * S.view.k) + 0.5;
        g.appendChild(el('line', { x1: sx, y1: 0, x2: sx, y2: sz.h,
          stroke: 'var(--snap)', 'stroke-width': 1 }));
      } else {
        var sy = Math.round((gd.v - S.view.y) * S.view.k) + 0.5;
        g.appendChild(el('line', { x1: 0, y1: sy, x2: sz.w, y2: sy,
          stroke: 'var(--snap)', 'stroke-width': 1 }));
      }
    });
  }

  function hud() {
    var b = S.out.length ? Warp.bounds(allPaths()) : null;
    var bits = [Math.round(S.view.k * 100) + '%'];
    if (b) bits.push(Math.round(b.width) + ' x ' + Math.round(b.height) + ' px');
    bits.push('grid ' + gridStep() + 'px');
    if (S.out.length) {
      var subs = allPaths().join(' ').split('M').length - 1;
      bits.push(S.out.length + (S.out.length === 1 ? ' path' : ' paths') +
                ', ' + subs + ' contours');
    }
    if (S.selected >= 0) {
      var c = S.quad[S.selected];
      bits.push('corner ' + (Math.round(c.x * 10) / 10) + ', ' + (Math.round(c.y * 10) / 10));
    }
    $('hud').textContent = bits.join('  ·  ');
    setVal('zoomVal', Math.round(S.view.k * 100) + '%');
    var gs = $('gStats');
    if (gs) {
      gs.textContent = S.grungeStats
        ? S.grungeStats.rings + ' shapes · ' + S.grungeStats.points.toLocaleString() +
          ' points · ' + S.grungeStats.ms + 'ms'
        : '';
    }
  }

  function render() { compute(); draw(); }

  /* ---------- view ---------- */

  function fit() {
    if (!S.out.length) return;
    var b = Warp.bounds(allPaths()), sz = stageSize();
    var pad = 60;
    S.view.k = Math.min((sz.w - pad * 2) / b.width, (sz.h - pad * 2) / b.height, 8);
    S.view.x = b.x + b.width / 2 - sz.w / (2 * S.view.k);
    S.view.y = b.y + b.height / 2 - sz.h / (2 * S.view.k);
    draw();
  }

  $('fit').onclick = fit;
  $('zoom100').onclick = function () {
    var sz = stageSize(), c = toWorld(sz.w / 2, sz.h / 2);
    S.view.k = 1;
    S.view.x = c.x - sz.w / 2; S.view.y = c.y - sz.h / 2;
    draw();
  };

  $('stage').addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = $('stage').getBoundingClientRect();
    var mx = e.clientX - r.left, my = e.clientY - r.top;
    var before = toWorld(mx, my);
    var factor = Math.pow(1.0015, -e.deltaY * (e.ctrlKey ? 3 : 1));
    S.view.k = Math.max(0.02, Math.min(400, S.view.k * factor));
    var after = toWorld(mx, my);
    S.view.x += before.x - after.x;
    S.view.y += before.y - after.y;
    draw();
  }, { passive: false });

  $('stage').addEventListener('pointerdown', function (e) {
    if (e.target.closest('.handle')) return;
    var sx = e.clientX, sy = e.clientY, ox = S.view.x, oy = S.view.y;
    $('stage').classList.add('pan');
    S.selected = -1;
    var move = function (ev) {
      S.view.x = ox - (ev.clientX - sx) / S.view.k;
      S.view.y = oy - (ev.clientY - sy) / S.view.k;
      draw();
    };
    var up = function () {
      $('stage').classList.remove('pan');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    draw();
  });

  /* ---------- handles: drag, snap, keyboard ---------- */

  function snapOpts(i, bypass) {
    return {
      corners: S.quad, moving: i, bbox: S.bbox,
      tol: SNAP_PX / S.view.k,
      grid: parseFloat($('gridStep').value) || 1,
      pixel: !bypass && $('snapPixel').checked,
      align: !bypass && $('snapAlign').checked
    };
  }

  $('handles').addEventListener('pointerdown', function (e) {
    var g = e.target.closest('.handle');
    if (!g) return;
    e.preventDefault(); e.stopPropagation();
    var i = +g.dataset.i;
    S.selected = i;
    g.focus({ preventScroll: true });
    var move = function (ev) {
      var r = $('stage').getBoundingClientRect();
      var w = toWorld(ev.clientX - r.left, ev.clientY - r.top);
      var res = Snap.apply(w.x, w.y, snapOpts(i, ev.metaKey || ev.ctrlKey));
      S.quad[i] = { x: res.x, y: res.y };
      S.guides = res.guides;
      render();
    };
    var up = function () {
      S.guides = [];
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draw();
      focusHandle(i);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    render();
  });

  $('handles').addEventListener('focusin', function (e) {
    var g = e.target.closest('.handle');
    if (g && S.selected !== +g.dataset.i) { S.selected = +g.dataset.i; draw(); }
  });

  function focusHandle(i) {
    var g = $('handles').querySelector('.handle[data-i="' + i + '"]');
    if (g) g.focus({ preventScroll: true });
  }

  window.addEventListener('keydown', function (e) {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    var i = S.selected;
    if (i < 0 || !S.quad) return;
    var dx = 0, dy = 0;
    if (e.key === 'ArrowLeft') dx = -1;
    else if (e.key === 'ArrowRight') dx = 1;
    else if (e.key === 'ArrowUp') dy = -1;
    else if (e.key === 'ArrowDown') dy = 1;
    else if (e.key === 'Escape') { S.selected = -1; draw(); return; }
    else if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault();
      S.quad[i] = defaultQuad(S.bbox)[i];
      S.guides = []; render(); focusHandle(i); return;
    } else return;

    e.preventDefault();
    var step = e.shiftKey ? BIG : NUDGE;      // real pixels, because 1 unit is 1 px
    var nx = S.quad[i].x + dx * step, ny = S.quad[i].y + dy * step;
    // Nudging is already exact, so only alignment snapping applies.
    var res = Snap.apply(nx, ny, {
      corners: S.quad, moving: i, bbox: S.bbox, tol: SNAP_PX / S.view.k,
      grid: 0, pixel: false, align: $('snapAlign').checked
    });
    S.quad[i] = { x: res.x, y: res.y };
    S.guides = res.guides;
    render();
    focusHandle(i);
    clearTimeout(window.__gt);
    window.__gt = setTimeout(function () { S.guides = []; draw(); }, 550);
  });

  /* ---------- presets ---------- */

  // three stacked bars, warped live to draw each shape preset's thumbnail
  var BARS = 'M0 0 H96 V17 H0 Z M0 25 H70 V42 H0 Z M0 50 H96 V67 H0 Z';

  var PRESET_TIP = {
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

  function buildPresets() {
    $('presets').innerHTML = Warp.PRESETS.map(function (p) {
      var opts = { preset: p.id, strength: 58, smooth: true };
      if (p.id === 'free') {
        opts.corners = [{ x: .16, y: 0 }, { x: 1, y: .14 }, { x: .84, y: 1 }, { x: 0, y: .86 }];
      }
      var d = Warp.warp([BARS], { x: 0, y: 0, width: 96, height: 67 }, opts).join(' ');
      var b = Warp.bounds([d]), pad = Math.max(b.width, b.height) * .05;
      return '<div class="preset' + (p.id === S.preset ? ' on' : '') + '" data-id="' +
        p.id + '" data-tip="' + p.label + '|' + (PRESET_TIP[p.id] || '') +
        '"><svg viewBox="' + (b.x - pad) + ' ' + (b.y - pad) + ' ' +
        (b.width + pad * 2) + ' ' + (b.height + pad * 2) + '"><path d="' + d +
        '" fill="currentColor"/></svg><span class="nm">' + p.label + '</span></div>';
    }).join('');
    Array.prototype.forEach.call($('presets').children, function (n) {
      n.onclick = function () {
        S.preset = n.dataset.id;
        Array.prototype.forEach.call($('presets').children, function (o) {
          o.classList.toggle('on', o === n);
        });
        render();
      };
    });
  }

  /* ---------- controls ---------- */

  $('strength').oninput = function () {
    S.strength = +this.value; setVal('strengthVal', this.value); render();
  };
  $('smooth').onchange = function () { S.smooth = this.checked; render(); };
  $('fill').oninput = function () { S.fill = this.value; draw(); };
  $('fillOn').onchange = draw;
  $('srcColours').onchange = draw;
  $('strokeW').oninput = draw;
  $('strokeC').oninput = draw;
  var G_IDS = ['gGrain', 'gRough', 'gBias', 'gBlotch', 'gSpatter', 'gPit',
               'gSpread', 'gSpreadD', 'gTexAmt', 'gTexScale',
               'gMelt', 'gMeltCut', 'gScale', 'gRes', 'gSimp'];
  var tenth = function (v) { return (v / 10).toFixed(1); };
  var G_FMT = {
    gGrain: tenth, gRough: tenth, gBias: tenth, gSpread: tenth,
    gTexScale: tenth, gMelt: tenth, gRes: tenth,
    gScale: function (v) { return v + '%'; },
    gSimp: function (v) { return (v / 100).toFixed(2); }
  };
  var G_DEFAULT = { gGrain: 16, gRough: 70, gBias: 0, gBlotch: 85, gSpatter: 45,
                    gPit: 14, gSpread: 0, gSpreadD: 55, gTexAmt: 0, gTexScale: 30,
                    gMelt: 0, gMeltCut: 50, gScale: 100, gRes: 20, gSimp: 45 };

  function syncGrungeLabels() {
    G_IDS.forEach(function (id) {
      var v = +$(id).value;
      setVal(id + 'Val', G_FMT[id] ? G_FMT[id](v) : String(v));
    });
  }

  G_IDS.forEach(function (id) {
    $(id).oninput = function () {
      // Hand-editing a dial means the result is no longer that named style.
      if (S.gPreset && id !== 'gRes' && id !== 'gSimp') {
        S.gPreset = ''; markOn('gPresets', '');
      }
      syncGrungeLabels(); render();
    };
  });
  $('gOn').onchange = function () {
    $('gControls').style.display = this.checked ? '' : 'none';
    render();
  };
  $('gSeed').onclick = function () {
    S.seed = (Math.random() * 100000) | 0;
    render();
  };
  $('gReset').onclick = function () {
    applyGrungePreset(G_DEFAULT, 'none', '');
  };
  syncGrungeLabels();

  /* ---------- dither styles ---------- */

  /* Slider values, not engine values, so the panel always shows what is set.
   * Anything left out falls back to the default. */
  var G_PRESETS = [
    { id: 'spray', name: 'Spray', tip: 'The base spray can look. Soft eroded edge with ink carrying past it',
      tex: 'rough', v: { gGrain: 14, gRough: 60, gSpatter: 50, gPit: 12,
                         gSpread: 40, gSpreadD: 50, gTexAmt: 25, gTexScale: 30 } },
    { id: 'halo', name: 'Halo', tip: 'A wide thin haze of droplets around an almost clean shape',
      tex: 'none', v: { gGrain: 18, gRough: 45, gSpatter: 35, gPit: 6,
                        gSpread: 95, gSpreadD: 22 } },
    { id: 'charcoal', name: 'Charcoal', tip: 'Coarse and crumbling, the way a stick breaks on rough paper',
      tex: 'crust', v: { gGrain: 34, gRough: 95, gBlotch: 95, gSpatter: 55, gPit: 22,
                         gSpread: 20, gTexAmt: 40, gTexScale: 55 } },
    { id: 'drybrush', name: 'Dry brush', tip: 'Long streaks pulled through the shape by a half dry bristle',
      tex: 'fibre', v: { gGrain: 10, gRough: 35, gSpatter: 20, gPit: 8,
                         gTexAmt: 45, gTexScale: 22 } },
    { id: 'photocopy', name: 'Photocopy', tip: 'Banded and contrasty, a page run through the machine too many times',
      tex: 'scan', v: { gGrain: 8, gRough: 30, gSpatter: 25, gPit: 6,
                        gTexAmt: 40, gTexScale: 26, gMelt: 12, gMeltCut: 58 } },
    { id: 'bleed', name: 'Bleed', tip: 'Wet ink spreading and pooling, edges fused together',
      tex: 'none', v: { gGrain: 22, gRough: 70, gSpatter: 60, gPit: 8,
                        gSpread: 55, gSpreadD: 70, gMelt: 38, gMeltCut: 34 } },
    { id: 'sand', name: 'Sandpaper', tip: 'Fine even dust pitting the whole surface',
      tex: 'speckle', v: { gGrain: 7, gRough: 25, gSpatter: 30, gPit: 30,
                           gTexAmt: 35, gTexScale: 12 } },
    { id: 'stamp', name: 'Rubber stamp', tip: 'Patchy pressure, solid in places and starved in others',
      tex: 'crust', v: { gGrain: 20, gRough: 45, gBlotch: 95, gSpatter: 25, gPit: 24,
                         gTexAmt: 30, gTexScale: 60, gMelt: 16, gMeltCut: 55 } },
    { id: 'halftone', name: 'Halftone', tip: 'A printer dot screen on a 15 degree angle, eaten into the shape',
      tex: 'halftone', v: { gGrain: 9, gRough: 20, gSpatter: 0, gPit: 0,
                            gTexAmt: 45, gTexScale: 24 } },
    { id: 'cracked', name: 'Cracked', tip: 'Thin branching splits running through solid ink',
      tex: 'crack', v: { gGrain: 16, gRough: 40, gSpatter: 15, gPit: 10,
                         gTexAmt: 30, gTexScale: 45 } },
    { id: 'concrete', name: 'Concrete', tip: 'Sprayed onto a rough wall, texture and spread together',
      tex: 'concrete', v: { gGrain: 24, gRough: 65, gBlotch: 90, gSpatter: 40, gPit: 18,
                            gSpread: 25, gTexAmt: 40, gTexScale: 40 } },
    { id: 'melted', name: 'Melted', tip: 'Blurred and re-cut hard, so everything fuses into organic blobs',
      tex: 'none', v: { gGrain: 26, gRough: 85, gSpatter: 65, gPit: 10,
                        gSpread: 35, gMelt: 55, gMeltCut: 62 } }
  ];

  function applyGrungePreset(vals, texture, id) {
    Object.keys(G_DEFAULT).forEach(function (k) {
      $(k).value = vals[k] !== undefined ? vals[k] : G_DEFAULT[k];
    });
    setTexture(texture);
    S.gPreset = id || '';
    markOn('gPresets', S.gPreset);
    syncGrungeLabels();
    render();
  }

  function markOn(hostId, id) {
    Array.prototype.forEach.call($(hostId).children, function (n) {
      n.classList.toggle('on', n.dataset.id === id);
    });
  }

  /* Every tile is the engine run for real on a small block, so what you see on
   * the swatch is what the preset does. */
  function presetThumb(preset) {
    var w = 46, h = 26, m = new Uint8Array(w * h);
    for (var y = 6; y < 20; y++) for (var x = 5; x < 41; x++) m[y * w + x] = 1;
    var v = {};
    Object.keys(G_DEFAULT).forEach(function (k) {
      v[k] = preset.v[k] !== undefined ? preset.v[k] : G_DEFAULT[k];
    });
    // The thumb is about a fifth of a real artwork, so scale the lengths down.
    var k = 0.42;
    var r = Grunge.erode(m, w, h, {
      grain: (v.gGrain / 10) * k, roughness: (v.gRough / 10) * k,
      bias: (v.gBias / 10) * k, blotch: 90 * k, blotchAmount: v.gBlotch / 100,
      spatter: v.gSpatter / 100, spatterRange: 7 * k,
      pit: v.gPit / 100, pitDepth: 6 * k,
      spread: (v.gSpread / 10) * k, spreadDensity: v.gSpreadD / 100,
      texture: preset.tex, textureAmount: preset.tex === 'none' ? 0 : v.gTexAmt / 100,
      textureScale: (v.gTexScale / 10) * k,
      meltRadius: (v.gMelt / 10) * k, meltCut: v.gMeltCut / 100,
      detail: 0.25, smooth: 1, minArea: 0.6, seed: 11
    });
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="xMidYMid meet">' +
      '<path d="' + Grunge.ringsToPath(r.rings, {}) + '" fill="currentColor"/></svg>';
  }

  /* Texture swatches are the raw field cut at its own midpoint, so each one
   * shows its real character rather than a drawn impression of it. */
  function textureThumb(name) {
    // Drawn at twice the tile it sits in, and in the tile's own proportions, so
    // the swatch is neither stretched nor chunky.
    var w = 250, h = 76, c = document.createElement('canvas');
    c.width = w; c.height = h;
    var ctx = c.getContext('2d');
    var img = ctx.createImageData(w, h);
    var N = { a: Grunge.makeNoise(3307), b: Grunge.makeNoise(7717) };
    var fn = Grunge.TEXTURES[name];
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
    return c.toDataURL();
  }

  function setTexture(name) {
    S.texture = name;
    markOn('gTextures', name);
  }

  function buildDitherTiles() {
    $('gPresets').innerHTML = G_PRESETS.map(function (p) {
      return '<div class="preset" data-id="' + p.id + '" data-tip="' + p.name +
        '|' + p.tip + '"><span class="thumb">' + presetThumb(p) +
        '</span><span class="cap">' + p.name + '</span></div>';
    }).join('');
    Array.prototype.forEach.call($('gPresets').children, function (n) {
      n.onclick = function () {
        var p = G_PRESETS.filter(function (o) { return o.id === n.dataset.id; })[0];
        applyGrungePreset(p.v, p.tex, p.id);
      };
    });

    var TEX_TIP = {
      none: 'None|No texture. Leave the inside of the shape solid',
      rough: 'Rough|Broad mottled wear, the most general purpose one',
      crust: 'Crust|Big crusty patches with hard edges',
      speckle: 'Speckle|Fine even dust',
      crack: 'Cracks|Thin branching splits',
      scan: 'Scan lines|Horizontal banding, like a bad photocopy',
      fibre: 'Fibre|Long diagonal strokes, a dry brush or paper grain',
      concrete: 'Concrete|Pitted stone, blotches and ridges together',
      halftone: 'Halftone|A print dot screen on a 15 degree angle',
      spray: 'Spray|Clustered droplets, dense in patches',
      image: 'Import|Use an image of your own as the texture'
    };
    var tile = function (id, inner) {
      var parts = TEX_TIP[id].split('|');
      return '<div class="preset" data-id="' + id + '" data-tip="' + TEX_TIP[id] +
        '"' + (id === 'image' ? ' id="texImport"' : '') +
        '><span class="thumb">' + inner + '</span>' +
        '<span class="cap">' + parts[0] + '</span></div>';
    };
    var tiles = tile('none', window.ICON.none);
    tiles += Grunge.TEXTURE_NAMES.map(function (t) {
      return tile(t, '<img alt="" src="' + textureThumb(t) + '">');
    }).join('');
    tiles += tile('image', window.ICON.image);
    $('gTextures').innerHTML = tiles;

    Array.prototype.forEach.call($('gTextures').children, function (n) {
      n.onclick = function () {
        if (n.dataset.id === 'image') { $('texFile').click(); return; }
        setTexture(n.dataset.id);
        // Picking a texture with the amount at zero would do nothing visible.
        if (n.dataset.id !== 'none' && +$('gTexAmt').value === 0) {
          $('gTexAmt').value = 35; syncGrungeLabels();
        }
        render();
      };
    });
    setTexture(S.texture);
  }

  /* An imported texture becomes a luminance field. Most distress scans are ink
   * on paper, so if the image reads mostly light, assume the dark marks are
   * what should eat the shape and start inverted. */
  $('texFile').onchange = function () {
    var f = this.files[0];
    this.value = '';
    if (!f) return;
    var url = URL.createObjectURL(f);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      var max = 512;
      var sc = Math.min(1, max / Math.max(img.width, img.height));
      var w = Math.max(8, Math.round(img.width * sc));
      var h = Math.max(8, Math.round(img.height * sc));
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      var px = ctx.getImageData(0, 0, w, h).data;
      var data = new Float32Array(w * h), sum = 0;
      for (var i = 0, q = 0; i < data.length; i++, q += 4) {
        var a = px[q + 3] / 255;
        var l = (0.2126 * px[q] + 0.7152 * px[q + 1] + 0.0722 * px[q + 2]) / 255;
        data[i] = l * a + (1 - a);
        sum += data[i];
      }
      S.textureImage = { data: data, w: w, h: h };
      S.textureName = f.name;
      $('gTexInv').checked = sum / data.length > 0.55;
      $('gTexInv').dispatchEvent(new Event('change', { bubbles: true }));
      $('texImport').dataset.tip = 'Import|' + f.name +
        ', ' + w + ' by ' + h + '. Click to swap it';
      setTexture('image');
      if (+$('gTexAmt').value === 0) { $('gTexAmt').value = 40; syncGrungeLabels(); }
      render();
    };
    img.onerror = function () { fail('Could not read that texture'); };
    img.src = url;
  };
  $('gTexInv').onchange = render;
  buildDitherTiles();

  $('showGrid').onchange = draw;
  $('bg').onchange = function () {
    var st = $('stage');
    st.classList.remove('bg-light', 'bg-checker');
    if (this.value !== 'dark') st.classList.add('bg-' + this.value);
    draw();
  };
  $('gridStep').oninput = hud;
  $('resetQuad').onclick = function () {
    S.quad = defaultQuad(S.bbox); S.guides = []; render();
  };

  /* ---------- loading artwork ---------- */

  function load(items, name) {
    S.items = items;
    S.paths = items.map(function (i) { return i.d; });
    S.bbox = Warp.bounds(S.paths);
    if (!S.bbox.width || !S.bbox.height) { fail('That artwork has no area'); return; }
    var painted = items.filter(function (i) { return i.fill && i.fill !== 'none'; })[0];
    S.fill = (painted && /^#[0-9a-f]{6}$/i.test(painted.fill)) ? painted.fill : '#ffffff';
    $('fill').value = S.fill;
    S.quad = defaultQuad(S.bbox);
    S.selected = -1;
    S.name = name || 'artwork';
    $('srcName').textContent = name + '  ·  ' +
      Math.round(S.bbox.width) + ' x ' + Math.round(S.bbox.height) + ' px';
    $('err').classList.remove('on');
    compute(); fit();
  }

  function fail(msg) {
    var e = $('err'); e.textContent = msg; e.classList.add('on');
  }

  /* ---------- raster images ---------- */

  function traceImage() {
    var img = S.image;
    if (!img) return;
    var levels = +$('levels').value;
    var cut = +$('imgThresh').value / 100;
    var r = Grunge.masksFromImage(img, 1600, levels, cut, false);
    var items = [];
    for (var k = levels - 1; k >= 0; k--) {     // lightest band first, ink on top
      var rings = Grunge.traceRings(r.masks[k], r.w, r.h);
      var kept = [];
      for (var i = 0; i < rings.length; i++) {
        if (Math.abs(Grunge.ringArea(rings[i])) < 3) continue;
        var simp = Grunge.rdp(rings[i], 0.6);
        if (simp.length > 2) kept.push(Grunge.chaikin(simp, 1));
      }
      if (!kept.length) continue;
      // Darkest band is black; lighter bands step towards paper.
      var t = levels === 1 ? 0 : k / levels;
      var g = Math.round(t * 205);
      var hex = '#' + [g, g, g].map(function (n) {
        return ('0' + n.toString(16)).slice(-2);
      }).join('');
      items.push({ d: Grunge.ringsToPath(kept, { scale: 1 }),
                   fill: hex, stroke: 'none', strokeWidth: 0 });
    }
    if (!items.length) { fail('Nothing came through at that cutoff'); return; }
    $('srcColours').checked = true;
    load(items, S.imageName);
  }

  function loadImageFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      S.image = img;
      S.imageName = file.name;
      $('imgRow').style.display = '';
      $('imgRow2').style.display = '';
      traceImage();
    };
    img.onerror = function () { fail('Could not read that image'); };
    img.src = url;
  }

  function isImage(file) {
    return /^image\/(png|jpeg|jpg|webp|gif|bmp)$/i.test(file.type) ||
           /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
  }

  $('levels').oninput = function () {
    setVal('levelsVal', this.value); traceImage();
  };
  $('imgThresh').oninput = function () {
    setVal('imgThreshVal', this.value); traceImage();
  };

  function loadMarkup(markup, name) {
    try {
      var r = SvgIn.parse(markup);
      $('srcColours').checked = true;
      load(r.items, name || 'pasted SVG');
    } catch (err) {
      fail(err.message || String(err));
    }
  }

  $('open').onclick = function () { $('file').click(); };
  $('openSvg').onclick = function () { $('file').click(); };
  $('file').onchange = function () {
    var f = this.files[0];
    if (!f) return;
    if (isImage(f)) loadImageFile(f);
    else f.text().then(function (t) { loadMarkup(t, f.name); });
    this.value = '';
  };
  $('pasteSvg').onclick = function () { $('pasteBtn').onclick(); };
  $('pasteBtn').onclick = function () {
    if (!navigator.clipboard || !navigator.clipboard.readText) {
      return fail('Use ⌘V instead, this browser will not read the clipboard on demand');
    }
    navigator.clipboard.readText().then(function (t) {
      if (t && t.indexOf('<') >= 0) loadMarkup(t, 'pasted SVG');
      else fail('No SVG markup on the clipboard');
    }).catch(function () { fail('Clipboard read was blocked. Press ⌘V instead.'); });
  };

  window.addEventListener('paste', function (e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (items) {
      for (var i = 0; i < items.length; i++) {
        if (/^image\/(png|jpeg|webp)$/.test(items[i].type)) {
          var im = items[i].getAsFile();
          if (im) { e.preventDefault(); loadImageFile(im); return; }
        }
        if (items[i].type === 'image/svg+xml') {
          var f = items[i].getAsFile();
          if (f) { e.preventDefault(); f.text().then(function (t) { loadMarkup(t, f.name); }); return; }
        }
      }
    }
    var text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (text && text.indexOf('<svg') >= 0) { e.preventDefault(); loadMarkup(text, 'pasted SVG'); }
  });

  var stage = $('stage');
  ['dragenter', 'dragover'].forEach(function (t) {
    stage.addEventListener(t, function (e) { e.preventDefault(); $('drop').classList.add('on'); });
  });
  ['dragleave', 'drop'].forEach(function (t) {
    stage.addEventListener(t, function (e) { e.preventDefault(); $('drop').classList.remove('on'); });
  });
  stage.addEventListener('drop', function (e) {
    var f = e.dataTransfer.files[0];
    if (!f) return;
    if (isImage(f)) loadImageFile(f);
    else f.text().then(function (t) { loadMarkup(t, f.name); });
  });

  /* ---------- export ---------- */

  function svgText() {
    var b = Warp.bounds(allPaths());
    var maxStroke = 0;
    var body = S.out.map(function (o) {
      var paint = paintFor(o.src);
      var a = 'fill="' + (paint.fill || 'none') + '"';
      if (paint.stroke && paint.stroke !== 'none' && paint.sw > 0) {
        maxStroke = Math.max(maxStroke, paint.sw);
        a += ' stroke="' + paint.stroke + '" stroke-width="' + paint.sw +
             '" stroke-linejoin="round" stroke-linecap="round"';
      }
      return '  <path d="' + o.d + '" ' + a + '/>';
    }).join('\n');
    var pad = 1 + maxStroke / 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
      (b.x - pad) + ' ' + (b.y - pad) + ' ' + (b.width + pad * 2) + ' ' +
      (b.height + pad * 2) + '" width="' + Math.round(b.width + pad * 2) +
      '" height="' + Math.round(b.height + pad * 2) + '">\n' + body + '\n</svg>\n';
  }

  $('copy').onclick = function () {
    if (!S.out.length) return;
    var btn = this;
    navigator.clipboard.writeText(svgText()).then(function () {
      btn.textContent = 'Copied';
      setTimeout(function () { btn.textContent = 'Copy SVG'; }, 1200);
    }).catch(function () { fail('Clipboard write was blocked'); });
  };

  $('download').onclick = function () {
    if (!S.out.length) return;
    var blob = new Blob([svgText()], { type: 'image/svg+xml' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.name || 'warp').replace(/\.svg$/i, '') + '-' + S.preset + '.svg';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  };

  /* ---------- boot ---------- */

  $('samples').innerHTML = (window.SAMPLES || []).map(function (s, i) {
    return '<button data-i="' + i + '">' + s.name + '</button>';
  }).join('');
  Array.prototype.forEach.call($('samples').children, function (b) {
    b.onclick = function () {
      var s = SAMPLES[+b.dataset.i];
      $('srcColours').checked = false;
      S.image = null;
      $('imgRow').style.display = 'none';
      $('imgRow2').style.display = 'none';
      load([{ d: s.d, fill: '#ffffff', stroke: 'none', strokeWidth: 0 }], s.name);
    };
  });

  window.addEventListener('resize', draw);

  /* Exposed for the console and for scripted checks. */
  window.__warp = {
    state: S,
    render: render,
    setCorner: function (i, x, y, bypass) {
      var res = Snap.apply(x, y, snapOpts(i, bypass));
      S.quad[i] = { x: res.x, y: res.y };
      S.guides = res.guides;
      S.selected = i;
      render();
      return res;
    },
    nudge: function (i, dx, dy, shift) {
      var step = shift ? BIG : NUDGE;
      S.selected = i;
      var res = Snap.apply(S.quad[i].x + dx * step, S.quad[i].y + dy * step, {
        corners: S.quad, moving: i, bbox: S.bbox, tol: SNAP_PX / S.view.k,
        grid: 0, pixel: false, align: $('snapAlign').checked
      });
      S.quad[i] = { x: res.x, y: res.y };
      S.guides = res.guides;
      render();
      return res;
    }
  };

  buildPresets();
  if (window.SAMPLES && SAMPLES.length) {
    $('srcColours').checked = false;
    load([{ d: SAMPLES[0].d, fill: '#ffffff', stroke: 'none', strokeWidth: 0 }], SAMPLES[0].name);
  }

  // ?scenario=... drives the tool for screenshots and checks.
  var q = new URLSearchParams(location.search);
  if (q.get('preset')) {
    var tile = $('presets').querySelector('.preset[data-id="' + q.get('preset') + '"]');
    if (tile) tile.click();
  }
  if (q.get('load')) {
    fetch(q.get('load')).then(function (r) { return r.text(); })
      .then(function (t) { loadMarkup(t, q.get('load')); })
      .catch(function () { fail('Could not fetch ' + q.get('load')); });
  }
  if (q.get('sample')) {
    var si = q.get('sample') | 0;
    if (SAMPLES[si]) {
      $('srcColours').checked = false;
      load([{ d: SAMPLES[si].d, fill: '#ffffff', stroke: 'none', strokeWidth: 0 }],
           SAMPLES[si].name);
    }
  }
  if (q.get('grunge')) {
    $('gOn').checked = true;
    $('gControls').style.display = '';
    q.get('grunge').split(',').forEach(function (kv) {
      var a = kv.split(':');
      if (a.length === 2 && $(a[0])) $(a[0]).value = a[1];
    });
    syncGrungeLabels();
    render();
  }
  if (q.get('image')) {
    fetch(q.get('image')).then(function (r) { return r.blob(); }).then(function (b) {
      loadImageFile(new File([b], q.get('image'), { type: b.type || 'image/png' }));
    }).catch(function () { fail('could not fetch ' + q.get('image')); });
  }
  if (q.get('corner')) {
    var parts = q.get('corner').split(',').map(Number);
    setTimeout(function () { window.__warp.setCorner(parts[0], parts[1], parts[2]); }, 80);
  }
})();
