/* The screenshots the README shows.
 *
 * Generated rather than taken by hand, because a README that advertises what
 * the tool does has to keep matching what the tool actually does. Re-run it
 * after any change to the interface:
 *
 *   npm run shots
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* Runs inside the page. Loads a file through the real file input, so the shot
 * goes through exactly the path a person does. */
const DRIVE = `(async function(step){
  function wait(ms){ return new Promise(function(r){ setTimeout(r, ms); }); }

  async function loadFile(name, type){
    var blob = await (await fetch(name)).blob();
    var f = new File([blob], name, { type: type });
    var dt = new DataTransfer(); dt.items.add(f);
    var input = document.getElementById('file');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(2600);
    return window.App.selected();
  }

  function recompute(){
    return new Promise(function(r){
      window.__onResult = r;
      window.App.markDirty(false);
      setTimeout(r, 40000);
    });
  }

  var Doc = window.Doc;
  var L = window.App.selected();
  if (step.text) {
    // Type, in a face picked by family name from whatever this machine has,
    // so the shot does not depend on a path.
    var entries = await window.App.fonts().list(false);
    var face = entries.filter(function (e) {
      return e.family === step.family && /bold|black|heavy/i.test(e.style);
    })[0] || entries.filter(function (e) { return e.family === step.family; })[0];
    L = await window.App.loadText({ text: step.text, font: face ? face.id : '' });
    await wait(800);
  } else if (!L || L.name !== step.file) {
    // Each shot names its own subject; only reload when it is a different one.
    L = await loadFile(step.file, step.type);
  }
  if (!L) return { error: 'nothing loaded' };

  L.effects.forEach(function(e){ e.on = false; });
  if (step.paint) Object.assign(L.paint, step.paint);
  if (step.effect){
    var entry = Doc.effect(L, step.effect);
    entry.on = true;
    if (step.preset){
      var table = step.effect === 'halftone' ? window.HALFTONE_PRESETS : window.DITHER_PRESETS;
      if (table && table[step.preset]) Object.assign(entry.params, table[step.preset].params);
    }
    if (step.params) Object.assign(entry.params, step.params);
  }
  if (step.tool){
    var btn = document.getElementById('tool-' + step.tool);
    if (btn) btn.click();
  }
  window.App.syncPanels();

  // Canvas colour is set outright rather than by clicking the button, which
  // cycles: clicking it once per shot left every shot on a different colour
  // from the one before, which is exactly the bug this comment replaces.
  var vp = window.App.viewport();
  vp.bg = step.bg || '#1e1e1e';
  // The Canvas swatch in the panel reads the view, so it has to be synced
  // after the view is set or the shot shows a swatch that disagrees with
  // the canvas behind it.
  window.App.syncPanels();
  if (step.grid === false && vp.grid) document.getElementById('gridBtn').click();
  vp.invalidate();
  document.getElementById('overlay').style.display = step.handles === false ? 'none' : '';

  await recompute();
  document.getElementById('fit').click();
  await wait(700);

  // The update notice, shown for real rather than mocked up, so the picture on
  // the download page keeps matching what the app puts on screen.
  var notice = null;
  if (step.notice && window.Updater){
    window.Updater.render(step.notice);
    await wait(250);
    var nr = document.getElementById('update').getBoundingClientRect();
    var pad = 18;
    notice = { x: nr.left - pad, y: nr.top - pad,
               width: nr.width + pad * 2, height: nr.height + pad * 2 };
  }

  // A tile of the whole image hides the very thing it is meant to show: at
  // README size a four pixel dot is not there. So zoom to a patch instead.
  if (step.detail){
    var s0 = vp.size(), tt = L.transform;
    var k = s0.w / (step.detail.w * tt.width);
    vp.setView({ k: k,
      x: tt.x + step.detail.cx * tt.width - (s0.w / 2) / k,
      y: tt.y + step.detail.cy * tt.height - (s0.h / 2) / k }, true);
    await wait(900);
  }

  // Where the artwork actually landed on screen, so a tile is the artwork and
  // not a square of empty canvas either side of it.
  var t = L.transform;
  var canvas = document.getElementById('canvas').getBoundingClientRect();
  var a = vp.toScreen({ x: t.x, y: t.y });
  var c = vp.toScreen({ x: t.x + t.width, y: t.y + t.height });
  var art = (step.detail || step.square)
    ? { x: canvas.left + (canvas.width - canvas.height) / 2, y: canvas.top,
        width: canvas.height, height: canvas.height }
    : { x: canvas.left + a.x, y: canvas.top + a.y,
        width: c.x - a.x, height: c.y - a.y };

  return { ok: true, art: notice || art, dpr: window.devicePixelRatio,
           stats: document.getElementById('stats').textContent };
})`;

// A garment shoot, which is what this is for. The landscape crop fills the
// window for the hero; the portrait one crops better into square tiles.
const WIDE = { file: 'hf.png', type: 'image/png' };
const SUBJECT = { file: 'banner.png', type: 'image/png' };

