/* The effect registry's contract.
 *
 * Loaded the way the browser loads it: every file evaluated into one shared
 * global, not as separate CommonJS modules. Under node each file would
 * otherwise get its own exports object and the cross-file lookups that work in
 * a page would silently find nothing.
 */
var vm = require('vm');
var fs = require('fs');
var path = require('path');

var sandbox = {};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.console = console;
sandbox.performance = { now: function () { return Date.now(); } };
// Enough of a canvas for the modules that check for one at load time.
sandbox.OffscreenCanvas = undefined;
sandbox.document = undefined;
vm.createContext(sandbox);

['src/engine/warp.js', 'src/engine/grunge.js', 'src/engine/halftone.js',
 'src/engine/geom.js', 'src/engine/raster.js',
 'src/doc/effects.js', 'src/doc/model.js', 'src/doc/register-effects.js'
].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), sandbox, { filename: f });
});

var E = sandbox.Effects;
var Doc = sandbox.Doc;

var pass = 0, fail = 0;
function ok(n, c, d) {
  if (c) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '  ' + d : '')); }
}

console.log('\nregistry');
ok('the engines all loaded into one global',
  !!(sandbox.Warp && sandbox.Grunge && sandbox.Halftone && sandbox.Geom && E && Doc));
ok('three effects, in stack order', E.ids().join(',') === 'warp,dither,halftone', E.ids().join(','));

E.list().forEach(function (def) {
  ok(def.id + ' has a label', !!def.label);
  ok(def.id + ' has a tip', !!def.tip);
  ok(def.id + ' has defaults', Object.keys(def.defaults || {}).length > 0);
  ok(def.id + ' has a run', typeof def.run === 'function');
  ok(def.id + ' defaults are a fresh copy each time',
    E.defaultsFor(def.id) !== E.defaultsFor(def.id));
});

console.log('\nparameters that had to change shape');
(function () {
  var ht = E.defaultsFor('halftone');
  // Cells-across is relative to the artwork, which broke every preset on a
  // photo. Pitch is absolute and is the only thing stored now.
  ok('halftone is sized by dot pitch, not cell count',
    typeof ht.pitch === 'number' && ht.frequency === undefined,
    JSON.stringify({ pitch: ht.pitch, frequency: ht.frequency }));
  ok('halftone carries a paper colour', typeof ht.paper === 'string', ht.paper);
  ok('halftone carries a duotone split', typeof ht.duotoneSplit === 'number', ht.duotoneSplit);
  ok('halftone starts in cmyk', ht.mode === 'cmyk');

  var di = E.defaultsFor('dither');
  ok('dither starts with no texture', di.texture === 'none' && di.textureAmount === 0);
  ok('dither carries an effect scale', typeof di.scale === 'number');

  var wp = E.defaultsFor('warp');
  ok('warp starts with untouched corners', wp.corners === null);
})();

console.log('\na fresh layer applies nothing');
(function () {
  var items = [{ d: 'M0 0H100V50H0Z', fill: '#000', stroke: 'none', strokeWidth: 0 }];
  var L = Doc.makeLayer({ items: items, bbox: sandbox.Warp.bounds([items[0].d]) }, 'x');
  Doc.ensureStack(L, E.ids(), E.defaultsFor);
  ok('the stack has one entry per effect', L.effects.length === 3);
  ok('every entry starts switched off', L.effects.every(function (e) { return !e.on; }));
  ok('the stack is in registry order',
    L.effects.map(function (e) { return e.type; }).join(',') === 'warp,dither,halftone');
})();

console.log('\nthe stack is async and ordered');
(function () {
  var order = [];
  E.register({
    id: 'probeA', label: 'A', tip: 'a', defaults: { n: 1 },
    run: function (input) { order.push('A'); return { items: input.items, bbox: input.bbox }; }
  });
  E.register({
    id: 'probeB', label: 'B', tip: 'b', defaults: { n: 1 },
    run: function (input) {
      // Returning a promise must be honoured, because the erosion fans out.
      return Promise.resolve().then(function () {
        order.push('B');
        return { items: input.items, bbox: input.bbox };
      });
    }
  });
  var layer = { effects: [{ type: 'probeA', on: true, params: {} },
                          { type: 'probeB', on: true, params: {} }] };
  var out = E.runStack(layer, { items: [], bbox: { x: 0, y: 0, width: 1, height: 1 } }, {});
  ok('runStack returns a promise', out && typeof out.then === 'function');
  return out.then(function (r) {
    ok('effects run in stack order even when one is async', order.join('') === 'AB', order.join(''));
    ok('stats come back keyed by effect', !!(r.stats.probeA && r.stats.probeB));
    console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
    process.exit(fail ? 1 : 0);
  });
})();
