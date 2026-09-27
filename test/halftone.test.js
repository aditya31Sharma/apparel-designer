/* Numeric checks on the halftone engine. No DOM, no browser.
 * Run: node test/halftone.test.js
 *
 * The one that matters is the ink-area test. If the radius were proportional to
 * coverage instead of its square root, a 50% grey would print at 25% and every
 * midtone would come out wrong, so the test asserts total dot area against
 * source coverage across the whole tone range.
 */
var H = require('../src/engine/halftone.js').Halftone;

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

function flat(w, h, r, g, b, a) {
  var px = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    px[i * 4] = r; px[i * 4 + 1] = g; px[i * 4 + 2] = b;
    px[i * 4 + 3] = a === undefined ? 255 : a;
  }
  return px;
}

console.log('\nseparation');
(function () {
  var s = H.separate(flat(2, 2, 255, 255, 255), 2, 2, { gcr: 1 });
  ok('white takes no ink', s.c[0] === 0 && s.m[0] === 0 && s.y[0] === 0 && s.k[0] === 0);

  s = H.separate(flat(2, 2, 0, 0, 0), 2, 2, { gcr: 1 });
  ok('black is all K at gcr 1', s.k[0] === 1 && s.c[0] === 0 && s.m[0] === 0 && s.y[0] === 0);

  s = H.separate(flat(2, 2, 0, 0, 0), 2, 2, { gcr: 0 });
  ok('black is all CMY at gcr 0',
    s.k[0] === 0 && near(s.c[0], 1, 1e-6) && near(s.m[0], 1, 1e-6) && near(s.y[0], 1, 1e-6));

  s = H.separate(flat(2, 2, 255, 0, 0), 2, 2, { gcr: 1 });
  ok('pure red is M+Y, no C, no K',
    near(s.c[0], 0, 1e-6) && near(s.m[0], 1, 1e-6) && near(s.y[0], 1, 1e-6) && s.k[0] === 0,
    'c=' + s.c[0] + ' m=' + s.m[0] + ' y=' + s.y[0] + ' k=' + s.k[0]);

  s = H.separate(flat(2, 2, 0, 255, 255), 2, 2, { gcr: 1 });
  ok('cyan is C only', near(s.c[0], 1, 1e-6) && near(s.m[0], 0, 1e-6) && near(s.y[0], 0, 1e-6));

  s = H.separate(flat(2, 2, 128, 128, 128), 2, 2, { gcr: 1 });
  ok('mid grey is K only, no colour cast',
    near(s.k[0], 1 - 128 / 255, 1e-6) && s.c[0] === 0 && s.m[0] === 0 && s.y[0] === 0);

  s = H.separate(flat(2, 2, 0, 0, 0, 0), 2, 2, { gcr: 1 });
  ok('fully transparent reads as paper', s.k[0] === 0 && s.c[0] === 0);
})();

console.log('\nsummed-area table');
(function () {
  var w = 40, h = 30;
  var ch = new Float32Array(w * h);
  // 0.375 is exact in float32; 0.35 is not, and the rounding would swamp the tolerance.
  for (var i = 0; i < ch.length; i++) ch[i] = 0.375;
  var sat = H.buildSat(ch, w, h);
  ok('uniform field averages to itself', near(H.boxMean(sat, w, h, 5, 5, 25, 20), 0.375, 1e-12));
  ok('box clamped past the right edge still averages correctly',
    near(H.boxMean(sat, w, h, 30, 10, 60, 20), 0.375, 1e-12));
  ok('a box entirely outside returns zero', H.boxMean(sat, w, h, 80, 80, 90, 90) === 0);

  // half the field at 1, half at 0, sampled across the seam
  var g = new Float32Array(w * h);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) g[y * w + x] = x < w / 2 ? 1 : 0;
  var sat2 = H.buildSat(g, w, h);
  ok('half-and-half field averages to 0.5 across the seam',
    near(H.boxMean(sat2, w, h, 0, 0, w, h), 0.5, 1e-9));
})();

