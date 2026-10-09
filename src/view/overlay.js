/* The selection overlay: frame, resize handles, rotation, warp corners.
 *
 * An SVG layer of about twenty nodes sitting over the canvas. Small enough that
 * rebuilding it every frame costs nothing, and it keeps hit-testing and crisp
 * one-pixel lines easy, which is the part canvas is bad at.
 */
(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var Doc = root.Doc, Snap = root.Snap;
  var R = 4.5;                       // handle radius in screen px

  // corner and edge handles, as fractions of the frame
  var HANDLES = [
    { id: 'nw', u: 0, v: 0, cur: 'nwse-resize' },
    { id: 'n', u: 0.5, v: 0, cur: 'ns-resize' },
    { id: 'ne', u: 1, v: 0, cur: 'nesw-resize' },
    { id: 'e', u: 1, v: 0.5, cur: 'ew-resize' },
    { id: 'se', u: 1, v: 1, cur: 'nwse-resize' },
    { id: 's', u: 0.5, v: 1, cur: 'ns-resize' },
    { id: 'sw', u: 0, v: 1, cur: 'nesw-resize' },
    { id: 'w', u: 0, v: 0.5, cur: 'ew-resize' }
  ];

  function node(tag, attrs) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  }

  function create(svg, opts) {
    var o = opts || {};
    var api = {
      layer: null,
      view: null,
      mode: 'transform',        // transform | warp
      selected: -1,
      guides: [],
      onChange: o.onChange || function () {},
      onCommit: o.onCommit || function () {},
      snapOptions: o.snapOptions || function () { return {}; }
    };

    var gFrame = node('g', {}), gHandles = node('g', {}), gGuides = node('g', {});
    svg.appendChild(gGuides); svg.appendChild(gFrame); svg.appendChild(gHandles);

    function toScreen(p) {
      return { x: (p.x - api.view.x) * api.view.k, y: (p.y - api.view.y) * api.view.k };
    }
    function toWorld(sx, sy) {
      return { x: sx / api.view.k + api.view.x, y: sy / api.view.k + api.view.y };
    }

    /* Frame corners in document space, honouring rotation and flips. */
    function corners() { return Doc.frameCorners(api.layer); }

    /* Where a handle sits, interpolated across the rotated frame. */
    function handlePoint(h) {
      var c = corners();
      var top = lerp(c[0], c[1], h.u), bot = lerp(c[3], c[2], h.u);
      return lerp(top, bot, h.v);
    }
    function lerp(a, b, t) { return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }; }

    /* Warp handles live in the frame's own normalised space, so they follow the
     * frame when it is moved, resized or rotated rather than fighting it. */
    function warpPoints() {
      var p = api.layer.effects.filter(function (e) { return e.type === 'warp'; })[0];
      var cn = (p && p.params.corners) || root.Warp.DEFAULT_CORNERS;
      var c = corners();
      return cn.map(function (q) {
        var top = lerp(c[0], c[1], q.x), bot = lerp(c[3], c[2], q.x);
        return lerp(top, bot, q.y);
      });
    }

    /* ---------- drawing ---------- */

    function draw() {
      gFrame.textContent = ''; gHandles.textContent = ''; gGuides.textContent = '';
      if (!api.layer || !api.view) return;

      var c = corners().map(toScreen);
      var pts = c.map(function (p) { return r1(p.x) + ',' + r1(p.y); }).join(' ');
      gFrame.appendChild(node('polygon', {
        points: pts, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1
      }));

      if (api.mode === 'warp') {
        var wp = warpPoints().map(toScreen);
        gFrame.appendChild(node('polygon', {
          points: wp.map(function (p) { return r1(p.x) + ',' + r1(p.y); }).join(' '),
          fill: 'none', stroke: 'var(--accent)', 'stroke-width': 1,
          'stroke-dasharray': '3 3', opacity: 0.85
        }));
        wp.forEach(function (p, i) { gHandles.appendChild(dot(p, i, 'corner', 'move')); });
      } else if (api.mode !== 'selective') {
        HANDLES.forEach(function (h, i) {
          var p = toScreen(handlePoint(h));
          gHandles.appendChild(rotZone(p, h));
          gHandles.appendChild(dot(p, i, 'handle', h.cur, h.id));
        });
      }

      api.guides.forEach(function (g) {
        var a = node('line', {
          stroke: 'var(--snap)', 'stroke-width': 1, 'stroke-dasharray': '4 3',
          'shape-rendering': 'crispEdges'
        });
        if (g.axis === 'x') {
          var sx = Math.round((g.v - api.view.x) * api.view.k) + 0.5;
          a.setAttribute('x1', sx); a.setAttribute('x2', sx);
          a.setAttribute('y1', 0); a.setAttribute('y2', svg.clientHeight);
        } else {
          var sy = Math.round((g.v - api.view.y) * api.view.k) + 0.5;
          a.setAttribute('y1', sy); a.setAttribute('y2', sy);
          a.setAttribute('x1', 0); a.setAttribute('x2', svg.clientWidth);
        }
        gGuides.appendChild(a);
      });
    }

    function r1(v) { return Math.round(v * 10) / 10; }

    function dot(p, i, cls, cursor, hid) {
      var g = node('g', { class: 'handle ' + cls, 'data-i': i, style: 'cursor:' + cursor });
      if (hid) g.setAttribute('data-h', hid);
      g.appendChild(node('circle', {
        cx: r1(p.x), cy: r1(p.y), r: R + 4, fill: 'transparent'
      }));
      g.appendChild(node('circle', {
        cx: r1(p.x), cy: r1(p.y), r: R,
        fill: i === api.selected ? 'var(--accent)' : '#fff',
        stroke: 'var(--accent)', 'stroke-width': 1.5
      }));
      return g;
    }

    /* A wider invisible ring just outside each corner grabs rotation, which is
     * the gesture Figma and Illustrator both use. */
    function rotZone(p, h) {
      if (h.id.length !== 2) return node('g', {});
      var g = node('g', { class: 'rotzone', 'data-h': h.id, style: 'cursor:crosshair' });
      g.appendChild(node('circle', {
        cx: r1(p.x), cy: r1(p.y), r: R + 13, fill: 'transparent'
      }));
      return g;
    }

    /* ---------- interaction ---------- */

    svg.addEventListener('pointerdown', function (e) {
      if (!api.layer) return;
      var rotate = e.target.closest('.rotzone');
      var handle = e.target.closest('.handle');
      if (!handle && !rotate) return;
      e.preventDefault();
      e.stopPropagation();

      if (rotate && !handle) return startRotate(e);
      if (handle.classList.contains('corner')) return startCorner(e, +handle.dataset.i);
      return startResize(e, handle.dataset.h);
    });

    function pointerWorld(e) {
      var r = svg.getBoundingClientRect();
      return toWorld(e.clientX - r.left, e.clientY - r.top);
    }

    function drag(e, onMove, onDone) {
      svg.setPointerCapture(e.pointerId);
      function move(ev) { onMove(ev); api.onChange(); draw(); }
      function up() {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        api.guides = [];
        onDone && onDone();
        api.onCommit();
        draw();
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }

    /* Resize. Work in the frame's unrotated space so a rotated box still drags
     * along its own edges rather than the screen's. */
    function startResize(e, hid) {
      var t = api.layer.transform;
      var start = Object.assign({}, t);
      var inv = Doc.invert(Doc.frameMatrix(start));
      var p0 = Doc.applyMatrix(inv, pointerWorld(e).x, pointerWorld(e).y);
      var ratio = start.width / (start.height || 1);
      api.selected = -1;

      drag(e, function (ev) {
        var pw = pointerWorld(ev);
        var p = Doc.applyMatrix(inv, pw.x, pw.y);
        var dx = p.x - p0.x, dy = p.y - p0.y;
        var x = start.x, y = start.y, w = start.width, h = start.height;

        if (hid.indexOf('w') > -1) { x = start.x + dx; w = start.width - dx; }
        if (hid.indexOf('e') > -1) { w = start.width + dx; }
        if (hid.indexOf('n') > -1) { y = start.y + dy; h = start.height - dy; }
        if (hid.indexOf('s') > -1) { h = start.height + dy; }

        if ((ev.shiftKey || api.lockRatio) && hid.length === 2) {
          // Keep proportion by driving height from width, moving the anchored edge.
          var nh = w / ratio;
          if (hid.indexOf('n') > -1) y += h - nh;
          h = nh;
        }
        if (w < 1) { w = 1; }
        if (h < 1) { h = 1; }

        if (!(ev.metaKey || ev.ctrlKey)) {
          var step = api.gridStep || 1;
          x = Math.round(x / step) * step; y = Math.round(y / step) * step;
          w = Math.round(w / step) * step; h = Math.round(h / step) * step;
        }
        t.x = x; t.y = y; t.width = Math.max(1, w); t.height = Math.max(1, h);
      });
    }

    function startRotate(e) {
      var t = api.layer.transform;
      var cx = t.x + t.width / 2, cy = t.y + t.height / 2;
      var p0 = pointerWorld(e);
      var a0 = Math.atan2(p0.y - cy, p0.x - cx) * 180 / Math.PI;
      var r0 = t.rotation || 0;

      drag(e, function (ev) {
        var p = pointerWorld(ev);
        var a = Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI;
        var deg = r0 + (a - a0);
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
        t.rotation = ((deg % 360) + 360) % 360;
      });
    }

    /* A warp corner, dragged in the frame's normalised space. */
    function startCorner(e, i) {
      api.selected = i;
      var entry = api.layer.effects.filter(function (x) { return x.type === 'warp'; })[0];
      if (!entry) return;
      if (!entry.params.corners) {
        entry.params.corners = root.Warp.DEFAULT_CORNERS.map(function (c) {
          return { x: c.x, y: c.y };
        });
      }
      var cn = entry.params.corners;
      var t = api.layer.transform;
      var inv = Doc.invert(Doc.frameMatrix(t));

      drag(e, function (ev) {
        var pw = pointerWorld(ev);
        var p = Doc.applyMatrix(inv, pw.x, pw.y);
        var free = ev.metaKey || ev.ctrlKey;
        var res = (Snap && !free)
          ? Snap.apply(p.x, p.y, api.snapOptions(i))
          : { x: p.x, y: p.y, guides: [] };
        api.guides = (res.guides || []).map(function (g) {
          // Guides come back in frame space; put them into document space.
          var q = Doc.applyMatrix(Doc.frameMatrix(t),
            g.axis === 'x' ? g.v : 0, g.axis === 'y' ? g.v : 0);
          return { axis: g.axis, v: g.axis === 'x' ? q.x : q.y };
        });
        cn[i] = {
          x: (res.x - t.x) / (t.width || 1),
          y: (res.y - t.y) / (t.height || 1)
        };
      });
    }

    /* ---------- keyboard ---------- */

    api.nudge = function (dx, dy, big) {
      if (!api.layer) return false;
      var step = (big ? 10 : 1) * (api.gridStep || 1);
      if (api.mode === 'warp' && api.selected >= 0) {
        var entry = api.layer.effects.filter(function (x) { return x.type === 'warp'; })[0];
        if (!entry) return false;
        if (!entry.params.corners) {
          entry.params.corners = root.Warp.DEFAULT_CORNERS.map(function (c) {
            return { x: c.x, y: c.y };
          });
        }
        var t = api.layer.transform;
        var c = entry.params.corners[api.selected];
        c.x += dx * step / (t.width || 1);
        c.y += dy * step / (t.height || 1);
      } else {
        api.layer.transform.x += dx * step;
        api.layer.transform.y += dy * step;
      }
      api.onChange(); draw();
      return true;
    };

    api.draw = draw;
    api.setSelected = function (i) { api.selected = i; draw(); };
    api.hitCorner = function (world) {
      if (api.mode !== 'warp' || !api.layer) return -1;
      var tol = 10 / api.view.k;
      var pts = warpPoints();
      for (var i = 0; i < pts.length; i++) {
        if (Math.hypot(pts[i].x - world.x, pts[i].y - world.y) < tol) return i;
      }
      return -1;
    };
    return api;
  }

  root.Overlay = { create: create, HANDLES: HANDLES };
})(window);
