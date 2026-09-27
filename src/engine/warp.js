/* Warp engine: SVG path in, deformed SVG path out.
 *
 * Shared by the plugin UI (live preview) and the apply step, so what you see is
 * exactly what lands on the canvas. No dependencies, no DOM.
 */
(function (root) {
  'use strict';

  // ---------- path parsing ----------

  var NUM = /[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g;

  function tokenize(d) {
    var out = [], re = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g, m;
    while ((m = re.exec(d))) out.push(m[1] || parseFloat(m[2]));
    return out;
  }

  /* Walk the commands and emit polylines. Curves are subdivided; `tol` is in the
   * same units as the path, so smaller shapes get proportionally fewer points. */
  /* `maxSeg` subdivides long straight runs. Without it a rectangle's edge stays
   * a single segment and a curved warp cannot bend it at all. */
  function parsePath(d, tol, maxSeg) {
    tol = tol || 0.25;
    maxSeg = maxSeg || Infinity;
    var t = tokenize(d), i = 0, subs = [], cur = null;
    var x = 0, y = 0, sx = 0, sy = 0, px = 0, py = 0, cmd = null, prev = null;

    function start(nx, ny) {
      cur = { points: [{ x: nx, y: ny }], closed: false };
      subs.push(cur);
    }
    function line(nx, ny) {
      if (!cur) start(x, y);
      // Measure from the last emitted point: callers update x/y before calling.
      var from = cur.points[cur.points.length - 1];
      var dx = nx - from.x, dy = ny - from.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      var n = (isFinite(maxSeg) && len > maxSeg) ? Math.min(256, Math.ceil(len / maxSeg)) : 1;
      for (var s2 = 1; s2 <= n; s2++) {
        cur.points.push({ x: from.x + dx * (s2 / n), y: from.y + dy * (s2 / n) });
      }
    }
    function cubic(x1, y1, x2, y2, nx, ny) {
      if (!cur) start(x, y);
      var n = cubicSteps(x, y, x1, y1, x2, y2, nx, ny, tol);
      for (var s = 1; s <= n; s++) {
        var u = s / n, iu = 1 - u;
        cur.points.push({
          x: iu * iu * iu * x + 3 * iu * iu * u * x1 + 3 * iu * u * u * x2 + u * u * u * nx,
          y: iu * iu * iu * y + 3 * iu * iu * u * y1 + 3 * iu * u * u * y2 + u * u * u * ny
        });
      }
    }
    function quad(x1, y1, nx, ny) {
      cubic(x + (2 / 3) * (x1 - x), y + (2 / 3) * (y1 - y),
            nx + (2 / 3) * (x1 - nx), ny + (2 / 3) * (y1 - ny), nx, ny);
    }

    while (i < t.length) {
      if (typeof t[i] === 'string') { cmd = t[i++]; }
      else if (cmd === 'M') { cmd = 'L'; }          // implicit lineto after moveto
      else if (cmd === 'm') { cmd = 'l'; }
      var rel = cmd >= 'a';
      var C = cmd.toUpperCase();

      if (C === 'Z') {
        if (cur) {
          if (isFinite(maxSeg)) line(sx, sy);   // subdivide the closing run too
          cur.closed = true; cur = null;
        }
        x = sx; y = sy; prev = 'Z';
        continue;
      }
      if (C === 'M') {
        x = t[i++] + (rel ? x : 0); y = t[i++] + (rel ? y : 0);
        sx = x; sy = y; start(x, y);
      } else if (C === 'L') {
        x = t[i++] + (rel ? x : 0); y = t[i++] + (rel ? y : 0); line(x, y);
      } else if (C === 'H') {
        x = t[i++] + (rel ? x : 0); line(x, y);
      } else if (C === 'V') {
        y = t[i++] + (rel ? y : 0); line(x, y);
      } else if (C === 'C') {
        var x1 = t[i++] + (rel ? x : 0), y1 = t[i++] + (rel ? y : 0),
            x2 = t[i++] + (rel ? x : 0), y2 = t[i++] + (rel ? y : 0),
            ex = t[i++] + (rel ? x : 0), ey = t[i++] + (rel ? y : 0);
        cubic(x1, y1, x2, y2, ex, ey); px = x2; py = y2; x = ex; y = ey;
      } else if (C === 'S') {
        var rx = (prev === 'C' || prev === 'S') ? 2 * x - px : x;
        var ry = (prev === 'C' || prev === 'S') ? 2 * y - py : y;
        var sx2 = t[i++] + (rel ? x : 0), sy2 = t[i++] + (rel ? y : 0),
            sex = t[i++] + (rel ? x : 0), sey = t[i++] + (rel ? y : 0);
        cubic(rx, ry, sx2, sy2, sex, sey); px = sx2; py = sy2; x = sex; y = sey;
      } else if (C === 'Q') {
        var qx = t[i++] + (rel ? x : 0), qy = t[i++] + (rel ? y : 0),
            qex = t[i++] + (rel ? x : 0), qey = t[i++] + (rel ? y : 0);
        quad(qx, qy, qex, qey); px = qx; py = qy; x = qex; y = qey;
      } else if (C === 'T') {
        var tx = (prev === 'Q' || prev === 'T') ? 2 * x - px : x;
        var ty = (prev === 'Q' || prev === 'T') ? 2 * y - py : y;
        var tex = t[i++] + (rel ? x : 0), tey = t[i++] + (rel ? y : 0);
        quad(tx, ty, tex, tey); px = tx; py = ty; x = tex; y = tey;
      } else if (C === 'A') {
        var arx = t[i++], ary = t[i++], rot = t[i++], laf = t[i++], sf = t[i++];
        var aex = t[i++] + (rel ? x : 0), aey = t[i++] + (rel ? y : 0);
        arcTo(x, y, arx, ary, rot, laf, sf, aex, aey, line);
        x = aex; y = aey;
      } else {
        i++; continue;
      }
      prev = C;
    }
    return subs.filter(function (s) { return s.points.length > 1; });
  }

  function cubicSteps(x0, y0, x1, y1, x2, y2, x3, y3, tol) {
    var d = Math.abs(x0 - x1) + Math.abs(y0 - y1) + Math.abs(x1 - x2) +
            Math.abs(y1 - y2) + Math.abs(x2 - x3) + Math.abs(y2 - y3);
    return Math.max(4, Math.min(96, Math.ceil(Math.sqrt(d / tol) * 1.6)));
  }

  function arcTo(x0, y0, rx, ry, rot, laf, sf, x1, y1, emit) {
    if (!rx || !ry) return emit(x1, y1);
    var rad = rot * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad);
    var dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
    var ux = cos * dx2 + sin * dy2, uy = -sin * dx2 + cos * dy2;
    rx = Math.abs(rx); ry = Math.abs(ry);
    var l = (ux * ux) / (rx * rx) + (uy * uy) / (ry * ry);
    if (l > 1) { rx *= Math.sqrt(l); ry *= Math.sqrt(l); }
    var sign = laf === sf ? -1 : 1;
    var num = rx * rx * ry * ry - rx * rx * uy * uy - ry * ry * ux * ux;
    var den = rx * rx * uy * uy + ry * ry * ux * ux;
    var co = sign * Math.sqrt(Math.max(0, num / den));
    var cxp = co * rx * uy / ry, cyp = -co * ry * ux / rx;
    var cx = cos * cxp - sin * cyp + (x0 + x1) / 2;
    var cy = sin * cxp + cos * cyp + (y0 + y1) / 2;
    var a0 = Math.atan2((uy - cyp) / ry, (ux - cxp) / rx);
    var a1 = Math.atan2((-uy - cyp) / ry, (-ux - cxp) / rx);
    var da = a1 - a0;
    if (!sf && da > 0) da -= 2 * Math.PI;
    if (sf && da < 0) da += 2 * Math.PI;
    var steps = Math.max(6, Math.ceil(Math.abs(da) / (Math.PI / 16)));
    for (var s = 1; s <= steps; s++) {
      var a = a0 + da * (s / steps);
      var px = cos * rx * Math.cos(a) - sin * ry * Math.sin(a) + cx;
      var py = sin * rx * Math.cos(a) + cos * ry * Math.sin(a) + cy;
      emit(px, py);
    }
  }

  root.WarpPath = { parsePath: parsePath, tokenize: tokenize };
})(typeof module !== 'undefined' ? module.exports : self);

