/* Resampling. Run: node test/raster.test.js
 *
 * These exist because walking the source and scattering into the destination
 * looked right on every photo tried and was silently wrong above 1:1, where
 * destination pixels that caught no source pixel stayed black.
 */
global.self = global;
global.OffscreenCanvas = undefined;
require('../src/engine/raster.js');
var R = global.Raster;

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

function solid(w, h, r, g, b, a) {
  var d = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = a === undefined ? 255 : a;
  }
  return { data: d, w: w, h: h };
}

function every(out, fn) {
  for (var i = 0; i < out.length; i += 4) if (!fn(out[i], out[i + 1], out[i + 2], out[i + 3])) return false;
  return true;
}

console.log('\nresample');
(function () {
  ok('Raster loads without a canvas', !!R && typeof R.resample === 'function');

  var down = R.resample(solid(100, 100, 12, 34, 56), 25, 25);
  ok('downscale keeps the colour', every(down, function (r, g, b) {
    return Math.abs(r - 12) < 2 && Math.abs(g - 34) < 2 && Math.abs(b - 56) < 2;
  }));

  // The case that was broken: a working bitmap bigger than the photo.
  var up = R.resample(solid(50, 50, 200, 100, 40), 175, 175);
  ok('upscale leaves no black gaps', every(up, function (r, g, b) {
    return Math.abs(r - 200) < 2 && Math.abs(g - 100) < 2 && Math.abs(b - 40) < 2;
  }), 'first px ' + [up[0], up[1], up[2]].join(','));
  ok('upscale is fully opaque', every(up, function (r, g, b, a) { return a === 255; }));

  var same = R.resample(solid(64, 64, 9, 9, 9), 64, 64);
  ok('one to one is exact', every(same, function (r) { return r === 9; }));

  var clear = R.resample(solid(80, 80, 255, 0, 0, 0), 40, 40);
  ok('fully transparent reads as paper, not as its colour',
    every(clear, function (r, g, b) { return r === 255 && g === 255 && b === 255; }),
    'got ' + [clear[0], clear[1], clear[2]].join(','));

  var halfA = R.resample(solid(80, 80, 0, 0, 0, 128), 40, 40);
  ok('half transparent black lands mid grey',
    Math.abs(halfA[0] - 128) < 3, halfA[0]);

  // A checkerboard must average, not alias to one colour.
  var w = 64, h = 64, d = new Uint8ClampedArray(w * h * 4);
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var v = ((x + y) % 2) ? 255 : 0;
      var i = (y * w + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
  }
  var avg = R.resample({ data: d, w: w, h: h }, 8, 8);
  ok('a checkerboard averages to mid grey rather than aliasing',
    every(avg, function (r) { return Math.abs(r - 128) < 12; }), 'first ' + avg[0]);

  var tiny = R.resample(solid(3, 3, 77, 77, 77), 1, 1);
  ok('collapsing to a single pixel works', Math.abs(tiny[0] - 77) < 2, tiny[0]);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
