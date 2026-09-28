/* The canvas viewport.
 *
 * Three tiers, because the whole point is that a pan never costs what a render
 * costs:
 *
 *   1. render   geometry changed. Draw the scene into an offscreen cache that
 *               covers the viewport plus a margin. This is the expensive one.
 *   2. present  pan. Blit the cache at an offset. No paths touched at all, so
 *               it stays under a millisecond no matter how many contours there
 *               are. When the pan runs past the cached margin, re-render once.
 *   3. zoom     scale the cache while the gesture is live, which goes soft the
 *               way Photoshop does, then re-render crisp when it settles.
 *
 * Nothing here builds path data as a string. Shapes arrive as Path2D, dots
 * arrive as typed arrays, and both get drawn under a matrix.
 */
(function (root) {
  'use strict';

  var H = root.Halftone;
  var MARGIN = 0.35;            // extra cache around the viewport, as a fraction
  var SETTLE_MS = 90;           // quiet time before a crisp re-render

  function create(canvas, opts) {
    var o = opts || {};
    var ctx = canvas.getContext('2d', { alpha: false });
    var cache = document.createElement('canvas');
    var cctx = cache.getContext('2d');

    var vp = {
      view: { x: 0, y: 0, k: 1 },
      scene: null,
      bg: '#1e1e1e',
      grid: true,
      gridStep: 1,
      onViewChange: o.onViewChange || function () {},
      onHit: o.onHit || null
    };

    var cacheView = null;       // the view the cache was drawn at
    var cacheRect = null;       // cache origin in screen px relative to cacheView
    var dpr = 1;
    var settleTimer = null;
    var dirty = true;
    var frame = null;

    /* ---------- sizing ---------- */

    function size() {
      var r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      var w = Math.max(1, Math.round(r.width * dpr));
      var h = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w; canvas.height = h;
        dirty = true;
      }
      return { w: r.width, h: r.height };
    }

    /* ---------- coordinate helpers ---------- */

    function toScreen(p) {
      return { x: (p.x - vp.view.x) * vp.view.k, y: (p.y - vp.view.y) * vp.view.k };
    }
    function toWorld(sx, sy) {
      return { x: sx / vp.view.k + vp.view.x, y: sy / vp.view.k + vp.view.y };
    }

    /* ---------- tier 1: render into the cache ---------- */

    function render() {
      var s = size();
      var mx = Math.round(s.w * MARGIN), my = Math.round(s.h * MARGIN);
      var cw = Math.round((s.w + mx * 2) * dpr), ch = Math.round((s.h + my * 2) * dpr);
      if (cache.width !== cw || cache.height !== ch) { cache.width = cw; cache.height = ch; }

      cacheView = { x: vp.view.x, y: vp.view.y, k: vp.view.k };
      cacheRect = { x: -mx, y: -my, w: s.w + mx * 2, h: s.h + my * 2 };

      cctx.setTransform(1, 0, 0, 1, 0, 0);
      cctx.fillStyle = vp.bg;
      cctx.fillRect(0, 0, cw, ch);

      // Everything below draws in CSS pixels of the cache, with the cache's own
      // origin offset folded in, so the scene code never thinks about dpr.
      cctx.setTransform(dpr, 0, 0, dpr, -cacheRect.x * dpr, -cacheRect.y * dpr);

      if (vp.grid) drawGrid(cctx, s, mx, my);
      if (vp.scene) drawScene(cctx);
      dirty = false;
    }

    /* The grid is drawn in the canvas colour, pushed a little towards the
     * other end of the range, so it reads on a white canvas as quietly as it
     * does on a dark one instead of turning into a black mesh. */
    function shade(hex, amount) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return amount > 0 ? '#282828' : '#d8d8d8';
      var n = parseInt(m[1], 16);
      var ch = [n >> 16, (n >> 8) & 255, n & 255].map(function (v) {
        return Math.max(0, Math.min(255, Math.round(v + amount * 255)));
      });
      return '#' + ch.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    }

    function isLight(hex) {
      var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
      if (!m) return false;
      var n = parseInt(m[1], 16);
      return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) > 128;
    }

    function drawGrid(c, s, mx, my) {
      var k = vp.view.k;
      var dir = isLight(vp.bg) ? -1 : 1;
      var step = vp.gridStep;
      // Step up in 1-2-5 decades until the lines are at least 9px apart.
      var target = 9 / k;
      var pow = Math.pow(10, Math.floor(Math.log10(Math.max(1e-6, target))));
      var mul = target / pow <= 1 ? 1 : target / pow <= 2 ? 2 : target / pow <= 5 ? 5 : 10;
      var g = Math.max(step, pow * mul);
      if (g * k < 4) return;

      var x0 = vp.view.x - mx / k, y0 = vp.view.y - my / k;
      var x1 = x0 + (s.w + mx * 2) / k, y1 = y0 + (s.h + my * 2) / k;

      c.lineWidth = 1 / k;
      c.save();
      c.translate(-vp.view.x * k, -vp.view.y * k);
      c.scale(k, k);

      var minor = Math.floor(x0 / g) * g;
      c.beginPath();
      for (var x = minor; x <= x1; x += g) { c.moveTo(x, y0); c.lineTo(x, y1); }
      for (var y = Math.floor(y0 / g) * g; y <= y1; y += g) { c.moveTo(x0, y); c.lineTo(x1, y); }
      c.strokeStyle = o.gridColour || shade(vp.bg, 0.04 * dir);
      c.stroke();

      // Every tenth line reads darker, which is what makes the grid scannable.
      var G = g * 10;
      c.beginPath();
      for (x = Math.floor(x0 / G) * G; x <= x1; x += G) { c.moveTo(x, y0); c.lineTo(x, y1); }
      for (y = Math.floor(y0 / G) * G; y <= y1; y += G) { c.moveTo(x0, y); c.lineTo(x1, y); }
      c.strokeStyle = o.gridColour10 || shade(vp.bg, 0.08 * dir);
      c.stroke();

      // The document origin
      c.beginPath();
      c.moveTo(0, y0); c.lineTo(0, y1);
      c.moveTo(x0, 0); c.lineTo(x1, 0);
      c.strokeStyle = o.axisColour || (dir > 0 ? '#3a4a5e' : '#7d93b3');
      c.stroke();
      c.restore();
    }

    function drawScene(c) {
      var sc = vp.scene;
      var k = vp.view.k;
      c.save();
      c.translate(-vp.view.x * k, -vp.view.y * k);
      c.scale(k, k);

      sc.layers.forEach(function (L) {
        c.save();
        var m = L.matrix;
        c.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        c.globalAlpha = L.opacity === undefined ? 1 : L.opacity;

        // A photo nothing has been applied to yet. Drawn at its frame, under
        // the same matrix as everything else, so moving and rotating it work
        // before any effect is switched on.
        if (L.image && L.bbox) {
          c.imageSmoothingQuality = 'high';
          c.drawImage(L.image, L.bbox.x, L.bbox.y, L.bbox.width, L.bbox.height);
        }

        if (L.shapes) {
          L.shapes.forEach(function (sh) {
            var paths = sh.paths || [sh.path];
            if (sh.fill && sh.fill !== 'none') {
              fillChunked(c, paths, sh.fill, sh.rule);
            }
            if (sh.stroke && sh.stroke !== 'none' && sh.strokeWidth > 0) {
              c.strokeStyle = sh.stroke;
              c.lineWidth = sh.strokeWidth;
              c.lineJoin = 'round'; c.lineCap = 'round';
              for (var j = 0; j < paths.length; j++) c.stroke(paths[j]);
            }
          });
        }

        if (L.plates) drawPlates(c, L);
        c.restore();
      });
      c.restore();
    }

    /* Spot inks are opaque and sit straight on the canvas, later plates over
     * earlier ones, which is what two inks do on a garment. Four colour
     * process inks are translucent and overprint, so those plates are each
     * drawn on a layer of their own with ordinary compositing and the four
     * layers multiplied down at the end.
     *
     * Two reasons for the layers, and the second is the one that matters.
     *
     * Multiply is priced per draw call. A screen has to be handed to the
     * canvas in chunks, because piling a hundred thousand subpaths into one
     * Path2D is quadratic for every dot shape that is not a circle. That makes
     * around two thousand fills, and with multiply set on every one of them a
     * frame took 783ms; the same chunks drawn normally take 117ms, and the
     * four images that composite them cost nothing.
     *
     * And it is what the file does. The export writes one compound path per
     * ink inside a multiply group, so a dot overlapping its neighbour is
     * multiplied once. Filling chunk after chunk with multiply set multiplies
     * every overlap that happens to straddle two chunks a second time, so the
     * canvas came out darker in the shadows than the SVG it was previewing.
     */
    var plateLayer = null, plateCtx = null;

    /* A scratch surface the size of whatever is being drawn into, kept between
     * frames because allocating one of these per frame costs more than the
     * work it saves. */
    function scratchFor(target) {
      if (!plateLayer) {
        plateLayer = typeof OffscreenCanvas !== 'undefined'
          ? new OffscreenCanvas(target.width, target.height)
          : document.createElement('canvas');
        plateCtx = null;
      }
      if (plateLayer.width !== target.width || plateLayer.height !== target.height) {
        plateLayer.width = target.width;
        plateLayer.height = target.height;
        plateCtx = null;
      }
      if (!plateCtx) plateCtx = plateLayer.getContext('2d');
      return plateCtx;
    }

    /* One shape, split across several Path2D objects, filled as one shape.
     *
     * The split exists because a hundred thousand subpaths in a single Path2D
     * is quadratic to build. But a shape's holes are rings like any other, and
     * filling chunk after chunk draws every hole that landed in a later chunk
     * as a solid island instead of punching it. Under about 250 contours
     * everything fits in one chunk and nothing shows; past that a traced photo
     * fills in solid, which is exactly what "the detail disappears" looked
     * like. A texture was getting the blame because a texture is what pushes
     * the contour count over the line.
     *
     * Drawn with xor, each chunk flips what the ones before it left, so the
     * layer ends up as the even-odd fill of every ring at once, which is what
     * the exporter gets for free by writing them all into one path. Nested
     * rings from a marching squares trace alternate direction, so even-odd and
     * nonzero agree on them and the canvas and the file say the same thing.
     */
    function fillChunked(c, paths, colour, rule) {
      if (paths.length === 1) {
        c.fillStyle = colour;
        c.fill(paths[0], rule || 'nonzero');
        return;
      }
      var g = scratchFor(c.canvas);
      var m = c.getTransform();
      var alpha = c.globalAlpha;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, plateLayer.width, plateLayer.height);
      g.setTransform(m);
      g.fillStyle = colour;
      var prev = g.globalCompositeOperation;
      g.globalCompositeOperation = 'xor';
      for (var i = 0; i < paths.length; i++) g.fill(paths[i], 'evenodd');
      g.globalCompositeOperation = prev;

      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = alpha;
      c.drawImage(plateLayer, 0, 0);
      c.restore();
    }

    function drawPlates(c, L) {
      var op = L.blend || 'source-over';
      var n = 0;
      L.plates.forEach(function (pl) { n += pl.paths.length; });

      // Opaque ink needs no layer, and neither does one fill per ink:
      // allocating one would cost more than it saves.
      if (op === 'source-over' || n <= L.plates.length) {
        var prev = c.globalCompositeOperation;
        c.globalCompositeOperation = op;
        L.plates.forEach(function (pl) {
          c.fillStyle = pl.colour;
          for (var q = 0; q < pl.paths.length; q++) c.fill(pl.paths[q]);
        });
        c.globalCompositeOperation = prev;
        return;
      }

      scratchFor(c.canvas);
      var m = c.getTransform();
      var alpha = c.globalAlpha;

      L.plates.forEach(function (pl) {
        plateCtx.setTransform(1, 0, 0, 1, 0, 0);
        plateCtx.clearRect(0, 0, plateLayer.width, plateLayer.height);
        plateCtx.setTransform(m);
        plateCtx.fillStyle = pl.colour;
        for (var q = 0; q < pl.paths.length; q++) plateCtx.fill(pl.paths[q]);

        c.save();
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalCompositeOperation = op;
        c.globalAlpha = alpha;
        c.drawImage(plateLayer, 0, 0);
        c.restore();
      });
    }

    /* ---------- tier 2 and 3: put the cache on screen ---------- */

    function present() {
      if (!cacheView) { render(); }
      var s = size();
      ctx.setTransform(1, 0, 0, 1, 0, 0);

      var scale = vp.view.k / cacheView.k;
      // Where the cache's top-left sits on screen now.
      var ox = (cacheView.x - vp.view.x) * vp.view.k + cacheRect.x * scale;
      var oy = (cacheView.y - vp.view.y) * vp.view.k + cacheRect.y * scale;
      var dw = cacheRect.w * scale, dh = cacheRect.h * scale;

      // Has the view drifted off what the cache covers?
      var stale = scale < 0.999 || scale > 1.001 ||
                  ox > 0 || oy > 0 || ox + dw < s.w || oy + dh < s.h;

      ctx.fillStyle = vp.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(cache, 0, 0, cache.width, cache.height, ox, oy, dw, dh);

      if (stale) scheduleSettle();
    }

    function scheduleSettle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(function () {
        render();
        present();
        vp.onViewChange(vp.view);
      }, SETTLE_MS);
    }

    /* Ask for a frame. Coalesces, so a burst of wheel events costs one paint. */
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = null;
        if (dirty) render();
        present();
      });
    }

    /* ---------- public ---------- */

    vp.setScene = function (scene) {
      vp.scene = scene;
      dirty = true;
      clearTimeout(settleTimer);
      schedule();
    };
    vp.invalidate = function () { dirty = true; clearTimeout(settleTimer); schedule(); };
    vp.redraw = schedule;
    // Exposed so a benchmark can time the two tiers separately rather than
    // timing how long it takes to ask for a frame.
    vp.present = present;
    vp.render = render;
    vp.toScreen = toScreen;
    vp.toWorld = toWorld;
    vp.size = function () { var r = canvas.getBoundingClientRect(); return { w: r.width, h: r.height }; };

    vp.setView = function (v, hard) {
      vp.view.x = v.x; vp.view.y = v.y; vp.view.k = v.k;
      if (hard) vp.invalidate(); else schedule();
      vp.onViewChange(vp.view);
    };

    vp.fit = function (bbox, pad) {
      if (!bbox || !bbox.width || !bbox.height) return;
      var s = vp.size();
      var p = pad === undefined ? 64 : pad;
      var k = Math.min((s.w - p * 2) / bbox.width, (s.h - p * 2) / bbox.height, 16);
      vp.setView({
        k: k,
        x: bbox.x + bbox.width / 2 - s.w / (2 * k),
        y: bbox.y + bbox.height / 2 - s.h / (2 * k)
      }, true);
    };

    vp.zoomTo = function (k, cx, cy) {
      var s = vp.size();
      var px = cx === undefined ? s.w / 2 : cx, py = cy === undefined ? s.h / 2 : cy;
      var before = toWorld(px, py);
      vp.view.k = Math.max(0.01, Math.min(600, k));
      var after = toWorld(px, py);
      vp.view.x += before.x - after.x;
      vp.view.y += before.y - after.y;
      schedule();
      vp.onViewChange(vp.view);
    };

    /* ---------- gestures ---------- */

    /* macOS reports a two-finger swipe as a wheel event with ctrlKey false, and
     * a pinch as a wheel event with ctrlKey true. Treating both as zoom, which
     * is the naive reading, makes the trackpad unusable: every attempt to scroll
     * sideways zooms instead. */
    canvas.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = canvas.getBoundingClientRect();
      var mx = e.clientX - r.left, my = e.clientY - r.top;

      if (e.ctrlKey || e.metaKey) {
        // pinch, or cmd-scroll on a mouse
        var factor = Math.pow(1.0022, -e.deltaY * (e.ctrlKey ? 3.2 : 1));
        vp.zoomTo(vp.view.k * factor, mx, my);
        return;
      }

      var dx = e.deltaX, dy = e.deltaY;
      if (e.shiftKey && !dx) { dx = dy; dy = 0; }   // mouse convention
      if (e.deltaMode === 1) { dx *= 16; dy *= 16; } // lines, not pixels
      vp.view.x += dx / vp.view.k;
      vp.view.y += dy / vp.view.k;
      schedule();
      vp.onViewChange(vp.view);
    }, { passive: false });

    var space = false;
    window.addEventListener('keydown', function (e) {
      if (e.code === 'Space' && !e.repeat && !/input|textarea/i.test(e.target.tagName)) {
        space = true; canvas.style.cursor = 'grab'; e.preventDefault();
      }
    });
    window.addEventListener('keyup', function (e) {
      if (e.code === 'Space') { space = false; canvas.style.cursor = ''; }
    });

    canvas.addEventListener('pointerdown', function (e) {
      var panning = space || e.button === 1;
      if (!panning && vp.onHit) {
        var r = canvas.getBoundingClientRect();
        if (vp.onHit(e, toWorld(e.clientX - r.left, e.clientY - r.top))) return;
      }
      if (!panning && e.button !== 0) return;
      if (!panning && vp.onHit) return;      // the app claimed it

      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = 'grabbing';
      var sx = e.clientX, sy = e.clientY, ox = vp.view.x, oy = vp.view.y;

      var move = function (ev) {
        vp.view.x = ox - (ev.clientX - sx) / vp.view.k;
        vp.view.y = oy - (ev.clientY - sy) / vp.view.k;
        schedule();
        vp.onViewChange(vp.view);
      };
      var up = function () {
        canvas.style.cursor = space ? 'grab' : '';
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });

    /* ---------- touch ---------- */

    /* A trackpad reports a two finger swipe and a pinch as wheel events, so the
     * handler above covers both. A touchscreen reports neither: it reports
     * touches, and the same two gestures have to be assembled from them.
     *
     * One finger pans. On the desktop one finger selects and space pans, but a
     * phone has no space bar, and every map and photo viewer on the platform
     * pans with one finger. Warp handles keep working because they live in the
     * overlay above this canvas and take the touch themselves; anything that
     * reaches here landed on empty canvas.
     *
     * Two fingers pan and zoom at once, about the point between them, which is
     * the one gesture people do without being told.
     */
    var live = null;          // the gesture in progress
    var lastTap = 0, lastTapX = 0, lastTapY = 0;

    function localPoint(t) {
      var r = canvas.getBoundingClientRect();
      return { x: t.clientX - r.left, y: t.clientY - r.top };
    }

    function gestureOf(touches) {
      var a = localPoint(touches[0]);
      if (touches.length < 2) return { cx: a.x, cy: a.y, spread: 0 };
      var b = localPoint(touches[1]);
      var dx = b.x - a.x, dy = b.y - a.y;
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2,
               spread: Math.sqrt(dx * dx + dy * dy) };
    }

    canvas.addEventListener('touchstart', function (e) {
      if (!e.touches.length) return;
      // Fingers arriving or leaving move the midpoint, so the gesture has to be
      // rebased on every change or the artwork jumps.
      var g = gestureOf(e.touches);
      live = { cx: g.cx, cy: g.cy, spread: g.spread,
               x: vp.view.x, y: vp.view.y, k: vp.view.k,
               moved: false, count: e.touches.length };
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', function (e) {
      if (!live || !e.touches.length) return;
      e.preventDefault();
      var g = gestureOf(e.touches);

      if (e.touches.length !== live.count) {
        live = { cx: g.cx, cy: g.cy, spread: g.spread,
                 x: vp.view.x, y: vp.view.y, k: vp.view.k,
                 moved: true, count: e.touches.length };
        return;
      }

      // Zoom first, so the pan that follows is measured in the new scale.
      var k = live.k;
      if (live.count > 1 && live.spread > 12 && g.spread > 12) {
        k = Math.max(0.01, Math.min(600, live.k * (g.spread / live.spread)));
      }
      // Keep whatever was under the midpoint at the start under it now.
      vp.view.k = k;
      vp.view.x = live.x + live.cx / live.k - g.cx / k;
      vp.view.y = live.y + live.cy / live.k - g.cy / k;

      if (Math.abs(g.cx - live.cx) > 3 || Math.abs(g.cy - live.cy) > 3 ||
          Math.abs(g.spread - live.spread) > 3) live.moved = true;

      schedule();
      vp.onViewChange(vp.view);
    }, { passive: false });

    function endTouch(e) {
      if (!live) return;
      if (e.touches.length) {
        // Down to fewer fingers rather than none: rebase and carry on.
        var g = gestureOf(e.touches);
        live = { cx: g.cx, cy: g.cy, spread: g.spread,
                 x: vp.view.x, y: vp.view.y, k: vp.view.k,
                 moved: true, count: e.touches.length };
        return;
      }
      var wasTap = !live.moved && live.count === 1;
      var px = live.cx, py = live.cy;
      live = null;
      if (!wasTap) return;

      // Double tap fits, the way a photo viewer does. Two taps count as one
      // gesture only if they land in the same place, so a tap at one edge and
      // a tap at the other stay two separate taps.
      var now = Date.now();
      if (now - lastTap < 320 &&
          Math.abs(px - lastTapX) < 40 && Math.abs(py - lastTapY) < 40) {
        lastTap = 0;
        if (vp.onDoubleTap) vp.onDoubleTap();
        return;
      }
      lastTap = now; lastTapX = px; lastTapY = py;
    }

    canvas.addEventListener('touchend', endTouch, { passive: false });
    canvas.addEventListener('touchcancel', endTouch, { passive: false });

    var ro = new ResizeObserver(function () { vp.invalidate(); });
    ro.observe(canvas);

    /* ---------- turning engine output into drawable things ---------- */

    /* Path data to Path2D. Done once per compute, never per frame. */
    vp.pathOf = function (d) { return new Path2D(d); };

    /* A plate of halftone dots, as Path2D objects. The outlines come from the
     * same emitDot the exporter uses, so the screen and the file agree.
     *
     * Split across several paths for the same reason contours are: piling tens
     * of thousands of subpaths into one Path2D is quadratic in Chrome. Eighty
     * thousand cross-shaped dots took seven seconds as a single path and eleven
     * milliseconds in chunks. Round dots happen to escape it because arc() takes
     * a different route, but the other five shapes do not. */
    var PLATE_CHUNK = 250;

    vp.platePaths = function (plate, pattern, fuzziness, seed) {
      var out = [];
      var p = null;
      var sink = {
        moveTo: function (x, y) { p.moveTo(x, y); },
        lineTo: function (x, y) { p.lineTo(x, y); },
        close: function () { p.closePath(); },
        arc: function (cx, cy, r) { p.moveTo(cx + r, cy); p.arc(cx, cy, r, 0, Math.PI * 2); },
        ellipse: function (cx, cy, rx, ry, rot) {
          p.moveTo(cx + rx, cy); p.ellipse(cx, cy, rx, ry, rot, 0, Math.PI * 2);
        }
      };
      var d = plate.dots, n = 0;
      for (var o = 0; o < d.length; o += H.STRIDE) {
        if (n % PLATE_CHUNK === 0) { p = new Path2D(); out.push(p); }
        H.emitDot(sink, pattern, d[o], d[o + 1], d[o + 2], d[o + 3], fuzziness, seed | 0);
        n++;
      }
      return out.length ? out : [new Path2D()];
    };

    size();
    return vp;
  }

  root.Viewport = { create: create };
})(window);