/* ---------- deformation ---------- */
(function (root) {
  'use strict';

  var bell = function (u) { return 4 * u * (1 - u); };          // 0 at edges, 1 at centre
  var tri  = function (u) { return 1 - Math.abs(2 * u - 1); };  // pointed version of bell
  var TAU  = Math.PI * 2;

  /* Most warps are an envelope: move the top edge and the bottom edge, then
   * interpolate everything between them. `top` and `bot` are offsets in units of
   * the shape's own height. A few need real 2D math and define `xy` instead. */
  var PRESETS = [
    { id: 'free',       label: 'Free',        free: true,
      xy: function (u, v) { return { u: u, v: v }; } },
    { id: 'arc',        label: 'Arc',         top: function (u, s) { return -s * bell(u); },
                                              bot: function (u, s) { return -s * bell(u); } },
    { id: 'peak',       label: 'Peak',        top: function (u, s) { return -s * tri(u); },
                                              bot: function (u, s) { return -s * tri(u); } },
    { id: 'archUp',     label: 'Arch Top',    top: function (u, s) { return -s * bell(u); },
                                              bot: function () { return 0; } },
    { id: 'archDown',   label: 'Arch Base',   top: function () { return 0; },
                                              bot: function (u, s) { return s * bell(u); } },
    { id: 'bulge',      label: 'Bulge',       top: function (u, s) { return -s * bell(u); },
                                              bot: function (u, s) { return s * bell(u); } },
    { id: 'squeeze',    label: 'Squeeze',     top: function (u, s) { return s * bell(u) * 0.5; },
                                              bot: function (u, s) { return -s * bell(u) * 0.5; } },
    { id: 'flag',       label: 'Flag',        top: function (u, s) { return s * Math.sin(TAU * u) * 0.5; },
                                              bot: function (u, s) { return s * Math.sin(TAU * u) * 0.5; } },
    { id: 'wave',       label: 'Wave',        top: function (u, s) { return s * Math.sin(TAU * u) * 0.5; },
                                              bot: function (u, s) { return -s * Math.sin(TAU * u) * 0.5; } },
    { id: 'rise',       label: 'Rise',        top: function (u, s) { return -s * u; },
                                              bot: function (u, s) { return -s * u; } },
    { id: 'slant',      label: 'Slant',
      // Slanting is a shift of x per unit of y, so it has to be measured in
      // height units. Scaling it by width shears wide text into ribbons.
      xy: function (u, v, s, a) { return { u: u + s * (1 - v) * 0.9 * a, v: v }; } },
    { id: 'shear',      label: 'Shear',
      xy: function (u, v, s) { return { u: u, v: v + s * (u - 0.5) * 0.8 }; } },
    { id: 'taperTop',   label: 'Taper Top',
      xy: function (u, v, s) { return { u: 0.5 + (u - 0.5) * (1 - s * 0.5 * (1 - v)), v: v }; } },
    { id: 'taperBase',  label: 'Taper Base',
      xy: function (u, v, s) { return { u: 0.5 + (u - 0.5) * (1 - s * 0.5 * v), v: v }; } },
    { id: 'perspective', label: 'Perspective',
      xy: function (u, v, s) {
        var k = 1 - s * 0.5 * (1 - v);
        return { u: 0.5 + (u - 0.5) * k, v: v * (1 - s * 0.2) + s * 0.1 };
      } },
    { id: 'inflate',    label: 'Fisheye',
      // A lens, not a balloon: pushing x as hard as y makes neighbouring
      // letters on a wide wordmark climb over each other.
      xy: function (u, v, s, a) {
        var dx = (u - 0.5) * 2, dy = (v - 0.5) * 2;
        var r = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
        var k = s * (1 - r * r) * 0.45;
        return { u: 0.5 + dx * (1 + k * a) / 2, v: 0.5 + dy * (1 + k) / 2 };
      } },
    { id: 'twist',      label: 'Twist',
      // Rotation is measured in the shape's own proportions, otherwise a wide
      // wordmark spins its middle straight through its own ends.
      xy: function (u, v, s, a) {
        var dx = (u - 0.5) * 2 / (a || 1), dy = (v - 0.5) * 2;
        var r = Math.min(1, Math.sqrt(dx * dx + dy * dy) / Math.SQRT2);
        var ang = s * (1 - r) * Math.PI * 0.35;
        var c = Math.cos(ang), sn = Math.sin(ang);
        return { u: 0.5 + (dx * c - dy * sn) * (a || 1) / 2, v: 0.5 + (dx * sn + dy * c) / 2 };
      } },
    { id: 'fish',       label: 'Fish',
      xy: function (u, v, s) {
        var k = 1 - s * Math.abs(2 * u - 1) * 0.75;
        return { u: u, v: 0.5 + (v - 0.5) * k };
      } }
  ];

  var BY_ID = {};
  PRESETS.forEach(function (p) { BY_ID[p.id] = p; });

  var DEFAULT_CORNERS = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];

  /* Bilinear patch through four draggable corners, given in normalized space as
   * [tl, tr, br, bl]. */
  function freeMap(u, v, corners) {
    var tl = corners[0], tr = corners[1], br = corners[2], bl = corners[3];
    var topX = tl.x + (tr.x - tl.x) * u, topY = tl.y + (tr.y - tl.y) * u;
    var botX = bl.x + (br.x - bl.x) * u, botY = bl.y + (br.y - bl.y) * u;
    return { u: topX + (botX - topX) * v, v: topY + (botY - topY) * v };
  }

  /* `aspect` is height/width. Warps that move points horizontally need it so the
   * amount stays sensible whether the shape is a square logo or a long wordmark. */
  function isIdentity(c) {
    if (!c) return true;
    for (var i = 0; i < 4; i++) {
      if (Math.abs(c[i].x - DEFAULT_CORNERS[i].x) > 1e-6 ||
          Math.abs(c[i].y - DEFAULT_CORNERS[i].y) > 1e-6) return false;
    }
    return true;
  }

  function mapPoint(u, v, preset, s, corners, aspect) {
    var m;
    if (preset.xy) {
      m = preset.xy(u, v, s, aspect === undefined ? 1 : aspect);
    } else {
      var t = preset.top(u, s), b = preset.bot(u, s);
      m = { u: u, v: t + v * (1 + b - t) };
    }
    // The corner quad rides on top of whatever the preset did, so the four
    // handles stay live no matter which preset is selected.
    if (!isIdentity(corners)) m = freeMap(m.u, m.v, corners);
    return m;
  }



  /* ---------- simplify and emit ---------- */

  function dedupe(pts) {
    var out = [pts[0]];
    for (var i = 1; i < pts.length; i++) {
      var p = pts[i], q = out[out.length - 1];
      if (Math.abs(p.x - q.x) > 1e-9 || Math.abs(p.y - q.y) > 1e-9) out.push(p);
    }
    // A closed contour often repeats its start point; drop it so the simplifier
    // never gets a zero-length span to measure against.
    if (out.length > 2) {
      var f0 = out[0], l0 = out[out.length - 1];
      if (Math.abs(f0.x - l0.x) < 1e-9 && Math.abs(f0.y - l0.y) < 1e-9) out.pop();
    }
    return out;
  }

  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    var keep = new Array(pts.length); keep[0] = keep[pts.length - 1] = true;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var seg = stack.pop(), a = seg[0], b = seg[1];
      if (b - a < 2) continue;
      var ax = pts[a].x, ay = pts[a].y, bx = pts[b].x, by = pts[b].y;
      var dx = bx - ax, dy = by - ay, len = Math.sqrt(dx * dx + dy * dy);
      var best = -1, bestD = eps;
      for (var i = a + 1; i < b; i++) {
        var d;
        if (len < 1e-9) {
          // Degenerate span: measure straight-line distance from the anchor
          // instead, or every point looks like it sits on the line.
          var ex = pts[i].x - ax, ey = pts[i].y - ay;
          d = Math.sqrt(ex * ex + ey * ey);
        } else {
          d = Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
        }
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best > 0) { keep[best] = true; stack.push([a, best], [best, b]); }
    }
    return pts.filter(function (_, i) { return keep[i]; });
  }

  /* Catmull-Rom through the points, converted to cubics. Keeps the outline
   * smooth instead of showing the sampling as flat facets. */
  var CORNER = Math.cos(28 * Math.PI / 180); // sharper than this stays sharp

  /* A point is a corner when the incoming and outgoing directions disagree
   * strongly. Letterforms are full of them and rounding them off makes type
   * look melted, so corners get a zero tangent and the spline breaks there. */
  function tangents(pts, closed) {
    var n = pts.length, t = new Array(n);
    for (var i = 0; i < n; i++) {
      var prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
      var next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
      var ax = pts[i].x - prev.x, ay = pts[i].y - prev.y;
      var bx = next.x - pts[i].x, by = next.y - pts[i].y;
      var la = Math.sqrt(ax * ax + ay * ay), lb = Math.sqrt(bx * bx + by * by);
      var corner = false;
      if (la > 1e-9 && lb > 1e-9) {
        corner = (ax * bx + ay * by) / (la * lb) < CORNER;
      }
      if (!closed && (i === 0 || i === n - 1)) corner = true;
      t[i] = corner ? { x: 0, y: 0 }
                    : { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 };
    }
    return t;
  }

  function smoothPath(pts, closed) {
    var n = pts.length;
    if (n < 3) return polyPath(pts, closed);
    var t = tangents(pts, closed);
    var d = 'M' + f(pts[0].x) + ' ' + f(pts[0].y);
    var last = closed ? n : n - 1;
    for (var i = 0; i < last; i++) {
      var p1 = pts[i], p2 = pts[(i + 1) % n], t1 = t[i], t2 = t[(i + 1) % n];
      if (!t1.x && !t1.y && !t2.x && !t2.y) {
        d += 'L' + f(p2.x) + ' ' + f(p2.y);
      } else {
        d += 'C' + f(p1.x + t1.x) + ' ' + f(p1.y + t1.y) +
             ' ' + f(p2.x - t2.x) + ' ' + f(p2.y - t2.y) +
             ' ' + f(p2.x) + ' ' + f(p2.y);
      }
    }
    return d + (closed ? 'Z' : '');
  }

  function polyPath(pts, closed) {
    var d = 'M' + f(pts[0].x) + ' ' + f(pts[0].y);
    for (var i = 1; i < pts.length; i++) d += 'L' + f(pts[i].x) + ' ' + f(pts[i].y);
    return d + (closed ? 'Z' : '');
  }

  function f(n) { return Math.round(n * 100) / 100; }

  /* ---------- the one call the UI and the plugin both use ---------- */

  function warp(paths, bbox, opts) {
    var preset = BY_ID[opts.preset] || BY_ID.arc;
    var s = (opts.strength || 0) / 100;
    var w = bbox.width || 1, h = bbox.height || 1;
    var aspect = h / w;
    var tol = Math.max(0.05, Math.min(w, h) / 900);
    var maxSeg = Math.max(w, h) / 64;
    var out = [];

    for (var p = 0; p < paths.length; p++) {
      var subs = root.WarpPath.parsePath(paths[p], tol, maxSeg);
      for (var i = 0; i < subs.length; i++) {
        var pts = subs[i].points, moved = new Array(pts.length);
        for (var j = 0; j < pts.length; j++) {
          var u = (pts[j].x - bbox.x) / w, v = (pts[j].y - bbox.y) / h;
          var m = mapPoint(u, v, preset, s, opts.corners, aspect);
          moved[j] = { x: bbox.x + m.u * w, y: bbox.y + m.v * h };
        }
        moved = dedupe(moved);
        if (moved.length > 3) moved = rdp(moved, tol * 0.6);
        // An open two-point path is a straight line and worth keeping; a closed
        // one with fewer than three points encloses nothing.
        if (moved.length < 2 || (subs[i].closed && moved.length < 3)) continue;
        out.push(opts.smooth === false
          ? polyPath(moved, subs[i].closed)
          : smoothPath(moved, subs[i].closed));
      }
    }
    return out;
  }

  function bounds(paths) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    paths.forEach(function (d) {
      root.WarpPath.parsePath(d, 1).forEach(function (s) {
        s.points.forEach(function (pt) {
          if (pt.x < minX) minX = pt.x; if (pt.x > maxX) maxX = pt.x;
          if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y;
        });
      });
    });
    if (!isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  root.Warp = { PRESETS: PRESETS, warp: warp, bounds: bounds, mapPoint: mapPoint,
    byId: BY_ID, DEFAULT_CORNERS: DEFAULT_CORNERS };
})(typeof module !== 'undefined' ? module.exports : self);
