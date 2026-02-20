const { contextBridge } = require('electron');

// Expose a flag so renderer knows it's in Electron
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
});
