var assert = require('assert'), N = require('../src/view/numeric-control.js').NumericControl;
var passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok  ' + name); }
global.document = { activeElement: null };
function input() {
  var listeners = {};
  return { value: '', classList: { add: function () {} }, setAttribute: function () {},
    addEventListener: function (type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    fire: function (type, key) { (listeners[type] || []).forEach(function (fn) { fn({ key: key, preventDefault: function () {}, stopPropagation: function () {} }); }); },
    select: function () {}, blur: function () { document.activeElement = null; this.fire('change'); }
  };
}
function control(extra) {
  var value = 50, begins = 0, commits = 0, slider = input(), number = input();
  var handle = N.bind(slider, number, Object.assign({ label: 'Length', min: 1, max: 100,
    get: function () { return value; }, set: function (v) { value = v; },
    begin: function () { begins++; }, commit: function () { commits++; } }, extra));
  return { slider: slider, number: number, handle: handle,
    state: function () { return { value: value, begins: begins, commits: commits }; } };
}
check('displayed percentages, centimetres and multipliers convert to model units', function () {
  assert.strictEqual(N.read('25%', 100, '%'), 0.25);
  assert.strictEqual(N.read('12.5 cm', 50, 'cm'), 0.25);
  assert.strictEqual(N.read('1.5x', 0.01, 'x'), 150);
  assert.strictEqual(N.read('-12.25', 1, '°'), -12.25);
});
check('blank, malformed, infinite and mismatched-unit values are rejected', function () {
  ['', ' ', '25abc', 'Infinity', '1e500', '12%', '2.3.4'].forEach(function (s) { assert.ok(Number.isNaN(N.read(s, 1, 'px'))); });
});
check('multiple live slider inputs create one undo gesture and one commit', function () {
  var c = control();
  [52, 58, 63].forEach(function (v) { c.slider.value = v; c.slider.fire('input'); });
  assert.deepStrictEqual(c.state(), { value: 63, begins: 1, commits: 0 });
  c.slider.fire('change'); c.slider.fire('blur');
  assert.deepStrictEqual(c.state(), { value: 63, begins: 1, commits: 1 });
});
check('typed decimal precision is retained and hard bounds are enforced', function () {
  var c = control(); c.number.value = '12.375'; c.number.fire('change');
  assert.strictEqual(c.state().value, 12.375); assert.strictEqual(c.number.value, '12.375');
  c.number.value = '500'; c.number.fire('change'); assert.strictEqual(c.state().value, 100);
});
check('Enter commits exactly once even when blur also fires change', function () {
  var c = control(); c.number.value = '73'; c.number.fire('keydown', 'Enter');
  assert.deepStrictEqual(c.state(), { value: 73, begins: 1, commits: 1 });
});
check('computed lengths do not create a second commit for floating point roundoff', function () {
  var value = 50;
  var c = control({ get: function () { return value; }, set: function (v) { value = v - Number.EPSILON * v; } });
  c.number.value = '120.25'; c.number.fire('keydown', 'Enter');
  assert.strictEqual(c.state().begins, 1); assert.strictEqual(c.state().commits, 1);
});
check('Escape and invalid text restore the current value without history', function () {
  var c = control(); c.number.value = 'invalid'; c.number.fire('change');
  assert.strictEqual(c.number.value, '50');
  c.number.value = '73'; c.number.fire('keydown', 'Escape');
  assert.deepStrictEqual(c.state(), { value: 50, begins: 0, commits: 0 });
});
check('sync leaves an in-progress typed value intact', function () {
  var c = control(); document.activeElement = c.number; c.number.value = '-12.';
  c.handle.show(); assert.strictEqual(c.number.value, '-12.'); document.activeElement = null;
});
check('unbounded exact dimensions expand the practical slider range', function () {
  var c = control({ min: undefined, max: undefined, rangeMin: -2000, rangeMax: 2000 });
  c.number.value = '-5000.5'; c.number.fire('change');
  assert.strictEqual(c.state().value, -5000.5); assert.strictEqual(c.slider.min, -5000.5);
});
check('pointer cancellation restores the gesture starting value', function () {
  var c = control(); c.slider.value = 80; c.slider.fire('input'); c.slider.fire('pointercancel');
  assert.strictEqual(c.state().value, 50); assert.strictEqual(c.number.value, '50');
});
check('missing selection disables both controls without displaying NaN', function () {
  var c = control({ get: function () { return undefined; } });
  assert.ok(c.slider.disabled && c.number.disabled); assert.strictEqual(c.number.value, '');
});
console.log('\nnumeric-control: ' + passed + ' passed, 0 failed');
