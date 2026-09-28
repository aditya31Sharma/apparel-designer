/* Words into outlines.
 *
 * A font is a set of outlines with rules for placing them, and this asks it
 * for the outline of each line of text and stacks the lines. What comes back
 * is the same kind of thing an SVG import gives: path data, so the warp bends
 * it, the dither chews it and the halftone screens it with nothing knowing it
 * was ever type.
 *
 * Kerning comes from the font. Tracking is in thousandths of an em, the unit
 * every layout program uses for it. Line height is a multiple of the size.
 */
(function (root) {
  'use strict';

  var DEFAULT = { text: 'TENZEN', font: '', size: 200, tracking: 0, leading: 1.1, align: 'left' };

  /* One line, glyph by glyph, placed from the glyphs' own outlines in font
   * units. The parser's positioning put NaN into some glyphs inside the app
   * (never under Node), and the canvas stops drawing a path at the first
   * NaN, so a word lost its tail. Scaling the raw outline here leaves nothing
   * to go wrong: a number times a number plus a number. A glyph that still
   * carries a bad number is left out whole rather than half drawn. */
  function fmt(v) { var r = Math.round(v * 100) / 100; return String(r === 0 ? 0 : r); }

  function glyphData(g, x, y, scale) {
    var cmds = (g.path && g.path.commands) || [];
    var d = '';
    for (var i = 0; i < cmds.length; i++) {
      var c = cmds[i], pts;
      if (c.type === 'Z') { d += 'Z'; continue; }
      if (c.type === 'M' || c.type === 'L') pts = [c.x, c.y];
      else if (c.type === 'Q') pts = [c.x1, c.y1, c.x, c.y];
      else if (c.type === 'C') pts = [c.x1, c.y1, c.x2, c.y2, c.x, c.y];
      else continue;
      var out = [];
      for (var k = 0; k < pts.length; k += 2) {
        var px = x + pts[k] * scale, py = y - pts[k + 1] * scale;
        if (!isFinite(px) || !isFinite(py)) return '';
        out.push(fmt(px), fmt(py));
      }
      d += c.type + out.join(' ');
    }
    return d;
  }

  function line(font, text, x0, y, size, tracking) {
    var scale = size / (font.unitsPerEm || 1000);
    var glyphs = font.stringToGlyphs(text);
    var x = x0, d = '';
    for (var i = 0; i < glyphs.length; i++) {
      var g = glyphs[i];
      d += glyphData(g, x, y, scale);
      var adv = (isFinite(g.advanceWidth) ? g.advanceWidth : 0) * scale;
      if (i + 1 < glyphs.length) {
        var k = 0;
        try { k = font.getKerningValue(g, glyphs[i + 1]); } catch (e) { k = 0; }
        if (isFinite(k)) adv += k * scale;
      }
      x += adv + (tracking / 1000) * size;
    }
    return { d: d, width: x - x0 };
  }

  function layout(font, spec) {
    var s = Object.assign({}, DEFAULT, spec || {});
    var size = Math.max(1, +s.size || DEFAULT.size);
    var tracking = +s.tracking || 0;
    var lines = String(s.text || '').split(/\r?\n/);
    var laid = lines.map(function (text) {
      return text ? line(font, text, 0, 0, size, tracking) : { d: '', width: 0 };
    });
    var widest = Math.max.apply(null, laid.map(function (l) { return l.width; }).concat([0]));
    var items = [];
    var y = size;
    lines.forEach(function (text, i) {
      if (text) {
        var x = s.align === 'centre' ? (widest - laid[i].width) / 2
              : s.align === 'right' ? widest - laid[i].width : 0;
        var d = line(font, text, x, y, size, tracking).d;
        if (d) items.push({ d: d, fill: '#000000', stroke: 'none', strokeWidth: 0 });
      }
      y += size * (+s.leading || DEFAULT.leading);
    });
    return items;
  }

  root.Text = { layout: layout, DEFAULT: DEFAULT };
})(typeof window !== 'undefined' ? window : this);
