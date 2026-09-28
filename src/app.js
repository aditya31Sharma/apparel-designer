/* Apparel Designer.
 *
 * Orchestration only: the document lives in doc/model.js, the effects in
 * doc/register-effects.js, the drawing in view/viewport.js, and the heavy
 * compute in a worker. This file wires them together and owns the panels.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var Doc = window.Doc, Effects = window.Effects, W = window.Warp, H = window.Halftone;

  /* Anything that throws during boot used to leave a blank window with no clue
   * why, so every error lands somewhere visible. */
  window.addEventListener('error', function (e) {
    fail((e.message || 'error') + '  @' +
      String(e.filename || '').split('/').pop() + ':' + e.lineno);
  });

  var doc = Doc.makeDoc();
  var history = Doc.History(80);
  var viewport, overlay, panels = {}, worker = null;
  var generation = 0, pending = null, interactive = false, idleTimer = null;
  var pixelsSent = null;          // which layer's pixels the worker already holds
  var lastPool = 1;
  var watchdog = null, restarts = 0;
  var renders = {};                 // layerId -> drawable result
  var tool = 'warp';
  var textureImage = null, textureName = '';

  /* ---------- error surface ---------- */

  function fail(msg) {
    var box = $('err');
    if (!box) return;
    box.textContent = msg;
    box.classList.add('on');
  }
  function clearFail() { var b = $('err'); if (b) b.classList.remove('on'); }

  /* ================= compute ================= */

  function startWorker() {
    try {
      worker = new Worker('src/workers/effects.worker.js');
      worker.onmessage = onWorkerMessage;
      worker.onerror = function (e) {
        fail('worker: ' + (e.message || 'failed') + ' (falling back to the main thread)');
        worker = null;
      };
    } catch (err) {
      worker = null;              // file:// without a server, or a blocked worker
    }
  }

  /* Ask for a recompute. While a slider is held the job runs at reduced
   * resolution, which is roughly six times cheaper and indistinguishable at
   * screen size; the full-quality pass follows when the drag stops. */
  /* Two passes per change: a reduced one now, the real one once the input stops.
   *
   * The full pass is armed only after the preview has landed, never on a timer
   * running alongside it. Arming it on a timer meant a drag that produced a
   * result every 80ms had the full pass superseding the preview before it
   * arrived, so every preview was computed, thrown away, and then waited on
   * anyway. The wait a person felt was both passes, not the cheap one. */
  var SETTLE_MS = 160;
  var wantFull = false;

  function markDirty(live) {
    interactive = !!live;
    clearTimeout(idleTimer);
    wantFull = !!live;
    compute(live ? 0.42 : 1);
  }

  /* Called once a result has been accepted. If that was a preview and nothing
   * new has come in since, queue the real thing. */
  function armFullPass() {
    if (!wantFull) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!wantFull) return;
      wantFull = false;
      compute(1);
    }, SETTLE_MS);
  }

  function compute(quality) {
    var layer = Doc.selected(doc);
    if (!layer) { renders = {}; paint(); return; }

    var job = {
      kind: 'run',
      generation: ++generation,
      items: layer.source.items.map(function (i) {
        return { d: i.d, frame: i.frame, fill: i.fill, stroke: i.stroke,
                 strokeWidth: i.strokeWidth };
      }),
      bbox: layer.source.bbox,
      effects: layer.effects.map(function (e) {
        return { type: e.type, on: e.on, params: JSON.parse(JSON.stringify(e.params)) };
      }),
      quality: quality,
      matte: layer.matte,
      textureImage: textureImage,
      noPool: !!window.__noPool,
      sourceId: layer.id
    };

    // A photo's pixels go over once and stay cached in the worker. Copying four
    // megabytes on every slider tick would cost more than the screen itself.
    if (layer.source.pixels && pixelsSent !== layer.id) {
      var px = layer.source.pixels;
      job.pixels = { data: new Uint8ClampedArray(px.data), w: px.w, h: px.h };
      pixelsSent = layer.id;
    }

    if (worker) {
      pending = { layer: layer, generation: job.generation };
      // The photo's pixels are a copy made for this message, so hand ownership
      // over rather than letting postMessage clone another 27MB of them.
      var transfer = job.pixels ? [job.pixels.data.buffer] : [];
      worker.postMessage(job, transfer);
      armWatchdog(job.generation);
    } else {
      runLocally(job, layer);
    }
  }

  /* A worker that stops answering leaves the canvas frozen with no explanation,
   * which reads as the whole app having hung. Give every job a ceiling; if one
   * passes it, say so, throw the worker away and start a fresh one. */
  var WATCHDOG_MS = 20000;

  function armWatchdog(gen) {
    clearTimeout(watchdog);
    watchdog = setTimeout(function () {
      if (gen !== generation) return;          // superseded, nothing to rescue
      restartWorker('the background worker stopped responding');
    }, WATCHDOG_MS);
  }

  function restartWorker(why) {
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;
    pixelsSent = null;
    restarts++;
    if (restarts > 3) {
      fail(why + '. Falling back to the main thread.');
      markDirty(false);
      return;
    }
    fail(why + '. Restarting it and retrying.');
    startWorker();
    markDirty(false);
  }

  /* The same stack, on the main thread. Only used when a worker cannot start. */
  function runLocally(job, layer) {
    try {
      var ctx = {
        quality: job.quality, textureImage: job.textureImage,
        rasterize: window.Raster.rasterize, traceImage: window.Raster.traceImage,
        maskFromPaths: window.Grunge.maskFromPaths
      };
      var t0 = performance.now();
      Effects.runStack({ effects: job.effects },
        { items: job.items, bbox: job.bbox, matte: job.matte,
          pixels: layer.source.pixels, sourceId: layer.id }, ctx).then(function (run) {
        acceptResult(layer, run.result, run.stats, job.generation,
          Math.round(performance.now() - t0));
        armFullPass();
        if (window.__onResult) { var g = window.__onResult; window.__onResult = null; g(); }
      }).catch(function (err) { fail(err.message || String(err)); });
    } catch (err) {
      fail(err.message || String(err));
    }
  }

  function onWorkerMessage(e) {
    var m = e.data;
    clearTimeout(watchdog);
    if (m.kind === 'error') { fail(m.message); return; }
    if (m.kind !== 'done' || m.generation !== generation) return;
    var layer = pending && pending.layer;
    if (!layer) return;
    if (m.poolProblem) fail('erosion pool: ' + m.poolProblem + ' (running single threaded)');
    lastPool = m.pool || 1;
    // Read by the benchmark and suite harnesses. Nothing in the app uses them.
    window.__lastBreakdown = m.breakdown || null;
    window.__lastHT = m.stats && m.stats.halftone ? m.stats.halftone : null;
    window.__lastStats = m.stats || null;
    acceptResult(layer, m, m.stats, m.generation, m.ms);
    armFullPass();
    // Signalled last, once the scene and the readouts are actually updated.
    // Firing it first meant a harness read the previous render's numbers and
    // every measurement came out one step behind.
    if (window.__onResult) { var f = window.__onResult; window.__onResult = null; f(); }
  }

  /* Turn engine output into things the canvas can draw. This is the only place
   * Path2D objects are built, and it happens once per compute, never per frame. */
  function acceptResult(layer, out, stats, gen, ms) {
    if (gen !== generation) return;
    clearFail();
    var tAccept = performance.now();

    var shapes = (out.items || []).map(function (it) {
      return {
        points: it.points, offsets: it.offsets, d: it.d,
        paths: window.Geom.itemPaths(it),
        fill: it.fill, stroke: it.stroke, strokeWidth: it.strokeWidth || 0
      };
    });

    var plates = null;
    if (out.plates && out.plates.length) {
      plates = out.plates.map(function (pl) {
        return {
          key: pl.key, label: pl.label, colour: pl.colour, dots: pl.dots,
          paths: viewport.platePaths(pl, out.pattern, out.fuzziness, out.seed)
        };
      });
    }

    renders[layer.id] = {
      shapes: shapes, plates: plates, paper: out.paper,
      pattern: out.pattern, fuzziness: out.fuzziness, seed: out.seed,
      bbox: out.bbox || layer.source.bbox
    };
    window.__timing = window.__timing || {};
    window.__timing.buildPaths = Math.round(performance.now() - tAccept);
    window.__timing.workerMs = ms;
    var tPaint = performance.now();
    showStats(stats, ms, shapes, plates, out.pattern);
    paint();
    window.__timing.firstPaint = Math.round(performance.now() - tPaint);
  }

  /* Roughly how big the SVG will be, without building it.
   *
   * A fine screen over a large photo is half a million dots and twenty-odd
   * megabytes. That is a fair file for that much geometry, but finding out by
   * pressing Save is not fair, so the number is on screen beforehand. */
  function estimateBytes(shapes, plates, pattern) {
    var bytes = 260;
    if (plates) {
      // Calibrated against real exports, rounded up: a figure that surprises
      // you by being low is worse than one that is a little cautious.
      var per = pattern === 'round' ? 62 : pattern === 'cross' ? 142 : 78;
      plates.forEach(function (p) { bytes += (p.dots.length / H.STRIDE) * per; });
    }
    (shapes || []).forEach(function (sh) {
      bytes += sh.points ? sh.points.length * 7.5 : (sh.d ? sh.d.length : 0);
    });
    return bytes;
  }

  function fmtBytes(b) {
    if (b > 1048576) return (b / 1048576).toFixed(b > 10485760 ? 0 : 1) + 'MB';
    return Math.max(1, Math.round(b / 1024)) + 'KB';
  }

  function showStats(stats, ms, shapes, plates, pattern) {
    var bits = [];
    if (plates) {
      var n = 0;
      plates.forEach(function (p) { n += p.dots.length / H.STRIDE; });
      bits.push(fmtN(n) + ' dots', plates.length + ' plates');
    }
    if (shapes && shapes.length) bits.push(fmtN(shapes.length) + ' shapes');
    var s = stats || {};
    if (s.halftone && s.halftone.pitch) {
      bits.push(Math.round(s.halftone.pitch * 10) / 10 + 'px pitch');
    }
    if (s.dither) bits.push(fmtN(s.dither.shapes) + ' contours');
    if (ms !== undefined) bits.push(ms + 'ms');
    if (lastPool > 1) bits.push(lastPool + ' threads');

    var est = estimateBytes(shapes, plates, pattern);
    var box = $('stats');
    if (box) box.textContent = bits.join('  ·  ');
    var size = $('exportSize');
    if (size) {
      size.textContent = (shapes && shapes.length) || plates ? '~' + fmtBytes(est) : '';
      size.classList.toggle('heavy', est > 8 * 1048576);
    }
  }
  function fmtN(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  /* ---------- scene ---------- */

  function paint() {
    var scene = { layers: [] };
    doc.layers.forEach(function (L) {
      var r = renders[L.id];
      if (!r) return;
      var paintDef = paintFor(L);
      scene.layers.push({
        matrix: Doc.layerMatrix(L),
        opacity: L.paint.opacity,
        shapes: r.plates ? null : r.shapes.map(function (sh) {
          return {
            paths: sh.paths,
            fill: paintDef.useSource ? sh.fill : paintDef.fill,
            stroke: paintDef.useSource ? sh.stroke : paintDef.stroke,
            strokeWidth: paintDef.useSource ? sh.strokeWidth : paintDef.strokeWidth
          };
        }),
        plates: r.plates,
        paper: r.plates ? r.paper : null,
        bbox: r.bbox
      });
    });
    viewport.setScene(scene);
    overlay.layer = Doc.selected(doc);
    overlay.view = viewport.view;
    overlay.mode = tool === 'warp' ? 'warp' : 'transform';
    overlay.draw();
    syncHud();
  }

  function paintFor(L) {
    var p = L.paint;
    return {
      useSource: p.useSourceColours,
      fill: p.fillOn ? p.fill : 'none',
      stroke: p.strokeWidth > 0 ? p.stroke : 'none',
      strokeWidth: p.strokeWidth
    };
  }

  /* ================= panels ================= */

  /* One accessor object per panel. `get` and `set` address either the layer's
   * own fields or the current effect's params, so the spec entries stay flat. */
  function apiFor(scope) {
    return {
      get: function (id) {
        var L = Doc.selected(doc);
        if (!L) return undefined;
        // `__on` is the effect's own switch, which lives on the stack entry
        // rather than among its parameters.
        if (id === '__on') return scope === 'layer' ? true : Doc.effect(L, scope).on;
        if (id === 'lockRatio') return !!L.lockRatio;
        return readPath(scope === 'layer' ? L : Doc.effect(L, scope).params, id);
      },
      set: function (id, v, live) {
        var L = Doc.selected(doc);
        if (!L) return;
        if (!live) history.push(doc);
        if (id === '__on') {
          Doc.effect(L, scope).on = v;
          overlay.lockRatio = !!L.lockRatio;
          markDirty(false);
          return;
        }
        if (id === 'lockRatio') { L.lockRatio = v; overlay.lockRatio = v; return; }
        writePath(scope === 'layer' ? L : Doc.effect(L, scope).params, id, v);
        if (scope !== 'layer') onParamChanged(scope, id, v);
        markDirty(live);
      },
      commit: function () { syncPanels(); },
      visible: function (cond) { return conditionHolds(scope, cond); }
    };
  }

  function readPath(obj, path) {
    return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, obj);
  }
  function writePath(obj, path, v) {
    var parts = path.split('.');
    var last = parts.pop();
    var target = parts.reduce(function (o, k) { return o[k] || (o[k] = {}); }, obj);
    target[last] = v;
  }

  /* Some parameters imply others: picking an angle preset rewrites the four
   * angles, picking a mode limits the channels, picking a style loads a set. */
  function onParamChanged(scope, id, v) {
    var L = Doc.selected(doc);
    var p = Doc.effect(L, scope).params;
    if (scope === 'halftone') {
      if (id === 'anglePreset' && H.ANGLE_PRESETS[v]) {
        p.angles = Object.assign({}, H.ANGLE_PRESETS[v]);
      }
      if (id === 'preset' && HALFTONE_PRESETS[v]) {
        Object.assign(p, JSON.parse(JSON.stringify(HALFTONE_PRESETS[v].params)));
      }
    }
    if (scope === 'dither') {
      if (id === 'preset' && DITHER_PRESETS[v]) {
        Object.assign(p, JSON.parse(JSON.stringify(DITHER_PRESETS[v].params)));
      }
      // Choosing Import asks for the file rather than silently doing nothing.
      if (id === 'texture' && v === 'image' && !textureImage) $('textureFile').click();
      if (id === 'texture' && v !== 'none' && p.textureAmount === 0) p.textureAmount = 0.4;
    }
  }

  function conditionHolds(scope, cond) {
    var L = Doc.selected(doc);
    if (!L) return false;
    var p = scope === 'layer' ? L : Doc.effect(L, scope).params;
    if (cond === 'duotone') return p.mode === 'duotone' || p.mode === 'mono';
    if (cond === 'cmyk') return p.mode === 'cmyk';
    if (cond === 'texture') return p.texture && p.texture !== 'none';
    return true;
  }

  function syncPanels() {
    Object.keys(panels).forEach(function (k) { panels[k].sync(); });
    syncChrome();
    // Controls that act on a layer read as live until there is one.
    var has = !!Doc.selected(doc);
    document.body.classList.toggle('empty', !has);
  }

  /* ================= loading artwork ================= */

  function loadItems(items, name, bitmap, pixels) {
    var bbox = W.bounds(items.map(function (i) { return i.d; }));
    if (!bbox.width || !bbox.height) { fail('That artwork has no area'); return; }

    var layer = Doc.makeLayer({
      items: items, bbox: bbox, bitmap: bitmap || null, pixels: pixels || null
    }, name);
    Doc.ensureStack(layer, Effects.ids(), Effects.defaultsFor);
    // Nothing is applied on import. The artwork looks exactly as it arrived.
    layer.effects.forEach(function (e) { e.on = false; });
    layer.paint.useSourceColours = true;

    doc.layers = [layer];
    doc.selection = layer.id;
    renders = {};
    pixelsSent = null;
    history.clear();

    $('srcName').textContent = name + '  ·  ' +
      Math.round(bbox.width) + ' x ' + Math.round(bbox.height) + ' px';
    $('drop').classList.remove('on');
    $('empty').classList.add('gone');
    clearFail();
    syncPanels();
    compute(1);
    setTimeout(function () { viewport.fit(bbox); }, 0);
  }

  function loadMarkup(markup, name) {
    try {
      var r = window.SvgIn.parse(markup);
      loadItems(r.items, name || 'pasted.svg');
    } catch (err) {
      fail(err.message || String(err));
    }
  }

  var PIXEL_CAP = 2600;      // plenty for any screen frequency worth printing

  function loadImageFile(file) {
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      URL.revokeObjectURL(url);
      // The pixels are pulled out once, here, because an HTMLImageElement
      // cannot be handed to a worker and re-reading it per keystroke would be
      // the slowest thing in the app.
      var nw = img.naturalWidth, nh = img.naturalHeight;
      var sc = Math.min(1, PIXEL_CAP / Math.max(nw, nh));
      var pw = Math.max(1, Math.round(nw * sc)), ph = Math.max(1, Math.round(nh * sc));
      var c = window.Raster.canvasOf(pw, ph);
      var g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, pw, ph);
      var pixels = { data: g.getImageData(0, 0, pw, ph).data, w: pw, h: ph };

      // The frame keeps the image's own proportions; the pixels ride along.
      var w = nw, h = nh;
      var d = 'M0 0H' + w + 'V' + h + 'H0Z';
      // `frame: true` marks this as a stand-in for the picture rather than
      // artwork in its own right. Effects use it to decide whether they still
      // need to trace the photo or are already looking at real outlines.
      loadItems([{ d: d, frame: true, fill: 'none', stroke: 'none', strokeWidth: 0 }],
        file.name, img, pixels);
      var L = Doc.selected(doc);
      if (L) {
        // An image on its own has nothing to show until an effect runs, so give
        // it the halftone straight away: that is what an image is here for.
        // A traced photo has no colours of its own worth keeping, so the Fill
        // control drives it. Halftone ignores this and uses its plates.
        L.paint.useSourceColours = false;
        // Dot pitch holds whatever size the artwork is, so nothing has to be
        // recalculated here any more.
        Doc.effect(L, 'halftone').on = true;
        tool = 'halftone';
        syncPanels();
        markDirty(false);
      }
    };
    img.onerror = function () { fail('Could not read that image'); };
    img.src = url;
  }

  function isImage(file) {
    return /^image\/(png|jpeg|jpg|webp|gif|bmp|avif)$/i.test(file.type) ||
           /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
  }

  function openFile(f) {
    if (!f) return;
    if (isImage(f)) loadImageFile(f);
    else f.text().then(function (t) { loadMarkup(t, f.name); });
  }

  /* ================= export ================= */

  function buildRenders() {
    return doc.layers.map(function (L) {
      var r = renders[L.id];
      if (!r) return null;
      var pd = paintFor(L);
      return {
        name: L.name,
        matrix: Doc.layerMatrix(L),
        bbox: r.bbox,
        opacity: L.paint.opacity,
        shapes: r.plates ? [] : r.shapes.map(function (sh) {
          return {
            d: window.Geom.itemPathData(sh),
            fill: pd.useSource ? sh.fill : pd.fill,
            stroke: pd.useSource ? sh.stroke : pd.stroke,
            strokeWidth: pd.useSource ? sh.strokeWidth : pd.strokeWidth
          };
        }),
        plates: r.plates,
        paper: r.plates ? r.paper : null,
        pattern: r.pattern, fuzziness: r.fuzziness, seed: r.seed
      };
    }).filter(Boolean);
  }

  function svgText(separations) {
    return window.SvgOut.build(buildRenders(), {
      separations: !!separations,
      precision: 2
    });
  }

  /* ================= boot ================= */

  function boot() {
    viewport = window.Viewport.create($('canvas'), {
      onViewChange: function () {
        overlay.view = viewport.view;
        overlay.draw();
        syncHud();
      },
      onHit: function (e, world) {
        var i = overlay.hitCorner(world);
        if (i >= 0) { overlay.setSelected(i); return false; }
        overlay.setSelected(-1);
        return false;
      }
    });

    overlay = window.Overlay.create($('overlay'), {
      onChange: function () { markDirty(true); },
      onCommit: function () { markDirty(false); syncPanels(); },
      snapOptions: function (movingIndex) {
        var L = Doc.selected(doc);
        var t = L.transform;
        var entry = Doc.effect(L, 'warp');
        var cn = (entry.params.corners || W.DEFAULT_CORNERS).map(function (c) {
          return { x: t.x + c.x * t.width, y: t.y + c.y * t.height };
        });
        return {
          pixel: $('snapPixel') ? $('snapPixel').checked : true,
          align: $('snapAlign') ? $('snapAlign').checked : true,
          step: overlay.gridStep || 1,
          corners: cn, moving: movingIndex,
          bbox: { x: t.x, y: t.y, width: t.width, height: t.height },
          tol: 7 / viewport.view.k
        };
      }
    });
    overlay.view = viewport.view;
    overlay.gridStep = 1;

    buildPanels();
    startWorker();
    wireDesktop();
    wireChrome();
    wireFiles();
    wireKeys();
    syncPanels();
    paint();
    // Last line of boot on purpose: reaching it is the proof that whatever
    // source this launch is running actually works.
    if (window.Updater) window.Updater.start();
  }

  /* ---------- chrome ---------- */

  function wireChrome() {
    $('open').onclick = function () { $('file').click(); };
    $('file').onchange = function () { openFile(this.files[0]); this.value = ''; };

    $('pasteBtn').onclick = function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        return fail('Press Cmd V instead, this build will not read the clipboard on demand');
      }
      navigator.clipboard.readText().then(function (t) {
        if (t && t.indexOf('<') >= 0) loadMarkup(t, 'pasted.svg');
        else fail('No SVG markup on the clipboard');
      }).catch(function () { fail('Clipboard read was blocked. Press Cmd V instead.'); });
    };

    Effects.list().forEach(function (def) {
      var btn = $('tool-' + def.id);
      if (!btn) return;
      btn.onclick = function () {
        tool = def.id;
        syncChrome();
        paint();
      };
    });

    $('fit').onclick = function () {
      var L = Doc.selected(doc);
      var r = L && renders[L.id];
      viewport.fit(r ? transformedBounds(L, r.bbox) : null);
    };
    $('zoom100').onclick = function () { viewport.zoomTo(1); };

    $('gridBtn').onclick = function () {
      viewport.grid = !viewport.grid;
      this.classList.toggle('on', viewport.grid);
      viewport.invalidate();
    };
    var BGS = [
      { id: 'dark', c: '#1e1e1e' }, { id: 'light', c: '#f2f2f2' }, { id: 'mid', c: '#808080' }
    ];
    var bgi = 0;
    $('bgBtn').onclick = function () {
      bgi = (bgi + 1) % BGS.length;
      viewport.bg = BGS[bgi].c;
      this.classList.toggle('on', bgi !== 0);
      this.dataset.tip = 'Canvas|' + BGS[bgi].id;
      viewport.invalidate();
    };

    $('undo').onclick = function () { if (history.undo(doc)) { syncPanels(); markDirty(false); } };
    $('redo').onclick = function () { if (history.redo(doc)) { syncPanels(); markDirty(false); } };

    $('copy').onclick = function () {
      if (!doc.layers.length) return;
      var btn = this, label = btn.querySelector('span');
      navigator.clipboard.writeText(svgText(false)).then(function () {
        label.textContent = 'Copied';
        setTimeout(function () { label.textContent = 'Copy'; }, 1200);
      }).catch(function () { fail('Clipboard write was blocked'); });
    };

    $('download').onclick = function () { saveSvg(false); };
    $('separations').onclick = function () { saveSvg(true); };

    $('removeBg').onclick = runBackgroundRemoval;
  }

  function saveSvg(separations) {
    if (!doc.layers.length) return;
    var text = svgText(separations);
    var L = Doc.selected(doc);
    var base = (L ? L.name : 'artwork').replace(/\.(svg|png|jpe?g|webp)$/i, '');
    var name = base + (separations ? '-separations' : '-apparel') + '.svg';

    if (window.desktop && window.desktop.saveFile) {
      window.desktop.saveFile(name, text).then(function (res) {
        if (res && res.path) $('srcName').textContent = res.path.split('/').pop();
      });
      return;
    }
    var blob = new Blob([text], { type: 'image/svg+xml' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function transformedBounds(L, bbox) {
    var m = Doc.layerMatrix(L);
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    [[bbox.x, bbox.y], [bbox.x + bbox.width, bbox.y],
     [bbox.x + bbox.width, bbox.y + bbox.height], [bbox.x, bbox.y + bbox.height]]
      .forEach(function (p) {
        var q = Doc.applyMatrix(m, p[0], p[1]);
        if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x;
        if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y;
      });
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function syncChrome() {
    Effects.list().forEach(function (def) {
      var btn = $('tool-' + def.id);
      if (btn) btn.classList.toggle('on', tool === def.id);
      var panel = $('panel-' + def.id);
      if (panel) panel.style.display = tool === def.id ? '' : 'none';
    });
    var L = Doc.selected(doc);
    $('removeBg').disabled = !L || !L.source.bitmap;
    $('undo').disabled = !history.canUndo();
    $('redo').disabled = !history.canRedo();
  }

  function syncHud() {
    $('zoomVal').textContent = Math.round(viewport.view.k * 100) + '%';
  }

  function wireFiles() {
    var stage = $('stage');
    ['dragenter', 'dragover'].forEach(function (t) {
      stage.addEventListener(t, function (e) { e.preventDefault(); $('drop').classList.add('on'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      stage.addEventListener(t, function (e) { e.preventDefault(); $('drop').classList.remove('on'); });
    });
    stage.addEventListener('drop', function (e) {
      e.preventDefault();
      openFile(e.dataTransfer.files[0]);
    });

    $('textureFile').onchange = function () {
      var f = this.files[0];
      this.value = '';
      if (!f) return;
      var url = URL.createObjectURL(f);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var max = 1024;
        var sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        var w = Math.max(8, Math.round(img.naturalWidth * sc));
        var h = Math.max(8, Math.round(img.naturalHeight * sc));
        var c = window.Raster.canvasOf(w, h);
        var g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, w, h);
        var d = g.getImageData(0, 0, w, h).data;
        var field = new Float32Array(w * h), sum = 0;
        for (var i = 0, q = 0; i < field.length; i++, q += 4) {
          var l = (0.2126 * d[q] + 0.7152 * d[q + 1] + 0.0722 * d[q + 2]) / 255;
          field[i] = l; sum += l;
        }
        textureImage = { data: field, w: w, h: h };
        textureName = f.name;
        // A scan of black speckle on white would otherwise erase the whole
        // shape, so start inverted when the image is mostly light.
        var L = Doc.selected(doc);
        if (L) {
          var dp = Doc.effect(L, 'dither').params;
          dp.textureInvert = (sum / field.length) > 0.55;
          if (dp.textureAmount === 0) dp.textureAmount = 0.4;
        }
        syncPanels();
        markDirty(false);
      };
      img.onerror = function () { fail('Could not read that texture'); };
      img.src = url;
    };

    window.addEventListener('paste', function (e) {
      var items = e.clipboardData && e.clipboardData.items;
      if (items) {
        for (var i = 0; i < items.length; i++) {
          if (/^image\//.test(items[i].type)) {
            var im = items[i].getAsFile();
            if (im) { e.preventDefault(); loadImageFile(im); return; }
          }
        }
      }
      var text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text && text.indexOf('<svg') >= 0) { e.preventDefault(); loadMarkup(text, 'pasted.svg'); }
    });
  }

  function wireKeys() {
    window.addEventListener('keydown', function (e) {
      if (/input|textarea|select/i.test(e.target.tagName)) return;
      var meta = e.metaKey || e.ctrlKey;

      if (meta && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey ? history.redo(doc) : history.undo(doc)) { syncPanels(); markDirty(false); }
        return;
      }
      if (meta && e.key.toLowerCase() === 'o') { e.preventDefault(); $('file').click(); return; }
      if (meta && e.key.toLowerCase() === 's') { e.preventDefault(); saveSvg(false); return; }
      if (meta && e.key === '0') { e.preventDefault(); $('fit').click(); return; }
      if (meta && (e.key === '=' || e.key === '+')) { e.preventDefault(); viewport.zoomTo(viewport.view.k * 1.25); return; }
      if (meta && e.key === '-') { e.preventDefault(); viewport.zoomTo(viewport.view.k / 1.25); return; }

      var D = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (D) {
        if (overlay.nudge(D[0], D[1], e.shiftKey)) { e.preventDefault(); syncPanels(); }
        return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        var L = Doc.selected(doc);
        if (L && tool === 'warp' && overlay.selected >= 0) {
          var p = Doc.effect(L, 'warp').params;
          if (p.corners) {
            p.corners[overlay.selected] = {
              x: W.DEFAULT_CORNERS[overlay.selected].x,
              y: W.DEFAULT_CORNERS[overlay.selected].y
            };
            markDirty(false);
          }
          e.preventDefault();
        }
      }
    });
  }

  /* Menus, when there is a menu bar to wire. The web build skips all of it. */
  function wireDesktop() {
    var D = window.desktop;
    if (!D) return;
    document.body.classList.add('desktop');
    var on = D.onMenu;
    on('open', function () { $('file').click(); });
    on('save', function () { saveSvg(false); });
    on('separations', function () { saveSvg(true); });
    on('copy', function () { $('copy').click(); });
    on('undo', function () { $('undo').click(); });
    on('redo', function () { $('redo').click(); });
    on('fit', function () { $('fit').click(); });
    on('actual', function () { $('zoom100').click(); });
    on('grid', function () { $('gridBtn').click(); });
    on('bg', function () { $('bgBtn').click(); });
    on('removebg', function () { $('removeBg').click(); });
    ['warp', 'dither', 'halftone'].forEach(function (t) {
      on('tool:' + t, function () { $('tool-' + t).click(); });
    });
    if (D.onBackgroundProgress) {
      D.onBackgroundProgress(function (stage) { $('bgState').textContent = stage; });
    }
  }

  /* ---------- background removal ---------- */

  function runBackgroundRemoval() {
    var L = Doc.selected(doc);
    if (!L || !L.source.bitmap) return;
    var btn = $('removeBg');
    btn.classList.add('busy');

    cutOut(L.source.bitmap).then(function (matte) {
      btn.classList.remove('busy');
      if (!matte) return;
      history.push(doc);
      L.matte = matte;
      if (matte.source === 'model') $('bgState').textContent = 'Background removed';
      else if (!/used the simple cut/.test($('bgState').textContent)) {
        $('bgState').textContent = 'Background removed with the simple cut';
      }
      markDirty(false);
    }).catch(function (err) {
      btn.classList.remove('busy');
      fail('Background removal failed: ' + (err.message || err));
    });
  }

  /* The desktop build runs BiRefNet locally through onnxruntime-node. Without
   * it, fall back to the luminance cut, which is far worse but honest about it. */
  function cutOut(bitmap) {
    if (window.desktop && window.desktop.removeBackground) {
      var c = window.Raster.canvasOf(bitmap.naturalWidth || bitmap.width,
                                     bitmap.naturalHeight || bitmap.height);
      var g = c.getContext('2d');
      g.drawImage(bitmap, 0, 0);
      var img = g.getImageData(0, 0, c.width, c.height);
      $('bgState').textContent = 'Removing background...';
      return window.desktop.removeBackground({
        data: img.data.buffer, width: c.width, height: c.height
      }).then(function (res) {
        if (res && res.mask) {
          return { mask: new Uint8Array(res.mask), w: res.width, h: res.height, source: 'model' };
        }
        // No model, no Node to run it in, or the download failed. Say what
        // happened and cut it the simple way rather than doing nothing.
        var why = (res && res.error) || 'the model was unavailable';
        $('bgState').textContent = 'Model unavailable (' + why + '), used the simple cut';
        return luminanceMatte(bitmap);
      }).catch(function (err) {
        $('bgState').textContent = 'Model failed (' + (err.message || err) +
          '), used the simple cut';
        return luminanceMatte(bitmap);
      });
    }
    return Promise.resolve(luminanceMatte(bitmap));
  }

  function luminanceMatte(bitmap) {
    var maxPx = 900;
    var bw = bitmap.naturalWidth || bitmap.width, bh = bitmap.naturalHeight || bitmap.height;
    var s = Math.min(1, maxPx / Math.max(bw, bh));
    var w = Math.max(8, Math.round(bw * s)), h = Math.max(8, Math.round(bh * s));
    var c = window.Raster.canvasOf(w, h);
    var g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bitmap, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data;
    // Take the corners as the background colour and knock out whatever matches.
    var refs = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]].map(function (p) {
      var i = (p[1] * w + p[0]) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    });
    var mask = new Uint8Array(w * h);
    for (var i = 0, p2 = 0; i < mask.length; i++, p2 += 4) {
      var best = 1e9;
      for (var r = 0; r < refs.length; r++) {
        var dr = d[p2] - refs[r][0], dg = d[p2 + 1] - refs[r][1], db = d[p2 + 2] - refs[r][2];
        var dist = dr * dr + dg * dg + db * db;
        if (dist < best) best = dist;
      }
      var t = Math.min(1, Math.sqrt(best) / 90);
      mask[i] = Math.round(t * 255);
    }
    return { mask: mask, w: w, h: h, source: 'luminance' };
  }

  /* ================= panel specs ================= */

  var DITHER_PRESETS = window.DITHER_PRESETS || {};
  var HALFTONE_PRESETS = window.HALFTONE_PRESETS || {};

  function buildPanels() {
    panels.layer = window.Controls.build($('panel-layer'), window.SPECS.layer(), apiFor('layer'));
    Effects.list().forEach(function (def) {
      var host = $('panel-' + def.id);
      if (!host || !window.SPECS[def.id]) return;
      panels[def.id] = window.Controls.build(host, window.SPECS[def.id](), apiFor(def.id));
    });
  }

  window.App = {
    doc: function () { return doc; },
    viewport: function () { return viewport; },
    overlay: function () { return overlay; },
    markDirty: markDirty,
    svgText: svgText,
    loadMarkup: loadMarkup,
    setTexture: function (img, name) { textureImage = img; textureName = name; },
    textureName: function () { return textureName; },
    history: history,
    syncPanels: syncPanels,
    selected: function () { return Doc.selected(doc); },
    tool: function () { return tool; },
    /* A snapshot for the test harnesses. When a recompute never comes back, the
     * first question is always whether there is a selected layer at all. */
    debug: function () {
      var L = Doc.selected(doc);
      return {
        layers: doc.layers.length,
        selection: doc.selection,
        selected: L ? L.id : null,
        selectedName: L ? L.name : null,
        hasPixels: !!(L && L.source.pixels),
        generation: generation,
        pendingGen: pending ? pending.generation : null,
        worker: !!worker,
        renders: Object.keys(renders).length
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
