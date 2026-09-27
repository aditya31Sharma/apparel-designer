/* UI chrome: icons, tooltips, switches, tool panels.
 * Kept apart from app.js so the tool logic stays about geometry. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- icons ---------- */
  document.querySelectorAll('[data-icon]').forEach(function (el) {
    var svg = window.ICON[el.dataset.icon];
    if (!svg) return;
    // Buttons with a text label get the icon before the label.
    el.insertAdjacentHTML('afterbegin', svg);
  });

  /* ---------- tooltips ---------- */
  var tip = $('tip'), timer = null, active = null;

  function show(el) {
    var parts = (el.dataset.tip || '').split('|');
    if (!parts[0]) return;
    tip.innerHTML = '<b>' + parts[0] + '</b>' +
      (parts[1] ? '<span>' + parts[1] + '</span>' : '');
    tip.classList.add('on');
    var r = el.getBoundingClientRect();
    var tr = tip.getBoundingClientRect();
    var x = r.left + r.width / 2 - tr.width / 2;
    var y = r.bottom + 7;
    if (y + tr.height > innerHeight - 6) y = r.top - tr.height - 7;
    tip.style.left = Math.max(6, Math.min(innerWidth - tr.width - 6, x)) + 'px';
    tip.style.top = Math.max(6, y) + 'px';
    active = el;
  }
  function hide() {
    clearTimeout(timer);
    tip.classList.remove('on');
    active = null;
  }
  document.addEventListener('pointerover', function (e) {
    var el = e.target.closest('[data-tip]');
    if (!el || el === active) return;
    clearTimeout(timer);
    timer = setTimeout(function () { show(el); }, 380);
  });
  document.addEventListener('pointerout', function (e) {
    if (e.target.closest('[data-tip]')) hide();
  });
  document.addEventListener('pointerdown', hide);

  /* ---------- switches bound to real checkboxes ---------- */
  document.querySelectorAll('.sw[data-cb]').forEach(function (sw) {
    var cb = $(sw.dataset.cb);
    if (!cb) return;
    sw.classList.toggle('on', cb.checked);
    sw.addEventListener('click', function () {
      cb.checked = !cb.checked;
      sw.classList.toggle('on', cb.checked);
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    cb.addEventListener('change', function () { sw.classList.toggle('on', cb.checked); });
  });

  /* ---------- toolbar toggles that stand in for hidden inputs ---------- */
  function bindToggle(btnId, inputId) {
    var btn = $(btnId), cb = $(inputId);
    btn.addEventListener('click', function () {
      cb.checked = !cb.checked;
      btn.classList.toggle('on', cb.checked);
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    btn.classList.toggle('on', cb.checked);
  }
  bindToggle('showGridBtn', 'showGrid');

  var BGS = ['dark', 'light', 'checker'];
  $('bgBtn').addEventListener('click', function () {
    var sel = $('bg');
    sel.value = BGS[(BGS.indexOf(sel.value) + 1) % BGS.length];
    $('bgBtn').classList.toggle('on', sel.value !== 'dark');
    $('bgBtn').dataset.tip = 'Canvas|' + sel.value[0].toUpperCase() + sel.value.slice(1);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* ---------- the two tools ---------- */
  var TOOLS = [
    { btn: 'toolWarp', panel: 'panelWarp' },
    { btn: 'toolDither', panel: 'panelDither' }
  ];
  TOOLS.forEach(function (t) {
    $(t.btn).addEventListener('click', function () {
      TOOLS.forEach(function (o) {
        var on = o === t;
        $(o.btn).classList.toggle('on', on);
        $(o.panel).style.display = on ? '' : 'none';
      });
      // Reaching for Dither implies wanting to see it.
      if (t.btn === 'toolDither' && !$('gOn').checked) {
        $('gOn').checked = true;
        $('gOn').dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  });
})();
