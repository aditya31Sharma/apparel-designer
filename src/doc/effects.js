/* The effect registry.
 *
 * An effect takes geometry and gives back geometry. It never sees the layer's
 * transform, paint or opacity, which is why those survive it. Adding a fourth
 * effect later means registering it here and writing its panel; nothing in the
 * viewport, the exporter or the transform code has to change.
 *
 * Shape of a registration:
 *   id       stable key, also the stack entry's type
 *   label    what the tab says
 *   defaults params an untouched layer starts with
 *   run(input, params, ctx) -> output
 *
 * input  { items: [{d, fill, stroke, strokeWidth}], bbox, matte }
 * output { items: [...], dots: [...], stats } - items are outlines, dots are
 *          parametric halftone cells; a renderer handles whichever is present.
 */
(function (root) {
  'use strict';

  var defs = {};
  var order = [];

  function register(def) {
    if (!def || !def.id) throw new Error('effect needs an id');
    if (!defs[def.id]) order.push(def.id);
    defs[def.id] = def;
    return def;
  }

  function get(id) { return defs[id]; }
  function ids() { return order.slice(); }
  function list() { return order.map(function (id) { return defs[id]; }); }

  function defaultsFor(id) {
    var d = defs[id];
    return d ? JSON.parse(JSON.stringify(d.defaults || {})) : {};
  }

  /* Run the stack in order, skipping anything switched off. Each effect hands
   * its output to the next, so warp-then-dither still works, and so does
   * warp-then-halftone. */
  function runStack(layer, input, ctx) {
    var cur = input, stats = {};
    for (var i = 0; i < layer.effects.length; i++) {
      var entry = layer.effects[i];
      if (!entry.on) continue;
      var def = defs[entry.type];
      if (!def || !def.run) continue;
      var t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var out = def.run(cur, entry.params, ctx || {});
      if (!out) continue;
      stats[entry.type] = Object.assign({
        ms: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
      }, out.stats || {});
      cur = out;
    }
    return { result: cur, stats: stats };
  }

  root.Effects = {
    register: register, get: get, ids: ids, list: list,
    defaultsFor: defaultsFor, runStack: runStack
  };
})(typeof module !== 'undefined' ? module.exports : self);