console.log('\nink area matches the tone asked for');
(function () {
  /* Rasterise the dots back down and count the pixels they actually cover.
   * Summing pi*r*r would double-count wherever neighbouring dots overlap, which
   * is exactly the regime this has to get right, so measure the union instead. */
  function inkFraction(dots, kind, w, h, pad) {
    var x0 = pad, y0 = pad, x1 = w - pad, y1 = h - pad;
    var gw = x1 - x0, gh = y1 - y0;
    var grid = new Uint8Array(gw * gh);
    for (var o = 0; o < dots.length; o += H.STRIDE) {
      var cx = dots[o], cy = dots[o + 1], r = dots[o + 2], ph = dots[o + 3];
      var reach = Math.ceil(r * 2.6) + 2;
      var ax = Math.max(x0, Math.floor(cx - reach)), bx = Math.min(x1, Math.ceil(cx + reach));
      var ay = Math.max(y0, Math.floor(cy - reach)), by = Math.min(y1, Math.ceil(cy + reach));
      var cos = Math.cos(-ph), sin = Math.sin(-ph);
      for (var y = ay; y < by; y++) {
        for (var x = ax; x < bx; x++) {
          var dx = x + 0.5 - cx, dy = y + 0.5 - cy;
          var lx = dx * cos - dy * sin, ly = dx * sin + dy * cos;
          if (H.insideDot(kind, lx, ly, r)) grid[(y - y0) * gw + (x - x0)] = 1;
        }
      }
    }
    var n = 0;
    for (var i = 0; i < grid.length; i++) n += grid[i];
    return n / grid.length;
  }

  var w = 600, h = 600;
  [0.2, 0.4, 0.6, 0.8].forEach(function (target) {
    var v = Math.round((1 - target) * 255);
    var res = H.screen(flat(w, h, v, v, v), w, h, {
      frequency: 60, inkDensity: 1, minDot: 0, gcr: 1, pattern: 'round',
      channels: { c: 0, m: 0, y: 0, k: 1 }
    });
    // Ignore a border so dots whose cells hang off the edge do not skew it.
    var frac = inkFraction(res.channels[0].dots, 'round', w, h, 30);
    ok('tone ' + target + ' prints as ' + (frac * 100).toFixed(1) + '% ink',
      near(frac, target, 0.035), 'wanted ' + target);
  });

  // Every shape has its own overlap curve, so every shape has to hold tone too.
  ['square', 'diamond', 'ellipse', 'cross'].forEach(function (kind) {
    var res = H.screen(flat(w, h, 128, 128, 128), w, h, {
      frequency: 60, inkDensity: 1, minDot: 0, pattern: kind,
      channels: { c: 0, m: 0, y: 0, k: 1 }
    });
    var frac = inkFraction(res.channels[0].dots, kind, w, h, 30);
    ok(kind + ' holds mid tone at ' + (frac * 100).toFixed(1) + '%',
      near(frac, 1 - 128 / 255, 0.05));
  });
})();

console.log('\nscreen geometry');
(function () {
  var w = 400, h = 400;
  var mid = flat(w, h, 128, 128, 128);

  var lo = H.screen(mid, w, h, { frequency: 40, channels: { c: 0, m: 0, y: 0, k: 1 } });
  var hi = H.screen(mid, w, h, { frequency: 80, channels: { c: 0, m: 0, y: 0, k: 1 } });
  var nLo = lo.channels[0].dots.length / H.STRIDE;
  var nHi = hi.channels[0].dots.length / H.STRIDE;
  ok('doubling frequency roughly quadruples the dot count (' + nLo + ' -> ' + nHi + ')',
    nHi / nLo > 3.4 && nHi / nLo < 4.6);

  ok('spacing is reported as width over frequency', near(lo.stats.spacing, 10, 1e-9));

  var all = H.screen(mid, w, h, { frequency: 40 });
  ok('four channels requested, four returned', all.channels.length === 4);
  ok('grey puts ink only on the black plate at gcr 1',
    all.channels[0].dots.length === 0 && all.channels[3].dots.length > 0);

  // Screen angle: at 45 degrees every dot centre should sit on a lattice
  // rotated 45 degrees, so u and v both land on half-integer multiples.
  var rot = H.screen(flat(w, h, 100, 100, 100), w, h, {
    frequency: 40, angles: { k: 45 }, channels: { c: 0, m: 0, y: 0, k: 1 }
  });
  var d = rot.channels[0].dots, spacing = w / 40;
  var cos = Math.cos(Math.PI / 4), sin = Math.sin(Math.PI / 4);
  var offGrid = 0;
  for (var o = 0; o < d.length; o += H.STRIDE) {
    var u = (d[o] * cos + d[o + 1] * sin) / spacing - 0.5;
    var v = (-d[o] * sin + d[o + 1] * cos) / spacing - 0.5;
    if (Math.abs(u - Math.round(u)) > 1e-3 || Math.abs(v - Math.round(v)) > 1e-3) offGrid++;
  }
  ok('every dot at 45 degrees sits on the rotated lattice', offGrid === 0,
    offGrid + ' strays');

  // Two channels at different angles must not sit on top of each other,
  // which is the whole point of the rosette.
  var two = H.screen(flat(w, h, 100, 160, 200), w, h, {
    frequency: 40, angles: { c: 15, m: 75, y: 0, k: 45 }
  });
  var c0 = two.channels[0].dots, k0 = two.channels[3].dots;
  var coincident = 0;
  for (var a = 0; a < Math.min(c0.length, 400); a += H.STRIDE) {
    for (var b = 0; b < Math.min(k0.length, 400); b += H.STRIDE) {
      if (Math.abs(c0[a] - k0[b]) < 0.05 && Math.abs(c0[a + 1] - k0[b + 1]) < 0.05) coincident++;
    }
  }
  ok('cyan and black screens do not land on the same centres', coincident < 3,
    coincident + ' coincident');
})();

