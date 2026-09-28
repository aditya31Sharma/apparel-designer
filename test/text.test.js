/* Type into outlines, on real fonts. */
'use strict';

const fs = require('fs');
const vm = require('vm');
const F = require('../electron/fonts.js');

let passed = 0, failed = 0;
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
}

const sandbox = { console: console };
sandbox.window = sandbox; sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(__dirname + '/../src/vendor/opentype.min.js', 'utf8'), sandbox, { filename: 'opentype.min.js' });
vm.runInContext(fs.readFileSync(__dirname + '/../src/engine/warp.js', 'utf8'), sandbox, { filename: 'warp.js' });
vm.runInContext(fs.readFileSync(__dirname + '/../src/engine/text.js', 'utf8'), sandbox, { filename: 'text.js' });
const Text = sandbox.Text, W = sandbox.Warp;

function parse(buf) {
  return sandbox.opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

console.log('\ntype');
ok('the layout module loads beside the parser', !!Text && typeof Text.layout === 'function' && !!sandbox.opentype);

const ARIAL = '/System/Library/Fonts/Supplemental/Arial.ttf';
const GILROY = process.env.HOME + '/Library/Fonts/Gilroy.ttc';

(function () {
  if (!fs.existsSync(ARIAL)) { console.log('  (skipped: no Arial.ttf on this machine)'); return; }
  const font = parse(fs.readFileSync(ARIAL));
  const one = Text.layout(font, { text: 'Tenzen', size: 200 });
  ok('one line is one outline', one.length === 1 && one[0].d.length > 200);
  ok('outlines are finite', !/NaN|Infinity/.test(one[0].d));
  const b = W.bounds([one[0].d]);
  ok('the line is about six letters wide', b.width > 500 && b.width < 800, Math.round(b.width));
  const two = Text.layout(font, { text: 'Tenzen\nAngels', size: 200, leading: 1.1 });
  ok('two lines are two outlines', two.length === 2);
  const b1 = W.bounds([two[0].d]), b2 = W.bounds([two[1].d]);
  ok('the second line sits a line height below', Math.abs((b2.y - b1.y) - 220) < 60, Math.round(b2.y - b1.y));
  const wide = Text.layout(font, { text: 'Tenzen', size: 200, tracking: 300 });
  ok('tracking widens the line', W.bounds([wide[0].d]).width > b.width * 1.3);
  const centred = Text.layout(font, { text: 'Tenzen\nA', size: 200, align: 'centre' });
  const c1 = W.bounds([centred[0].d]), c2 = W.bounds([centred[1].d]);
  ok('centred lines share a middle, give or take the side bearings',
    Math.abs((c1.x + c1.width / 2) - (c2.x + c2.width / 2)) < 14,
    Math.round(c1.x + c1.width / 2) + ' vs ' + Math.round(c2.x + c2.width / 2));
  const right = Text.layout(font, { text: 'Tenzen\nA', size: 200, align: 'right' });
  const r1 = W.bounds([right[0].d]), r2 = W.bounds([right[1].d]);
  ok('right aligned lines share an end', Math.abs((r1.x + r1.width) - (r2.x + r2.width)) < 24,
    Math.round(r1.x + r1.width) + ' vs ' + Math.round(r2.x + r2.width));
  ok('an empty line makes no outline', Text.layout(font, { text: '\n\nTenzen', size: 100 }).length === 1);
  const AV = Text.layout(font, { text: 'AV', size: 200 });
  const AA = Text.layout(font, { text: 'AA', size: 200 });
  ok('kerning pulls a pair together', W.bounds([AV[0].d]).width < W.bounds([AA[0].d]).width,
    Math.round(W.bounds([AV[0].d]).width) + ' vs ' + Math.round(W.bounds([AA[0].d]).width));
})();

(function () {
  if (!fs.existsSync(GILROY)) { console.log('  (skipped: no Gilroy.ttc on this machine)'); return; }
  /* The case that clipped a line: this face's kerning lookup answers NaN
   * for some pairs, and the parser's own layout put every later glyph at
   * NaN, so the canvas drew the first two letters and stopped. */
  const font = parse(F.fixCmap(F.extractFromCollection(fs.readFileSync(GILROY), 0)));
  const items = Text.layout(font, { text: 'ANGELS', size: 200 });
  ok('a font whose kerning answers NaN still lays out every letter', items.length === 1 && !/NaN/.test(items[0].d));
  const b = W.bounds([items[0].d]);
  ok('and the whole word is there', b.width > 600, Math.round(b.width));
  // Six letters, and the A has a counter: at least seven contours, or a
  // glyph was dropped on the quiet.
  const contours = (items[0].d.match(/M/g) || []).length;
  ok('no glyph was dropped', contours >= 7, contours + ' contours');
})();

console.log('\ntext: ' + passed + ' passed, ' + failed + ' failed');
if (failed) process.exit(1);
