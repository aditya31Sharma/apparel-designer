/* Brush gestures stay in source coordinates, including after rotation or flip. */
(function (root) {
  'use strict';
  function start(o) {
    var stage = o.stage, active = true, stroke = null, pointerId = null, space = false;
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:10';
    var group = document.createElementNS(NS, 'g'), trail = document.createElementNS(NS, 'path');
    var ring = document.createElementNS(NS, 'circle');
    trail.setAttribute('fill', 'none'); trail.setAttribute('stroke', '#808080');
    trail.setAttribute('stroke-opacity', '.7'); trail.setAttribute('stroke-linecap', 'round'); trail.setAttribute('stroke-linejoin', 'round');
    ring.setAttribute('fill', 'none'); ring.setAttribute('stroke', '#ffffff');
    ring.setAttribute('vector-effect', 'non-scaling-stroke'); ring.setAttribute('stroke-width', '1.5');
    group.append(trail, ring); svg.append(group); stage.append(svg); ring.style.display = 'none';
    var style = document.createElement('style');
    style.textContent = '#stage[data-eraser] * { cursor: crosshair !important; }';
    document.head.append(style); stage.setAttribute('data-eraser', '');

    function point(e) {
      var c = o.canvas.getBoundingClientRect(), p = o.viewport.toWorld(e.clientX - c.left, e.clientY - c.top);
      return root.Doc.applyMatrix(root.Doc.invert(root.Doc.layerMatrix(o.layer)), p.x, p.y);
    }
    function draw(e) {
      var m = root.Doc.layerMatrix(o.layer), v = o.viewport.view;
      var c = o.canvas.getBoundingClientRect(), s = stage.getBoundingClientRect(), p = point(e);
      group.setAttribute('transform', 'matrix(' + [m.a * v.k, m.b * v.k, m.c * v.k, m.d * v.k,
        (m.e - v.x) * v.k + c.left - s.left, (m.f - v.y) * v.k + c.top - s.top].join(' ') + ')');
      ring.setAttribute('cx', p.x); ring.setAttribute('cy', p.y); ring.setAttribute('r', o.size() / 2);
      ring.style.display = '';
      if (stroke) {
        trail.setAttribute('stroke-width', stroke.radius * 2);
        trail.setAttribute('d', stroke.points.map(function (q, i) { return (i ? 'L' : 'M') + q.x + ' ' + q.y; }).join(' ') + 'l0 .001');
      }
    }
    function claim(e) { e.preventDefault(); e.stopImmediatePropagation(); }
    function down(e) {
      if (!stage.contains(e.target) || e.button !== 0 || space || !o.ready()) return;
      claim(e); pointerId = e.pointerId;
      stroke = { radius: o.size() / 2, points: [point(e)] };
      stage.setPointerCapture(pointerId); draw(e);
    }
    function move(e) {
      if (stroke && e.pointerId === pointerId) {
        claim(e);
        var p = point(e), last = stroke.points[stroke.points.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) >= Math.max(.2, stroke.radius / 8)) stroke.points.push(p);
        draw(e);
      } else if (stage.contains(e.target)) draw(e);
      else ring.style.display = 'none';
    }
    function finish(e) {
      if (!stroke || e.pointerId !== pointerId) return;
      claim(e); var done = stroke; stroke = null;
      if (stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
      trail.setAttribute('d', ''); pointerId = null;
      if (e.type === 'pointerup') o.commit(done);
    }
    function key(e) {
      if (e.code === 'Space') space = e.type === 'keydown';
      if (e.key === 'Escape' && e.type === 'keydown') { claim(e); stop(); }
    }
    function stop() {
      if (!active) return;
      active = false; stroke = null;
      if (pointerId !== null && stage.hasPointerCapture(pointerId)) stage.releasePointerCapture(pointerId);
      stage.removeAttribute('data-eraser'); svg.remove(); style.remove();
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', finish, true);
      document.removeEventListener('pointercancel', finish, true);
      document.removeEventListener('keydown', key, true); document.removeEventListener('keyup', key, true);
      o.onStop();
    }
    document.addEventListener('pointerdown', down, true); document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', finish, true); document.addEventListener('pointercancel', finish, true);
    document.addEventListener('keydown', key, true); document.addEventListener('keyup', key, true);
    return stop;
  }
  root.ArtworkEraser = { start: start };
})(self);
