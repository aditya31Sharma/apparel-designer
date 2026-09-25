/* Grunge: turn artwork into eroded, ink-spattered vector shapes.
 *
 * The method, which is what Photoshop's stamp/spatter stacks approximate:
 *   1. rasterise the artwork to a coverage mask
 *   2. build a signed distance field from that mask
 *   3. add fractal noise to the distance, so the outline moves in and out
 *   4. re-threshold at zero
 *   5. trace the result back to contours and emit paths
 *
 * Distance transform is Felzenszwalb and Huttenlocher's exact squared-Euclidean
 * transform (two 1D passes over lower envelopes of parabolas, O(n)).
 * Contour tracing is marching squares with holes wound against their shell, so
 * a nonzero fill rule renders counters correctly.
 */
(function (root) {
  'use strict';

  var INF = 1e20;

  /* ---------- seeded noise ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* Value noise on a hashed lattice. Cheaper than gradient noise and the blobby
   * character suits ink better than Perlin's smooth lobes. */
  function makeNoise(seed) {
    var perm = new Uint8Array(512);
    var rnd = mulberry32(seed);
    var p = new Uint8Array(256);
    for (var i = 0; i < 256; i++) p[i] = i;
    for (i = 255; i > 0; i--) {
      var j = (rnd() * (i + 1)) | 0;
      var t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (i = 0; i < 512; i++) perm[i] = p[i & 255];

    function hash(x, y) {
      return perm[(perm[x & 255] + (y & 255)) & 255] / 255;
    }
    function smooth(t) { return t * t * (3 - 2 * t); }

    return function (x, y) {
      var xi = Math.floor(x), yi = Math.floor(y);
      var xf = x - xi, yf = y - yi;
      var u = smooth(xf), v = smooth(yf);
      var a = hash(xi, yi), b = hash(xi + 1, yi);
      var c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
  }

  function fbm(noise, x, y, octaves, gain, lacunarity) {
    var sum = 0, amp = 1, norm = 0, fx = x, fy = y;
    for (var o = 0; o < octaves; o++) {
      sum += amp * noise(fx, fy);
      norm += amp;
      amp *= gain;
      fx *= lacunarity; fy *= lacunarity;
    }
    return sum / norm;
  }

  /* ---------- exact euclidean distance transform ---------- */

  function edt1d(f, d, v, z, n) {
    var k = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (var q = 1; q < n; q++) {
      var s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  /* squared distance to the nearest cell where mask is truthy */
  function edt2d(mask, w, h, invert) {
    var grid = new Float64Array(w * h);
    for (var i = 0; i < w * h; i++) {
      var on = invert ? !mask[i] : !!mask[i];
      grid[i] = on ? 0 : INF;
    }
    var size = Math.max(w, h);
    var f = new Float64Array(size), d = new Float64Array(size);
    var v = new Int32Array(size), z = new Float64Array(size + 1);

    for (var x = 0; x < w; x++) {
      for (var y = 0; y < h; y++) f[y] = grid[y * w + x];
      edt1d(f, d, v, z, h);
      for (y = 0; y < h; y++) grid[y * w + x] = d[y];
    }
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) f[x] = grid[y * w + x];
      edt1d(f, d, v, z, w);
      for (x = 0; x < w; x++) grid[y * w + x] = d[x];
    }
    return grid;
  }

  /* Signed distance in pixels, positive inside the shape. */
  function sdf(mask, w, h) {
    var outside = edt2d(mask, w, h, false);
    var inside = edt2d(mask, w, h, true);
    var out = new Float32Array(w * h);
    for (var i = 0; i < w * h; i++) {
      out[i] = Math.sqrt(inside[i]) - Math.sqrt(outside[i]);
    }
    return out;
  }

  root.Grunge = {
    mulberry32: mulberry32, makeNoise: makeNoise, fbm: fbm,
    edt2d: edt2d, sdf: sdf
  };
})(typeof module !== 'undefined' ? module.exports : window);

/* ---------- mask to contours ---------- */
(function (root) {
  'use strict';

  var G = root.Grunge;

  /* Trace the boundary between filled and empty pixels as rectilinear rings.
   * Each filled pixel contributes its exposed sides, wound so the filled side
   * is always on the right. Outer rings then come out clockwise and holes
   * anticlockwise on their own, which is what a nonzero fill rule wants. */
  function traceRings(mask, w, h) {
    var VW = w + 1;
    var nV = VW * (h + 1);
    // up to two outgoing edges per vertex (diagonal touch points need the pair)
    var e0 = new Int32Array(nV).fill(-1);
    var e1 = new Int32Array(nV).fill(-1);

    function addEdge(ax, ay, bx, by) {
      var a = ay * VW + ax, b = by * VW + bx;
      if (e0[a] === -1) e0[a] = b; else e1[a] = b;
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        if (y === 0 || !mask[(y - 1) * w + x]) addEdge(x, y, x + 1, y);
        if (x === w - 1 || !mask[y * w + x + 1]) addEdge(x + 1, y, x + 1, y + 1);
        if (y === h - 1 || !mask[(y + 1) * w + x]) addEdge(x + 1, y + 1, x, y + 1);
        if (x === 0 || !mask[y * w + x - 1]) addEdge(x, y + 1, x, y);
      }
    }

    var rings = [];
    for (var v = 0; v < nV; v++) {
      while (e0[v] !== -1) {
        var ring = [];
        var cur = v, prev = -1;
        while (true) {
          var nxt = -1;
          if (e0[cur] !== -1 && e1[cur] !== -1 && prev !== -1) {
            // Junction: keep going straight or turn right, never cross over.
            nxt = pickTurn(prev, cur, e0[cur], e1[cur], VW);
          } else if (e0[cur] !== -1) {
            nxt = e0[cur];
          } else if (e1[cur] !== -1) {
            nxt = e1[cur];
          }
          if (nxt === -1) break;
          if (e0[cur] === nxt) { e0[cur] = e1[cur]; e1[cur] = -1; }
          else if (e1[cur] === nxt) { e1[cur] = -1; }
          ring.push({ x: cur % VW, y: (cur / VW) | 0 });
          prev = cur; cur = nxt;
          if (cur === v) break;
        }
        if (ring.length > 3) rings.push(ring);
      }
    }
    return rings;
  }

  function pickTurn(prev, cur, a, b, VW) {
    var pdx = (cur % VW) - (prev % VW), pdy = ((cur / VW) | 0) - ((prev / VW) | 0);
    var best = a, bestScore = -Infinity;
    [a, b].forEach(function (n) {
      var dx = (n % VW) - (cur % VW), dy = ((n / VW) | 0) - ((cur / VW) | 0);
      // cross < 0 is a right turn with y pointing down; dot ranks straight ahead
      var cross = pdx * dy - pdy * dx;
      var dot = pdx * dx + pdy * dy;
      var score = cross < 0 ? 2 : (cross === 0 && dot > 0 ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = n; }
    });
    return best;
  }

  function ringArea(r) {
    var a = 0;
    for (var i = 0, n = r.length; i < n; i++) {
      var p = r[i], q = r[(i + 1) % n];
      a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
  }

  function rdp(pts, eps) {
    if (pts.length < 4) return pts;
    var keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var s = stack.pop(), a = s[0], b = s[1];
      if (b - a < 2) continue;
      var ax = pts[a].x, ay = pts[a].y;
      var dx = pts[b].x - ax, dy = pts[b].y - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      var best = -1, bestD = eps;
      for (var i = a + 1; i < b; i++) {
        var d = len < 1e-9
          ? Math.hypot(pts[i].x - ax, pts[i].y - ay)
          : Math.abs((pts[i].x - ax) * dy - (pts[i].y - ay) * dx) / len;
        if (d > bestD) { bestD = d; best = i; }
      }
      if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
    }
    var out = [];
    for (i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  /* Chaikin corner cutting: softens the pixel staircase without the overshoot
   * a spline through every point would give. */
  function chaikin(pts, passes) {
    for (var p = 0; p < passes; p++) {
      var out = [];
      for (var i = 0, n = pts.length; i < n; i++) {
        var a = pts[i], b = pts[(i + 1) % n];
        out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
        out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
      }
      pts = out;
    }
    return pts;
  }

  function ringsToPath(rings, opts) {
    var scale = opts.scale || 1, ox = opts.ox || 0, oy = opts.oy || 0;
    var f = function (n) { return Math.round(n * 100) / 100; };
    var d = '';
    rings.forEach(function (r) {
      if (r.length < 3) return;
      d += 'M' + f(r[0].x * scale + ox) + ' ' + f(r[0].y * scale + oy);
      for (var i = 1; i < r.length; i++) {
        d += 'L' + f(r[i].x * scale + ox) + ' ' + f(r[i].y * scale + oy);
      }
      d += 'Z';
    });
    return d;
  }

  G.traceRings = traceRings;
  G.ringArea = ringArea;
  G.rdp = rdp;
  G.chaikin = chaikin;
  G.ringsToPath = ringsToPath;
})(typeof module !== 'undefined' ? module.exports : window);

/* ---------- the effect ---------- */
(function (root) {
  'use strict';

  var G = root.Grunge;

  var DEFAULTS = {
    grain: 3,          // px per noise cell: small = fine spatter, large = chunky
    octaves: 4,
    roughness: 2.4,    // px the outline is allowed to wander
    bias: 0,           // negative eats the shape away, positive fattens it
    blotch: 90,        // px per cell of the slow field that varies erosion
    blotchAmount: 0.85,// 0 = even erosion everywhere, 1 = very patchy
    spatter: 0.35,     // loose specks thrown off the edge
    spatterRange: 7,   // px they carry
    pit: 0.12,         // holes opened up inside the strokes
    pitDepth: 6,       // how far inside pitting reaches
    detail: 0.6,       // simplification tolerance in px
    smooth: 1,         // chaikin passes
    minArea: 1.5,      // drop specks smaller than this, in px^2
    seed: 1
  };

  function opts(o) {
    var r = {};
    for (var k in DEFAULTS) r[k] = (o && o[k] !== undefined) ? o[k] : DEFAULTS[k];
    return r;
  }

  /* mask: Uint8Array of w*h, non-zero where the artwork is.
   * Returns { rings, stats } in mask pixel coordinates. */
  function erode(mask, w, h, options) {
    var p = opts(options);
    var d = G.sdf(mask, w, h);

    var nGrain = G.makeNoise(p.seed);
    var nBlotch = G.makeNoise(p.seed + 977);
    var nSpat = G.makeNoise(p.seed + 5501);
    var nPit = G.makeNoise(p.seed + 1289);

    var gs = 1 / Math.max(0.4, p.grain);
    var bs = 1 / Math.max(4, p.blotch);
    var out = new Uint8Array(w * h);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var dist = d[i];

        // Anything far from the edge is settled; skip the noise work.
        var reach = p.roughness * (1 + p.blotchAmount) + p.spatterRange + 2;
        if (dist > reach && p.pit <= 0) { out[i] = 1; continue; }
        if (dist < -reach) { out[i] = 0; continue; }

        // Slow field decides which regions erode hard and which survive.
        var blot = G.fbm(nBlotch, x * bs, y * bs, 3, 0.55, 2);
        var amp = p.roughness * (1 - p.blotchAmount + 2 * p.blotchAmount * blot);

        var n = G.fbm(nGrain, x * gs, y * gs, p.octaves, 0.5, 2.03);
        var moved = dist + amp * (n * 2 - 1) + p.bias;
        var inside = moved > 0;

        // Specks thrown clear of the edge, thinning out with distance.
        if (!inside && p.spatter > 0 && dist > -p.spatterRange && dist < 1) {
          var falloff = 1 - Math.min(1, -Math.min(0, dist) / p.spatterRange);
          var s = G.fbm(nSpat, x * gs * 1.9 + 31.7, y * gs * 1.9 - 12.3, 2, 0.5, 2);
          if (s > 1 - p.spatter * falloff * falloff * 0.6) inside = true;
        }

        // Pits opened inside the strokes, following the same slow field.
        if (inside && p.pit > 0 && dist < p.pitDepth) {
          var pf = 1 - dist / p.pitDepth;
          var q = G.fbm(nPit, x * gs * 1.35 - 77.1, y * gs * 1.35 + 5.9, 3, 0.5, 2);
          if (q > 1 - p.pit * pf * blot) inside = false;
        }

        out[i] = inside ? 1 : 0;
      }
    }

    var rings = G.traceRings(out, w, h);
    var kept = [];
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      if (Math.abs(G.ringArea(ring)) < p.minArea) continue;
      var simp = p.detail > 0 ? G.rdp(ring, p.detail) : ring;
      if (simp.length < 3) continue;
      if (p.smooth > 0) simp = G.chaikin(simp, p.smooth);
      kept.push(simp);
    }
    return {
      rings: kept,
      mask: out,
      stats: { rings: rings.length, kept: kept.length,
               points: kept.reduce(function (a, r) { return a + r.length; }, 0) }
    };
  }

  G.DEFAULTS = DEFAULTS;
  G.erode = erode;
})(typeof module !== 'undefined' ? module.exports : window);

