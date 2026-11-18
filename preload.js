const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hub', {
  toggle: id => ipcRenderer.send('toggle', id),
  add: url => ipcRenderer.send('add', url),
  toggleFit: () => ipcRenderer.send('fit'),
  setScale: v => ipcRenderer.send('scale', v),
  setItemScale: v => ipcRenderer.send('itemScale', v),
  toggleAdblock: () => ipcRenderer.send('adblock'),
  pip: () => ipcRenderer.send('pip'),
  onToast: fn => ipcRenderer.on('toast', (_, m) => fn(m)),
  setMode: m => ipcRenderer.send('mode', m),
  activate: id => ipcRenderer.send('activate', id),
  close: id => ipcRenderer.send('close', id),
  onState: fn => ipcRenderer.on('state', (_, s) => fn(s)),
});
