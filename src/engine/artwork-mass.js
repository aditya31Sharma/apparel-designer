/* One silhouette for the printed mass; exported edits are traced vector paths. */
(function (root) {
  'use strict';
  var G = root.Grunge || require('./grunge.js').Grunge;
  var defaults = { outline: false, gap: 8, width: 3, colour: '#ffffff', switchBase: false, brushSize: 24, erasures: [] };

  function fillHoles(mask, w, h) {
    var outside = new Uint8Array(mask.length), queue = new Int32Array(mask.length), head = 0, tail = 0;
    function add(i) { if (!mask[i] && !outside[i]) { outside[i] = 1; queue[tail++] = i; } }
    for (var x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
    for (var y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
    while (head < tail) {
      var i = queue[head++], col = i % w;
      if (col) add(i - 1);
      if (col < w - 1) add(i + 1);
      if (i >= w) add(i - w);
      if (i < mask.length - w) add(i + w);
    }
    return outside.map(function (v) { return v ? 0 : 1; });
  }

  function masks(ink, w, h, options) {
    var bridge = options.bridge || 0, envelope = ink.slice();
    if (bridge > 0 && ink.some(Boolean)) {
      var grow = G.edt2d(ink, w, h, false).map(function (v) { return v <= bridge * bridge ? 1 : 0; });
      var shrink = G.edt2d(fillHoles(grow, w, h), w, h, true);
      envelope = ink.map(function (v, i) { return v || shrink[i] > bridge * bridge ? 1 : 0; });
    }
    envelope = fillHoles(envelope, w, h);
    var distance = G.edt2d(envelope, w, h, false);
    var gap = Math.max(0, options.gap || 0), edge = gap + Math.max(0, options.width || 0);
    var base = new Uint8Array(ink.length), outline = new Uint8Array(ink.length);
    for (var i = 0; i < ink.length; i++) {
      var inner = distance[i] <= gap * gap;
      base[i] = inner && !ink[i] ? 1 : 0;
      outline[i] = !inner && distance[i] <= edge * edge ? 1 : 0;
    }
    return { envelope: envelope, base: base, outline: outline };
  }

  function active(p) { return !!(p && (p.outline || p.switchBase || (p.erasures && p.erasures.length))); }

  function apply(render, box, options) {
    var p = Object.assign({}, defaults, options);
    if (!active(p)) return render;
    var span = Math.max(box.width, box.height, 1), bridge = span * 0.01;
    var strokePad = (render.shapes || []).reduce(function (n, sh) { return Math.max(n, (sh.strokeWidth || 0) / 2); }, 0);
    var margin = Math.max(p.gap + p.width, bridge * 2) + strokePad + 2;
    var scale = Math.min(3, 1536 / (span + margin * 2));
    var pad = Math.ceil(margin * scale) + 2;
    var w = Math.ceil(box.width * scale) + pad * 2, h = Math.ceil(box.height * scale) + pad * 2;
    var ox = box.x - pad / scale, oy = box.y - pad / scale;
    var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var ink = new Uint8Array(w * h), erased;
    var tracePaint = p.erasures.length > 0 || (render.clips || []).length > 0;
    var shapes = p.switchBase || tracePaint ? [] : (render.shapes || []).slice();
    var plates = p.switchBase ? null : tracePaint && render.plates ? [] : render.plates;
    var aggregate = !tracePaint || p.switchBase, scratch = null;

    function reset() {
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
      ctx.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
      ctx.fillStyle = ctx.strokeStyle = '#000000'; ctx.lineCap = ctx.lineJoin = 'round';
      ctx.globalCompositeOperation = 'source-over';
    }
    function read() {
      var pixels = ctx.getImageData(0, 0, w, h).data, mask = new Uint8Array(w * h);
      for (var i = 0; i < mask.length; i++) mask[i] = pixels[i * 4 + 3] >= 128 ? 1 : 0;
      return mask;
    }
    reset();
    p.erasures.forEach(function (stroke) {
      if (!stroke.points.length) return;
      ctx.lineWidth = stroke.radius * 2;
      ctx.beginPath(); ctx.arc(stroke.points[0].x, stroke.points[0].y, stroke.radius, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      stroke.points.slice(1).forEach(function (q) { ctx.lineTo(q.x, q.y); }); ctx.stroke();
    });
    erased = read();
    reset();

    function collect(paths, colour, strokeWidth, rule, isPlate) {
      if (!colour || colour === 'none') return;
      if (!aggregate) reset();
      ctx.save();
      (render.clips || []).forEach(function (clip) { ctx.clip(clip.path || new Path2D(clip.d)); });
      if (strokeWidth) {
        ctx.lineWidth = strokeWidth; paths.forEach(function (path) { ctx.stroke(path); });
      } else {
        // Contour chunks can contain holes in a different chunk from their shell.
        if (aggregate && !isPlate && paths.length > 1) {
          if (!scratch) { scratch = document.createElement('canvas'); scratch.width = w; scratch.height = h; }
          var g = scratch.getContext('2d');
          g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, w, h);
          g.setTransform(scale, 0, 0, scale, -ox * scale, -oy * scale);
          g.globalCompositeOperation = 'xor';
          paths.forEach(function (path) { g.fill(path, 'evenodd'); });
          ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(scratch, 0, 0);
        } else {
          if (!isPlate && paths.length > 1) ctx.globalCompositeOperation = 'xor';
          paths.forEach(function (path) { ctx.fill(path, rule || 'nonzero'); });
        }
      }
      ctx.restore();
      if (aggregate) return;
      var mask = read();
      for (var i = 0; i < ink.length; i++) { if (erased[i]) mask[i] = 0; if (mask[i]) ink[i] = 1; }
      if (tracePaint && !p.switchBase) {
        var shape = vector(mask, colour);
        if (isPlate) plates.push({ key: isPlate.key, label: isPlate.label, colour: colour,
          d: root.Geom.itemPathData(shape), paths: shape.paths, rule: 'evenodd' });
        else shapes.push(shape);
      }
    }
    (render.shapes || []).forEach(function (shape) {
      collect(shape.paths, shape.fill, 0, shape.rule, false);
      if (shape.strokeWidth > 0) collect(shape.paths, shape.stroke, shape.strokeWidth, null, false);
    });
    (render.plates || []).forEach(function (plate) { collect(plate.paths, plate.colour, 0, null, plate); });
    if (aggregate) { ink = read(); for (var i = 0; i < ink.length; i++) if (erased[i]) ink[i] = 0; }

    function vector(mask, colour) {
      for (var i = 0; i < mask.length; i++) if (erased[i]) mask[i] = 0;
      var rings = G.traceRings(mask, w, h);
      var arrays = G.ringsToArrays(rings, { scale: 1 / scale, ox: ox, oy: oy });
      return Object.assign(arrays, { paths: root.Geom.toPaths(arrays.points, arrays.offsets),
        fill: colour, stroke: 'none', strokeWidth: 0, rule: 'evenodd' });
    }

    if (p.outline || p.switchBase) {
      var result = masks(ink, w, h, { gap: p.gap * scale, width: p.width * scale, bridge: bridge * scale });
      if (p.switchBase) shapes.push(vector(result.base, p.colour));
      if (p.outline && p.width > 0) shapes.push(vector(result.outline, p.colour));
    }
    return { shapes: shapes, plates: plates, clips: [], bbox: {
      x: box.x - margin, y: box.y - margin, width: box.width + margin * 2, height: box.height + margin * 2
    } };
  }

  root.ArtworkMass = { defaults: defaults, active: active, masks: masks, apply: apply };
})(typeof module !== 'undefined' ? module.exports : self);
