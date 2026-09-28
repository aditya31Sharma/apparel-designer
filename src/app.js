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
  var generation = 0, pending = null;
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

  /* One fidelity, and it is the one you keep.
   *
   * A held slider used to run a cheap preview: the source sampled at 42%, the
   * halftone screen coarsened to 65% of its frequency, and the erosion grid
   * halved, which in mask pixels means the grain, the spatter and the spread
   * all came out more than twice the size. Then the drag stopped and the real
   * pass replaced it with something else. You were aiming at a picture the
   * tool had no intention of giving you.
   *
   * So the preview is now the result. The speed comes from doing less work
   * rather than different work: one job is in flight at a time, and a change
   * arriving while one is running replaces whatever was waiting instead of
   * joining a queue behind it. A drag used to post a job per slider tick and
   * the worker computed every one of them in full, discarding all but the
   * last. It now computes the newest state as fast as it can and skips the
   * ones nobody would have seen, which is both correct and less work than the
   * two-pass scheme it replaces.
   */
  var busy = false;      // a job is out
  var queued = false;    // and the document has moved on since

  /* `live` used to pick a quality. It is kept because callers pass it and
   * because a drag and a commit are still worth telling apart, but nothing
   * about the result depends on it any more. */
  function markDirty(live) {
    if (busy) { queued = true; return; }
    compute();
  }

  /* Called once a job has landed, however it landed. */
  function finishJob() {
    busy = false;
    if (!queued) return;
    queued = false;
    compute();
  }

  function compute() {
    var layer = Doc.selected(doc);
    if (!layer) { renders = {}; queued = false; paint(); return; }
    busy = true;

    var job = {
      kind: 'run',
      generation: ++generation,
      items: layer.source.items.map(function (i) {
        return { d: i.d, frame: i.frame, fill: i.fill, stroke: i.stroke,
                 strokeWidth: i.strokeWidth };
      }),
      bbox: layer.source.bbox,
      // The threshold measured from the picture, for whichever way round the
      // tone is running.
      autoCut: layer.invert ? layer.source.autoCutInv : layer.source.autoCut,
      invert: !!layer.invert,
      effects: layer.effects.map(function (e) {
        return { type: e.type, on: e.on, params: JSON.parse(JSON.stringify(e.params)) };
      }),
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
    // The job that hung is never coming back to release the lock.
    busy = false;
    queued = false;
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
        textureImage: job.textureImage,
        rasterize: window.Raster.rasterize, traceImage: window.Raster.traceImage,
        maskFromPaths: window.Grunge.maskFromPaths
      };
      var t0 = performance.now();
      Effects.runStack({ effects: job.effects },
        { items: job.items, bbox: job.bbox, matte: job.matte, invert: job.invert,
          autoCut: job.autoCut, pixels: layer.source.pixels, sourceId: layer.id },
        ctx).then(function (run) {
        acceptResult(layer, run.result, run.stats, job.generation,
          Math.round(performance.now() - t0));
        var newest = !queued;
        finishJob();
        if (newest && window.__onResult) { var g = window.__onResult; window.__onResult = null; g(); }
      }).catch(function (err) { fail(err.message || String(err)); finishJob(); });
    } catch (err) {
      fail(err.message || String(err));
      finishJob();
    }
  }

  function onWorkerMessage(e) {
    var m = e.data;
    clearTimeout(watchdog);
    if (m.kind === 'error') { fail(m.message); finishJob(); return; }
    if (m.kind !== 'done' || m.generation !== generation) { finishJob(); return; }
    var layer = pending && pending.layer;
    if (!layer) return;
    if (m.poolProblem) fail('erosion pool: ' + m.poolProblem + ' (running single threaded)');
    lastPool = m.pool || 1;
    // Read by the benchmark and suite harnesses. Nothing in the app uses them.
    window.__lastBreakdown = m.breakdown || null;
    window.__lastHT = m.stats && m.stats.halftone ? m.stats.halftone : null;
    window.__lastStats = m.stats || null;
    window.__lastMs = m.ms;
    acceptResult(layer, m, m.stats, m.generation, m.ms);
    // Signalled last, once the scene and the readouts are actually updated,
    // and only when nothing newer is waiting. Firing it first meant a harness
    // read the previous render's numbers; firing it while a change was still
    // queued meant it read the render before the one it had asked about,
    // which showed up as a coarse screen exporting three times the dots it
    // could have had.
    var newest = !queued;
    finishJob();
    if (newest && window.__onResult) { var f = window.__onResult; window.__onResult = null; f(); }
  }

  /* Turn engine output into things the canvas can draw. This is the only place
   * Path2D objects are built, and it happens once per compute, never per frame. */
  function acceptResult(layer, out, stats, gen, ms) {
    if (gen !== generation) return;
    clearFail();
    var tAccept = performance.now();

    var shapes = (out.items || []).map(function (it) {
      return {
        points: it.points, offsets: it.offsets, d: it.d, frame: !!it.frame,
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
      shapes: shapes, plates: plates, mode: out.mode,
      pattern: out.pattern, fuzziness: out.fuzziness, seed: out.seed,
      bbox: out.bbox || layer.source.bbox
    };
    window.__timing = window.__timing || {};
    window.__timing.buildPaths = Math.round(performance.now() - tAccept);
    window.__timing.workerMs = ms;
    var tPaint = performance.now();
    var untouched = untouchedImage(layer, renders[layer.id]);
    showStats(stats, ms, shapes, plates, out.pattern, untouched ? {
      width: Math.round(layer.source.bbox.width),
      height: Math.round(layer.source.bbox.height),
      uri: imageUriFor(layer)
    } : null, out.fuzziness);
    paint();
    window.__timing.firstPaint = Math.round(performance.now() - tPaint);
  }

  /* Roughly how big the SVG will be, without building it.
   *
   * A fine screen over a large photo is half a million dots and twenty-odd
   * megabytes. That is a fair file for that much geometry, but finding out by
   * pressing Save is not fair, so the number is on screen beforehand. */
  function estimateBytes(shapes, plates, pattern, fuzziness) {
    var bytes = 260;
    if (plates) {
      // Measured against real exports and rounded up: a figure that
      // surprises you by being low is worse than one a little cautious.
      plates.forEach(function (p) {
        var d = p.dots;
        for (var o = 0; o < d.length; o += H.STRIDE) {
          var r = d[o + 2];
          if (fuzziness > 0) {
            // Any grit turns a dot into a polygon whose point count follows
            // its radius, the same rule emitDot uses. A point is a command,
            // two coordinates to two decimals and a space: sixteen bytes.
            var steps = Math.max(6, Math.min(28, Math.round(r * 2.2) + 6));
            bytes += 2 + (steps + 1) * 16;
          } else if (pattern === 'round' || pattern === 'ellipse') {
            // Two arcs. The radius is written four times and its double
            // twice, so a wide screen with an eleven pixel dot costs more
            // per dot than a fine one with a two pixel dot.
            var rs = String(Math.round(r * 100) / 100).length;
            bytes += (pattern === 'ellipse' ? 60 : 40) + 6 * rs;
          } else {
            bytes += pattern === 'cross' ? 162 : 82;
          }
        }
      });
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

  function showStats(stats, ms, shapes, plates, pattern, raw, fuzziness) {
    var bits = [];
    // A photo with nothing applied has no geometry to count, and counting the
    // one frame rectangle holding its pixels as "1 shapes" says nothing.
    if (raw) {
      var box0 = $('stats');
      if (box0) {
        box0.textContent = 'photo  ·  ' + fmtN(raw.width) + ' x ' + fmtN(raw.height) +
          '  ·  nothing applied';
      }
      var size0 = $('exportSize');
      if (size0) {
        var bytes = raw.uri ? Math.round(raw.uri.length * 0.75) : 0;
        size0.textContent = bytes ? '~' + fmtBytes(bytes) : '';
        size0.classList.toggle('heavy', bytes > 8 * 1048576);
      }
      return;
    }
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

    var est = estimateBytes(shapes, plates, pattern, fuzziness);
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
      var raw = untouchedImage(L, r);
      if (raw) {
        scene.layers.push({
          matrix: Doc.layerMatrix(L), opacity: L.paint.opacity,
          image: raw, bbox: r.bbox
        });
        return;
      }
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
        plates: inkPlates(L, r),
        blend: plateBlend(r),
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

  /* A one or two colour screen prints in the layer's ink. The effect never
   * sees the ink, so the plates come back marked rather than coloured and are
   * painted here, which is what makes changing the ink a repaint instead of a
   * screen. Four colour process plates keep their own inks. */
  function inkPlates(L, r) {
    if (!r.plates) return null;
    if (r.mode === 'cmyk') return r.plates;
    var two = r.mode === 'duotone';
    var p = Doc.effect(L, 'halftone').params;
    return r.plates.map(function (pl) {
      var second = two && pl.key === 'm';
      return {
        key: pl.key, dots: pl.dots, paths: pl.paths,
        colour: second ? (p.ink2 || pl.colour) : L.paint.fill,
        label: two ? (second ? 'Ink 2' : 'Ink 1') : 'Ink'
      };
    });
  }

  /* Process inks are translucent and overprint; spot inks are opaque and sit
   * on top of each other, which is what they do on a garment. */
  function plateBlend(r) {
    return r.plates && r.mode === 'cmyk' ? 'multiply' : 'source-over';
  }

  /* The imported picture with the cut-out applied, for the case where nothing
   * else has been. Removing the background used to be invisible until an
   * effect was switched on, because the untouched-photo path draws the source
   * bitmap and the source bitmap knows nothing about the matte: the cut was
   * computed, stored and correct, and the canvas carried on showing the photo
   * it came from. Cached against the matte object itself, so re-running the
   * cut replaces it and nothing else does. */
  var matted = {};

  function mattedBitmap(L) {
    var img = L.source.bitmap;
    if (!img) return null;
    if (!L.matte) return img;
    var hit = matted[L.id];
    if (hit && hit.matte === L.matte) return hit.canvas;

    var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
    if (!w || !h) return img;
    try {
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      var g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, w, h);
      var frame = g.getImageData(0, 0, w, h);
      var px = frame.data, mw = L.matte.w, mh = L.matte.h, mask = L.matte.mask;
      for (var y = 0; y < h; y++) {
        var my = Math.min(mh - 1, (y * mh / h) | 0);
        for (var x = 0; x < w; x++) {
          var mx = Math.min(mw - 1, (x * mw / w) | 0);
          var i = (y * w + x) * 4;
          px[i + 3] = (px[i + 3] * mask[my * mw + mx] / 255) | 0;
        }
      }
      g.putImageData(frame, 0, 0);
      matted[L.id] = { matte: L.matte, canvas: c };
      return c;
    } catch (e) {
      return img;
    }
  }

  /* A photo that no effect has touched yet.
   *
   * An imported picture is carried as a frame rectangle with the pixels riding
   * along, and every effect that consumes it replaces that rectangle with real
   * outlines. So as long as what came back is still the frame, there is nothing
   * to draw but the picture, and the picture is what should be drawn. */
  function untouchedImage(L, r) {
    if (!L.source.bitmap || !r || r.plates) return null;
    if (!r.shapes || !r.shapes.length) return null;
    for (var i = 0; i < r.shapes.length; i++) if (!r.shapes[i].frame) return null;
    return mattedBitmap(L);
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
        // The canvas belongs to the view, not to any layer, so it is there
        // with nothing loaded.
        if (id === 'canvas') return viewport ? viewport.bg : '#1e1e1e';
        if (id === 'bgProgress') return bgJob;
        var L = Doc.selected(doc);
        if (!L) return undefined;
        // `__on` is the effect's own switch, which lives on the stack entry
        // rather than among its parameters.
        if (id === '__on') return scope === 'layer' ? true : Doc.effect(L, scope).on;
        if (id === 'lockRatio') return !!L.lockRatio;
        if (id === 'hasMatte') return bgJob.busy ? 'busy' : !!L.matte;
        return readPath(scope === 'layer' ? L : Doc.effect(L, scope).params, id);
      },
      set: function (id, v, live) {
        if (id === 'canvas') { setCanvas(v); return; }
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
        if (id === 'invert') { setInvert(L, v); return; }
        if (id.indexOf('source.text.') === 0) {
          // Only type has text to edit. Writing into a photo or an SVG would
          // build a half-made text object on it and mislabel it as type.
          if (!L.source.text) return;
          writePath(L, id, v);
          // A new font has to be fetched and parsed before it can be set in.
          if (id === 'source.text.font') {
            window.FontLib.load(v).then(function () {
              retext(L, false); syncPanels();
            }).catch(function (e) {
              fail('That font could not be read: ' + (e.message || e));
            });
            return;
          }
          retext(L, live);
          return;
        }
        writePath(scope === 'layer' ? L : Doc.effect(L, scope).params, id, v);
        if (scope !== 'layer') { onParamChanged(scope, id, v); markDirty(live); return; }
        if (id.indexOf('paint.') === 0) {
          // The ink is the ink: touching it means use it.
          if (id === 'paint.fill') L.paint.useSourceColours = false;
          // Paint never reaches an effect, so nothing has to be computed
          // again. A colour change on a six hundred millisecond dither is a
          // repaint, not a wait.
          paint();
          return;
        }
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
      if (id === 'preset' && HALFTONE_PRESETS[v]) {
        Object.assign(p, JSON.parse(JSON.stringify(HALFTONE_PRESETS[v].params)));
      }
    }
    if (scope === 'dither') {
      if (id === 'preset' && DITHER_PRESETS[v]) {
        var next = JSON.parse(JSON.stringify(DITHER_PRESETS[v].params));
        /* How much of a picture becomes ink belongs to the picture; how much
         * heavier or lighter than the middle a style runs belongs to the
         * style. So a style's threshold is applied as the offset it is from
         * the 40% baseline, and a style stays a choice about the look rather
         * than something that throws away a level measured from the artwork. */
        var auto = L.invert ? L.source.autoCutInv : L.source.autoCut;
        if (auto !== undefined && next.imageCut !== undefined) {
          next.imageCut = Math.max(0.1, Math.min(0.85, auto + (next.imageCut - 0.4)));
        }
        Object.assign(p, next);
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
    if (cond === 'duotone') return p.mode === 'duotone';
    if (cond === 'cmyk') return p.mode === 'cmyk';
    if (cond === 'texture') return !!p.texture && p.texture !== 'none';
    if (cond === 'notexture') return !p.texture || p.texture === 'none';
    // The tone controls only mean anything when there is a photo to threshold.
    if (cond === 'photo') return !!L.source.pixels;
    if (cond === 'vector') return !L.source.pixels;
    if (cond === 'text') return !!L.source.text;
    return true;
  }

  /* The canvas colour is the garment. It lives in the view, is remembered
   * between launches, and never goes into the file. */
  function setCanvas(v) {
    if (!/^#[0-9a-f]{6}$/i.test(v || '')) return;
    viewport.bg = v;
    viewport.invalidate();
    try { localStorage.setItem('ad.canvas', v); } catch (e) { /* private window */ }
  }

  /* Which way round a photo's tone runs. The dither's threshold was measured
   * from the picture for one polarity, so flipping it swaps in the threshold
   * measured for the other. */
  function setInvert(L, v) {
    L.invert = !!v;
    var cut = L.invert ? L.source.autoCutInv : L.source.autoCut;
    if (cut !== undefined) Doc.effect(L, 'dither').params.imageCut = cut;
    markDirty(false);
  }

  function syncPanels() {
    Object.keys(panels).forEach(function (k) { panels[k].sync(); });
    syncChrome();
    // Controls that act on a layer read as live until there is one.
    var has = !!Doc.selected(doc);
    document.body.classList.toggle('empty', !has);
  }

  /* ================= loading artwork ================= */

  /* The threshold that decides how much of a photo becomes ink, read off the
   * photo rather than averaged over all photos.
   *
   * One fixed number cannot serve both: a garment shot with no background and
   * a drawing that is half white paper want thresholds twenty points apart,
   * and getting it wrong is not subtle. Too low and the subject disappears,
   * too high and everything dark fuses into one silhouette, which is what a
   * hood, a shadow or a dark jacket does to a picture.
   *
   * So aim at a coverage instead of a level: the threshold at which about a
   * third of the picture is ink. Measured against the pictures this was going
   * wrong on, that lands where the answer looks right on each of them, and it
   * is a rule that can be explained rather than a constant that cannot.
   */
  var INK_TARGET = 0.33;

  function autoCut(px, invert) {
    if (!px || !px.data) return 0.4;
    var d = px.data, hist = new Uint32Array(256), n = 0;
    // Composited onto the ground the tracer will use, and inverted the way
    // the tracer will invert, so the histogram is of what gets thresholded.
    var gv = invert ? 0 : 255;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3] / 255;
      var r = d[i] * a + gv * (1 - a);
      var g = d[i + 1] * a + gv * (1 - a);
      var b = d[i + 2] * a + gv * (1 - a);
      var l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      hist[(invert ? 255 - l : l) | 0]++;
      n++;
    }
    if (!n) return 0.4;
    var target = n * INK_TARGET, cum = 0;
    for (var v = 0; v < 256; v++) {
      cum += hist[v];
      /* Capped, because on a bright picture a third of the frame is only
       * reached by climbing into the sky behind the subject. Past about half
       * luminance a threshold is inking things the eye reads as light, which
       * is the signature of a background being swallowed rather than of a
       * subject being found. */
      if (cum >= target) return Math.max(0.18, Math.min(0.48, (v + 0.5) / 255));
    }
    return 0.4;
  }

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
    // A file painted in one colour is a one colour artwork, and the Ink swatch
    // should say so rather than showing white over a black logo. Anything with
    // more colours keeps them until the ink is touched.
    var one = pixels ? null : soleColour(items);
    if (one) { layer.paint.fill = one; layer.paint.useSourceColours = false; }
    if (!bgJob.busy) { bgJob = { text: '', busy: false }; }

    doc.layers = [layer];
    doc.selection = layer.id;
    renders = {};
    pixelsSent = null;
    imageUris = {};
    matted = {};
    history.clear();

    $('srcName').textContent = name + '  ·  ' +
      Math.round(bbox.width) + ' x ' + Math.round(bbox.height) + ' px';
    $('drop').classList.remove('on');
    $('empty').classList.add('gone');
    clearFail();
    syncPanels();
    compute();
    setTimeout(function () { viewport.fit(bbox); }, 0);
  }

  var probe = null;
  function normHex(v) {
    if (!v || v === 'none' || /^url\(/i.test(v)) return null;
    if (!probe) probe = document.createElement('canvas').getContext('2d');
    // An unparseable colour leaves the previous one in place, so start from a
    // sentinel that no real artwork would resolve to and reject it.
    probe.fillStyle = '#010203';
    probe.fillStyle = v;
    var out = String(probe.fillStyle);
    return /^#[0-9a-f]{6}$/i.test(out) && out !== '#010203' ? out.toLowerCase() : null;
  }

  function soleColour(items) {
    var seen = {}, n = 0;
    for (var i = 0; i < items.length; i++) {
      var cs = [items[i].fill];
      if (items[i].stroke && items[i].strokeWidth > 0) cs.push(items[i].stroke);
      for (var j = 0; j < cs.length; j++) {
        if (!cs[j] || cs[j] === 'none') continue;
        var h = normHex(cs[j]);
        if (!h) return null;
        if (!seen[h]) { seen[h] = true; n++; }
      }
    }
    return n === 1 ? Object.keys(seen)[0] : null;
  }

  function loadMarkup(markup, name) {
    try {
      var r = window.SvgIn.parse(markup);
      loadItems(r.items, name || 'pasted.svg');
    } catch (err) {
      fail(err.message || String(err));
    }
  }

  /* ---------- type ---------- */

  /* The words changed, or the font, the size, the tracking: lay the text out
   * again and let the frame take the new size. Position and rotation stay,
   * and so does every effect, since they run inside the frame. */
  function retext(L, live) {
    var t = L.source.text;
    if (!t) return;
    var font = window.FontLib.get(t.font);
    if (!font) return;
    var items = window.Text.layout(font, t);
    var bbox = items.length ? W.bounds(items.map(function (i) { return i.d; })) : null;
    // Nothing to draw, which is what an empty box is: keep the last outlines
    // on the canvas until there is something to replace them with.
    if (!bbox || !bbox.width || !bbox.height) return;
    L.source.items = items;
    L.source.bbox = bbox;
    L.transform.width = bbox.width;
    L.transform.height = bbox.height;
    L.name = textName(t.text);
    $('srcName').textContent = L.name + '  ·  ' +
      Math.round(bbox.width) + ' x ' + Math.round(bbox.height) + ' px';
    markDirty(live);
  }

  function textName(text) {
    var one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.slice(0, 24) || 'text';
  }

  /* A text layer. The font comes from the machine's list, parsed once; the
   * outlines it gives are a source like any SVG, so everything downstream
   * treats type as artwork. */
  function loadText(spec) {
    var t = Object.assign({}, window.Text.DEFAULT, spec || {});
    var FL = window.FontLib;
    return FL.list(false).then(function (entries) {
      if (!t.font) {
        var pick = FL.pickDefault(entries);
        if (!pick) throw new Error('No fonts were found on this machine');
        t.font = pick.id;
      }
      return FL.load(t.font);
    }).then(function (font) {
      var items = window.Text.layout(font, t);
      if (!items.length) throw new Error('Nothing to type yet');
      loadItems(items, textName(t.text), null, null);
      var L = Doc.selected(doc);
      if (!L) return null;
      L.source.text = t;
      // Type prints in the ink, white on the dark canvas by default, the way
      // a photo does. The source colour of an outline is nothing worth keeping.
      L.paint.useSourceColours = false;
      L.paint.fill = '#ffffff';
      syncPanels();
      markDirty(false);
      return L;
    }).catch(function (e) {
      fail(e.message || String(e));
      return null;
    });
  }

  function focusText() {
    var ta = document.querySelector('#panel-layer textarea');
    if (ta) { ta.focus(); ta.select(); }
  }

  function isFont(file) {
    return /\.(ttf|otf|ttc|woff)$/i.test(file.name || '');
  }

  /* A font file dropped or opened: kept by the shell, then used at once,
   * on the text that is there or on new text if there is none. */
  function addFontFile(f) {
    window.FontLib.addFile(f).then(function (entry) {
      if (!entry) return null;
      var L = Doc.selected(doc);
      if (L && L.source.text) {
        L.source.text.font = entry.id;
        return window.FontLib.load(entry.id).then(function () { retext(L, false); syncPanels(); });
      }
      return loadText({ font: entry.id });
    }).catch(function (e) {
      fail('Could not add that font: ' + (e.message || e));
    });
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
        // Nothing is switched on. An imported photo used to arrive already
        // screened, because a photo with no effect running had nothing to draw:
        // its layer is a bare frame rectangle with the pixels riding along, and
        // a frame with no fill draws as nothing at all. The viewport now draws
        // the picture itself in that case, so an import can look like what was
        // imported and the first thing the tool does to your artwork can be
        // the thing you asked for.
        //
        // A traced photo has no colours of its own worth keeping, so the Ink
        // control drives one, and a one or two colour halftone prints in it.
        L.paint.useSourceColours = false;
        // White ink on the dark canvas, which is a print on a dark garment.
        // Both are one swatch away. There is no paper: the artwork sits on
        // the canvas, and the canvas is whatever you make it.
        L.paint.fill = '#ffffff';

        // Read once, from this picture, for both ways round the tone can run,
        // and used by everything that traces it.
        L.source.autoCut = autoCut(L.source.pixels, false);
        L.source.autoCutInv = autoCut(L.source.pixels, true);
        Doc.effect(L, 'dither').params.imageCut = L.source.autoCut;

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
    if (isFont(f)) addFontFile(f);
    else if (isImage(f)) loadImageFile(f);
    else f.text().then(function (t) { loadMarkup(t, f.name); });
  }

  /* ================= export ================= */

  /* The imported picture as a data URI, for the case where it is what gets
   * exported. Built once per layer: re-encoding a 27 megapixel photo to PNG on
   * every keystroke in the Save button's size readout is not free. */
  var imageUris = {};

  function imageUriFor(L) {
    var img = mattedBitmap(L);
    if (!img) return null;
    // Keyed on the matte too: a cut-out is a different picture.
    var key = L.id + '|' + (L.matte ? L.matte.w + 'x' + L.matte.h + '|' + (L.matte.source || '') : 'raw');
    if (imageUris[key]) return imageUris[key];
    try {
      // The picture as it arrived, not the working copy: the pixels kept for
      // the effects are capped in size, and an export should not be.
      var w = img.naturalWidth || img.width;
      var h = img.naturalHeight || img.height;
      if (!w || !h) return null;
      // A real element, because toDataURL is not on OffscreenCanvas, which is
      // what the shared helper hands back in a browser that has one.
      var c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      imageUris[key] = c.toDataURL('image/png');
      return imageUris[key];
    } catch (e) {
      return null;
    }
  }

  function buildRenders() {
    return doc.layers.map(function (L) {
      var r = renders[L.id];
      if (!r) return null;
      var pd = paintFor(L);
      if (untouchedImage(L, r)) {
        return {
          name: L.name, matrix: Doc.layerMatrix(L), bbox: r.bbox,
          opacity: L.paint.opacity, shapes: [], plates: null,
          image: imageUriFor(L)
        };
      }
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
        plates: inkPlates(L, r),
        blend: plateBlend(r),
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
    try {
      var kept = localStorage.getItem('ad.canvas');
      if (/^#[0-9a-f]{6}$/i.test(kept || '')) viewport.bg = kept;
    } catch (e) { /* no storage, the default canvas */ }

    buildPanels();
    startWorker();
    wireDesktop();
    wireChrome();
    wireFiles();
    wireKeys();
    syncPanels();
    // After the chrome is wired, because the phone layout rebinds some of what
    // it just bound, and before the first paint so nothing is laid out twice.
    if (window.Mobile) window.Mobile.start();
    paint();
    // The font list is built by the shell on the first run, which takes a
    // few seconds across a thousand files, so it starts after the first
    // paint and the picker fills in when it lands.
    if (window.FontLib) {
      window.FontLib.onChange(function () {
        var row = panels.layer && panels.layer.rows['source.text.font'];
        if (row && row.repaint) { row.repaint(); panels.layer.sync(); }
      });
      setTimeout(function () { window.FontLib.list(false).catch(function () {}); }, 1200);
    }
    // Last line of boot on purpose: reaching it is the proof that whatever
    // source this launch is running actually works.
    if (window.Updater) window.Updater.start();
  }

  /* ---------- chrome ---------- */

  function wireChrome() {
    $('open').onclick = function () { $('file').click(); };
    $('type').onclick = function () {
      loadText({}).then(function (L) { if (L) focusText(); });
    };
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
    // Double tapping the canvas frames the artwork, which is what a photo
    // viewer does and what there is no room for a button for on a phone.
    viewport.onDoubleTap = function () { $('fit').click(); };

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
      setCanvas(BGS[bgi].c);
      this.classList.toggle('on', bgi !== 0);
      this.dataset.tip = 'Canvas|' + BGS[bgi].id + '. Any colour: the Canvas swatch in the panel';
      syncPanels();
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
      if (meta && e.key.toLowerCase() === 't') { e.preventDefault(); $('type').click(); return; }
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
    if (D.onBackgroundProgress) D.onBackgroundProgress(bgStage);
  }

  /* ---------- background removal ---------- */

  /* What the panel shows while the cut is running: the stage, a bar, and how
   * long is left. The model gives no progress of its own, so the bar runs on
   * the clock against how long it took last time on this machine, and the
   * first time against a guess. Nobody can tell a seven second job from a
   * hung one without it. */
  var bgJob = { text: '', busy: false };
  var bgTimer = null;
  var BG_GUESS_MS = 9000;

  function bgEstimate() {
    try {
      var v = parseInt(localStorage.getItem('ad.bgMs'), 10);
      if (v > 500 && v < 600000) return v;
    } catch (e) { /* no storage */ }
    return BG_GUESS_MS;
  }

  function bgRemember(ms) {
    try { localStorage.setItem('ad.bgMs', String(ms)); } catch (e) { /* no storage */ }
  }

  /* Straight to the two rows rather than through a full panel sync, since
   * this runs several times a second while the cut is out. */
  function showBg() {
    var rows = panels.layer && panels.layer.rows;
    if (!rows) return;
    if (rows.bgProgress) rows.bgProgress.show(bgJob);
    var L = Doc.selected(doc);
    if (rows.hasMatte) rows.hasMatte.show(bgJob.busy ? 'busy' : !!(L && L.matte));
  }

  /* A stage reported by the main process: the model download says how far
   * it has got, the model run only says what it is doing. */
  function bgStage(stage) {
    if (!bgJob.busy) return;
    var m = /(\d+)% of (\d+)MB/.exec(stage || '');
    if (m) {
      bgJob.download = true;
      bgJob.pct = (+m[1]) / 100;
      bgJob.text = 'Fetching the background model, one time only';
      bgJob.eta = m[1] + '% of ' + m[2] + 'MB';
    } else {
      // The clock starts on the run itself, not on a download before it.
      if (bgJob.download) bgJob.t0 = performance.now();
      bgJob.download = false;
      bgJob.text = stage || 'Removing background';
    }
    showBg();
  }

  function bgTick() {
    if (!bgJob.busy || bgJob.download) return;
    var elapsed = performance.now() - bgJob.t0;
    var est = bgJob.estimate;
    bgJob.pct = Math.min(0.96, elapsed / est);
    bgJob.eta = elapsed >= est ? 'nearly there'
      : 'about ' + Math.max(1, Math.ceil((est - elapsed) / 1000)) + 's left';
    showBg();
  }

  function runBackgroundRemoval() {
    var L = Doc.selected(doc);
    if (!L || !L.source.bitmap || bgJob.busy) return;
    var est = bgEstimate();
    bgJob = { text: 'Removing background', busy: true, pct: 0,
              eta: 'about ' + Math.ceil(est / 1000) + 's', t0: performance.now(),
              estimate: est, download: false };
    clearInterval(bgTimer);
    bgTimer = setInterval(bgTick, 120);
    showBg();
    var tAll = performance.now();

    cutOut(L.source.bitmap).then(function (matte) {
      clearInterval(bgTimer);
      var total = ((performance.now() - tAll) / 1000).toFixed(1) + 's';
      if (!matte) { bgJob = { text: '', busy: false }; showBg(); return; }
      history.push(doc);
      L.matte = matte;
      if (matte.source === 'model') {
        bgRemember(Math.round(performance.now() - bgJob.t0));
        bgJob = { text: 'Background removed in ' + total, busy: false, pct: 1 };
      } else {
        bgJob = { text: bgJob.fallback || 'Background removed with the simple cut',
                  busy: false, pct: 1, failed: !!bgJob.fallback };
      }
      showBg();
      markDirty(false);
    }).catch(function (err) {
      clearInterval(bgTimer);
      bgJob = { text: 'Background removal failed: ' + (err.message || err),
                busy: false, failed: true };
      showBg();
    });
  }

  function restoreBackground(L) {
    history.push(doc);
    L.matte = null;
    bgJob = { text: '', busy: false };
    showBg();
    markDirty(false);
  }

  /* One button: remove the background, or put it back once it is gone. */
  function toggleBackground() {
    var L = Doc.selected(doc);
    if (!L || !L.source.bitmap || bgJob.busy) return;
    if (L.matte) restoreBackground(L); else runBackgroundRemoval();
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
      return window.desktop.removeBackground({
        data: img.data.buffer, width: c.width, height: c.height
      }).then(function (res) {
        if (res && res.mask) {
          return { mask: new Uint8Array(res.mask), w: res.width, h: res.height, source: 'model' };
        }
        // No model, no Node to run it in, or the download failed. Say what
        // happened and cut it the simple way rather than doing nothing.
        var why = (res && res.error) || 'the model was unavailable';
        bgJob.fallback = 'Model unavailable (' + why + '), used the simple cut';
        return luminanceMatte(bitmap);
      }).catch(function (err) {
        bgJob.fallback = 'Model failed (' + (err.message || err) + '), used the simple cut';
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
    // The rest of the layer's controls, below whichever effect is showing.
    panels.more = window.Controls.build($('panel-more'), window.SPECS.more(), apiFor('layer'));
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
    toggleBackground: toggleBackground,
    bgState: function () { return bgJob; },
    setCanvas: setCanvas,
    loadText: loadText,
    retext: function (L) { retext(L || Doc.selected(doc), false); },
    fonts: function () { return window.FontLib; },
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
