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
  /* Async because an effect may fan its work out across a pool and wait for it.
   * Effects that have nothing to wait for just return a value and this resolves
   * immediately. */
  function runStack(layer, input, ctx) {
    var cur = input, stats = {};
    var now = function () {
      return (typeof performance !== 'undefined' ? performance.now() : Date.now());
    };

    var chain = Promise.resolve();
    layer.effects.forEach(function (entry) {
      if (!entry.on) return;
      var def = defs[entry.type];
      if (!def || !def.run) return;
      chain = chain.then(function () {
        var t0 = now();
        return Promise.resolve(def.run(cur, entry.params, ctx || {})).then(function (out) {
          if (!out) return;
          stats[entry.type] = Object.assign({ ms: Math.round(now() - t0) }, out.stats || {});
          cur = out;
        });
      });
    });

    return chain.then(function () { return { result: cur, stats: stats }; });
  }

  root.Effects = {
    register: register, get: get, ids: ids, list: list,
    defaultsFor: defaultsFor, runStack: runStack
  };
})(typeof module !== 'undefined' ? module.exports : self);
