/* Geometry interchange, and the two performance traps that cost seconds.
 * Run: node test/geom.test.js
 */
var Geom = require('../src/engine/geom.js').Geom;

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}

function rings(n, pts) {
  var points = new Float32Array(n * pts * 2);
  var offsets = new Int32Array(n + 1);
  var k = 0;
  for (var r = 0; r < n; r++) {
    offsets[r] = k;
    var cx = (r % 100) * 10, cy = Math.floor(r / 100) * 10;
    for (var i = 0; i < pts; i++) {
      var a = i / pts * Math.PI * 2;
      points[k * 2] = cx + Math.cos(a) * 4;
      points[k * 2 + 1] = cy + Math.sin(a) * 4;
      k++;
    }
  }
  offsets[n] = k;
  return { points: points, offsets: offsets };
}

console.log('\npath data');
(function () {
  var g = rings(3, 5);
  var d = Geom.toPathData(g.points, g.offsets, 2);
  ok('one M per ring', (d.match(/M/g) || []).length === 3);
  ok('one Z per ring', (d.match(/Z/g) || []).length === 3);
  ok('four L per five-point ring', (d.match(/L/g) || []).length === 3 * 4);
  ok('no NaN', d.indexOf('NaN') === -1);

  var tiny = { points: new Float32Array([0, 0, 1, 1]), offsets: new Int32Array([0, 2]) };
  ok('a ring with under three points is dropped',
    Geom.toPathData(tiny.points, tiny.offsets) === '');
})();

console.log('\nbounds');
(function () {
  var pts = new Float32Array([0, 0, 10, 4, -2, 9]);
  var b = Geom.bounds(pts);
  ok('bounds span the points', b.x === -2 && b.y === 0 && b.width === 12 && b.height === 9,
    JSON.stringify(b));
  ok('empty points give an empty box', Geom.bounds(new Float32Array(0)).width === 0);

  var u = Geom.unionBounds([
    { points: new Float32Array([0, 0, 5, 5]), offsets: new Int32Array([0, 2]) },
    { points: new Float32Array([10, 10, 20, 30]), offsets: new Int32Array([0, 2]) }
  ]);
  ok('union covers both items', u.width === 20 && u.height === 30, JSON.stringify(u));
})();

console.log('\nchunking');
(function () {
  // Piling every contour into one Path2D is quadratic in Chrome: thirty
  // thousand rings took nine and a half seconds as one path and under a tenth
  // of that in chunks. There is no Path2D here, but the split is the thing that
  // has to survive, so assert the ring count comes out in pieces.
  var g = rings(1200, 6);
  var d = Geom.toPathData(g.points, g.offsets);
  ok('every ring survives the split', (d.match(/M/g) || []).length === 1200);

  var round = Geom.toPathData(g.points, g.offsets, 0);
  var fine = Geom.toPathData(g.points, g.offsets, 3);
  ok('precision shortens the output', round.length < fine.length,
    round.length + ' vs ' + fine.length);
})();

console.log('\nitem accessors');
(function () {
  var g = rings(2, 4);
  ok('an item with points reports its own bounds',
    Geom.itemBounds({ points: g.points, offsets: g.offsets }).width > 0);
  ok('an item with points yields path data',
    Geom.itemPathData({ points: g.points, offsets: g.offsets }).indexOf('M') === 0);
  ok('an item with d keeps it', Geom.itemPathData({ d: 'M0 0H5Z' }) === 'M0 0H5Z');
  ok('transferables lists both buffers',
    Geom.transferables([{ points: g.points, offsets: g.offsets }]).length === 2);
  ok('transferables skips string items', Geom.transferables([{ d: 'M0 0' }]).length === 0);
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