/* ---------- browser side: artwork in, paths out ---------- */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;
  var G = root.Grunge;

  function canvasOf(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  /* Paint SVG path data into a binary mask. `pxPerUnit` sets how finely the
   * grain can be resolved: the whole effect happens in mask pixels. */
  function maskFromPaths(paths, bbox, pxPerUnit, pad) {
    var w = Math.max(8, Math.ceil(bbox.width * pxPerUnit) + pad * 2);
    var h = Math.max(8, Math.ceil(bbox.height * pxPerUnit) + pad * 2);
    var ctx = canvasOf(w, h).getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(pad - bbox.x * pxPerUnit, pad - bbox.y * pxPerUnit);
    ctx.scale(pxPerUnit, pxPerUnit);
    ctx.fillStyle = '#000';
    paths.forEach(function (d) { ctx.fill(new Path2D(d)); });
    ctx.restore();
    var img = ctx.getImageData(0, 0, w, h).data;
    var mask = new Uint8Array(w * h);
    for (var i = 0, p = 0; i < mask.length; i++, p += 4) mask[i] = img[p] < 128 ? 1 : 0;
    return { mask: mask, w: w, h: h, pxPerUnit: pxPerUnit, pad: pad, bbox: bbox };
  }

  /* Threshold a bitmap into one mask per tone. Level 0 is the darkest ink. */
  function masksFromImage(img, maxPx, levels, threshold, invert) {
    var scale = Math.min(1, maxPx / Math.max(img.width, img.height));
    var w = Math.max(8, Math.round(img.width * scale));
    var h = Math.max(8, Math.round(img.height * scale));
    var ctx = canvasOf(w, h).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    var data = ctx.getImageData(0, 0, w, h).data;

    var lum = new Float32Array(w * h);
    for (var i = 0, p = 0; i < lum.length; i++, p += 4) {
      var a = data[p + 3] / 255;
      var l = (0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]) / 255;
      // Transparent pixels read as paper, not as ink.
      l = l * a + (1 - a);
      lum[i] = invert ? 1 - l : l;
    }

    var out = [];
    for (var k = 0; k < levels; k++) {
      // Darkest band first; each later band covers progressively lighter tones.
      var cut = threshold * (k + 1) / levels;
      var m = new Uint8Array(w * h);
      for (i = 0; i < m.length; i++) m[i] = lum[i] <= cut ? 1 : 0;
      out.push(m);
    }
    return { masks: out, w: w, h: h };
  }

  /* One call: artwork plus settings in, SVG path data out (artwork units). */
  function fromPaths(paths, bbox, options) {
    var o = options || {};
    var px = o.pxPerUnit || 2;
    var pad = Math.ceil((o.roughness || G.DEFAULTS.roughness) +
                        (o.spatterRange || G.DEFAULTS.spatterRange) + 6);
    var R = maskFromPaths(paths, bbox, px, pad);
    var res = G.erode(R.mask, R.w, R.h, o);
    var d = G.ringsToPath(res.rings, {
      scale: 1 / px,
      ox: bbox.x - pad / px,
      oy: bbox.y - pad / px
    });
    return { d: d, stats: res.stats, mask: R };
  }

  G.maskFromPaths = maskFromPaths;
  G.masksFromImage = masksFromImage;
  G.fromPaths = fromPaths;
})(typeof module !== 'undefined' ? module.exports : window);
