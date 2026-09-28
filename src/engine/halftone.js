/* Halftone: turn continuous tone into a real CMYK dot screen, as vectors.
 *
 * The method is what a printing RIP does:
 *   1. separate RGB into cyan, magenta, yellow and black ink coverage
 *   2. build a summed-area table per channel, so averaging a screen cell of any
 *      size is four array reads and the cost stops depending on frequency
 *   3. lay a square grid per channel, rotated to that channel's screen angle
 *   4. at each cell, make a dot whose AREA is proportional to ink coverage
 *   5. emit one compound path per channel, composited with multiply
 *
 * Dot area, not dot radius, is what carries tone on paper. Scaling the radius
 * with coverage instead is the classic mistake and it makes every midtone too
 * dark, so the radius here always goes through a square root.
 *
 * Output is parametric: each channel returns a flat Float32Array of
 * [cx, cy, r, phase, ...] quads. The viewport turns those into a Path2D with
 * arcs, and the exporter turns the same numbers into path data. Neither one
 * builds a string until it has to.
 */
(function (root) {
  'use strict';

  var STRIDE = 4;               // cx, cy, r, phase per dot
  var TAU = Math.PI * 2;

  /* ---------- separation ---------- */

  /* Grey component replacement. gcr 1 pulls the full common grey out into black,
   * which is what keeps shadows from going muddy when three inks stack. gcr 0
   * leaves the black channel empty and prints everything from CMY. */
  /* Scratch buffers, kept between calls.
   *
   * A single screening of a 1296px image allocates four separation planes and
   * four summed-area tables: around eighty megabytes, thrown away immediately.
   * Doing that on every slider tick left the worker collecting garbage for
   * longer than it spent screening, which showed up as a job taking two hundred
   * milliseconds of wall time for sixty milliseconds of work. Holding onto the
   * buffers costs a fixed amount of memory and removes the pauses entirely. */
  var scratch = { n: 0, planes: null, sat: null, satN: 0 };

  function planesFor(n) {
    if (!scratch.planes || scratch.n !== n) {
      scratch.planes = [new Float32Array(n), new Float32Array(n),
                        new Float32Array(n), new Float32Array(n)];
      scratch.n = n;
    }
    return scratch.planes;
  }

  function satFor(n) {
    if (!scratch.sat || scratch.satN !== n) {
      scratch.sat = new Float64Array(n);
      scratch.satN = n;
    }
    return scratch.sat;
  }

  function separate(rgba, w, h, opts) {
    var gcr = opts && opts.gcr !== undefined ? opts.gcr : 1;
    var n = w * h;
    var pl = planesFor(n);
    var C = pl[0], M = pl[1], Y = pl[2], K = pl[3];
    C.fill(0); M.fill(0); Y.fill(0); K.fill(0);

    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var a = rgba[p + 3] / 255;
      // Paper shows through anything transparent, so it takes no ink at all.
      var r = (rgba[p] / 255) * a + (1 - a);
      var g = (rgba[p + 1] / 255) * a + (1 - a);
      var b = (rgba[p + 2] / 255) * a + (1 - a);

      var kFull = 1 - Math.max(r, g, b);
      var k = kFull * gcr;
      var d = 1 - k;
      if (d > 1e-6) {
        C[i] = clamp01((1 - r - k) / d);
        M[i] = clamp01((1 - g - k) / d);
        Y[i] = clamp01((1 - b - k) / d);
      }
      K[i] = k;
    }
    return { c: C, m: M, y: Y, k: K };
  }

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* Ink demand for a one or two colour print: how dark the pixel is, by eye.
   *
   * Separating to CMYK and printing only the black plate is wrong here. Black
   * generation is 1 - max(r,g,b), so a saturated red has no black in it at all
   * and a red logo comes out as blank paper. A one-colour print wants
   * perceptual darkness, which is what luminance gives. */
  /* Inverted, ink follows lightness instead of darkness: what a light ink on a
   * dark garment prints. Anything transparent shows the ground, and the
   * ground takes no ink whichever way round the tone runs, so it is composited
   * onto black in that case rather than white. */
  function toneOf(rgba, w, h, invert) {
    var n = w * h;
    var t = new Float32Array(n);
    var gv = invert ? 0 : 1;
    for (var i = 0, p = 0; i < n; i++, p += 4) {
      var a = rgba[p + 3] / 255;
      var r = (rgba[p] / 255) * a + gv * (1 - a);
      var g = (rgba[p + 1] / 255) * a + gv * (1 - a);
      var b = (rgba[p + 2] / 255) * a + gv * (1 - a);
      var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      t[i] = invert ? l : 1 - l;
    }
    return t;
  }

  /* Two inks from one tone.
   *
   * The colour carries the whole range, the dark ink only comes in once the
   * tone passes the split, and they overprint in the shadows. That is what a
   * risograph or a two-colour screen print actually does, and it is why a
   * duotone keeps its colour in the midtones instead of turning into a mono
   * screen with a tint. */
  function duotoneOf(rgba, w, h, split, invert) {
    var t = toneOf(rgba, w, h, invert);
    var n = t.length;
    var dark = new Float32Array(n), colour = new Float32Array(n);
    var s = clamp01(split === undefined ? 0.45 : split);
    var span = Math.max(0.05, 1 - s);
    for (var i = 0; i < n; i++) {
      var v = t[i];
      var d = clamp01((v - s) / span);
      dark[i] = d * d * (3 - 2 * d);            // eased in, so shadows arrive smoothly
      // The colour thins where the dark ink takes over, so the two together
      // do not pile up past what the paper can hold.
      colour[i] = clamp01(v) * (1 - 0.45 * dark[i]);
    }
    return { dark: dark, colour: colour };
  }

  /* ---------- summed-area table ---------- */

  /* sat has one extra row and column of zeros, so a box sum never needs a bounds
   * check. Float32 loses precision past a few million accumulated samples, so the
   * table is Float64 even though the input is Float32. */
  function buildSat(ch, w, h, reuse) {
    var sw = w + 1;
    var sat = reuse || new Float64Array(sw * (h + 1));
    if (reuse) sat.fill(0);
    for (var y = 0; y < h; y++) {
      var rowSum = 0;
      var src = y * w, cur = (y + 1) * sw, prev = y * sw;
      for (var x = 0; x < w; x++) {
        rowSum += ch[src + x];
        sat[cur + x + 1] = sat[prev + x + 1] + rowSum;
      }
    }
    return sat;
  }

  /* Mean of the box [x0,x1) by [y0,y1), clamped to the image. */
  function boxMean(sat, w, h, x0, y0, x1, y1) {
    if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
    if (x1 > w) x1 = w; if (y1 > h) y1 = h;
    var bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return 0;
    var sw = w + 1;
    var s = sat[y1 * sw + x1] - sat[y0 * sw + x1] - sat[y1 * sw + x0] + sat[y0 * sw + x0];
    return s / (bw * bh);
  }

  /* ---------- seeded per-dot noise ---------- */

  /* Every modulator has to be reproducible from the cell index alone, so the
   * viewport and the exporter can draw the identical dot without passing state. */
  function hash2(i, j, seed) {
    var n = (i * 374761393 + j * 668265263 + seed * 1442695040888963407) | 0;
    n = (n ^ (n >>> 13)) * 1274126177 | 0;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }

  /* Smooth value noise over the cell lattice, for fields that should drift
   * rather than flicker: paper fibre and ink mottling. */
  function lattice(x, y, seed) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var xf = x - xi, yf = y - yi;
    var u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    var a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    var c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  function fbm2(x, y, seed, oct) {
    var s = 0, amp = 1, norm = 0, f = 1;
    for (var o = 0; o < oct; o++) {
      s += amp * lattice(x * f, y * f, seed + o * 131);
      norm += amp; amp *= 0.5; f *= 2.07;
    }
    return s / norm;
  }

  /* ---------- coverage to dot size ---------- */

  /* A round dot inscribed in its cell can only ever cover pi/4 of that cell, so
   * sizing the radius as sqrt(coverage) * half prints every tone 21% too light.
   * Past about 70% the dots have to overlap their neighbours and it is the white
   * gaps between them that carry the tone, which no closed form covers neatly
   * across every dot shape.
   *
   * So measure it instead. Rasterise one cell of the periodic lattice at a range
   * of dot sizes, counting how much ink actually lands once neighbours overlap,
   * then invert that curve. Built once per shape and cached. */

  var covTables = {};
  var COV_STEPS = 96, COV_GRID = 72, COV_TMAX = 1.06;

  function insideDot(kind, dx, dy, t) {
    if (t <= 0) return false;
    switch (kind) {
      case 'square': {
        var a = t * 0.8862269;
        return Math.abs(dx) <= a && Math.abs(dy) <= a;
      }
      case 'diamond': {
        var d = t * 1.2533141;
        return Math.abs(dx) + Math.abs(dy) <= d;
      }
      case 'ellipse': {
        var rx = t * 1.35, ry = t * 0.74;
        return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
      }
      case 'line':
        return Math.abs(dx) <= t * 2.4 && Math.abs(dy) <= t * 0.55;
      case 'cross': {
        var arm = t * 1.35, th = t * 0.42;
        return (Math.abs(dx) <= arm && Math.abs(dy) <= th) ||
               (Math.abs(dx) <= th && Math.abs(dy) <= arm);
      }
      default:
        return dx * dx + dy * dy <= t * t;
    }
  }

  function coverageTable(kind) {
    if (covTables[kind]) return covTables[kind];
    var table = new Float64Array(COV_STEPS + 1);
    var N = COV_GRID;
    for (var s = 0; s <= COV_STEPS; s++) {
      var t = COV_TMAX * s / COV_STEPS;
      // Anything more than two cells away cannot reach, so nine centres is enough.
      var reach = Math.ceil(t * 2.5) + 1;
      var hit = 0;
      for (var py = 0; py < N; py++) {
        var y = (py + 0.5) / N;
        for (var px = 0; px < N; px++) {
          var x = (px + 0.5) / N;
          var on = false;
          for (var j = -reach; j <= reach && !on; j++) {
            for (var i = -reach; i <= reach && !on; i++) {
              if (insideDot(kind, x - (0.5 + i), y - (0.5 + j), t)) on = true;
            }
          }
          if (on) hit++;
        }
      }
      table[s] = hit / (N * N);
    }
    covTables[kind] = table;
    return table;
  }

  /* Invert the curve: given the ink this cell owes, how big does the dot get?
   * Returned in cell units, so multiply by spacing for pixels. */
  function dotSizeFor(table, cov) {
    if (cov <= 0) return 0;
    var last = table.length - 1;
    if (cov >= table[last]) return COV_TMAX;
    var lo = 0, hi = last;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (table[mid] < cov) lo = mid; else hi = mid;
    }
    var a = table[lo], b = table[hi];
    var f = b > a ? (cov - a) / (b - a) : 0;
    return COV_TMAX * (lo + f) / COV_STEPS;
  }

  /* ---------- the screen ---------- */

  var DEFAULTS = {
    frequency: 120,      // screen cells across the artwork width
    pattern: 'round',    // round | square | ellipse | line | cross | diamond
    inkDensity: 0.9,     // global multiplier on dot area
    dotGain: 0,          // -1 shrinks midtones, +1 fattens them, like real paper
    roughness: 0,        // 0..1 jitter on cell centre and radius
    fuzziness: 0,        // 0..1 how ragged the dot outline is
    paperFibre: 0,       // 0..1 slow field that starves ink
    inkTexture: 0,       // 0..1 per-dot mottling
    gcr: 1,              // grey component replacement
    minDot: 0.06,        // dots below this fraction of the cell are dropped
    seed: 1
  };

  // Traditional offset angles. Thirty degrees apart is what stops the rosette
  // from turning into a moire pattern; yellow sits on zero because the eye
  // forgives it there.
  var ANGLE_PRESETS = {
    classic: { c: 15, m: 75, y: 0, k: 45 },
    reference: { c: 15, m: -15, y: 0, k: 45 },
    flat: { c: 0, m: 0, y: 0, k: 0 }
  };

  var CHANNELS = [
    { key: 'c', label: 'Cyan', colour: '#00AEEF' },
    { key: 'm', label: 'Magenta', colour: '#EC008C' },
    { key: 'y', label: 'Yellow', colour: '#FFF200' },
    { key: 'k', label: 'Black', colour: '#000000' }
  ];

  function opts(o) {
    var r = {};
    for (var key in DEFAULTS) r[key] = (o && o[key] !== undefined) ? o[key] : DEFAULTS[key];
    return r;
  }

  /* Screen one channel. Returns a Float32Array of [cx, cy, r, phase] quads in
   * image pixel coordinates. */
  function screenChannel(sat, w, h, angleDeg, p, seedOffset) {
    var spacing = w / Math.max(1, p.frequency);
    var half = spacing / 2;
    var table = coverageTable(p.pattern);
    var th = angleDeg * Math.PI / 180;
    var cos = Math.cos(th), sin = Math.sin(th);
    var seed = (p.seed + seedOffset) | 0;

    // The rotated grid has to cover the whole image, so take the four corners
    // into the rotated frame and walk the box they span.
    var u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    var corners = [[0, 0], [w, 0], [0, h], [w, h]];
    for (var ci = 0; ci < 4; ci++) {
      var cx = corners[ci][0], cy = corners[ci][1];
      var u = cx * cos + cy * sin, v = -cx * sin + cy * cos;
      if (u < u0) u0 = u; if (u > u1) u1 = u;
      if (v < v0) v0 = v; if (v > v1) v1 = v;
    }
    var i0 = Math.floor(u0 / spacing) - 1, i1 = Math.ceil(u1 / spacing) + 1;
    var j0 = Math.floor(v0 / spacing) - 1, j1 = Math.ceil(v1 / spacing) + 1;

    var cap = Math.max(16, (i1 - i0) * (j1 - j0));
    var out = new Float32Array(cap * STRIDE);
    var n = 0;

    var gainK = p.dotGain * 0.45;
    var minR = p.minDot * spacing;

    for (var j = j0; j <= j1; j++) {
      for (var i = i0; i <= i1; i++) {
        var uu = (i + 0.5) * spacing, vv = (j + 0.5) * spacing;
        var x = uu * cos - vv * sin;
        var y = uu * sin + vv * cos;

        if (p.roughness > 0) {
          var jr = p.roughness * half * 0.55;
          x += (hash2(i, j, seed) * 2 - 1) * jr;
          y += (hash2(i, j, seed + 7919) * 2 - 1) * jr;
        }
        if (x < -half || y < -half || x > w + half || y > h + half) continue;

        var cov = boxMean(sat, w, h, Math.round(x - half), Math.round(y - half),
                          Math.round(x + half), Math.round(y + half));
        if (cov <= 0) continue;

        // Dot gain: paper spreads ink, so midtones print heavier than the file
        // says. A gamma on coverage models it in either direction.
        if (gainK !== 0) cov = Math.pow(cov, 1 - gainK);

        if (p.paperFibre > 0) {
          var fib = fbm2(x / (spacing * 3.1), y / (spacing * 3.1), seed + 311, 3);
          cov *= 1 - p.paperFibre * (1 - fib) * 0.85;
        }
        if (p.inkTexture > 0) {
          var mot = fbm2(x / (spacing * 0.9), y / (spacing * 0.9), seed + 977, 2);
          cov *= 1 - p.inkTexture * (1 - mot) * 0.6;
        }
        if (p.roughness > 0) {
          cov *= 1 - p.roughness * hash2(i, j, seed + 5501) * 0.35;
        }

        cov *= p.inkDensity;
        if (cov <= 0) continue;
        if (cov > 1) cov = 1;

        // Measured, so the ink that lands equals the tone that was asked for.
        var r = dotSizeFor(table, cov) * spacing;
        if (r < minR) continue;

        var o = n * STRIDE;
        out[o] = x; out[o + 1] = y; out[o + 2] = r;
        // phase carries the screen angle plus a per-dot spin, so non-round dots
        // sit on the screen rather than on the page axes.
        out[o + 3] = th + (p.fuzziness > 0 ? hash2(i, j, seed + 1289) * TAU : 0);
        n++;
      }
    }
    return out.subarray(0, n * STRIDE);
  }

  /* One call: pixels in, per-channel dot arrays out. */
  function screen(rgba, w, h, options) {
    var p = opts(options);
    var angles = options && options.angles ? options.angles : ANGLE_PRESETS.classic;
    var on = options && options.channels ? options.channels : { c: 1, m: 1, y: 1, k: 1 };
    var mode = (options && options.mode) || 'cmyk';
    // A separation is a positive by definition; only spot inks can run negative.
    var invert = !!(options && options.invert) && mode !== 'cmyk';

    // One and two colour prints work from perceptual tone, not from the CMYK
    // black plate, which has no black in a saturated colour at all.
    var planes, order;
    if (mode === 'mono') {
      planes = { k: toneOf(rgba, w, h, invert) };
      order = [{ key: 'k', label: 'Black', idx: 3 }];
    } else if (mode === 'duotone') {
      var duo = duotoneOf(rgba, w, h, options && options.duotoneSplit, invert);
      planes = { k: duo.dark, m: duo.colour };
      order = [{ key: 'm', label: 'Colour', idx: 1 }, { key: 'k', label: 'Black', idx: 3 }];
    } else {
      planes = separate(rgba, w, h, p);
      order = CHANNELS.map(function (c, i) {
        return { key: c.key, label: c.label, idx: i };
      }).filter(function (c) { return on[c.key]; });
    }

    var out = [], total = 0;
    for (var i = 0; i < order.length; i++) {
      var ch = order[i];
      var defn = CHANNELS[ch.idx];
      var sat = buildSat(planes[ch.key], w, h, satFor((w + 1) * (h + 1)));
      var dots = screenChannel(sat, w, h, angles[ch.key] || 0, p, ch.idx * 1013);
      total += dots.length / STRIDE;
      out.push({ key: ch.key, label: ch.label, colour: defn.colour, dots: dots });
    }
    return {
      channels: out,
      stats: { dots: total, spacing: w / Math.max(1, p.frequency), channels: out.length }
    };
  }

  /* ---------- dot outlines ---------- */

  /* Both the viewport and the exporter walk a dot through this, so what you see
   * on screen is exactly what lands in the file. `sink` takes moveTo, lineTo,
   * arc and close, which Path2D provides natively and the exporter fakes. */
  function emitDot(sink, kind, cx, cy, r, phase, fuzz, seed) {
    if (r <= 0) return;

    if (fuzz > 0) {
      // A ragged outline: walk a polygon whose radius wobbles. Segment count
      // follows the radius so small dots stay cheap.
      var steps = Math.max(6, Math.min(28, Math.round(r * 2.2) + 6));
      for (var s = 0; s <= steps; s++) {
        var a = phase + s / steps * TAU;
        var rr = r * (1 + (hash2(s, (cx * 31 + cy * 17) | 0, seed) * 2 - 1) * fuzz * 0.55);
        var shape = radiusFor(kind, a - phase, 1);
        var px = cx + Math.cos(a) * rr * shape, py = cy + Math.sin(a) * rr * shape;
        if (s === 0) sink.moveTo(px, py); else sink.lineTo(px, py);
      }
      sink.close();
      return;
    }

    switch (kind) {
      case 'round':
        sink.arc(cx, cy, r);
        break;
      case 'square': {
        // side chosen so the square carries the same area as the circle would
        var a2 = r * 0.8862269;
        quad(sink, cx, cy, a2, a2, phase);
        break;
      }
      case 'diamond': {
        var d = r * 1.2533141;   // same area as the circle, rotated 45 degrees
        poly(sink, cx, cy, [[0, -d], [d, 0], [0, d], [-d, 0]], phase);
        break;
      }
      case 'ellipse':
        sink.ellipse(cx, cy, r * 1.35, r * 0.74, phase);
        break;
      case 'line': {
        // A bar spanning the cell, thickening with coverage. Classic line screen.
        var halfLen = r * 2.4, halfThick = r * 0.55;
        quad(sink, cx, cy, halfLen, halfThick, phase);
        break;
      }
      case 'cross': {
        var arm = r * 1.35, thick = r * 0.42;
        quad(sink, cx, cy, arm, thick, phase);
        quad(sink, cx, cy, thick, arm, phase);
        break;
      }
      default:
        sink.arc(cx, cy, r);
    }
  }

  /* Shape factor for the fuzzy path: how far the outline sits at angle a. */
  function radiusFor(kind, a, r) {
    if (kind === 'square' || kind === 'diamond') {
      var t = kind === 'diamond' ? a + Math.PI / 4 : a;
      var c = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t));
      return r * 0.8862269 / Math.max(c, s);
    }
    if (kind === 'ellipse') {
      var ca = Math.cos(a), sa = Math.sin(a);
      return r / Math.sqrt(ca * ca / (1.35 * 1.35) + sa * sa / (0.74 * 0.74));
    }
    return r;
  }

  function quad(sink, cx, cy, hw, hh, rot) {
    poly(sink, cx, cy, [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]], rot);
  }

  function poly(sink, cx, cy, pts, rot) {
    var cos = Math.cos(rot), sin = Math.sin(rot);
    for (var i = 0; i < pts.length; i++) {
      var x = cx + pts[i][0] * cos - pts[i][1] * sin;
      var y = cy + pts[i][0] * sin + pts[i][1] * cos;
      if (i === 0) sink.moveTo(x, y); else sink.lineTo(x, y);
    }
    sink.close();
  }

  /* ---------- SVG path data ---------- */

  /* A sink that writes path data. One compound path per channel, which is four
   * nodes in the file instead of one node per dot. */
  function PathSink(precision) {
    var f = Math.pow(10, precision === undefined ? 2 : precision);
    var n = function (v) { return Math.round(v * f) / f; };
    var d = '';
    return {
      moveTo: function (x, y) { d += 'M' + n(x) + ' ' + n(y); },
      lineTo: function (x, y) { d += 'L' + n(x) + ' ' + n(y); },
      close: function () { d += 'Z'; },
      arc: function (cx, cy, r) {
        // Two half-arcs, because a single 360 degree arc is degenerate in SVG.
        d += 'M' + n(cx - r) + ' ' + n(cy) +
             'a' + n(r) + ' ' + n(r) + ' 0 1 0 ' + n(r * 2) + ' 0' +
             'a' + n(r) + ' ' + n(r) + ' 0 1 0 ' + n(-r * 2) + ' 0Z';
      },
      ellipse: function (cx, cy, rx, ry, rot) {
        var deg = n(rot * 180 / Math.PI);
        d += 'M' + n(cx - rx) + ' ' + n(cy) +
             'A' + n(rx) + ' ' + n(ry) + ' ' + deg + ' 1 0 ' + n(cx + rx) + ' ' + n(cy) +
             'A' + n(rx) + ' ' + n(ry) + ' ' + deg + ' 1 0 ' + n(cx - rx) + ' ' + n(cy) + 'Z';
      },
      get: function () { return d; }
    };
  }

  function channelPath(channel, params, precision) {
    var p = opts(params);
    var sink = PathSink(precision);
    var dots = channel.dots;
    for (var o = 0; o < dots.length; o += STRIDE) {
      emitDot(sink, p.pattern, dots[o], dots[o + 1], dots[o + 2], dots[o + 3],
              p.fuzziness, p.seed | 0);
    }
    return sink.get();
  }

  root.Halftone = {
    STRIDE: STRIDE,
    DEFAULTS: DEFAULTS,
    CHANNELS: CHANNELS,
    ANGLE_PRESETS: ANGLE_PRESETS,
    separate: separate,
    toneOf: toneOf,
    duotoneOf: duotoneOf,
    buildSat: buildSat,
    releaseScratch: function () { scratch = { n: 0, planes: null, sat: null, satN: 0 }; },
    boxMean: boxMean,
    screen: screen,
    screenChannel: screenChannel,
    emitDot: emitDot,
    insideDot: insideDot,
    coverageTable: coverageTable,
    dotSizeFor: dotSizeFor,
    channelPath: channelPath,
    PathSink: PathSink,
    hash2: hash2,
    fbm2: fbm2
  };
})(typeof module !== 'undefined' ? module.exports : self);
