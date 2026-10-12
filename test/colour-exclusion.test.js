'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/engine/colour-exclusion.js').ColourExclusion;
const S = require('../src/export/svg.js').SvgOut;

test('colour matching accepts source hex and RGB paints without conflating nearby colours', () => {
  for (const paint of ['#AABBCC', '#abc', '#abcd', '#aabbcc80', 'rgb(170, 187, 204)', 'rgba(170,187,204,0.4)']) {
    assert.equal(C.hex(paint), '#aabbcc');
  }
  assert.equal(C.hex('rgba(170,187,205,0.4)'), '#aabbcd');
  for (const paint of ['none', 'url(#gradient)', 'invalid', null]) assert.equal(C.hex(paint), null);
});

test('dither exclusion removes matching fills and outlines while preserving other geometry', () => {
  const shapes = [
    { d: 'M0 0H10V10Z', fill: '#fff', stroke: '#000000', strokeWidth: 2 },
    { d: 'M20 0H30V10Z', fill: 'rgba(255,255,255,0.3)', stroke: 'none', strokeWidth: 0 },
    { d: 'M40 0H50V10Z', fill: '#ff0000', stroke: '#ffffff', strokeWidth: 2 }
  ];
  const input = { shapes, plates: null }, before = JSON.stringify(input);
  const output = C.apply(input, { on: true, colour: '#ffffff' });
  assert.equal(output.shapes.length, 2);
  assert.equal(output.shapes[0].fill, 'none');
  assert.equal(output.shapes[0].stroke, '#000000');
  assert.equal(output.shapes[1].fill, '#ff0000');
  assert.equal(output.shapes[1].stroke, 'none');
  assert.equal(JSON.stringify(input), before);
  assert.strictEqual(C.apply(input, { on: false, colour: '#ffffff' }), input);
  assert.strictEqual(C.apply(input, { on: true, colour: 'bad' }), input);
});

test('halftone exclusion removes exact ink plates, retaining dot buffers and an empty plate result', () => {
  const dots = new Float32Array([1, 2, 3, 4]);
  const input = { shapes: [], plates: [
    { key: 'c', colour: 'rgba(0,174,239,0.85)', dots },
    { key: 'm', colour: '#ec008c', dots }
  ] };
  const output = C.apply(input, { on: true, colour: '#00aeef' });
  assert.deepEqual(output.plates.map(p => p.key), ['m']);
  assert.strictEqual(output.plates[0].dots, dots);
  assert.equal(input.plates.length, 2);
  assert.deepEqual(C.apply(output, { on: true, colour: '#ec008c' }).plates, []);
});

test('filtered SVG contains retained flat paths and no removed paint or bitmap', () => {
  const render = { matrix: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    bbox: { x: 0, y: 0, width: 20, height: 10 }, shapes: [
      { d: 'M0 0H10V10Z', fill: '#ffffff' }, { d: 'M10 0H20V10Z', fill: '#000000' }
    ] };
  const svg = S.build([C.apply(render, { on: true, colour: '#ffffff' })]);
  assert.match(svg, /fill="#000000"/);
  assert.doesNotMatch(svg, /#ffffff|<image|data:image|<mask/);
});
