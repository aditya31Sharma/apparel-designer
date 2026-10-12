'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const SVG = require('../src/engine/svg-clipboard.js').SVGClipboard;
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 20"><path d="M0 0L30 20"/></svg>';
const data = (values, items = []) => ({ getData: type => values[type] || '', items });

test('SVG text wins over a raster clipboard preview', async () => {
  const result = SVG.read(data({ 'text/plain': svg }, [{ type: 'image/png', getAsFile() { throw Error('PNG must not be read'); } }]));
  assert.equal(await result, svg);
});
test('SVG inside HTML and SVG files are accepted', async () => {
  assert.equal(await SVG.read(data({ 'text/html': '<html><body>' + svg + '</body></html>' })), svg);
  assert.equal(await SVG.read(data({}, [{ type: 'image/svg+xml', getAsFile: () => ({ text: async () => svg }) } ])), svg);
});
test('native Figma data is identified without falling back to its PNG', async () => {
  await assert.rejects(SVG.read(data({ 'text/html': '<span data-figma="payload"></span>' })), /Copy as SVG/);
});
test('ordinary text and raster paste remain available to existing handlers', () => {
  assert.equal(SVG.read(data({ 'text/plain': 'hello' })), null);
  assert.equal(SVG.read(data({}, [{ type: 'image/png' }])), null);
});
test('SVG clipboard preserves Unicode and vector markup', async () => {
  const text = svg.replace('<path', '<title>Tenzen \u2764</title><path');
  assert.equal(await SVG.read(data({ 'text/plain': text })), text);
});
