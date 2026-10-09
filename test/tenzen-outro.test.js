var assert = require('assert');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var T = require('../src/engine/tenzen-outro.js').TenzenOutro;
var passed = 0;
function check(name, run) { run(); passed++; console.log('  ok  ' + name); }
function photo(w, h) {
  var data = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    data[i * 4] = i * 17 % 256;
    data[i * 4 + 1] = i * 31 % 256;
    data[i * 4 + 2] = i * 47 % 256;
    data[i * 4 + 3] = i % 256;
  }
  return { data: data, w: w, h: h };
}

check('source pixels and alpha survive the effect', function () {
  var src = photo(37, 23), before = src.data.slice();
  var out = T.process(src);
  assert.deepStrictEqual(src.data, before);
  assert.strictEqual(out.w, src.w); assert.strictEqual(out.h, src.h);
  for (var i = 0; i < out.data.length; i += 4) {
    assert.strictEqual(out.data[i], out.data[i + 1]);
    assert.strictEqual(out.data[i], out.data[i + 2]);
    assert.strictEqual(out.data[i + 3], before[i + 3]);
    assert.ok(out.data[i] <= 153);
  }
});
check('black and white retain the native outro endpoints', function () {
  var px = { w: 2, h: 1, data: new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]) };
  assert.deepStrictEqual(Array.from(T.process(px, { outroGrain: 0 }).data),
    [0, 0, 0, 255, 153, 153, 153, 255]);
  assert.strictEqual(T.process(px, { outroGrain: 0, outroDarken: 0 }).data[4], 255);
  assert.strictEqual(T.process(px, { outroGrain: 0 }, null, true).data[0], 153);
});
check('matte coverage multiplies existing transparency', function () {
  var px = photo(4, 1); px.data.fill(200);
  var out = T.process(px, {}, { w: 2, h: 1, mask: new Uint8Array([0, 128]) });
  assert.deepStrictEqual(Array.from(out.data.slice(0, 8)), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.strictEqual(out.data[11], 100); assert.strictEqual(out.data[15], 100);
});
check('grain is repeatable and seed changes affect only tone', function () {
  var src = photo(65, 47), a = T.process(src), b = T.process(src), c = T.process(src, { seed: 32 });
  assert.deepStrictEqual(a.data, b.data); assert.notDeepStrictEqual(a.data, c.data);
  for (var i = 3; i < a.data.length; i += 4) assert.strictEqual(a.data[i], c.data[i]);
  assert.deepStrictEqual(T.process(src, { outroGrain: 0, seed: 1 }).data,
    T.process(src, { outroGrain: 0, seed: 2 }).data);
});
check('small and odd images keep every edge pixel', function () {
  [[1, 1], [1, 13], [17, 1], [3, 5]].forEach(function (size) {
    var src = photo(size[0], size[1]);
    var out = T.process(src);
    assert.strictEqual(out.data.length, size[0] * size[1] * 4);
    assert.strictEqual(out.data[out.data.length - 1], src.data[src.data.length - 1]);
  });
});

var sandbox = { console: console }; sandbox.self = sandbox; sandbox.window = sandbox;
vm.createContext(sandbox);
['engine/warp', 'engine/grunge', 'engine/halftone', 'engine/geom', 'engine/raster',
 'engine/tenzen-outro', 'doc/effects', 'doc/register-effects', 'engine/selective-halftone',
 'doc/register-selective', 'view/specs'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/', f + '.js'), 'utf8'), sandbox);
});
var E = sandbox.Effects;
check('preset is available without changing the existing stack', function () {
  assert.strictEqual(E.ids().join(','), 'warp,dither,halftone,selective');
  assert.strictEqual(sandbox.DITHER_PRESETS.tenzenOutro.label, 'Tenzen outro preset');
  assert.strictEqual(sandbox.DITHER_PRESETS.tenzenOutro.params.outroDarken, 0.4);
});
check('outro controls parse displayed percentages without changing defaults', function () {
  var rows = sandbox.SPECS.dither().reduce(function (all, section) { return all.concat(section.rows); }, []);
  ['outroGrain', 'outroDarken'].forEach(function (key) {
    var row = rows.find(function (r) { return r.id === key; });
    assert.strictEqual(row.parse(row.fmt(T.defaults[key])), T.defaults[key]);
    assert.strictEqual(row.parse('6%'), 0.06);
  });
});
var input = { items: [{ frame: true }], bbox: { x: 2, y: 3, width: 65, height: 47 }, pixels: photo(65, 47) };
var layer = { effects: [{ type: 'dither', on: true, params: { preset: 'tenzenOutro' } }] };
var ctx = { maskFromPaths: function () { throw new Error('photo must not be traced'); },
  rasterize: sandbox.Raster.rasterize };
E.runStack(layer, input, ctx).then(function (run) {
  check('Dither emits the treated image and preserves the frame', function () {
    assert.strictEqual(run.result.bbox, input.bbox);
    assert.strictEqual(run.result.photo, run.result.pixels);
    assert.strictEqual(run.result.items.length, 0);
    assert.deepStrictEqual(Array.from(run.result.photo.data), Array.from(T.process(input.pixels).data));
  });
  layer.effects.push({ type: 'halftone', on: true, params: E.defaultsFor('halftone') });
  return E.runStack(layer, input, ctx);
}).then(function (run) {
  check('a later halftone consumes the processed pixels', function () {
    assert.ok(run.result.plates.length > 0);
    assert.strictEqual(run.result.photo, undefined);
  });
  layer.effects.forEach(function (fx) { fx.on = false; });
  return E.runStack(layer, input, ctx);
}).then(function (run) {
  check('disabling effects restores the untouched source', function () { assert.strictEqual(run.result, input); });
  console.log('\ntenzen-outro: ' + passed + ' passed, 0 failed');
}).catch(function (err) { console.error(err); process.exitCode = 1; });
