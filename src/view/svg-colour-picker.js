/* Pick the vector's actual fill, independent of the canvas ground or zoom. */
(function (root) {
  'use strict';

  function contains(shape, point, context) {
    if (shape.rule === 'evenodd') return shape.paths.reduce(function (inside, path) {
      return inside !== context.isPointInPath(path, point.x, point.y, 'evenodd');
    }, false);
    return shape.paths.some(function (path) { return context.isPointInPath(path, point.x, point.y); });
  }

  function pick(render, point, context) {
    if ((render.clips || []).some(function (clip) {
      return !context.isPointInPath(clip.path, point.x, point.y);
    })) return null;
    var plates = render.plates || [];
    for (var p = plates.length - 1; p >= 0; p--) {
      if (contains(plates[p], point, context)) return root.ColourExclusion.hex(plates[p].colour);
    }
    var shapes = render.shapes || [];
    for (var i = shapes.length - 1; i >= 0; i--) {
      var shape = shapes[i], colour = root.ColourExclusion.hex(shape.stroke);
      if (colour && shape.strokeWidth > 0) {
        context.lineWidth = shape.strokeWidth;
        context.lineJoin = 'round'; context.lineCap = 'round';
        if (shape.paths.some(function (path) {
          return context.isPointInStroke(path, point.x, point.y);
        })) return colour;
      }
      colour = root.ColourExclusion.hex(shape.fill);
      if (colour && contains(shape, point, context)) return colour;
    }
    return null;
  }

  function start(options) {
    var stage = options.stage, cursor = stage.style.cursor;
    var context = document.createElement('canvas').getContext('2d');
    var active = true;
    stage.style.cursor = 'crosshair';
    var style = document.createElement('style');
    style.textContent = '#stage[data-colour-picker] * { cursor: crosshair !important; }';
    document.head.appendChild(style);
    stage.setAttribute('data-colour-picker', '');

    function stop() {
      if (!active) return;
      active = false;
      stage.style.cursor = cursor;
      stage.removeAttribute('data-colour-picker');
      style.remove();
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', key, true);
      options.onStop();
    }
    function pointer(event) {
      if (!stage.contains(event.target)) { stop(); return; }
      if (event.button !== 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      var rect = options.canvas.getBoundingClientRect();
      var world = options.viewport.toWorld(event.clientX - rect.left, event.clientY - rect.top);
      var local = root.Doc.applyMatrix(root.Doc.invert(root.Doc.layerMatrix(options.layer)), world.x, world.y);
      var colour = pick(options.render, local, context);
      if (!colour) return;
      stop(); options.onPick(colour);
    }
    function key(event) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); stop();
      }
    }
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', key, true);
    return stop;
  }

  root.SVGColourPicker = { start: start };
})(self);
