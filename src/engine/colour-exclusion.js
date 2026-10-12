/* Filter final vector paints, after layer ink and halftone colours are resolved. */
(function (root) {
  'use strict';
  var context;

  function hex(value) {
    var text = String(value || '').trim().toLowerCase();
    var match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
    if (match) {
      var digits = match[1];
      if (digits.length < 5) digits = digits.slice(0, 3).replace(/./g, function (c) { return c + c; });
      return '#' + digits.slice(0, 6);
    }
    match = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*[\d.]+)?\s*\)$/.exec(text);
    if (match) return '#' + match.slice(1, 4).map(function (v) {
      return Math.min(255, Number(v)).toString(16).padStart(2, '0');
    }).join('');
    if (typeof CSS !== 'undefined' && CSS.supports('color', text) && text !== 'transparent') {
      if (!context) context = document.createElement('canvas').getContext('2d');
      context.fillStyle = text;
      if (context.fillStyle !== text) return hex(context.fillStyle);
    }
    return null;
  }

  function apply(render, settings) {
    var target = settings.on && hex(settings.colour);
    if (!target) return render;
    var shapes = (render.shapes || []).map(function (shape) {
      var fill = hex(shape.fill) === target ? 'none' : shape.fill;
      var stroke = hex(shape.stroke) === target ? 'none' : shape.stroke;
      if (fill === shape.fill && stroke === shape.stroke) return shape;
      return Object.assign({}, shape, { fill: fill, stroke: stroke,
        strokeWidth: stroke === 'none' ? 0 : shape.strokeWidth });
    }).filter(function (shape) {
      return (shape.fill && shape.fill !== 'none') ||
        (shape.stroke && shape.stroke !== 'none' && shape.strokeWidth > 0);
    });
    return Object.assign({}, render, { shapes: shapes,
      plates: render.plates ? render.plates.filter(function (plate) {
        return hex(plate.colour) !== target;
      }) : render.plates });
  }

  root.ColourExclusion = { hex: hex, apply: apply };
})(typeof module !== 'undefined' ? module.exports : self);
