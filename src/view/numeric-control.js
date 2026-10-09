/* A slider and an exact value share one model and one undoable gesture. */
(function (root) {
  'use strict';
  function format(v, places) { return String(Number(v.toFixed(places === undefined ? 6 : places))); }
  function read(text, scale, unit) {
    var match = String(text).trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*([^\d\s]*)$/i);
    if (!match || (match[2] && match[2] !== (unit || ''))) return NaN;
    var v = Number(match[1]) / (scale || 1);
    return Number.isFinite(v) ? v : NaN;
  }
  function option(v) { return typeof v === 'function' ? v() : v; }
  function clamp(v, min, max) {
    if (Number.isFinite(min)) v = Math.max(min, v);
    if (Number.isFinite(max)) v = Math.min(max, v);
    return v;
  }
  function bind(slider, number, o) {
    var editing = false, initial;
    var fmt = o.format || format;
    slider.classList.add('numeric-range'); number.classList.add('numeric-value');
    number.type = 'text'; number.inputMode = 'decimal'; number.spellcheck = false;
    slider.setAttribute('aria-label', o.label); number.setAttribute('aria-label', o.label + ' value');
    slider.step = o.step || 1;
    function show(force) {
      var v = o.get(), valid = Number.isFinite(v);
      slider.disabled = number.disabled = !valid;
      if (!editing) {
        var min = option(o.rangeMin), max = option(o.rangeMax);
        if (!Number.isFinite(min)) min = option(o.min);
        if (!Number.isFinite(max)) max = option(o.max);
        if (!Number.isFinite(min)) min = 0;
        if (!Number.isFinite(max)) max = 100;
        slider.min = valid ? Math.min(min, v) : min;
        slider.max = valid ? Math.max(max, v) : max;
      }
      if (valid) slider.value = v;
      if (force || document.activeElement !== number) number.value = valid ? fmt(v) : '';
      if (valid) slider.setAttribute('aria-valuetext', fmt(v));
    }
    function begin() {
      if (editing) return;
      initial = o.get(); editing = true;
      if (o.begin) o.begin();
    }
    function finish() {
      if (!editing) return;
      editing = false; if (o.commit) o.commit(); show(true);
    }
    slider.addEventListener('input', function (e) {
      e.stopPropagation(); begin();
      o.set(clamp(Number(slider.value), option(o.min), option(o.max)), true); show(true);
    });
    slider.addEventListener('change', function (e) { e.stopPropagation(); finish(); });
    slider.addEventListener('pointercancel', function () {
      if (editing) { o.set(initial, true); finish(); }
    });
    slider.addEventListener('keydown', function (e) { e.stopPropagation(); });
    slider.addEventListener('keyup', function (e) { e.stopPropagation(); finish(); });
    slider.addEventListener('blur', finish);
    function typed() {
      var v = o.parse ? o.parse(number.value) : read(number.value, o.scale, o.unit);
      if (!Number.isFinite(v)) { show(true); return; }
      v = clamp(v, option(o.min), option(o.max));
      if (o.integer) v = Math.round(v);
      var current = o.get(), tolerance = Number.EPSILON * Math.max(1, Math.abs(v), Math.abs(current)) * 8;
      if (Math.abs(v - current) <= tolerance) { show(true); return; }
      begin(); o.set(v, false); finish();
    }
    number.addEventListener('change', function (e) { e.stopPropagation(); typed(); });
    number.addEventListener('focus', function () { number.select(); });
    number.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); typed(); number.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); show(true); number.blur(); }
    });
    show();
    return { show: show };
  }
  root.NumericControl = { bind: bind, read: read, format: format, clamp: clamp };
})(typeof module !== 'undefined' ? module.exports : window);
