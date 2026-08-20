const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mcpOverlay', Object.freeze({
  onStatus: callback => subscribe('mcp:overlay-status', callback),
  onActivity: callback => subscribe('mcp:overlay-activity', callback)
}));
