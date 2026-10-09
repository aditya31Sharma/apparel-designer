(function (root) {
  'use strict';
  var Doc = root.Doc, Engine = root.SelectiveHalftone;
  var NS = 'http://www.w3.org/2000/svg';
  function node(tag, attrs, text) {
    var el = document.createElementNS(NS, tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    if (text) el.textContent = text;
    return el;
  }
  function create(o) {
    var selectedId = null, active = false, dragging = false, numbers = {};
    var group = node('g', { class: 'selective-handles' });
    o.svg.appendChild(group);
    o.panel.innerHTML = '<div class="sec"><h2>Selective half-tone<span class="grow"></span>' +
      '<button class="sw" data-action="toggle" aria-label="Enable selective half-tone"></button></h2>' +
      '<div class="note">Drag from full print (100%) to transparent (0%). Drag the line to move the fade.</div>' +
      '<div class="selective-add"><select aria-label="Fade edge" data-field="edge">' +
      '<option value="bottom">Bottom edge</option><option value="top">Top edge</option>' +
      '<option value="left">Left edge</option><option value="right">Right edge</option></select>' +
      '<button data-action="add">Add fade</button></div><div class="selective-list"></div></div>' +
      '<div class="sec selective-options"><h2>Selected fade</h2>' +
      '<label class="pr"><span class="lbl grow">Shape</span><select data-field="mode" aria-label="Fade shape"><option value="linear">Linear</option><option value="curved">Curved</option></select></label>' +
      '<div class="pr selective-number"><span class="lbl">Length</span><input type="range" data-range="length"><input class="num" type="text" inputmode="decimal" data-field="length"></div>' +
      '<div class="pr selective-number selective-bend"><span class="lbl">Bend</span><input type="range" data-range="bend"><input class="num" type="text" inputmode="decimal" data-field="bend"></div>' +
      '<div class="note selective-bend">Drag the diamond to bend the fade. The curved guide marks 50% print.</div>' +
      '<div class="selective-actions"><button data-action="reverse">Reverse</button><button data-action="duplicate">Duplicate</button></div></div>' +
      '<div class="sec"><h2>Dots</h2>' +
      '<div class="pr selective-number"><span class="lbl">Spacing</span><input type="range" data-range="pitch"><input class="num" type="text" inputmode="decimal" data-field="pitch"></div>' +
      '<div class="pr selective-number"><span class="lbl">Angle</span><input type="range" data-range="angle"><input class="num" type="text" inputmode="decimal" data-field="angle"></div></div>';
    function entry() { var layer = o.layer(); return layer && Doc.effect(layer, 'selective'); }
    function chosen() {
      var fx = entry();
      if (!fx) return null;
      var f = fx.params.fades.find(function (v) { return v.id === selectedId; }) || fx.params.fades[0];
      selectedId = f ? f.id : null;
      return f;
    }
    function change(fn) {
      if (!entry()) return;
      o.begin(); fn(); o.change(false); sync(); draw(active);
    }
    function add(side) {
      var fx = entry(), b = o.layer().source.bbox;
      var fade = Object.assign({ id: 'fade-' + Date.now() + '-' + fx.params.fades.length, on: true }, Engine.edge(b, side, 50));
      fx.params.fades.push(fade); fx.on = true; selectedId = fade.id;
    }
    o.panel.addEventListener('click', function (e) {
      var button = e.target.closest('[data-action]');
      if (!button || !entry()) return;
      var action = button.dataset.action, fx = entry(), f = chosen();
      if (action === 'select') { selectedId = button.dataset.id; sync(); draw(active); return; }
      change(function () {
        if (action === 'add') add(o.panel.querySelector('[data-field="edge"]').value);
        if (action === 'toggle') fx.on = !fx.on;
        if (action === 'remove') fx.params.fades = fx.params.fades.filter(function (v) { return v.id !== button.dataset.id; });
        if (action === 'fadeToggle') {
          var target = fx.params.fades.find(function (v) { return v.id === button.dataset.id; }); target.on = !target.on;
        }
        if (action === 'reverse' && f) {
          var p = f.start; f.start = f.end; f.end = p;
          if (Number.isFinite(f.bend)) f.bend = -f.bend;
          if (Number.isFinite(f.curveSpan)) f.curveSpan = -f.curveSpan;
        }
        if (action === 'duplicate' && f) {
          var copy = JSON.parse(JSON.stringify(f)); copy.id = 'fade-' + Date.now();
          fx.params.fades.push(copy); selectedId = copy.id;
        }
      });
    });
    o.panel.addEventListener('change', function (e) {
      var key = e.target.dataset.field;
      if (!key || key === 'edge' || !entry()) return;
      var f = chosen();
      if (key === 'mode' && f) change(function () {
        f.mode = e.target.value === 'curved' ? 'curved' : 'linear';
        if (!Number.isFinite(f.bend)) f.bend = -0.5;
        if (!Number.isFinite(f.curveSpan)) f.curveSpan = Engine.curveSpan(o.layer().source.bbox, f);
      });
    });
    [
      { key: 'length', label: 'Length', min: 1, unit: 'px', rangeMax: function () {
        var layer = o.layer(), b = layer && layer.source.bbox; return b ? Math.hypot(b.width, b.height) : 1000;
      } },
      { key: 'bend', label: 'Bend', min: -400, max: 400, unit: '%' },
      { key: 'pitch', label: 'Spacing', min: 2, max: 100, unit: 'px' },
      { key: 'angle', label: 'Angle', min: -180, max: 180, unit: '°' }
    ].forEach(function (def) {
      var key = def.key;
      numbers[key] = root.NumericControl.bind(o.panel.querySelector('[data-range="' + key + '"]'),
        o.panel.querySelector('[data-field="' + key + '"]'), Object.assign({}, def, {
          format: function (v) { return root.NumericControl.format(v, 2) + def.unit; },
          get: function () {
            var fx = entry(), f = chosen(); if (!fx) return undefined;
            if (key === 'length') return f ? Engine.length(f) : undefined;
            if (key === 'bend') return f ? (f.bend || 0) * 100 : undefined;
            return fx.params[key];
          }, begin: o.begin,
          set: function (v, live) {
            var f = chosen();
            if (key === 'length' && f) {
              var old = Math.max(0.5, Engine.length(f));
              f.end = { x: f.start.x + (f.end.x - f.start.x) * v / old,
                y: f.start.y + (f.end.y - f.start.y) * v / old };
            } else if (key === 'bend' && f) f.bend = v / 100;
            else entry().params[key] = v;
            o.change(live); draw(active);
          }, commit: function () { o.change(false); sync(); draw(active); }
        }));
    });

    function sync() {
      var fx = entry(), f = chosen();
      o.panel.querySelectorAll('button,input,select').forEach(function (el) { el.disabled = !fx; });
      o.panel.querySelector('[data-action="toggle"]').classList.toggle('on', !!(fx && fx.on));
      o.panel.querySelector('.selective-options').hidden = !f;
      o.panel.querySelectorAll('.selective-bend').forEach(function (el) { el.hidden = !f || f.mode !== 'curved'; });
      var list = o.panel.querySelector('.selective-list'); list.textContent = '';
      if (!fx) return;
      fx.params.fades.forEach(function (fade, i) {
        var row = document.createElement('div'); row.className = 'selective-fade';
        [['fadeToggle', fade.on === false ? '○' : '●', 'Toggle fade '], ['select', 'Fade ' + (i + 1), 'Select fade '], ['remove', '×', 'Remove fade ']].forEach(function (def) {
          var button = document.createElement('button'); button.dataset.action = def[0]; button.dataset.id = fade.id;
          button.textContent = def[1]; button.setAttribute('aria-label', def[2] + (i + 1));
          if (def[0] === 'select') { button.classList.toggle('on', fade.id === selectedId); button.setAttribute('aria-pressed', String(fade.id === selectedId)); }
          if (def[0] === 'fadeToggle') button.setAttribute('aria-pressed', String(fade.on !== false));
          row.appendChild(button);
        });
        list.appendChild(row);
      });
      Object.keys(numbers).forEach(function (key) { numbers[key].show(); });
      o.panel.querySelector('[data-field="mode"]').value = f && f.mode === 'curved' ? 'curved' : 'linear';
    }
    function screen(p) {
      var q = Doc.applyMatrix(Doc.layerMatrix(o.layer()), p.x, p.y), view = o.view();
      return { x: (q.x - view.x) * view.k, y: (q.y - view.y) * view.k };
    }
    function source(e) {
      var rect = o.svg.getBoundingClientRect(), view = o.view();
      return Doc.applyMatrix(Doc.invert(Doc.layerMatrix(o.layer())),
        (e.clientX - rect.left) / view.k + view.x, (e.clientY - rect.top) / view.k + view.y);
    }
    function draw(show) {
      var focused = document.activeElement, focusPart, focusFade;
      if (group.contains(focused)) { focusPart = focused.dataset.part; focusFade = focused.closest('[data-fade]').dataset.fade; }
      active = show; group.textContent = '';
      var fx = entry(); if (!active || !fx || !fx.on) return;
      chosen();
      fx.params.fades.forEach(function (f, i) {
        if (f.on === false) return;
        var a = screen(f.start), b = screen(f.end), selected = f.id === selectedId;
        var screenLength = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
        var color = selected ? 'var(--accent)' : '#aeb5bc';
        var g = node('g', { 'data-fade': f.id, opacity: selected ? 1 : 0.6 });
        if (f.mode === 'curved') {
          var contour = Engine.contour(o.layer().source.bbox, f, 0.5);
          var ca = screen(contour.start), cc = screen(contour.control), cb = screen(contour.end);
          g.appendChild(node('path', { d: 'M' + ca.x + ' ' + ca.y + 'Q' + cc.x + ' ' + cc.y + ' ' + cb.x + ' ' + cb.y,
            fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': '5 4', 'pointer-events': 'none' }));
        }
        var attrs = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
        g.appendChild(node('line', Object.assign({}, attrs, { stroke: '#181818', 'stroke-width': 4 })));
        g.appendChild(node('line', Object.assign({}, attrs, { stroke: color, 'stroke-width': 2 })));
        [['start', a, '100%'], ['end', b, '0%']].forEach(function (item) {
          var p = item[1];
          var handle = node('g', { class: 'selective-hit', 'data-part': item[0], tabindex: 0,
            role: 'button', 'aria-label': 'Fade ' + (i + 1) + ' ' + item[2] + ' endpoint' });
          handle.appendChild(node('circle', { cx: p.x, cy: p.y, r: 12, fill: 'transparent' }));
          handle.appendChild(node('rect', { x: p.x - 5, y: p.y - 5, width: 10, height: 10,
            fill: item[0] === 'start' ? '#fff' : '#303030', stroke: color, 'stroke-width': 2, rx: 1 }));
          g.appendChild(handle);
          if (selected) {
            var sign = item[0] === 'start' ? -1 : 1;
            var labelX = p.x + sign * (b.x - a.x) / screenLength * 38;
            var labelY = p.y + sign * (b.y - a.y) / screenLength * 38;
            g.appendChild(node('rect', { x: labelX - 20, y: labelY - 9, width: 40, height: 19, rx: 3, fill: 'var(--accent)' }));
            g.appendChild(node('text', { x: labelX, y: labelY + 4, fill: '#fff', 'font-size': 11, 'text-anchor': 'middle' }, item[2]));
          }
        });
        g.appendChild(node('line', { x1: a.x + (b.x - a.x) * 0.25, y1: a.y + (b.y - a.y) * 0.25,
          x2: a.x + (b.x - a.x) * 0.75, y2: a.y + (b.y - a.y) * 0.75,
          stroke: 'transparent', 'stroke-width': 16, class: 'selective-hit', 'data-part': 'line',
          tabindex: 0, role: 'button', 'aria-label': 'Move fade ' + (i + 1) }));
        if (f.mode === 'curved') {
          var bp = screen(Engine.bendPoint(f));
          var bend = node('g', { class: 'selective-hit', 'data-part': 'bend', tabindex: 0,
            role: 'button', 'aria-label': 'Bend fade ' + (i + 1) });
          bend.appendChild(node('circle', { cx: bp.x, cy: bp.y, r: 14, fill: 'transparent' }));
          bend.appendChild(node('path', { d: 'M' + bp.x + ' ' + (bp.y - 7) + 'l7 7 -7 7 -7 -7Z',
            fill: 'var(--field)', stroke: color, 'stroke-width': 2 }));
          g.appendChild(bend);
        }
        group.appendChild(g);
      });
      if (focusPart) {
        var focus = group.querySelector('[data-fade="' + focusFade + '"] [data-part="' + focusPart + '"]');
        if (focus) focus.focus();
      }
    }
    group.addEventListener('pointerdown', function (e) {
      var hit = e.target.closest('.selective-hit'); if (!hit || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      selectedId = hit.closest('[data-fade]').dataset.fade;
      var f = chosen(), part = hit.dataset.part, start = JSON.parse(JSON.stringify(f)), p0 = source(e);
      o.begin(); dragging = true; o.svg.setPointerCapture(e.pointerId); sync();
      function move(ev) {
        var p = source(ev);
        if (part === 'line') {
          ['start', 'end'].forEach(function (key) { f[key] = { x: start[key].x + p.x - p0.x, y: start[key].y + p.y - p0.y }; });
        } else if (part === 'bend') {
          var bp = Engine.bendPoint(start);
          f.bend = Engine.bendAt({ x: bp.x + p.x - p0.x, y: bp.y + p.y - p0.y }, f);
        } else {
          var fixed = f[part === 'start' ? 'end' : 'start'];
          if (ev.shiftKey) {
            var angle = Math.round(Math.atan2(p.y - fixed.y, p.x - fixed.x) / (Math.PI / 4)) * Math.PI / 4;
            var len = Math.hypot(p.x - fixed.x, p.y - fixed.y);
            p = { x: fixed.x + Math.cos(angle) * len, y: fixed.y + Math.sin(angle) * len };
          }
          if (Math.hypot(p.x - fixed.x, p.y - fixed.y) < 0.5) return;
          f[part] = p;
        }
        o.change(true); draw(active);
        numbers.length.show(); numbers.bend.show();
      }
      function up(ev) {
        window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        if (o.svg.hasPointerCapture(e.pointerId)) o.svg.releasePointerCapture(e.pointerId);
        if (ev.type === 'pointercancel') {
          f.start = start.start; f.end = start.end;
          if (start.bend === undefined) delete f.bend; else f.bend = start.bend;
        }
        dragging = false; o.change(false); sync(); draw(active);
      }
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    });
    group.addEventListener('keydown', function (e) {
      var hit = e.target.closest('.selective-hit');
      if (!hit || !/^Arrow/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation(); selectedId = hit.closest('[data-fade]').dataset.fade;
      var f = chosen(), part = hit.dataset.part, step = e.shiftKey ? 10 : 1;
      change(function () {
        if (part === 'bend') {
          var bp = Engine.bendPoint(f);
          bp.x += e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
          bp.y += e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
          f.bend = Engine.bendAt(bp, f); return;
        }
        (part === 'line' ? ['start', 'end'] : [part]).forEach(function (key) {
          f[key].x += e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0;
          f[key].y += e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0;
        });
      });
      var focus = group.querySelector('[data-fade="' + selectedId + '"] [data-part="' + part + '"]');
      if (focus) focus.focus();
    });
    return { draw: draw, sync: function () { if (!dragging) sync(); }, selected: chosen };
  }
  root.SelectiveHalftoneView = { create: create };
})(window);