/* The tiles are shot on the light canvas in black ink, which is what this work
 * is actually for: one screen, one plate, on a garment. */
const PRINT = { bg: '#f2f2f2', grid: false, handles: false,
                paint: { fill: '#141414', useSourceColours: false } };

// Both faces, which is where the tone matters most.
const DETAIL = { detail: { cx: 0.50, cy: 0.27, w: 0.80 }, art: true };

const SHOTS = [
  // Four colour on a light canvas: the one screen that is about colour, on
  // the one ground it is for.
  Object.assign({ name: 'hero', effect: 'halftone', tool: 'halftone',
                  preset: 'fourcolour', bg: '#f2f2f2' }, WIDE),

  Object.assign({ name: 'halftone-cmyk', effect: 'halftone', tool: 'halftone',
                  preset: 'fourcolour', params: { pitch: 6 } }, SUBJECT, PRINT, DETAIL,
                { paint: { fill: '#141414', useSourceColours: true } }),

  Object.assign({ name: 'halftone-mono', effect: 'halftone', tool: 'halftone',
                  preset: 'onecolour',
                  params: { pitch: 5, grit: 0.4 } }, SUBJECT, PRINT, DETAIL),

  Object.assign({ name: 'dither', effect: 'dither', tool: 'dither',
                  preset: 'distressed',
                  params: { imageCut: 0.34, imageLevels: 1 } }, SUBJECT, PRINT, DETAIL),

  // 'free' rather than the default arc: the point of the tile is the four
  // corner handles, and an arc on top of them throws artwork past the frame.
  Object.assign({ name: 'warp', effect: 'warp', tool: 'warp',
                  params: { imageCut: 0.34, preset: 'free',
                            corners: [{ x: 0.08, y: 0.02 }, { x: 0.95, y: 0.14 },
                                      { x: 0.90, y: 0.98 }, { x: 0.02, y: 0.86 }] } },
                SUBJECT, PRINT, { art: true, square: true, handles: true }),

  // Type: a display face off this machine, chewed by the dither, on the
  // light canvas in black ink like the other tiles.
  Object.assign({ name: 'type', text: 'TENZEN\nANGELS', family: 'Gilroy',
                  effect: 'dither', tool: 'dither', preset: 'screenprint',
                  art: true }, PRINT),

  Object.assign({ name: 'update-notice', effect: 'halftone', tool: 'halftone', art: true,
                  notice: { state: 'ready', version: '2.2.0',
                            notes: 'A finer default screen, and warp handles that snap to the frame.' } },
                WIDE)
];

async function run(win, app, outDir) {
  const dir = path.join(outDir, '..', 'docs', 'media');
  fs.mkdirSync(dir, { recursive: true });

  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 1800));

  // The canvas alone, for the small tiles. Found from the page rather than
  // guessed, so a layout change does not silently crop them.
  const box = await win.webContents.executeJavaScript(
    'JSON.stringify((function(){var r=document.getElementById("stage").getBoundingClientRect();' +
    'return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})())');
  const stage = JSON.parse(box);

  for (const shot of SHOTS) {
    const res = await win.webContents.executeJavaScript(
      DRIVE + '(' + JSON.stringify(shot) + ')', true);
    if (res && res.error) {
      console.error(shot.name + ': ' + res.error);
      continue;
    }
    /* Captured whole and then cropped, rather than asking capturePage for a
     * rectangle: passing it one came back as bare canvas for anything near the
     * bottom of the window. The two take different units, which is its own
     * trap. capturePage wants CSS pixels; crop wants the image's own, so the
     * rectangle has to be scaled by the device pixel ratio first. */
    let image = await win.capturePage();
    if (shot.art && res.art) {
      image = image.crop(scale(clamp(res.art, stage), res.dpr || 1));
    }
    fs.writeFileSync(path.join(dir, shot.name + '.png'), image.toPNG());
    console.log(shot.name + ' -> docs/media/' + shot.name + '.png  ' + (res.stats || '') +
      (process.env.SHOT_DEBUG ? '  rect=' + JSON.stringify(res.art) : ''));
  }

  app.exit(0);
}

function scale(r, k) {
  return { x: Math.round(r.x * k), y: Math.round(r.y * k),
           width: Math.round(r.width * k), height: Math.round(r.height * k) };
}

/* The artwork's rectangle, kept inside the canvas and rounded to whole pixels
 * so the crop never asks for a row that is not there. */
function clamp(art, stage) {
  const x = Math.max(stage.x, Math.round(art.x));
  const y = Math.max(stage.y, Math.round(art.y));
  return {
    x: x, y: y,
    width: Math.max(16, Math.min(Math.round(art.width), stage.x + stage.width - x)),
    height: Math.max(16, Math.min(Math.round(art.height), stage.y + stage.height - y))
  };
}

module.exports = { run };
