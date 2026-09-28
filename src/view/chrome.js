/* Chrome: icons, tooltips, and the switches that stand in for checkboxes.
 * Deliberately not about geometry, tools or state.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  function injectIcons(scope) {
    (scope || document).querySelectorAll('[data-icon]').forEach(function (el) {
      if (el.dataset.iconDone) return;
      var svg = window.ICON[el.dataset.icon];
      if (!svg) return;
      el.insertAdjacentHTML('afterbegin', svg);
      el.dataset.iconDone = '1';
    });
  }
  injectIcons();
  $('brandMark').innerHTML = window.ICON.brand;
  var big = document.querySelector('#empty .big');
  if (big) big.innerHTML = window.ICON.open;

  /* Panels are built after this file runs, so watch for what they add. */
  new MutationObserver(function () { injectIcons(); })
    .observe(document.body, { childList: true, subtree: true });

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
  function hide() { clearTimeout(timer); tip.classList.remove('on'); active = null; }

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
  window.addEventListener('blur', hide);

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
  });

  if (window.desktop) document.body.classList.add('desktop');
})();
