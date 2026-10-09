var assert = require('assert'), fs = require('fs'), vm = require('vm'), path = require('path');
var H = require('../src/engine/selective-halftone.js').SelectiveHalftone;
var passed = 0;
function check(name, run) { run(); passed++; console.log('  ok  ' + name); }
var box = { x: 10, y: 20, width: 300, height: 400 };
check('all four edge presets are exactly 50 artwork pixels', function () {
  ['top', 'bottom', 'left', 'right'].forEach(function (side) {
    var f = H.edge(box, side, 50);
    assert.strictEqual(H.length(f), 50);
    assert.ok(H.projection({ x: 160, y: 220 }, f) < 0);
    assert.strictEqual(H.projection(f.end, f), 1);
  });
});
check('a small image keeps both endpoints within its bounds', function () {
  assert.strictEqual(H.length(H.edge({ x: 0, y: 0, width: 20, height: 10 }, 'bottom', 50)), 10);
});
check('dot area follows requested coverage including the solid join', function () {
  [0, 0.1, 0.25, 0.5, 0.8, 0.95, 1].forEach(function (coverage) {
    var r = H.radius(coverage), hit = 0, n = 300;
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      var dx = (x + 0.5) / n - 0.5, dy = (y + 0.5) / n - 0.5;
      if (dx * dx + dy * dy <= r * r) hit++;
    }
    assert.ok(Math.abs(hit / (n * n) - coverage) < 0.003, 'area ' + coverage);
  });
});
check('disabled and collapsed fades leave the design untouched', function () {
  var f = H.edge(box, 'bottom', 50); f.on = false;
  assert.strictEqual(H.build(box, { fades: [f] }).clips.length, 0);
  f.on = true; f.end = f.start;
  assert.strictEqual(H.build(box, { fades: [f] }).clips.length, 0);
});
check('two fades remain independent and deterministic', function () {
  var bottom = H.edge(box, 'bottom', 50), top = H.edge(box, 'top', 50);
  var a = H.build(box, { fades: [bottom], pitch: 8, angle: 45 });
  var b = H.build(box, { fades: [bottom, top], pitch: 8, angle: 45 });
  assert.deepStrictEqual(b.clips.slice(0, 2), a.clips);
  assert.strictEqual(b.fades, 2); assert.strictEqual(b.clips.length, 4);
  assert.ok(a.dots > 0); assert.ok(!b.clips.some(function (c) { return /NaN|Infinity/.test(c.d); }));
  assert.deepStrictEqual(H.build(box, { fades: [bottom, bottom] }).clips.slice(0, 2), H.build(box, { fades: [bottom, bottom] }).clips.slice(2));
});
var curved = Object.assign({ mode: 'curved', bend: -0.7, curveSpan: 100 }, H.edge(box, 'top', 50));
function near(a, b) { assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b); }
check('curved endpoints retain full and zero print, bend handle stays at half print', function () {
  near(H.projection(curved.start, curved), 0); near(H.projection(curved.end, curved), 1);
  near(H.projection(H.bendPoint(curved), curved), 0.5);
  near(H.bendAt(H.bendPoint(curved), curved), curved.bend);
  near(H.projection({ x: 200, y: 45 }, curved), H.projection({ x: 120, y: 45 }, curved));
  assert.ok(H.projection({ x: 260, y: 45 }, curved) > H.projection({ x: 160, y: 45 }, curved));
});
check('zero bend and Linear mode reproduce the original linear masks', function () {
  var linear = H.edge(box, 'top', 50), zero = Object.assign({}, curved, { bend: 0 });
  var disabledCurve = Object.assign({}, curved, { mode: 'linear' });
  assert.deepStrictEqual(H.build(box, { fades: [zero] }), H.build(box, { fades: [linear] }));
  assert.deepStrictEqual(H.build(box, { fades: [disabledCurve] }), H.build(box, { fades: [linear] }));
});
check('quadratic clipping boundaries exactly match the curved coverage field', function () {
  [0, 0.5, 1].forEach(function (limit) {
    var c = H.contour(box, curved, limit);
    [0, 0.1, 0.25, 0.5, 0.8, 1].forEach(function (t) {
      var p = { x: (1 - t) ** 2 * c.start.x + 2 * t * (1 - t) * c.control.x + t * t * c.end.x,
        y: (1 - t) ** 2 * c.start.y + 2 * t * (1 - t) * c.control.y + t * t * c.end.y };
      near(H.projection(p, curved), limit);
    });
  });
});
check('curved coverage follows translated and rotated artwork coordinates', function () {
  var angle = 0.83, c = Math.cos(angle), s = Math.sin(angle);
  function move(p) { return { x: c * p.x - s * p.y + 173, y: s * p.x + c * p.y - 97 }; }
  var transformed = Object.assign({}, curved, { start: move(curved.start), end: move(curved.end) });
  [{ x: 175, y: 37 }, { x: -45, y: 25 }, { x: 255, y: 84 }].forEach(function (p) {
    near(H.projection(p, curved), H.projection(move(p), transformed));
  });
  var expected = move(H.bendPoint(curved)), actual = H.bendPoint(transformed);
  near(expected.x, actual.x); near(expected.y, actual.y);
});
check('reversing a curved fade complements coverage without moving its contour', function () {
  var reverse = Object.assign({}, curved, { start: curved.end, end: curved.start, bend: -curved.bend, curveSpan: -curved.curveSpan });
  [{ x: 90, y: 24 }, { x: 245, y: 55 }, { x: 175, y: 71 }].forEach(function (p) {
    near(H.projection(p, curved) + H.projection(p, reverse), 1);
  });
  assert.deepStrictEqual(H.bendPoint(reverse), H.bendPoint(curved));
});
check('multiple curved and linear fades remain independent with finite export paths', function () {
  var a = H.build(box, { fades: [curved] }), b = H.build(box, { fades: [curved, H.edge(box, 'bottom', 50)] });
  assert.deepStrictEqual(b.clips.slice(0, 2), a.clips);
  assert.ok(a.clips[0].d.includes('Q')); assert.ok(a.clips[1].d.includes('Q'));
  assert.ok(a.dots > 0); assert.strictEqual(b.fades, 2);
  [-4, 4].forEach(function (bend) {
    var out = H.build(box, { fades: [Object.assign({}, curved, { bend: bend, curveSpan: 1 })] });
    assert.ok(!out.clips.some(function (clip) { return /NaN|Infinity/.test(clip.d); }));
  });
});
var sandbox = {}; sandbox.self = sandbox;
vm.createContext(sandbox);
['src/doc/effects.js', 'src/engine/selective-halftone.js', 'src/doc/register-selective.js', 'src/export/svg.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox);
});
var input = { items: [{ frame: true }], pixels: { data: new Uint8ClampedArray([13, 97, 211, 192]), w: 1, h: 1 }, bbox: box };
var params = { fades: [H.edge(box, 'bottom', 50)], pitch: 8, angle: 45 };
var out = sandbox.Effects.get('selective').run(input, params);
check('the final effect preserves original pixels and vector data', function () {
  assert.strictEqual(out.items, input.items); assert.strictEqual(out.pixels, input.pixels);
  assert.strictEqual(out.bbox, input.bbox); assert.strictEqual(input.clips, undefined);
  assert.strictEqual(out.clips.length, 2);
});
check('SVG carries all masks with distinct ids in artwork coordinates', function () {
  var layer = { matrix: { a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 }, bbox: box,
    image: 'data:image/png;base64,example', shapes: [], clips: out.clips };
  var svg = sandbox.SvgOut.build([layer, layer]);
  assert.strictEqual((svg.match(/<clipPath /g) || []).length, 4);
  assert.ok(svg.includes('id="selective-mask-3"'));
  assert.ok(svg.includes('clipPathUnits="userSpaceOnUse"'));
  assert.ok(svg.includes('transform="matrix(1 0 0 1 30 40)"'));
  assert.ok(!svg.includes('<rect'));
});
console.log('\nselective-halftone: ' + passed + ' passed, 0 failed');
