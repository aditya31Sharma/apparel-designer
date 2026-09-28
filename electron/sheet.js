/* Visual verification. Runs each effect over each test image, captures the
 * canvas, and writes a contact sheet so the output can be looked at rather
 * than inferred from numbers. */
'use strict';
const fs = require('fs');
const path = require('path');

const SCRIPT = `(async function(){
  function wait(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  var Doc = window.Doc;
  var shots = [], notes = [];

  async function loadFile(name, type){
    var blob = await (await fetch(name)).blob();
    var f = new File([blob], name, {type:type});
    var dt = new DataTransfer(); dt.items.add(f);
    var input = document.getElementById('file');
    input.files = dt.files; input.dispatchEvent(new Event('change', {bubbles:true}));
    await wait(2600);
    return window.App.selected();
  }
  function recompute(){
    return new Promise(function(r){ window.__onResult = r; window.App.markDirty(false); setTimeout(r, 30000); });
  }

  async function shot(label, layer, setup){
    layer.effects.forEach(function(e){ e.on = false; });
    setup();
    window.App.syncPanels();
    var t0 = performance.now();
    await recompute();
    var ms = Math.round(performance.now() - t0);
    document.getElementById('fit').click();
    await wait(500);
    var c = document.getElementById('canvas');
    shots.push({ label: label, png: c.toDataURL('image/png'), ms: ms,
                 stats: document.getElementById('stats').textContent });
    notes.push(label + ' :: ' + ms + 'ms :: ' + document.getElementById('stats').textContent);
  }

  var files = [['doom.jpg','image/jpeg'],['palm.png','image/png'],
               ['banner.png','image/png'],['hf.png','image/png'],['alpha.png','image/png']];

  for (var fi = 0; fi < files.length; fi++){
    var L = await loadFile(files[fi][0], files[fi][1]);
    var tag = files[fi][0].split('.')[0];
    notes.push('--- ' + tag + ' ' + (L.source.pixels ? L.source.pixels.w+'x'+L.source.pixels.h : '?') + ' ---');

    await shot(tag+'/halftone', L, function(){ Doc.effect(L,'halftone').on = true; });
    await shot(tag+'/halftone-mono', L, function(){
      Doc.effect(L,'halftone').on = true;
      Object.assign(Doc.effect(L,'halftone').params, window.HALFTONE_PRESETS.poster.params);
    });
    await shot(tag+'/halftone-twocolour', L, function(){
      Doc.effect(L,'halftone').on = true;
      Object.assign(Doc.effect(L,'halftone').params, window.HALFTONE_PRESETS.twocolour.params);
    });
    await shot(tag+'/dither', L, function(){
      Doc.effect(L,'dither').on = true;
      Object.assign(Doc.effect(L,'dither').params, window.DITHER_PRESETS.spray.params);
    });
    await shot(tag+'/dither-distressed', L, function(){
      Doc.effect(L,'dither').on = true;
      Object.assign(Doc.effect(L,'dither').params, window.DITHER_PRESETS.distressed.params);
    });
  }

  return JSON.stringify({ notes: notes, shots: shots });
})()`;

async function run(win, app, outDir) {
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));
  let raw;
  try { raw = await win.webContents.executeJavaScript(SCRIPT, true); }
  catch (err) { raw = JSON.stringify({ notes: ['ERROR ' + (err.stack || err)], shots: [] }); }
  const data = JSON.parse(raw);
  const dir = path.join(outDir, 'sheet');
  fs.mkdirSync(dir, { recursive: true });
  data.shots.forEach((s) => {
    const file = path.join(dir, s.label.replace(/\//g, '_') + '.png');
    fs.writeFileSync(file, Buffer.from(s.png.split(',')[1], 'base64'));
  });
  fs.writeFileSync(path.join(outDir, 'sheet.txt'), data.notes.join('\n'));
  app.quit();
}
module.exports = { run };
