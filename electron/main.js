/* Apparel Designer, desktop shell.
 *
 * The renderer is the same plain HTML and JS the web build serves, so nothing
 * here is required for the app to run; it adds the four things a browser tab
 * cannot give: cross-origin isolation for shared memory, headroom past a tab's
 * memory ceiling, real file dialogs, and local model inference.
 */
'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const ROOT = path.join(__dirname, '..');
let win = null;

/* Workers cannot be started from a file:// page, and the whole reason the heavy
 * compute stays off the main thread is that they can. So the app is served over
 * its own scheme instead, which also lets every response carry the isolation
 * headers SharedArrayBuffer needs. */
const SCHEME = 'app';

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true, secure: true, supportFetchAPI: true,
    corsEnabled: true, stream: true
  }
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm'
};

function registerAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || rel === '') rel = '/index.html';

    // Never serve anything outside the app directory, whatever the URL says.
    const file = path.normalize(path.join(ROOT, rel));
    if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });

    try {
      const body = await fs.readFile(file);
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Resource-Policy': 'same-origin',
          'Cache-Control': 'no-cache'
        }
      });
    } catch (err) {
      return new Response('not found: ' + rel, { status: 404 });
    }
  });
}

/* Cross-origin isolation is what SharedArrayBuffer needs, and no static host
 * can set these headers. Setting them here is the concrete reason the desktop
 * build can move worker results without copying them. */
function applyIsolationHeaders(session) {
  session.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: Object.assign({}, details.responseHeaders, {
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
        'Cross-Origin-Resource-Policy': ['same-origin']
      })
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

  applyIsolationHeaders(win.webContents.session);
  win.loadURL(SCHEME + '://bundle/index.html');
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

app.whenReady().then(() => {
  registerAppProtocol();
  createWindow();
  buildMenu();
  if (SELFTEST) {
    require('./selftest.js').run(win, app, path.join(ROOT, 'build'))
      .catch((err) => { console.error(err); app.exit(1); });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
