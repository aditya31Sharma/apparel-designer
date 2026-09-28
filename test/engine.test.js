/* Document model, effect registry and SVG export. No DOM.
 * Run: node test/engine.test.js
 *
 * The point of most of these is the promise the whole redesign rests on: the
 * layer's frame, rotation, opacity and paint come out the same no matter what
 * the effect stack does.
 */
// Under node each module attaches to its own module.exports, so pull the
// namespaces off the require results and hand them to each other by hand.
var W = require('../src/engine/warp.js').Warp;
var H = require('../src/engine/halftone.js').Halftone;
var Doc = require('../src/doc/model.js').Doc;
var Effects = require('../src/doc/effects.js').Effects;
var SvgOut = require('../src/export/svg.js').SvgOut;
require('../src/export/svg.js').Halftone = H;

var pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ' + detail : '')); }
}
function near(a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol); }

function sampleLayer() {
  var items = [{ d: 'M0 0H100V50H0Z', fill: '#f36', stroke: 'none', strokeWidth: 0 }];
  var L = Doc.makeLayer({ items: items, bbox: W.bounds(['M0 0H100V50H0Z']) }, 'test');
  return L;
}

console.log('\ndocument model');
(function () {
  var L = sampleLayer();
  ok('a new layer takes its frame from the artwork',
    L.transform.width === 100 && L.transform.height === 50);
  ok('a new layer has an empty effect stack', L.effects.length === 0);

  Doc.ensureStack(L, ['warp', 'dither'], function () { return { a: 1 }; });
  ok('the stack gets one entry per effect, all switched off',
    L.effects.length === 2 && L.effects.every(function (e) { return e.on === false; }));

  Doc.ensureStack(L, ['warp', 'dither', 'halftone'], function () { return { b: 2 }; });
  ok('adding an effect keeps the existing entries',
    L.effects.length === 3 && L.effects[0].params.a === 1 && L.effects[2].params.b === 2);

  ok('effect() finds by type', Doc.effect(L, 'dither').type === 'dither');
  ok('anyEffectOn is false on a fresh layer', Doc.anyEffectOn(L) === false);
  Doc.effect(L, 'dither').on = true;
  ok('anyEffectOn notices a switch', Doc.anyEffectOn(L) === true);
})();

console.log('\ntransform maths');
(function () {
  var L = sampleLayer();
  var m = Doc.layerMatrix(L);
  var p = Doc.applyMatrix(m, 0, 0);
  ok('an untouched layer maps the origin to itself', near(p.x, 0) && near(p.y, 0));

  L.transform.x = 40; L.transform.y = 25;
  m = Doc.layerMatrix(L);
  p = Doc.applyMatrix(m, 0, 0);
  ok('moving the frame moves the artwork', near(p.x, 40) && near(p.y, 25));

  L.transform.x = 0; L.transform.y = 0;
  L.transform.width = 200; L.transform.height = 100;
  m = Doc.layerMatrix(L);
  p = Doc.applyMatrix(m, 100, 50);
  ok('doubling the frame doubles the artwork', near(p.x, 200) && near(p.y, 100));

  L.transform.width = 100; L.transform.height = 50;
  L.transform.rotation = 90;
  var c = Doc.frameCorners(L);
  // A 90 degree turn about the centre sends the top-left corner to the top-right.
  ok('rotation turns the frame about its own centre',
    near(c[0].x, 75, 1e-6) && near(c[0].y, -25, 1e-6),
    JSON.stringify(c[0]));

  L.transform.rotation = 37;
  m = Doc.layerMatrix(L);
  var inv = Doc.invert(m);
  var back = Doc.applyMatrix(inv, Doc.applyMatrix(m, 17, 9).x, Doc.applyMatrix(m, 17, 9).y);
  ok('inverting the matrix round-trips a point', near(back.x, 17, 1e-9) && near(back.y, 9, 1e-9));

  L.transform.rotation = 0;
  L.transform.flipX = true;
  c = Doc.frameCorners(L);
  ok('flipping across swaps left and right', near(c[0].x, 100) && near(c[1].x, 0));
})();

var asyncChecks = [];

console.log('\nthe stack never touches the frame');
(function () {
  Effects.register({
    id: 'shrink', label: 'Shrink', defaults: { by: 0.5 },
    run: function (input, p) {
      // Deliberately rewrites the geometry and the bbox.
      return {
        items: input.items.map(function (i) { return { d: 'M0 0H10V5H0Z', fill: i.fill }; }),
        bbox: { x: 0, y: 0, width: 10, height: 5 },
        stats: { shapes: 1 }
      };
    }
  });

  var L = sampleLayer();
  Doc.ensureStack(L, ['shrink'], Effects.defaultsFor);
  L.transform.x = 33; L.transform.y = 12;
  L.transform.width = 260; L.transform.height = 130;
  L.transform.rotation = 21;
  L.paint.opacity = 0.42;
  L.paint.fill = '#00ff88';

  var before = JSON.stringify([L.transform, L.paint]);
  Doc.effect(L, 'shrink').on = true;

  // runStack is a promise now, because an effect may fan its work across a pool.
  asyncChecks.push(
    Effects.runStack(L, { items: L.source.items, bbox: L.source.bbox }, {}).then(function (run) {
      var after = JSON.stringify([L.transform, L.paint]);
      ok('the effect did change the geometry', run.result.items[0].d === 'M0 0H10V5H0Z');
      ok('position, size, rotation, opacity and fill are untouched', before === after);
      ok('stats come back per effect', run.stats.shrink && run.stats.shrink.shapes === 1);

      Doc.effect(L, 'shrink').on = false;
      return Effects.runStack(L, { items: L.source.items, bbox: L.source.bbox }, {});
    }).then(function (off) {
      ok('a switched-off effect passes the artwork straight through',
        off.result.items[0].d === 'M0 0H100V50H0Z');
    }));
})();

