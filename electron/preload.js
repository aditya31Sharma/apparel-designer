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
  'tool:warp', 'tool:dither', 'tool:halftone'
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

  removeBackground: (payload) => ipcRenderer.invoke('bg:remove', payload),
  backgroundStatus: () => ipcRenderer.invoke('bg:status'),
  onBackgroundProgress: (fn) => ipcRenderer.on('bg:progress', (_e, stage) => fn(stage)),

  onMenu: (name, fn) => { menuHandlers[name] = fn; }
});