console.log('\nmodulators respond');
(function () {
  var w = 300, h = 300, mid = flat(w, h, 128, 128, 128);
  var base = { frequency: 40, channels: { c: 0, m: 0, y: 0, k: 1 }, minDot: 0 };
  function inkOf(extra) {
    var o = Object.assign({}, base, extra);
    var d = H.screen(mid, w, h, o).channels[0].dots, a = 0;
    for (var i = 0; i < d.length; i += H.STRIDE) a += Math.PI * d[i + 2] * d[i + 2];
    return a / (w * h);
  }
  var plain = inkOf({});
  ok('ink density scales coverage down', inkOf({ inkDensity: 0.5 }) < plain * 0.75);
  ok('paper fibre starves ink', inkOf({ paperFibre: 0.9 }) < plain);
  ok('ink texture starves ink', inkOf({ inkTexture: 0.9 }) < plain);
  ok('positive dot gain fattens midtones', inkOf({ dotGain: 0.8 }) > plain);
  ok('negative dot gain thins midtones', inkOf({ dotGain: -0.8 }) < plain);
  ok('minDot drops the smallest dots',
    H.screen(flat(w, h, 245, 245, 245), w, h,
      Object.assign({}, base, { minDot: 0.5 })).channels[0].dots.length <
    H.screen(flat(w, h, 245, 245, 245), w, h,
      Object.assign({}, base, { minDot: 0 })).channels[0].dots.length);
})();

