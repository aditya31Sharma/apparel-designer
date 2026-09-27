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
    guides: [], out: [], seed: 1, grungeStats: null
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

  function grungeOpts() {
    return {
      grain: +$('gGrain').value / 10,
      roughness: +$('gRough').value / 10,
      bias: +$('gBias').value / 10,
      blotchAmount: +$('gBlotch').value / 100,
      spatter: +$('gSpatter').value / 100,
      pit: +$('gPit').value / 100,
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

  var ICON = 'M0 0 H96 V17 H0 Z M0 25 H70 V42 H0 Z M0 50 H96 V67 H0 Z';

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
      var d = Warp.warp([ICON], { x: 0, y: 0, width: 96, height: 67 }, opts).join(' ');
      var b = Warp.bounds([d]), pad = Math.max(b.width, b.height) * .05;
      return '<div class="preset' + (p.id === S.preset ? ' on' : '') + '" data-id="' +
        p.id + '" data-tip="' + p.label + '|' + (PRESET_TIP[p.id] || '') +
        '"><svg viewBox="' + (b.x - pad) + ' ' + (b.y - pad) + ' ' +
        (b.width + pad * 2) + ' ' + (b.height + pad * 2) + '"><path d="' + d +
        '" fill="currentColor"/></svg></div>';
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
  var G_IDS = ['gGrain', 'gRough', 'gBias', 'gBlotch', 'gSpatter', 'gPit', 'gRes', 'gSimp'];
  var G_FMT = {
    gGrain: function (v) { return (v / 10).toFixed(1); },
    gRough: function (v) { return (v / 10).toFixed(1); },
    gBias: function (v) { return (v / 10).toFixed(1); },
    gRes: function (v) { return (v / 10).toFixed(1); },
    gSimp: function (v) { return (v / 100).toFixed(2); }
  };
  var G_DEFAULT = { gGrain: 16, gRough: 70, gBias: 0, gBlotch: 85, gSpatter: 45,
                    gPit: 14, gRes: 20, gSimp: 45 };

  function syncGrungeLabels() {
    G_IDS.forEach(function (id) {
      var v = +$(id).value;
      setVal(id + 'Val', G_FMT[id] ? G_FMT[id](v) : String(v));
    });
  }

  G_IDS.forEach(function (id) {
    $(id).oninput = function () { syncGrungeLabels(); render(); };
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
    Object.keys(G_DEFAULT).forEach(function (k) { $(k).value = G_DEFAULT[k]; });
    syncGrungeLabels(); render();
  };
  syncGrungeLabels();

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
  $('file').onchange = function () {
    var f = this.files[0];
    if (!f) return;
    if (isImage(f)) loadImageFile(f);
    else f.text().then(function (t) { loadMarkup(t, f.name); });
    this.value = '';
  };
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
