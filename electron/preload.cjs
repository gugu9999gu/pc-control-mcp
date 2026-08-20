const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('mcpApp', Object.freeze({
  getStatus: () => ipcRenderer.invoke('mcp:get-status'),
  getActivity: limit => ipcRenderer.invoke('mcp:get-activity', limit),
  captureDesktopFrame: () => ipcRenderer.invoke('mcp:capture-desktop-frame'),
  start: mode => ipcRenderer.invoke('mcp:start', mode),
  stop: () => ipcRenderer.invoke('mcp:stop'),
  setProfile: profile => ipcRenderer.invoke('mcp:set-profile', profile),
  revokeConnector: clientId => ipcRenderer.invoke('mcp:revoke-connector', clientId),
  getSettings: () => ipcRenderer.invoke('mcp:get-settings'),
  setSettings: patch => ipcRenderer.invoke('mcp:set-settings', patch),
  previewOverlay: () => ipcRenderer.invoke('mcp:preview-overlay'),
  cloudflareStatus: () => ipcRenderer.invoke('mcp:cloudflare-status'),
  cloudflareLogin: () => ipcRenderer.invoke('mcp:cloudflare-login'),
  createNamedTunnel: values => ipcRenderer.invoke('mcp:create-named-tunnel', values),
  saveNamedTunnel: values => ipcRenderer.invoke('mcp:save-named-tunnel', values),
  copyUrl: () => ipcRenderer.invoke('mcp:copy-url'),
  copyLanUrl: () => ipcRenderer.invoke('mcp:copy-lan-url'),
  copyToken: () => ipcRenderer.invoke('mcp:copy-token'),
  openChatGpt: () => ipcRenderer.invoke('mcp:open-chatgpt'),
  openDataFolder: () => ipcRenderer.invoke('mcp:open-data-folder'),
  windowCommand: command => ipcRenderer.invoke('mcp:window', command),
  onStatus: callback => subscribe('mcp:status', callback),
  onActivity: callback => subscribe('mcp:activity', callback),
  onAction: callback => subscribe('mcp:action', callback),
  onBusy: callback => subscribe('mcp:busy', callback)
}));
