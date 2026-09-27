/* Outlines as flat numbers.
 *
 * Contours cross between the worker and the page as an x,y `points` array plus
 * a `offsets` array saying where each ring starts. Everything that needs them as
 * something else converts here, once, at the moment it actually needs to.
 *
 * The reason this exists: building a path string in the worker and parsing it
 * straight back into a Path2D on the page cost 93ms and 32ms respectively on a
 * photo trace, for no benefit. The string is only ever needed when a file is
 * written, so that is the only place it gets built.
 */
(function (root) {
  'use strict';

  /* Building one Path2D out of many contours is quadratic in the number of
   * subpaths in Chrome: a thousand rings takes 11ms, thirty thousand takes nine
   * and a half seconds. An eroded photo routinely produces tens of thousands,
   * which is where the multi-second freeze came from.
   *
   * Splitting the rings across several Path2D objects keeps each one small
   * enough that the quadratic never bites, and the total goes linear. Two
   * hundred and fifty rings apiece measured fastest across every size tried;
   * filling a handful of paths instead of one costs nothing. */
  var CHUNK = 250;

  function toPath2D(points, offsets) {
    return toPaths(points, offsets)[0] || new Path2D();
  }

  function toPaths(points, offsets) {
    var out = [];
    var rings = offsets.length - 1;
    var r = 0;
    while (r < rings) {
      var p = new Path2D();
      var end = Math.min(rings, r + CHUNK);
      var any = false;
      for (; r < end; r++) {
        var a = offsets[r], b = offsets[r + 1];
        if (b - a < 3) continue;
        p.moveTo(points[a * 2], points[a * 2 + 1]);
        for (var i = a + 1; i < b; i++) p.lineTo(points[i * 2], points[i * 2 + 1]);
        p.closePath();
        any = true;
      }
      if (any) out.push(p);
    }
    return out.length ? out : [new Path2D()];
  }

  function toPathData(points, offsets, precision) {
    var f = Math.pow(10, precision === undefined ? 2 : precision);
    var n = function (v) { return Math.round(v * f) / f; };
    var d = '';
    for (var r = 0; r < offsets.length - 1; r++) {
      var a = offsets[r], b = offsets[r + 1];
      if (b - a < 3) continue;
      d += 'M' + n(points[a * 2]) + ' ' + n(points[a * 2 + 1]);
      for (var i = a + 1; i < b; i++) {
        d += 'L' + n(points[i * 2]) + ' ' + n(points[i * 2 + 1]);
      }
      d += 'Z';
    }
    return d;
  }

  function bounds(points) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < points.length; i += 2) {
      var x = points[i], y = points[i + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /* An item may carry outlines either way round. Whatever asks for one form
   * gets it without caring which the producer chose. */
  function itemPath2D(item) {
    if (item.path2d) return item.path2d;
    if (item.points) return toPath2D(item.points, item.offsets);
    return new Path2D(item.d);
  }

  /* Every Path2D an item needs, as an array. Callers draw them in order. */
  function itemPaths(item) {
    if (item.paths) return item.paths;
    if (item.path2d) return [item.path2d];
    if (item.points) return toPaths(item.points, item.offsets);
    return [new Path2D(item.d)];
  }

  function itemPathData(item, precision) {
    if (item.d) return item.d;
    if (item.points) return toPathData(item.points, item.offsets, precision);
    return '';
  }

  function itemBounds(item) {
    if (item.points) return bounds(item.points);
    return root.Warp ? root.Warp.bounds([item.d]) : { x: 0, y: 0, width: 0, height: 0 };
  }

  function unionBounds(items) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    items.forEach(function (it) {
      var b = itemBounds(it);
      if (!b.width && !b.height) return;
      if (b.x < x0) x0 = b.x; if (b.x + b.width > x1) x1 = b.x + b.width;
      if (b.y < y0) y0 = b.y; if (b.y + b.height > y1) y1 = b.y + b.height;
    });
    if (!isFinite(x0)) return { x: 0, y: 0, width: 0, height: 0 };
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /* Buffers to hand to postMessage, so nothing gets copied on the way out. */
  function transferables(items) {
    var out = [];
    items.forEach(function (it) {
      if (it.points) out.push(it.points.buffer, it.offsets.buffer);
    });
    return out;
  }

  root.Geom = {
    toPath2D: toPath2D, toPaths: toPaths, toPathData: toPathData, bounds: bounds,
    itemPaths: itemPaths,
    itemPath2D: itemPath2D, itemPathData: itemPathData,
    itemBounds: itemBounds, unionBounds: unionBounds, transferables: transferables
  };
})(typeof module !== 'undefined' ? module.exports : self);
