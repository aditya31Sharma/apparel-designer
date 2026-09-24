/* Snapping for the corner handles.
 *
 * Three kinds, in the order they win ties: alignment with the other corners,
 * the source shape's own edges and centre, then the pixel grid. Everything is
 * measured in world units; the threshold arrives already converted from screen
 * pixels so the feel stays constant at any zoom.
 */
(function (root) {
  'use strict';

  function targets(corners, moving, bbox) {
    var xs = [], ys = [];
    corners.forEach(function (c, i) {
      if (i === moving) return;
      xs.push({ v: c.x, kind: 'corner' });
      ys.push({ v: c.y, kind: 'corner' });
    });
    if (bbox) {
      var cx = bbox.x + bbox.width / 2, cy = bbox.y + bbox.height / 2;
      xs.push({ v: bbox.x, kind: 'edge' }, { v: bbox.x + bbox.width, kind: 'edge' },
              { v: cx, kind: 'centre' });
      ys.push({ v: bbox.y, kind: 'edge' }, { v: bbox.y + bbox.height, kind: 'edge' },
              { v: cy, kind: 'centre' });
    }
    return { xs: xs, ys: ys };
  }

  function nearest(value, list, tol) {
    var best = null, bestD = tol;
    for (var i = 0; i < list.length; i++) {
      var d = Math.abs(list[i].v - value);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  /* opts: { corners, moving, bbox, tol, grid, pixel, align }
   * Returns { x, y, guides: [{axis, v, kind}] } */
  function apply(x, y, opts) {
    var guides = [];
    var t = targets(opts.corners, opts.moving, opts.bbox);

    if (opts.align !== false) {
      var gx = nearest(x, t.xs, opts.tol);
      if (gx) { x = gx.v; guides.push({ axis: 'x', v: gx.v, kind: gx.kind }); }
      var gy = nearest(y, t.ys, opts.tol);
      if (gy) { y = gy.v; guides.push({ axis: 'y', v: gy.v, kind: gy.kind }); }
    }

    // Pixel snapping only applies to an axis that alignment did not already claim,
    // otherwise rounding would drag the handle back off the guide.
    if (opts.pixel !== false && opts.grid > 0) {
      var tookX = guides.some(function (g) { return g.axis === 'x'; });
      var tookY = guides.some(function (g) { return g.axis === 'y'; });
      if (!tookX) x = Math.round(x / opts.grid) * opts.grid;
      if (!tookY) y = Math.round(y / opts.grid) * opts.grid;
    }
    return { x: x, y: y, guides: guides };
  }

  root.Snap = { apply: apply };
})(typeof module !== 'undefined' ? module.exports : window);
