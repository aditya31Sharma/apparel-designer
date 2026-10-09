/* Opaque dot masks. The image or vector beneath keeps its own colour and alpha. */
(function (root) {
  'use strict';
  function round(v) { return Math.round(v * 1000) / 1000; }
  function length(f) { return Math.hypot(f.end.x - f.start.x, f.end.y - f.start.y); }
  function rectangle(b) {
    return [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height }, { x: b.x, y: b.y + b.height }];
  }
  function frame(f) {
    var len = length(f), dx = (f.end.x - f.start.x) / len, dy = (f.end.y - f.start.y) / len;
    var span = Number.isFinite(f.curveSpan) && Math.abs(f.curveSpan) >= 1 ? f.curveSpan : len;
    var bend = f.mode === 'curved' && Number.isFinite(f.bend) ? f.bend : 0;
    return { start: f.start, len: len, dx: dx, dy: dy, span: span, k: bend * len / (span * span) };
  }
  function local(p, q) {
    var x = p.x - q.start.x, y = p.y - q.start.y;
    return { u: x * q.dx + y * q.dy, v: -x * q.dy + y * q.dx };
  }
  function point(q, u, v) { return { x: q.start.x + u * q.dx - v * q.dy, y: q.start.y + u * q.dy + v * q.dx }; }
  function value(p, q) { var v = local(p, q); return (v.u - q.k * v.v * v.v) / q.len; }
  function projection(p, f) { return value(p, frame(f)); }
  // Exact quadratic contour at a given coverage, extended across the artwork.
  function contour(b, f, limit) {
    var q = frame(f), corners = rectangle(b).map(function (p) { return local(p, q); });
    var vs = corners.map(function (p) { return p.v; }), v0 = Math.min.apply(null, vs) - 1, v1 = Math.max.apply(null, vs) + 1;
    var u = limit * q.len, a = u + q.k * v0 * v0, z = u + q.k * v1 * v1;
    var back = Math.min.apply(null, corners.map(function (p) { return p.u; }).concat([u, a, z])) - 1;
    return { start: point(q, a, v0), control: point(q, u + q.k * v0 * v1, (v0 + v1) / 2),
      end: point(q, z, v1), backStart: point(q, back, v0), backEnd: point(q, back, v1) };
  }
  function pair(p) { return round(p.x) + ' ' + round(p.y); }
  function region(b, f, limit) {
    if (!frame(f).k) return polygon(halfPlane(b, f, limit));
    var c = contour(b, f, limit);
    return 'M' + pair(c.backStart) + 'L' + pair(c.start) + 'Q' + pair(c.control) + ' ' + pair(c.end) + 'L' + pair(c.backEnd) + 'Z';
  }
  function bendPoint(f) { var q = frame(f); return point(q, q.len / 2 + q.k * q.span * q.span, q.span); }
  function bendAt(p, f) { var q = frame(f); return Math.max(-4, Math.min(4, local(p, q).u / q.len - 0.5)); }
  function curveSpan(b, f) {
    var q = frame(f), vs = rectangle(b).map(function (p) { return local(p, q).v; });
    return Math.max(q.len, (Math.max.apply(null, vs) - Math.min.apply(null, vs)) / 3);
  }
  function halfPlane(b, f, limit) {
    var points = rectangle(b), out = [];
    points.forEach(function (a, i) {
      var z = points[(i + 1) % points.length];
      var av = projection(a, f) - limit, zv = projection(z, f) - limit;
      if (av <= 0) out.push(a);
      if ((av <= 0) !== (zv <= 0)) {
        var t = av / (av - zv);
        out.push({ x: a.x + (z.x - a.x) * t, y: a.y + (z.y - a.y) * t });
      }
    });
    return out;
  }
  function polygon(points) {
    return points.length ? points.map(function (p, i) {
      return (i ? 'L' : 'M') + round(p.x) + ' ' + round(p.y);
    }).join('') + 'Z' : '';
  }

  // Invert the area of a circle clipped by its square grid cell. This reaches
  // full coverage smoothly instead of leaving gaps where the fade meets solid ink.
  var radii = new Float64Array(257);
  for (var n = 0; n <= 256; n++) {
    var lo = 0, hi = Math.SQRT1_2;
    for (var j = 0; j < 24; j++) {
      var r = (lo + hi) / 2;
      var area = Math.PI * r * r;
      if (r > 0.5) area -= 4 * (r * r * Math.acos(0.5 / r) - 0.5 * Math.sqrt(r * r - 0.25));
      if (area < n / 256) lo = r; else hi = r;
    }
    radii[n] = n ? (lo + hi) / 2 : 0;
  }
  function radius(coverage) {
    var t = Math.max(0, Math.min(1, coverage)) * 256, i = Math.floor(t);
    return i === 256 ? radii[256] : radii[i] + (radii[i + 1] - radii[i]) * (t - i);
  }
  function build(b, params) {
    var pitch = Math.max(2, params.pitch || 8);
    var a = (params.angle || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    var corners = rectangle(b).map(function (p) { return { x: c * p.x + s * p.y, y: -s * p.x + c * p.y }; });
    var u0 = Math.floor(Math.min.apply(null, corners.map(function (p) { return p.x; })) / pitch) - 1;
    var u1 = Math.ceil(Math.max.apply(null, corners.map(function (p) { return p.x; })) / pitch) + 1;
    var v0 = Math.floor(Math.min.apply(null, corners.map(function (p) { return p.y; })) / pitch) - 1;
    var v1 = Math.ceil(Math.max.apply(null, corners.map(function (p) { return p.y; })) / pitch) + 1;
    var clips = [], count = 0, fades = 0;
    (params.fades || []).forEach(function (f) {
      var len = length(f);
      if (f.on === false || !Number.isFinite(len) || len < 0.5) return;
      var q = frame(f), d = region(b, f, 0), reach = pitch * Math.SQRT1_2;
      for (var v = v0; v <= v1; v++) {
        for (var u = u0; u <= u1; u++) {
          var gu = (u + 0.5) * pitch, gv = (v + 0.5) * pitch;
          var p = { x: c * gu - s * gv, y: s * gu + c * gv };
          var t = value(p, q);
          // Include circles that can cross the solid boundary, even at a steep bend.
          var margin = (reach + Math.abs(q.k) * (2 * Math.abs(local(p, q).v) * reach + reach * reach)) / len;
          if (t < -margin || t >= 1) continue;
          var rr = radius(1 - t) * pitch;
          d += 'M' + round(p.x - rr) + ' ' + round(p.y) +
            'a' + round(rr) + ' ' + round(rr) + ' 0 1 1 ' + round(2 * rr) + ' 0' +
            'a' + round(rr) + ' ' + round(rr) + ' 0 1 1 ' + round(-2 * rr) + ' 0Z';
          count++;
        }
      }
      clips.push({ d: d, fadeId: f.id }, { d: region(b, f, 1), fadeId: f.id });
      fades++;
    });
    return { clips: clips, dots: count, fades: fades };
  }
  function edge(b, side, span) {
    var vertical = side === 'top' || side === 'bottom';
    var size = vertical ? b.height : b.width, distance = Math.min(span || 50, size);
    var x = b.x + b.width / 2, y = b.y + b.height / 2;
    if (side === 'top') return { start: { x: x, y: b.y + distance }, end: { x: x, y: b.y } };
    if (side === 'left') return { start: { x: b.x + distance, y: y }, end: { x: b.x, y: y } };
    if (side === 'right') return { start: { x: b.x + b.width - distance, y: y }, end: { x: b.x + b.width, y: y } };
    return { start: { x: x, y: b.y + b.height - distance }, end: { x: x, y: b.y + b.height } };
  }
  root.SelectiveHalftone = { build: build, edge: edge, length: length, radius: radius, projection: projection,
    contour: contour, bendPoint: bendPoint, bendAt: bendAt, curveSpan: curveSpan };
})(typeof module !== 'undefined' ? module.exports : self);
