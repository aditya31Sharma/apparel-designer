/* SVG out.
 *
 * Path data gets built here and nowhere else. During interaction the geometry
 * lives as typed arrays and Path2D objects; turning 200,000 numbers into a
 * string is only worth paying for when a file is actually being written.
 *
 * Halftone plates come out as one compound path per ink inside a multiply
 * group, so Illustrator opens four objects rather than a hundred thousand.
 */
(function (root) {
  'use strict';

  function H() { return root.Halftone; }

  function round(v, p) { var f = Math.pow(10, p); return Math.round(v * f) / f; }

  function matrixAttr(m, p) {
    if (Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 &&
        Math.abs(m.d - 1) < 1e-9 && Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9) return '';
    return ' transform="matrix(' + [m.a, m.b, m.c, m.d, m.e, m.f]
      .map(function (v) { return round(v, 6); }).join(' ') + ')"';
  }

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  }

  /* Bounds of everything, in document space, so the viewBox holds the artwork
   * after the transform rather than before it. */
  function documentBounds(renders) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    renders.forEach(function (R) {
      var m = R.matrix;
      var b = R.bbox;
      if (!b) return;
      [[b.x, b.y], [b.x + b.width, b.y], [b.x + b.width, b.y + b.height], [b.x, b.y + b.height]]
        .forEach(function (pt) {
          var x = m.a * pt[0] + m.c * pt[1] + m.e;
          var y = m.b * pt[0] + m.d * pt[1] + m.f;
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        });
    });
    if (!isFinite(x0)) return { x: 0, y: 0, width: 1, height: 1 };
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /* One plate to path data, using the same outline routine the viewport draws. */
  function platePath(plate, pattern, fuzziness, seed, precision) {
    var sink = H().PathSink(precision === undefined ? 2 : precision);
    var d = plate.dots;
    for (var o = 0; o < d.length; o += H().STRIDE) {
      H().emitDot(sink, pattern, d[o], d[o + 1], d[o + 2], d[o + 3], fuzziness, seed | 0);
    }
    return sink.get();
  }

  /* renders: [{ matrix, bbox, shapes:[{d,fill,stroke,strokeWidth}],
   *             plates:[{key,label,colour,dots}], pattern, fuzziness, seed,
   *             opacity, name }]
   * opts:    { separations, precision, background } */
  function build(renders, opts) {
    var o = opts || {};
    var prec = o.precision === undefined ? 2 : o.precision;
    var b = documentBounds(renders);
    var maxStroke = 0;
    var body = [];

    renders.forEach(function (R) {
      var tf = matrixAttr(R.matrix, prec);
      var alpha = (R.opacity === undefined || R.opacity >= 1)
        ? '' : ' opacity="' + round(R.opacity, 3) + '"';
      var open = '  <g' + (R.name ? ' id="' + esc(R.name) + '"' : '') + tf + alpha + '>';
      var parts = [];

      /* The ground the ink sits on, whether that ink is a screen or an outline
       * traced from a photograph. It travels with the artwork so the file
       * opens looking like the canvas did. */
      if (R.paper && R.paper !== 'none' && R.bbox) {
        parts.push('    <rect x="' + round(R.bbox.x, prec) + '" y="' + round(R.bbox.y, prec) +
          '" width="' + round(R.bbox.width, prec) + '" height="' + round(R.bbox.height, prec) +
          '" fill="' + R.paper + '"/>');
      }

      /* A photo nothing has been applied to yet. It leaves as the picture it
       * is, embedded, because a file that opens empty is not an export of what
       * was on the canvas. Switch an effect on and it leaves as geometry, which
       * is what this tool is for. */
      if (R.image && R.bbox) {
        parts.push('    <image x="' + round(R.bbox.x, prec) + '" y="' + round(R.bbox.y, prec) +
          '" width="' + round(R.bbox.width, prec) + '" height="' + round(R.bbox.height, prec) +
          '" preserveAspectRatio="none" href="' + R.image + '"/>');
      }

      (R.shapes || []).forEach(function (sh) {
        var a = ' fill="' + (sh.fill && sh.fill !== 'none' ? sh.fill : 'none') + '"';
        if (sh.rule === 'evenodd') a += ' fill-rule="evenodd"';
        if (sh.stroke && sh.stroke !== 'none' && sh.strokeWidth > 0) {
          maxStroke = Math.max(maxStroke, sh.strokeWidth);
          a += ' stroke="' + sh.stroke + '" stroke-width="' + round(sh.strokeWidth, 3) +
               '" stroke-linejoin="round" stroke-linecap="round"';
        }
        parts.push('    <path d="' + sh.d + '"' + a + '/>');
      });

      if (R.plates && R.plates.length) {
        if (o.separations) {
          // One group per ink, named, nothing blended. This is what a printer
          // asks for when they want the plates apart.
          R.plates.forEach(function (pl) {
            parts.push('    <g id="' + esc(pl.label) + '">');
            parts.push('      <path d="' + platePath(pl, R.pattern, R.fuzziness, R.seed, prec) +
                       '" fill="' + pl.colour + '"/>');
            parts.push('    </g>');
          });
        } else {
          parts.push('    <g style="mix-blend-mode:multiply">');
          R.plates.forEach(function (pl) {
            parts.push('      <path d="' + platePath(pl, R.pattern, R.fuzziness, R.seed, prec) +
                       '" fill="' + pl.colour + '" data-ink="' + esc(pl.label) + '"/>');
          });
          parts.push('    </g>');
        }
      }

      if (parts.length) body.push(open, parts.join('\n'), '  </g>');
    });

    var pad = 1 + maxStroke / 2;
    var vb = [round(b.x - pad, prec), round(b.y - pad, prec),
              round(b.width + pad * 2, prec), round(b.height + pad * 2, prec)];
    var head = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.join(' ') +
      '" width="' + Math.max(1, Math.round(b.width + pad * 2)) +
      '" height="' + Math.max(1, Math.round(b.height + pad * 2)) + '">';
    var bg = o.background
      ? '\n  <rect x="' + vb[0] + '" y="' + vb[1] + '" width="' + vb[2] +
        '" height="' + vb[3] + '" fill="' + o.background + '"/>'
      : '';
    return head + bg + '\n' + body.join('\n') + '\n</svg>\n';
  }

  root.SvgOut = { build: build, platePath: platePath, documentBounds: documentBounds };
})(typeof module !== 'undefined' ? module.exports : self);
