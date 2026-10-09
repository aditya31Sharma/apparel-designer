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
      var fmt = row.fmt || function (v) { return root.NumericControl.format(v); };
      var unit = (fmt(1).match(/[a-z%°]+$/i) || [''])[0];
      if (unit) fmt = function (v) { return root.NumericControl.format(v * (unit === '%' ? 100 : 1)) + unit; };
      var control = root.NumericControl.bind(slider, num, {
        label: row.label, min: row.min, max: row.max, rangeMin: row.rangeMin, rangeMax: row.rangeMax,
        step: step, integer: row.id === 'seed' || row.id === 'imageLevels', format: fmt,
        unit: unit, scale: unit === '%' ? 100 : 1,
        get: function () { return api.get(row.id); }, begin: api.begin,
        set: function (v) { api.set(row.id, v, true); }, commit: function () { api.commit(row.id); }
      });
      return { node: node, show: function () { control.show(); } };
    },

    number: function (row, api) {
      return KINDS.range(Object.assign({ step: row.scrub || 1 }, row), api);
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
            '><span class="thumb' + (t.paper ? ' paper' : '') + '">' + t.thumb + '</span>' +
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
      var btn = node.querySelector('button'), lbl = node.querySelector('.lbl');
      btn.addEventListener('click', function () { row.action(api); });
      /* A row bound to a value can change its wording with it: the same
       * button removes a background and, once there is a cut, puts it back.
       * The value 'busy' disables it while the work is out. */
      function show(v) {
        if (row.altLabel !== undefined) lbl.textContent = v === true ? row.altLabel : row.label;
        btn.disabled = v === 'busy';
      }
      return { node: node, show: show };
    },

    /* A job in flight: what it is doing, how far along, and how long is left.
     * Shows nothing until there is something to say. */
    progress: function (row) {
      var node = el(
        '<div class="prog"' + tipAttr(row) + '>' +
        '<div class="prog-row">' + icon(row.icon) +
        '<span class="ptext grow"></span><span class="eta"></span></div>' +
        '<div class="bar"><i></i></div></div>');
      var text = node.querySelector('.ptext'), eta = node.querySelector('.eta');
      var bar = node.querySelector('.bar'), fill = node.querySelector('.bar i');
      node.hidden = true;
      function show(st) {
        var on = !!(st && st.text);
        node.hidden = !on;
        if (!on) return;
        text.textContent = st.text;
        eta.textContent = st.eta || '';
        node.classList.toggle('busy', !!st.busy);
        node.classList.toggle('failed', !!st.failed);
        bar.hidden = !st.busy;
        fill.style.width = Math.round(Math.max(0, Math.min(1, st.pct || 0)) * 100) + '%';
      }
      return { node: node, show: show };
    },

    note: function (row) {
      return { node: el('<div class="note">' + row.text + '</div>'), show: function () {} };
    },

    /* Two numbers side by side: X and Y, W and H. */
    pair: function (row, api) {
      var node = el('<div class="numeric-pair"' + tipAttr(row) + '></div>');
      var children = [row.a, row.b].map(function (field) {
        var size = /width|height/.test(field.id);
        var child = KINDS.range(Object.assign({ step: 0.1, min: size ? 0.01 : undefined,
          rangeMin: size ? 1 : -2000, rangeMax: size ? 4000 : 2000 }, field), api);
        node.appendChild(child.node); return child;
      });
      var lockBtn;
      if (row.lock) {
        lockBtn = el('<button class="tbtn lockbtn" aria-label="Lock ratio" data-tip="Lock ratio|Keep width and height in proportion">' + (ICON.lock || '') + '</button>');
        children[0].node.querySelector('.gi').replaceWith(lockBtn);
        lockBtn.addEventListener('click', function () { api.set(row.lock, !api.get(row.lock)); api.commit(row.lock); show(); });
      }
      function show() {
        children.forEach(function (child) { child.show(); });
        if (lockBtn) lockBtn.classList.toggle('on', !!api.get(row.lock));
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
      /* Folded away until asked for. The controls that matter less often
       * are kept rather than cut, behind a heading that opens on a click and
       * remembers whether it was left open. */
      if (section.collapsed && section.title) {
        var h2 = sec.querySelector('h2');
        var key = 'ad.fold.' + (section.id || section.title);
        var open = false;
        try { open = localStorage.getItem(key) === 'open'; } catch (e) { /* no storage */ }
        sec.classList.add('fold');
        sec.classList.toggle('closed', !open);
        h2.insertAdjacentHTML('beforeend', '<span class="grow"></span><span class="chev"></span>');
        h2.addEventListener('click', function () {
          var closed = sec.classList.toggle('closed');
          try { localStorage.setItem(key, closed ? 'closed' : 'open'); } catch (e) { /* no storage */ }
        });
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
