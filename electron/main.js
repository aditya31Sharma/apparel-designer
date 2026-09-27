/* Apparel Designer, desktop shell.
 *
 * The renderer is the same plain HTML and JS the web build serves, so nothing
 * here is required for the app to run; it adds the four things a browser tab
 * cannot give: cross-origin isolation for shared memory, headroom past a tab's
 * memory ceiling, real file dialogs, and local model inference.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const http = require('http');
const net = require('net');

const ROOT = path.join(__dirname, '..');
let win = null;

/* The app is served over a loopback HTTP origin rather than opened off disk.
 * Two reasons, both load-bearing:
 *   - a file:// page cannot start a Web Worker at all, and the heavy compute
 *     has to be off the main thread
 *   - cross-origin isolation, which is what SharedArrayBuffer needs, is only
 *     granted to http and https origins. A custom scheme does not get it, which
 *     I found out the hard way. With it, the worker pool shares one buffer
 *     instead of copying a four megabyte mask per band.
 * The server binds to 127.0.0.1 on a port the OS picks, and refuses anything
 * that is not a GET for a file inside the app directory. */

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm'
};

let serverOrigin = null;

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405); res.end('method not allowed'); return;
      }
      let rel;
      try {
        rel = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
      } catch (e) {
        res.writeHead(400); res.end('bad path'); return;
      }
      if (rel === '/' || rel === '') rel = '/index.html';

      // The background model lives in the app's data directory, not in the
      // bundle: it is 213MB and is fetched once on first use. Expose just that
      // one directory so the page can load it like any other asset.
      if (rel.startsWith('/model/')) {
        const name = path.basename(rel);
        const file = path.join(app.getPath('userData'), 'models', name);
        try {
          const body = await fs.readFile(file);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': body.length,
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Cache-Control': 'no-store'
          });
          res.end(req.method === 'HEAD' ? undefined : body);
        } catch (err) {
          res.writeHead(404); res.end('no model');
        }
        return;
      }

      // Never serve anything outside the app directory, whatever the URL says.
      const file = path.normalize(path.join(ROOT, rel));
      if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
        res.writeHead(403); res.end('forbidden'); return;
      }

      try {
        const body = await fs.readFile(file);
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Content-Length': body.length,
          // These two are the whole point: they are what turns on
          // crossOriginIsolated, and no static host can set them.
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cache-Control': 'no-store'
        });
        res.end(req.method === 'HEAD' ? undefined : body);
      } catch (err) {
        res.writeHead(404); res.end('not found');
      }
    });

    server.on('error', reject);
    // Port 0 lets the OS pick a free one, so two copies never collide.
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      serverOrigin = 'http://127.0.0.1:' + port;
      resolve(serverOrigin);
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1e1e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 11 },
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Images and SVGs come off the user's own disk, so the renderer has to be
      // able to read file:// URLs it was handed.
      webSecurity: true
    }
  });

  win.loadURL(serverOrigin + '/index.html');
  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ---------- menu ---------- */

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = (channel) => () => win && win.webContents.send(channel);

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open...', accelerator: 'CmdOrCtrl+O', click: send('menu:open') },
        { type: 'separator' },
        { label: 'Save SVG...', accelerator: 'CmdOrCtrl+S', click: send('menu:save') },
        { label: 'Save Separations...', accelerator: 'Shift+CmdOrCtrl+S', click: send('menu:separations') },
        { label: 'Copy SVG', accelerator: 'Shift+CmdOrCtrl+C', click: send('menu:copy') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: send('menu:undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: send('menu:redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Fit to Screen', accelerator: 'CmdOrCtrl+0', click: send('menu:fit') },
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+1', click: send('menu:actual') },
        { type: 'separator' },
        { label: 'Pixel Grid', accelerator: "CmdOrCtrl+'", click: send('menu:grid') },
        { label: 'Canvas Colour', accelerator: 'CmdOrCtrl+B', click: send('menu:bg') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Tool',
      submenu: [
        { label: 'Warp', accelerator: 'CmdOrCtrl+Alt+1', click: send('menu:tool:warp') },
        { label: 'Dither', accelerator: 'CmdOrCtrl+Alt+2', click: send('menu:tool:dither') },
        { label: 'Halftone', accelerator: 'CmdOrCtrl+Alt+3', click: send('menu:tool:halftone') },
        { type: 'separator' },
        { label: 'Remove Background', accelerator: 'CmdOrCtrl+Alt+B', click: send('menu:removebg') }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- file dialogs ---------- */

ipcMain.handle('dialog:open', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Artwork', extensions: ['svg', 'png', 'jpg', 'jpeg', 'webp', 'avif'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const file = res.filePaths[0];
  const buf = await fs.readFile(file);
  return { path: file, name: path.basename(file), data: buf.buffer.slice(
    buf.byteOffset, buf.byteOffset + buf.byteLength) };
});

ipcMain.handle('dialog:save', async (_e, name, text) => {
  const res = await dialog.showSaveDialog(win, {
    defaultPath: name,
    filters: [{ name: 'SVG', extensions: ['svg'] }]
  });
  if (res.canceled || !res.filePath) return null;
  await fs.writeFile(res.filePath, text, 'utf8');
  return { path: res.filePath };
});

/* ---------- background removal ---------- */

ipcMain.handle('bg:remove', async (_e, payload) => {
  try {
    const { removeBackground } = require('./bgremove.js');
    return await removeBackground(payload, app.getPath('userData'),
      (stage) => win && win.webContents.send('bg:progress', stage));
  } catch (err) {
    return { error: err.message || String(err) };
  }
});

ipcMain.handle('bg:status', async () => {
  try {
    const { modelStatus } = require('./bgremove.js');
    return await modelStatus(app.getPath('userData'));
  } catch (err) {
    return { ready: false, error: err.message || String(err) };
  }
});

/* ---------- lifecycle ---------- */

const SELFTEST = process.argv.includes('--selftest');
const BENCH = process.argv.includes('--bench');
const SUITE = process.argv.includes('--suite');
const SHEET = process.argv.includes('--sheet');
// Benchmarks have to run at the pixel density a real display has, or the cache
// is a quarter of the size it will be in use and every number flatters.
const DPR_ARG = process.argv.find((a) => a.startsWith('--dpr='));
if (DPR_ARG) app.commandLine.appendSwitch('force-device-scale-factor', DPR_ARG.split('=')[1]);

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  buildMenu();
  // A stalled suite should say where it stalled rather than time out silently.
  if (SUITE) {
    const tick = setInterval(async () => {
      try {
        const p = await win.webContents.executeJavaScript('JSON.stringify(window.__suiteProgress||null)');
        if (p && p !== 'null') {
          require('fs').writeFileSync(path.join(ROOT, 'build', 'suite-progress.json'), p);
        }
      } catch (e) { /* window gone */ }
    }, 3000);
    app.on('before-quit', () => clearInterval(tick));
  }

  if (SELFTEST || BENCH || SUITE || SHEET) {
    const mod = SHEET ? './sheet.js' : SUITE ? './suite.js' : BENCH ? './bench.js' : './selftest.js';
    require(mod).run(win, app, path.join(ROOT, 'build'))
      .catch((err) => { console.error(err); app.exit(1); });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
