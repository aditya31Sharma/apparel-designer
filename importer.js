/* Turn any pasted or dropped SVG into flat absolute paths in one pixel space.
 *
 * Primitives become paths, every transform and the root viewBox are baked in, so
 * what comes out is directly comparable to on-screen pixels.
 */
(function (root) {
  'use strict';

  var SHAPES = 'path,rect,circle,ellipse,line,polyline,polygon';

  function num(el, name, dflt) {
    var v = parseFloat(el.getAttribute(name));
    return isFinite(v) ? v : (dflt || 0);
  }

  function toPathData(el) {
    var t = el.tagName.toLowerCase();
    if (t === 'path') return el.getAttribute('d') || '';
    if (t === 'rect') {
      var x = num(el, 'x'), y = num(el, 'y'),
          w = num(el, 'width'), h = num(el, 'height'),
          rx = num(el, 'rx'), ry = num(el, 'ry') || num(el, 'rx');
      if (!w || !h) return '';
      if (!rx && !ry) return 'M' + x + ' ' + y + 'H' + (x + w) + 'V' + (y + h) + 'H' + x + 'Z';
      rx = Math.min(rx || ry, w / 2); ry = Math.min(ry || rx, h / 2);
      return 'M' + (x + rx) + ' ' + y +
        'H' + (x + w - rx) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + (x + w) + ' ' + (y + ry) +
        'V' + (y + h - ry) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + (x + w - rx) + ' ' + (y + h) +
        'H' + (x + rx) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + x + ' ' + (y + h - ry) +
        'V' + (y + ry) + 'A' + rx + ' ' + ry + ' 0 0 1 ' + (x + rx) + ' ' + y + 'Z';
    }
    if (t === 'circle' || t === 'ellipse') {
      var cx = num(el, 'cx'), cy = num(el, 'cy');
      var ax = t === 'circle' ? num(el, 'r') : num(el, 'rx');
      var ay = t === 'circle' ? num(el, 'r') : num(el, 'ry');
      if (!ax || !ay) return '';
      return 'M' + (cx - ax) + ' ' + cy +
        'A' + ax + ' ' + ay + ' 0 0 1 ' + (cx + ax) + ' ' + cy +
        'A' + ax + ' ' + ay + ' 0 0 1 ' + (cx - ax) + ' ' + cy + 'Z';
    }
    if (t === 'line') {
      return 'M' + num(el, 'x1') + ' ' + num(el, 'y1') +
             'L' + num(el, 'x2') + ' ' + num(el, 'y2');
    }
    if (t === 'polyline' || t === 'polygon') {
      var pts = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return '';
      var d = 'M' + pts[0] + ' ' + pts[1];
      for (var i = 2; i + 1 < pts.length; i += 2) d += 'L' + pts[i] + ' ' + pts[i + 1];
      return d + (t === 'polygon' ? 'Z' : '');
    }
    return '';
  }

  function applyMatrix(d, m, tol) {
    if (!m) return d;
    var subs = root.WarpPath.parsePath(d, tol || 0.2), out = '';
    subs.forEach(function (s) {
      s.points.forEach(function (p, i) {
        var x = m.a * p.x + m.c * p.y + m.e;
        var y = m.b * p.x + m.d * p.y + m.f;
        out += (i ? 'L' : 'M') + (Math.round(x * 100) / 100) + ' ' + (Math.round(y * 100) / 100);
      });
      if (s.closed) out += 'Z';
    });
    return out;
  }

  function hidden() {
    var host = document.getElementById('__svgimport');
    if (!host) {
      host = document.createElement('div');
      host.id = '__svgimport';
      host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;' +
        'left:-9999px;top:-9999px;opacity:0;pointer-events:none';
      document.body.appendChild(host);
    }
    return host;
  }

  /* Returns { paths, fill, width, height } or throws. */
  function parse(markup) {
    var doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw new Error('That is not valid SVG');
    var svg = doc.querySelector('svg');
    if (!svg) throw new Error('No <svg> element found');

    var host = hidden();
    host.innerHTML = '';
    var live = document.importNode(svg, true);
    host.appendChild(live);

    try {
      var els = live.querySelectorAll(SHAPES);
      if (!els.length) throw new Error('No drawable shapes in that SVG');
      var rootCTM = live.getScreenCTM();
      var items = [];

      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        var cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
        var d = toPathData(el);
        if (!d) continue;
        var m = null;
        try {
          var own = el.getScreenCTM();
          if (own && rootCTM) m = rootCTM.inverse().multiply(own);
        } catch (e) { m = null; }
        var flat = applyMatrix(d, m);
        if (!flat) continue;

        // Keep each element's own paint. A stroked icon drawn as filled blobs is
        // not the same artwork.
        var fill = el.getAttribute('fill') || cs.fill || '#000';
        var stroke = el.getAttribute('stroke') || cs.stroke || 'none';
        var sw = parseFloat(el.getAttribute('stroke-width') || cs.strokeWidth) || 0;
        var tag = el.tagName.toLowerCase();
        if (tag === 'line' || tag === 'polyline') {
          if (!el.hasAttribute('fill')) fill = 'none';
          if (stroke === 'none') { stroke = '#000'; sw = sw || 1; }
        }
        if (fill === 'none' && stroke === 'none') continue;
        if (stroke !== 'none' && !sw) sw = 1;
        // Scale the stroke by the transform so it matches what the source drew.
        if (m) sw *= Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1;

        items.push({ d: flat, fill: fill, stroke: stroke, strokeWidth: sw });
      }
      if (!items.length) throw new Error('Nothing drawable in that SVG');
      return { items: items, paths: items.map(function (it) { return it.d; }) };
    } finally {
      host.innerHTML = '';
    }
  }

  root.SvgIn = { parse: parse, toPathData: toPathData };
})(window);
