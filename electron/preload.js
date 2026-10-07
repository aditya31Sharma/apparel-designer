/* The only bridge between the page and the machine.
 * contextIsolation is on and nodeIntegration is off, so this list is the entire
 * surface the renderer gets.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const menuHandlers = {};

[
  'open', 'save', 'separations', 'copy', 'undo', 'redo',
  'fit', 'actual', 'grid', 'bg', 'removebg',
  'tool:warp', 'tool:dither', 'tool:halftone', 'mockup', 'video'
].forEach((name) => {
  ipcRenderer.on('menu:' + name, () => {
    const fn = menuHandlers[name];
    if (fn) fn();
  });
});

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,

  openFile: () => ipcRenderer.invoke('dialog:open'),
  saveFile: (name, text) => ipcRenderer.invoke('dialog:save', name, text),
  saveBinary: (name, data) => ipcRenderer.invoke('dialog:saveBinary', name, data),

  removeBackground: (payload) => ipcRenderer.invoke('bg:remove', payload),
  backgroundStatus: () => ipcRenderer.invoke('bg:status'),
  onBackgroundProgress: (fn) => ipcRenderer.on('bg:progress', (_e, stage) => fn(stage)),

  /* Every font in Adobe Fonts and Downloads that is not installed yet, into
   * ~/Library/Fonts. { dryRun: true } reports without writing anything. */
  installFonts: (opts) => ipcRenderer.invoke('fonts:install', opts || {}),

  onMenu: (name, fn) => { menuHandlers[name] = fn; },

  /* Updating. The page tells the main process it managed to start, which is
   * what stops a broken update from being kept. */
  ready: () => ipcRenderer.send('app:alive'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  onUpdate: (fn) => ipcRenderer.on('update:state', (_e, state) => fn(state)),
  restart: () => ipcRenderer.invoke('update:restart'),
  openReleases: () => ipcRenderer.invoke('update:releases'),
  revertUpdate: () => ipcRenderer.invoke('update:revert'),

  /* Video Editor. Media reaches the page as loopback URLs, never as paths it can
   * open itself; rendering and YouTube import run in the main process. */
  video: {
    status: () => ipcRenderer.invoke('video:status'),
    pick: (kind) => ipcRenderer.invoke('video:pick', kind),
    youtube: (url) => ipcRenderer.invoke('video:youtube', url),
    saveProject: (json) => ipcRenderer.invoke('video:project:save', json),
    loadProject: () => ipcRenderer.invoke('video:project:load'),
    render: (project, overlays) => ipcRenderer.invoke('video:render', project, overlays),
    cancel: () => ipcRenderer.invoke('video:cancel'),
    reveal: (file) => ipcRenderer.invoke('video:reveal', file),
    onProgress: (fn) => ipcRenderer.on('video:progress', (_e, p) => fn(p))
  }
});