console.log('\nhistory');
(function () {
  var L = sampleLayer();
  Doc.ensureStack(L, ['warp'], function () { return { strength: 45 }; });
  var doc = Doc.makeDoc();
  Doc.addLayer(doc, L);
  var hist = Doc.History(10);

  hist.push(doc);
  L.transform.x = 500;
  Doc.effect(L, 'warp').on = true;
  ok('undo restores the frame and the stack',
    hist.undo(doc) && doc.layers[0].transform.x === 0 &&
    Doc.effect(doc.layers[0], 'warp').on === false);
  ok('redo puts it back',
    hist.redo(doc) && doc.layers[0].transform.x === 500 &&
    Doc.effect(doc.layers[0], 'warp').on === true);
  ok('undo stack reports itself', hist.canUndo() === true && hist.canRedo() === false);

  var deep = Doc.History(3);
  for (var i = 0; i < 8; i++) { L.transform.x = i; deep.push(doc); }
  var count = 0;
  while (deep.undo(doc)) count++;
  ok('history is capped at its limit', count === 3, count + ' steps');
})();

console.log('\nsvg export');
(function () {
  var L = sampleLayer();
  L.transform.x = 10; L.transform.y = 5; L.transform.rotation = 30;
  var renders = [{
    name: 'art', matrix: Doc.layerMatrix(L), bbox: L.source.bbox, opacity: 0.6,
    shapes: [{ d: 'M0 0H100V50H0Z', fill: '#f36', stroke: 'none', strokeWidth: 0 }]
  }];
  var svg = SvgOut.build(renders, {});
  ok('emits a root svg with a viewBox', /^<svg [^>]*viewBox="/.test(svg));
  ok('bakes the layer matrix onto the group', /transform="matrix\(/.test(svg));
  ok('carries opacity', /opacity="0.6"/.test(svg));
  ok('no NaN or undefined leaks in', !/NaN|undefined/.test(svg));

  var b = SvgOut.documentBounds(renders);
  ok('bounds account for the rotation', b.width > 100 && b.height > 50,
    Math.round(b.width) + 'x' + Math.round(b.height));

  // halftone plates
  var w = 120, h = 60;
  var px = new Uint8ClampedArray(w * h * 4);
  for (var i = 0; i < w * h; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 128; px[i * 4 + 3] = 255;
  }
  var res = H.screen(px, w, h, { frequency: 20 });
  var plateRenders = [{
    name: 'ht', matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    bbox: { x: 0, y: 0, width: w, height: h },
    plates: res.channels, pattern: 'round', fuzziness: 0, seed: 1,
    blend: 'multiply'
  }];
  var hs = SvgOut.build(plateRenders, {});
  ok('plates come out as one path each',
    (hs.match(/<path /g) || []).length === res.channels.length);
  ok('process plates are grouped to multiply', /mix-blend-mode:multiply/.test(hs));
  ok('no paper in the file', !/<rect /.test(hs));
  ok('every ink is named', (hs.match(/data-ink="/g) || []).length === res.channels.length);
  // Spot inks are opaque and sit on top of each other, as they do on a garment.
  var spot = SvgOut.build([Object.assign({}, plateRenders[0], { blend: 'source-over' })], {});
  ok('spot plates are not blended', !/mix-blend-mode/.test(spot) && /<g>/.test(spot));

  var sep = SvgOut.build(plateRenders, { separations: true });
  ok('separations put each ink in its own named group',
    /<g id="Cyan">/.test(sep) && /<g id="Black">/.test(sep) &&
    !/mix-blend-mode/.test(sep));
})();

console.log('\nwarp still behaves');
(function () {
  var d = 'M0 0H200V60H0Z';
  var bbox = W.bounds([d]);
  var flat = W.warp([d], bbox, { preset: 'arc', strength: 0, smooth: false });
  ok('zero strength leaves the shape where it was',
    near(W.bounds(flat).height, 60, 1.5), W.bounds(flat).height);

  var bent = W.warp([d], bbox, { preset: 'arc', strength: 70, smooth: true });
  ok('arc actually bends it', W.bounds(bent).height > 70, W.bounds(bent).height);

  // The counter has to survive, which is what caught the winding bug before.
  var ring = 'M0 0H200V60H0ZM40 15H160V45H40Z';
  var out = W.warp([ring], W.bounds([ring]), { preset: 'arc', strength: 50, smooth: true });
  ok('a shape with a hole keeps both contours', out.join(' ').split('M').length - 1 >= 2);

  ok('every preset returns geometry', W.PRESETS.every(function (p) {
    var r = W.warp([d], bbox, { preset: p.id, strength: 60, smooth: true });
    return r.length > 0 && r.join('').indexOf('NaN') === -1;
  }));
})();

Promise.all(asyncChecks).then(function () {
  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}).catch(function (err) {
  console.log('\n  FAIL async checks threw: ' + (err && err.stack || err));
  process.exit(1);
});
