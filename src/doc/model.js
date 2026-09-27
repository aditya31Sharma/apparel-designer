/* The document. One layer owns its artwork, its frame and its paint; effects are
 * an ordered stack that runs inside that frame and never sees it.
 *
 * That split is the whole point. Because the transform is applied after the
 * stack, position, size, rotation and opacity survive turning any effect on or
 * off, which is what a design tool is supposed to do and what the old
 * warp-corners-are-the-transform arrangement could not.
 */
(function (root) {
  'use strict';

  var uid = 0;
  function nextId(prefix) { return prefix + '-' + (++uid) + '-' + Date.now().toString(36); }

  function makeLayer(source, name) {
    var b = source.bbox;
    return {
      id: nextId('layer'),
      name: name || 'Layer',
      source: source,
      transform: {
        x: b.x, y: b.y, width: b.width, height: b.height,
        rotation: 0, flipX: false, flipY: false
      },
      paint: {
        fill: '#ffffff', fillOn: true,
        stroke: '#ff4d88', strokeWidth: 0,
        opacity: 1, blend: 'normal',
        useSourceColours: true
      },
      effects: [],            // empty: a fresh import renders exactly as imported
      matte: null,            // alpha from background removal
      corners: null           // warp's four handles, in normalised frame space
    };
  }

  function makeDoc() {
    return { layers: [], selection: null, version: 0 };
  }

  function selected(doc) {
    if (!doc.selection) return null;
    for (var i = 0; i < doc.layers.length; i++) {
      if (doc.layers[i].id === doc.selection) return doc.layers[i];
    }
    return null;
  }

  function addLayer(doc, layer) {
    doc.layers.push(layer);
    doc.selection = layer.id;
    doc.version++;
    return layer;
  }

  /* ---------- effect stack ---------- */

  /* The stack always holds one entry per registered effect, in a fixed order, so
   * the panels can bind to a stable object and toggling is just a boolean. An
   * effect that has never been touched sits there switched off. */
  function ensureStack(layer, order, defaultsFor) {
    var byType = {};
    layer.effects.forEach(function (e) { byType[e.type] = e; });
    layer.effects = order.map(function (type) {
      return byType[type] || { type: type, on: false, params: defaultsFor(type) };
    });
    return layer.effects;
  }

  function effect(layer, type) {
    for (var i = 0; i < layer.effects.length; i++) {
      if (layer.effects[i].type === type) return layer.effects[i];
    }
    return null;
  }

  function anyEffectOn(layer) {
    return layer.effects.some(function (e) { return e.on; });
  }

  /* ---------- transform ---------- */

  /* The frame maps the source's own coordinates into the document. Effects work
   * in source coordinates; this runs afterwards, once. */
  function frameMatrix(t) {
    var cx = t.x + t.width / 2, cy = t.y + t.height / 2;
    var rad = (t.rotation || 0) * Math.PI / 180;
    var cos = Math.cos(rad), sin = Math.sin(rad);
    var sx = t.flipX ? -1 : 1, sy = t.flipY ? -1 : 1;
    // translate to centre, flip, rotate, translate back
    return {
      a: cos * sx, b: sin * sx,
      c: -sin * sy, d: cos * sy,
      e: cx - (cos * sx * cx + -sin * sy * cy),
      f: cy - (sin * sx * cx + cos * sy * cy)
    };
  }

  /* Source bbox to frame: effects output in source space, the frame may have
   * been resized since import, so scale the difference in. */
  function fitMatrix(layer) {
    var b = layer.source.bbox, t = layer.transform;
    var sx = b.width ? t.width / b.width : 1;
    var sy = b.height ? t.height / b.height : 1;
    return {
      a: sx, b: 0, c: 0, d: sy,
      e: t.x - b.x * sx, f: t.y - b.y * sy
    };
  }

  function mul(m, n) {
    return {
      a: m.a * n.a + m.c * n.b,
      b: m.b * n.a + m.d * n.b,
      c: m.a * n.c + m.c * n.d,
      d: m.b * n.c + m.d * n.d,
      e: m.a * n.e + m.c * n.f + m.e,
      f: m.b * n.e + m.d * n.f + m.f
    };
  }

  /* Full source-to-document matrix: fit the frame, then rotate and flip it. */
  function layerMatrix(layer) {
    return mul(frameMatrix(layer.transform), fitMatrix(layer));
  }

  function applyMatrix(m, x, y) {
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
  }

  function invert(m) {
    var det = m.a * m.d - m.b * m.c;
    if (!det) return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    return {
      a: m.d / det, b: -m.b / det,
      c: -m.c / det, d: m.a / det,
      e: (m.c * m.f - m.d * m.e) / det,
      f: (m.b * m.e - m.a * m.f) / det
    };
  }

  /* The frame's four corners in document space, for handles and hit testing. */
  function frameCorners(layer) {
    var t = layer.transform, m = frameMatrix(t);
    return [
      applyMatrix(m, t.x, t.y),
      applyMatrix(m, t.x + t.width, t.y),
      applyMatrix(m, t.x + t.width, t.y + t.height),
      applyMatrix(m, t.x, t.y + t.height)
    ];
  }

  /* ---------- history ---------- */

  /* Snapshots, not commands. A document is small (the source geometry is shared
   * by reference, only the frame and params are cloned) and snapshots cannot
   * drift out of sync with the model the way inverse commands can. */
  function History(limit) {
    var past = [], future = [], cap = limit || 60;

    function snap(doc) {
      return JSON.stringify(doc.layers.map(function (l) {
        return {
          id: l.id, name: l.name,
          transform: Object.assign({}, l.transform),
          paint: Object.assign({}, l.paint),
          effects: l.effects.map(function (e) {
            return { type: e.type, on: e.on, params: Object.assign({}, e.params) };
          }),
          corners: l.corners ? l.corners.map(function (c) { return { x: c.x, y: c.y }; }) : null
        };
      }));
    }

    function restore(doc, json) {
      var saved = JSON.parse(json);
      saved.forEach(function (s, i) {
        var l = doc.layers[i];
        if (!l) return;
        l.name = s.name;
        l.transform = s.transform;
        l.paint = s.paint;
        l.effects = s.effects;
        l.corners = s.corners;
      });
      doc.version++;
    }

    return {
      push: function (doc) {
        past.push(snap(doc));
        if (past.length > cap) past.shift();
        future.length = 0;
      },
      undo: function (doc) {
        if (!past.length) return false;
        future.push(snap(doc));
        restore(doc, past.pop());
        return true;
      },
      redo: function (doc) {
        if (!future.length) return false;
        past.push(snap(doc));
        restore(doc, future.pop());
        return true;
      },
      canUndo: function () { return past.length > 0; },
      canRedo: function () { return future.length > 0; },
      clear: function () { past.length = 0; future.length = 0; }
    };
  }

  root.Doc = {
    makeLayer: makeLayer, makeDoc: makeDoc, addLayer: addLayer, selected: selected,
    ensureStack: ensureStack, effect: effect, anyEffectOn: anyEffectOn,
    frameMatrix: frameMatrix, fitMatrix: fitMatrix, layerMatrix: layerMatrix,
    frameCorners: frameCorners, applyMatrix: applyMatrix, invert: invert, mul: mul,
    History: History, nextId: nextId
  };
})(typeof module !== 'undefined' ? module.exports : self);
