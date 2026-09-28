/* Property panels, generated from a spec.
 *
 * One spec entry produces the icon, the name, the control and the readout, and
 * binds it to a parameter. Because the label comes from the same place as the
 * binding, a control cannot end up on screen without a name, which is exactly
 * the failure the hand-written panels kept having.
 */
(function (root) {
  'use strict';

  var ICON = root.ICON || {};

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstChild;
  }

  function icon(name) {
    return '<span class="gi">' + (ICON[name] || '') + '</span>';
  }

  function tipAttr(row) {
    if (!row.tip) return '';
    // A pair row names its two fields rather than itself, so fall back to those.
    var title = row.label || (row.a && row.b ? row.a.label + ' and ' + row.b.label : '');
    return ' data-tip="' + String(title).replace(/"/g, '') + '|' +
      row.tip.replace(/"/g, '') + '"';
  }

  /* ---------- row kinds ---------- */

  var KINDS = {
    range: function (row, api) {
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl">' + row.label + '</span>' +
        '<input type="range">' +
        '<input class="num" type="text" inputmode="decimal"></div>');
      var slider = node.querySelector('input[type=range]');
      var num = node.querySelector('.num');
      var step = row.step || 1;
      var scale = 1 / step;
      slider.min = Math.round(row.min * scale);
      slider.max = Math.round(row.max * scale);
      slider.step = 1;

      var fmt = row.fmt || function (v) {
        return step < 1 ? v.toFixed(String(step).split('.')[1].length) : String(v);
      };
      function show(v) { slider.value = Math.round(v * scale); num.value = fmt(v); }

      slider.addEventListener('input', function () {
        api.set(row.id, +this.value / scale, true);
        num.value = fmt(+this.value / scale);
      });
      slider.addEventListener('change', function () { api.commit(row.id); });
      num.addEventListener('change', function () {
        var v = parseFloat(this.value);
        if (isNaN(v)) { show(api.get(row.id)); return; }
        v = Math.max(row.min, Math.min(row.max, v));
        show(v); api.set(row.id, v); api.commit(row.id);
      });
      return { node: node, show: show };
    },

    number: function (row, api) {
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl">' + row.label + '</span>' +
        '<input class="num wide" type="text" inputmode="decimal">' +
        '<span class="grow"></span></div>');
      var num = node.querySelector('.num');
      var fmt = row.fmt || function (v) { return String(Math.round(v * 100) / 100); };
      function show(v) {
        if (document.activeElement === num) return;
        num.value = (v === undefined || v === null || v !== v) ? '' : fmt(v);
      }
      num.addEventListener('change', function () {
        var v = parseFloat(this.value);
        if (isNaN(v)) { show(api.get(row.id)); return; }
        if (row.min !== undefined) v = Math.max(row.min, v);
        if (row.max !== undefined) v = Math.min(row.max, v);
        show(v); api.set(row.id, v); api.commit(row.id);
      });
      // Figma's scrub: drag the label to change the value.
      scrub(node.querySelector('.lbl'), function (dx) {
        var v = api.get(row.id) + dx * (row.scrub || 1);
        if (row.min !== undefined) v = Math.max(row.min, v);
        if (row.max !== undefined) v = Math.min(row.max, v);
        show(v); api.set(row.id, v, true);
      }, function () { api.commit(row.id); });
      return { node: node, show: show };
    },

    toggle: function (row, api) {
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl grow">' + row.label + '</span>' +
        '<span class="sw"></span></div>');
      var sw = node.querySelector('.sw');
      function show(v) { sw.classList.toggle('on', !!v); }
      sw.addEventListener('click', function () {
        var v = !api.get(row.id);
        show(v); api.set(row.id, v); api.commit(row.id);
      });
      return { node: node, show: show };
    },

    colour: function (row, api) {
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl">' + row.label + '</span>' +
        '<input type="color" class="swatch">' +
        '<input class="num hex" type="text" spellcheck="false"></div>');
      var sw = node.querySelector('.swatch'), hex = node.querySelector('.hex');
      function show(v) { sw.value = v; if (document.activeElement !== hex) hex.value = v; }
      sw.addEventListener('input', function () { hex.value = this.value; api.set(row.id, this.value, true); });
      sw.addEventListener('change', function () { api.commit(row.id); });
      hex.addEventListener('change', function () {
        var v = this.value.trim();
        if (!/^#?[0-9a-f]{6}$/i.test(v)) { show(api.get(row.id)); return; }
        if (v[0] !== '#') v = '#' + v;
        show(v); api.set(row.id, v); api.commit(row.id);
      });
      return { node: node, show: show };
    },

    select: function (row, api) {
      var opts = row.options.map(function (o) {
        return '<option value="' + o.value + '">' + o.label + '</option>';
      }).join('');
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl">' + row.label + '</span>' +
        '<select class="sel">' + opts + '</select></div>');
      var sel = node.querySelector('select');
      function show(v) { sel.value = v; }
      sel.addEventListener('change', function () { api.set(row.id, this.value); api.commit(row.id); });
      return { node: node, show: show };
    },

    /* A row of icon buttons that behave as one choice, like Figma's alignment. */
    segment: function (row, api) {
      var btns = row.options.map(function (o) {
        return '<button data-v="' + o.value + '" data-tip="' + o.label +
          (o.tip ? '|' + o.tip : '') + '">' +
          (o.icon ? (ICON[o.icon] || '') : '<span>' + o.label + '</span>') + '</button>';
      }).join('');
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl">' + row.label + '</span>' +
        '<div class="seg grow">' + btns + '</div></div>');
      function show(v) {
        node.querySelectorAll('.seg button').forEach(function (b) {
          b.classList.toggle('on', b.dataset.v === String(v));
        });
      }
      node.querySelectorAll('.seg button').forEach(function (b) {
        b.addEventListener('click', function () {
          show(b.dataset.v); api.set(row.id, b.dataset.v); api.commit(row.id);
        });
      });
      return { node: node, show: show };
    },

    /* Captioned tiles: dither styles, textures, halftone presets. */
    tiles: function (row, api) {
      // A row can drive a setting other than the one it is filed under, so the
      // same choice can appear twice: a short recommended group at the top and
      // the full list below it.
      var key = row.bind || row.id;
      var node = el('<div class="tiles" data-rowid="' + row.id + '"></div>');
      function paint(items) {
        node.innerHTML = items.map(function (t) {
          return '<div class="preset" data-v="' + t.value + '"' +
            (t.tip ? ' data-tip="' + t.label + '|' + t.tip + '"' : '') +
            '><span class="thumb">' + t.thumb + '</span>' +
            '<span class="cap">' + t.label + '</span></div>';
        }).join('');
        node.querySelectorAll('.preset').forEach(function (p) {
          p.addEventListener('click', function () {
            api.set(key, p.dataset.v); api.commit(key);
          });
        });
      }
      paint(typeof row.items === 'function' ? row.items() : row.items);
      function show(v) {
        node.querySelectorAll('.preset').forEach(function (p) {
          p.classList.toggle('on', p.dataset.v === String(v));
        });
      }
      return { node: node, show: show, repaint: paint };
    },

    button: function (row, api) {
      var node = el(
        '<div class="pr"' + tipAttr(row) + '>' + icon(row.icon) +
        '<span class="lbl grow">' + row.label + '</span>' +
        '<button class="tbtn">' + (ICON[row.buttonIcon || row.icon] || '') + '</button></div>');
      node.querySelector('button').addEventListener('click', function () { row.action(api); });
      return { node: node, show: function () {} };
    },

    note: function (row) {
      return { node: el('<div class="note">' + row.text + '</div>'), show: function () {} };
    },

    /* Two numbers side by side: X and Y, W and H. */
    pair: function (row, api) {
      var node = el(
        '<div class="pr pair"' + tipAttr(row) + '>' +
        '<span class="lbl2">' + row.a.label + '</span>' +
        '<input class="num" data-k="a" type="text" inputmode="decimal">' +
        '<span class="lbl2">' + row.b.label + '</span>' +
        '<input class="num" data-k="b" type="text" inputmode="decimal">' +
        (row.lock ? '<button class="tbtn lockbtn" data-tip="Lock ratio|Keep width and height in proportion">' +
          (ICON.lock || '') + '</button>' : '') + '</div>');
      var ia = node.querySelector('[data-k=a]'), ib = node.querySelector('[data-k=b]');
      var lockBtn = node.querySelector('.lockbtn');
      // With nothing loaded there is no value to show. Blank, not NaN.
      var fmt = row.fmt || function (v) { return String(Math.round(v * 100) / 100); };
      var safe = function (v) { return (v === undefined || v === null || v !== v) ? '' : fmt(v); };

      function show() {
        if (document.activeElement !== ia) ia.value = safe(api.get(row.a.id));
        if (document.activeElement !== ib) ib.value = safe(api.get(row.b.id));
        if (lockBtn) lockBtn.classList.toggle('on', !!api.get(row.lock));
      }
      function commitField(input, id) {
        input.addEventListener('change', function () {
          var v = parseFloat(this.value);
          if (isNaN(v)) { show(); return; }
          api.set(id, v); api.commit(id); show();
        });
      }
      commitField(ia, row.a.id); commitField(ib, row.b.id);
      scrub(node.querySelectorAll('.lbl2')[0], function (dx) {
        api.set(row.a.id, api.get(row.a.id) + dx * (row.scrub || 1), true); show();
      }, function () { api.commit(row.a.id); });
      scrub(node.querySelectorAll('.lbl2')[1], function (dx) {
        api.set(row.b.id, api.get(row.b.id) + dx * (row.scrub || 1), true); show();
      }, function () { api.commit(row.b.id); });
      if (lockBtn) {
        lockBtn.addEventListener('click', function () {
          api.set(row.lock, !api.get(row.lock)); api.commit(row.lock); show();
        });
      }
      return { node: node, show: show, pair: true };
    }
  };

  /* Drag a label left or right to change its number, the way Figma does. */
  function scrub(handle, onMove, onEnd) {
    if (!handle) return;
    handle.classList.add('scrub');
    handle.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      var last = e.clientX;
      function move(ev) {
        var dx = ev.clientX - last;
        last = ev.clientX;
        onMove(dx * (ev.shiftKey ? 10 : 1));
      }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        onEnd && onEnd();
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  /* ---------- building a panel ---------- */

  function build(container, spec, api) {
    container.innerHTML = '';
    var rows = {};

    spec.forEach(function (section) {
      var sec = document.createElement('div');
      sec.className = 'sec';
      if (section.id) sec.dataset.sec = section.id;
      if (section.title) {
        var h = document.createElement('h2');
        h.innerHTML = '<span>' + section.title + '</span>';
        if (section.toggleId) {
          h.innerHTML += '<span class="grow"></span><span class="sw" data-sectoggle></span>';
        }
        sec.appendChild(h);
        if (section.toggleId) {
          var sw = h.querySelector('[data-sectoggle]');
          rows['__sec_' + section.toggleId] = {
            node: sw,
            show: function (v) { sw.classList.toggle('on', !!v); }
          };
          sw.addEventListener('click', function () {
            var v = !api.get(section.toggleId);
            sw.classList.toggle('on', v);
            api.set(section.toggleId, v); api.commit(section.toggleId);
          });
        }
      }
      // A whole section can be conditional, so a heading with nothing under it
      // never appears.
      if (section.showIf) sec.dataset.showif = section.showIf;
      (section.rows || []).forEach(function (row) {
        var make = KINDS[row.kind];
        if (!make) return;
        var built = make(row, api);
        if (row.id) { built.bind = row.bind || row.id; rows[row.id] = built; }
        else rows['__' + Math.random()] = built;
        if (row.showIf) built.node.dataset.showif = row.showIf;
        sec.appendChild(built.node);
      });
      container.appendChild(sec);
    });

    return {
      rows: rows,
      /* Push current parameter values into every control. */
      sync: function () {
        Object.keys(rows).forEach(function (id) {
          var r = rows[id];
          if (id.indexOf('__sec_') === 0) { r.show(api.get(id.slice(6))); return; }
          if (id.indexOf('__') === 0) return;
          // A pair row owns two values and reads them itself, so it has nothing
          // to be handed and must still be told to refresh.
          if (r.pair) { r.show(); return; }
          var v = api.get(r.bind || id);
          if (v !== undefined) r.show(v);
        });
        container.querySelectorAll('[data-showif]').forEach(function (n) {
          n.style.display = api.visible(n.dataset.showif) ? '' : 'none';
        });
      }
    };
  }

  root.Controls = { build: build, KINDS: KINDS, scrub: scrub };
})(window);