console.log('\none and two colour modes');
(function () {
  var w = 300, h = 300;
  function flat2(r, g, b) { return flat(w, h, r, g, b); }
  function inkOf(res) {
    var a = 0;
    res.channels.forEach(function (ch) {
      for (var o = 0; o < ch.dots.length; o += H.STRIDE) {
        a += Math.PI * ch.dots[o + 2] * ch.dots[o + 2];
      }
    });
    return a / (w * h);
  }
  var base = { frequency: 30, minDot: 0, inkDensity: 1 };

  /* The bug this guards: black generation is 1 - max(r,g,b), so a saturated
   * colour has no black in it and a mono screen printed a red logo as blank
   * paper. One and two colour modes work from perceptual tone instead. */
  var redMono = inkOf(H.screen(flat2(255, 0, 0), w, h, Object.assign({ mode: 'mono' }, base)));
  ok('mono prints a saturated red as ink, not as blank paper', redMono > 0.5, redMono.toFixed(2));

  var yellowMono = inkOf(H.screen(flat2(255, 255, 0), w, h, Object.assign({ mode: 'mono' }, base)));
  ok('mono prints yellow light, because yellow is light', yellowMono < 0.2, yellowMono.toFixed(2));
  ok('mono ranks red darker than yellow, as the eye does', redMono > yellowMono);

  var blackMono = inkOf(H.screen(flat2(0, 0, 0), w, h, Object.assign({ mode: 'mono' }, base)));
  var whiteMono = inkOf(H.screen(flat2(255, 255, 255), w, h, Object.assign({ mode: 'mono' }, base)));
  ok('mono covers black', blackMono > 0.9, blackMono.toFixed(2));
  ok('mono leaves white alone', whiteMono < 0.02, whiteMono.toFixed(2));

  var duo = H.screen(flat2(120, 120, 120), w, h, Object.assign({ mode: 'duotone' }, base));
  ok('duotone gives exactly two plates', duo.channels.length === 2,
    duo.channels.map(function (c) { return c.label; }).join('+'));
  ok('duotone names them colour and black',
    duo.channels[0].label === 'Colour' && duo.channels[1].label === 'Black');

  // The colour has to carry the midtones, or a duotone is just mono with a tint.
  function plateArea(res, i) {
    var d = res.channels[i].dots, a = 0;
    for (var o = 0; o < d.length; o += H.STRIDE) a += Math.PI * d[o + 2] * d[o + 2];
    return a / (w * h);
  }
  var mid = H.screen(flat2(150, 150, 150), w, h, Object.assign({ mode: 'duotone' }, base));
  ok('the colour carries the midtones', plateArea(mid, 0) > 0.2, plateArea(mid, 0).toFixed(2));
  ok('the dark ink stays out of the midtones', plateArea(mid, 1) < plateArea(mid, 0),
    plateArea(mid, 1).toFixed(2) + ' vs ' + plateArea(mid, 0).toFixed(2));

  var shadow = H.screen(flat2(30, 30, 30), w, h, Object.assign({ mode: 'duotone' }, base));
  ok('the dark ink arrives in the shadows', plateArea(shadow, 1) > plateArea(mid, 1));

  // 100 grey sits above the default split, so there is dark ink to hold back.
  var early = H.screen(flat2(100, 100, 100), w, h,
    Object.assign({ mode: 'duotone', duotoneSplit: 0.35 }, base));
  var late = H.screen(flat2(100, 100, 100), w, h,
    Object.assign({ mode: 'duotone', duotoneSplit: 0.8 }, base));
  ok('raising the split holds the dark ink back further',
    plateArea(late, 1) < plateArea(early, 1) && plateArea(early, 1) > 0.05,
    plateArea(late, 1).toFixed(3) + ' vs ' + plateArea(early, 1).toFixed(3));

  var cmyk = H.screen(flat2(255, 0, 0), w, h, Object.assign({ mode: 'cmyk' }, base));
  ok('cmyk still separates a red into magenta and yellow',
    cmyk.channels.length === 4 && plateArea(cmyk, 1) > 0.8 && plateArea(cmyk, 2) > 0.8);
})();

console.log('\npath output');
(function () {
  var w = 200, h = 200;
  var res = H.screen(flat(w, h, 128, 128, 128), w, h,
    { frequency: 20, channels: { c: 0, m: 0, y: 0, k: 1 } });
  ['round', 'square', 'ellipse', 'line', 'cross', 'diamond'].forEach(function (kind) {
    var d = H.channelPath(res.channels[0], { pattern: kind, frequency: 20 });
    ok(kind + ' emits path data', d.length > 50 && /^M/.test(d) && /Z$/.test(d));
    ok(kind + ' has no NaN', d.indexOf('NaN') === -1);
  });
  var fz = H.channelPath(res.channels[0], { pattern: 'round', fuzziness: 0.6, frequency: 20 });
  ok('fuzzy dots emit polygons, not arcs', fz.indexOf('L') > -1 && fz.indexOf('NaN') === -1);

  // Determinism: the viewport and the exporter must draw the same dot.
  var a = H.channelPath(res.channels[0], { pattern: 'round', fuzziness: 0.6, seed: 4 });
  var b = H.channelPath(res.channels[0], { pattern: 'round', fuzziness: 0.6, seed: 4 });
  ok('fuzzy output is deterministic for a given seed', a === b);
})();

console.log('\ncost');
(function () {
  var w = 1200, h = 1200;
  var px = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    px[i * 4] = (i % 256); px[i * 4 + 1] = ((i / 7) | 0) % 256;
    px[i * 4 + 2] = ((i / 13) | 0) % 256; px[i * 4 + 3] = 255;
  }
  [60, 120, 240].forEach(function (f) {
    var t = Date.now();
    var r = H.screen(px, w, h, { frequency: f });
    var ms = Date.now() - t;
    console.log('  freq ' + String(f).padStart(3) + ': ' +
      String(r.stats.dots).padStart(7) + ' dots in ' + String(ms).padStart(4) + 'ms');
    ok('frequency ' + f + ' screens a 1200px image under 1.5s', ms < 1500);
  });
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
