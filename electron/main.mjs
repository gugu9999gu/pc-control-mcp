import {
  app,
  BrowserWindow,
  clipboard,
  desktopCapturer,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  screen,
  session,
  shell,
  Tray
} from 'electron';
import { writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpController } from './lib/controller.mjs';

const ELECTRON_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = resolve(ELECTRON_ROOT, '..');
const APP_VERSION = (() => {
  try { return JSON.parse(readFileSync(join(SOURCE_ROOT, 'package.json'), 'utf8')).version || app.getVersion(); }
  catch { return app.getVersion(); }
})();
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) app.quit();

let mainWindow = null;
let overlayWindow = null;
let tray = null;
let controller = null;
let isQuitting = false;
let statusTimer = null;
let statusInFlight = false;
let overlayReady = false;
let overlayPromise = null;
const pendingOverlayActivities = [];
const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));

function appPaths() {
  return {
    projectRoot: app.isPackaged ? app.getAppPath() : SOURCE_ROOT,
    dataDir: app.isPackaged ? join(app.getPath('userData'), 'data') : join(SOURCE_ROOT, 'data'),
    serverEntry: app.isPackaged ? join(app.getAppPath(), 'src', 'server.mjs') : join(SOURCE_ROOT, 'src', 'server.mjs'),
    controlScript: app.isPackaged
      ? join(process.resourcesPath, 'server-scripts', 'windows-control.ps1')
      : join(SOURCE_ROOT, 'scripts', 'windows-control.ps1'),
    runtimeCwd: app.isPackaged ? process.resourcesPath : SOURCE_ROOT
  };
}

function displayState() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  const left = Math.min(...displays.map(display => display.bounds.x));
  const top = Math.min(...displays.map(display => display.bounds.y));
  const right = Math.max(...displays.map(display => display.bounds.x + display.bounds.width));
  const bottom = Math.max(...displays.map(display => display.bounds.y + display.bounds.height));
  return {
    primary: {
      id: String(primary.id),
      bounds: primary.bounds,
      workArea: primary.workArea,
      scaleFactor: primary.scaleFactor
    },
    virtual: { x: left, y: top, width: right - left, height: bottom - top },
    displays: displays.map(display => ({ id: String(display.id), bounds: display.bounds, scaleFactor: display.scaleFactor }))
  };
}

async function enrichedStatus() {
  const status = await controller.getStatus();
  return { ...status, display: displayState(), appVersion: APP_VERSION, packaged: app.isPackaged };
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function sendOverlay(channel, payload) {
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayReady) {
    overlayWindow.webContents.send(channel, payload);
  } else if (channel === 'mcp:overlay-activity') {
    pendingOverlayActivities.push(payload);
    if (pendingOverlayActivities.length > 120) pendingOverlayActivities.splice(0, pendingOverlayActivities.length - 120);
  }
}

function broadcastActivity(event) {
  send('mcp:activity', event);
  sendOverlay('mcp:overlay-activity', event);
}

function syncOverlayBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const virtual = displayState().virtual;
  overlayWindow.setBounds(virtual, false);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
}

async function publishStatus() {
  if (statusInFlight) return;
  statusInFlight = true;
  try {
    const status = await enrichedStatus();
    send('mcp:status', status);
    sendOverlay('mcp:overlay-status', status);
  } catch (error) {
    send('mcp:action', { timestamp: new Date().toISOString(), level: 'error', message: error.message });
  } finally {
    statusInFlight = false;
  }
}

function configureDisplayCapture() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!mainWindow || mainWindow.isDestroyed() || request.frame !== mainWindow.webContents.mainFrame || !request.videoRequested) {
      callback({});
      return;
    }
    try {
      const primaryId = String(screen.getPrimaryDisplay().id);
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const source = sources.find(item => String(item.display_id) === primaryId) || sources[0];
      callback(source ? { video: source } : {});
    } catch {
      callback({});
    }
  });
}

function secureStore() {
  return {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: value => safeStorage.encryptString(value),
    decrypt: value => safeStorage.decryptString(value)
  };
}

function registerIpc() {
  ipcMain.handle('mcp:get-status', () => enrichedStatus());
  ipcMain.handle('mcp:get-activity', (_event, limit) => controller.getRecentActivity(limit));
  ipcMain.handle('mcp:capture-desktop-frame', async event => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) throw new Error('화면 캡처 요청을 확인할 수 없습니다.');
    const primaryId = String(screen.getPrimaryDisplay().id);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 720 } });
    const source = sources.find(item => String(item.display_id) === primaryId) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('기본 모니터 프레임을 가져오지 못했습니다.');
    const size = source.thumbnail.getSize();
    return { dataUrl: source.thumbnail.toDataURL(), width: size.width, height: size.height, timestamp: Date.now() };
  });
  ipcMain.handle('mcp:start', async (_event, mode) => controller.start(mode));
  ipcMain.handle('mcp:start-preferred', () => controller.startPreferred());
  ipcMain.handle('mcp:restart-server', () => controller.restartServer());
  ipcMain.handle('mcp:stop', () => controller.stop());
  ipcMain.handle('mcp:set-profile', (_event, profile) => controller.setProfile(profile));
  ipcMain.handle('mcp:revoke-connector', (_event, clientId) => controller.revokeConnector(clientId));
  ipcMain.handle('mcp:get-settings', () => controller.getSettings());
  ipcMain.handle('mcp:set-settings', async (_event, patch) => {
    const next = await controller.updateSettings(patch || {});
    if (next.overlayEnabled) await ensureOverlayWindow();
    else destroyOverlayWindow();
    return next;
  });
  ipcMain.handle('mcp:preview-overlay', async () => {
    const settings = await controller.getSettings();
    if (!settings.overlayEnabled) await controller.updateSettings({ overlayEnabled: true });
    await ensureOverlayWindow();
    runOverlayPreview().catch(error => controller.action(`HUD 미리보기 오류: ${error.message}`, 'error'));
    return { started: true };
  });
  ipcMain.handle('mcp:cloudflare-status', () => controller.cloudflareStatus());
  ipcMain.handle('mcp:cloudflare-login', () => controller.cloudflareLogin());
  ipcMain.handle('mcp:create-named-tunnel', (_event, values) => controller.createNamedTunnel(values || {}));
  ipcMain.handle('mcp:save-named-tunnel', (_event, values) => controller.saveNamedTunnel(values || {}));
  ipcMain.handle('mcp:copy-url', async () => {
    const status = await controller.getStatus();
    if (!status.mcpUrl) throw new Error('복사할 MCP URL이 없습니다. 서버를 먼저 시작하세요.');
    clipboard.writeText(status.mcpUrl);
    return status.mcpUrl;
  });
  ipcMain.handle('mcp:copy-lan-url', async () => {
    const status = await controller.getStatus();
    if (!status.lanMcpUrl) throw new Error('LAN IP 주소가 아직 활성화되지 않았습니다. 하이브리드 IP 모드를 켜고 서버를 시작하세요.');
    clipboard.writeText(status.lanMcpUrl);
    return status.lanMcpUrl;
  });
  ipcMain.handle('mcp:copy-token', async () => {
    const token = await controller.getBootstrapToken();
    clipboard.writeText(token);
    return true;
  });
  ipcMain.handle('mcp:open-chatgpt', () => shell.openExternal('https://chatgpt.com/'));
  ipcMain.handle('mcp:open-chatgpt-plugins', () => shell.openExternal('https://chatgpt.com/plugins'));
  ipcMain.handle('mcp:open-data-folder', () => shell.openPath(controller.dataDir));
  ipcMain.handle('mcp:window', (_event, command) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (command === 'minimize') mainWindow.minimize();
    else if (command === 'maximize') mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
    else if (command === 'close') mainWindow.hide();
    return true;
  });
}

function windowSecurity(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\/(?:www\.)?(?:chatgpt\.com|dash\.cloudflare\.com)(?:\/|$)/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 930,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    backgroundColor: '#071012',
    title: 'Remote MCP Control',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#071012', symbolColor: '#dffdf8', height: 42 },
    webPreferences: {
      preload: join(ELECTRON_ROOT, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  });
  windowSecurity(mainWindow);
  mainWindow.loadFile(join(ELECTRON_ROOT, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', event => {
    if (!isQuitting && !IS_SMOKE_TEST) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.webContents.on('did-finish-load', async () => {
    await publishStatus();
    if (IS_SMOKE_TEST) runSmokeCapture().catch(() => { isQuitting = true; app.quit(); });
  });
}

async function createOverlayWindow() {
  const virtual = displayState().virtual;
  const window = new BrowserWindow({
    x: virtual.x,
    y: virtual.y,
    width: virtual.width,
    height: virtual.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    show: false,
    webPreferences: {
      preload: join(ELECTRON_ROOT, 'overlay-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  });
  overlayWindow = window;
  overlayReady = false;
  window.setIgnoreMouseEvents(true, { forward: true });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.webContents.once('did-finish-load', async () => {
    if (window.isDestroyed() || overlayWindow !== window) return;
    overlayReady = true;
    window.webContents.send('mcp:overlay-status', await enrichedStatus());
    for (const event of pendingOverlayActivities.splice(0)) {
      window.webContents.send('mcp:overlay-activity', event);
    }
  });
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.showInactive();
  });
  window.on('closed', () => {
    if (overlayWindow === window) {
      overlayWindow = null;
      overlayReady = false;
    }
  });
  await window.loadFile(join(ELECTRON_ROOT, 'overlay', 'overlay.html'));
  syncOverlayBounds();
}

async function ensureOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    syncOverlayBounds();
    if (!overlayWindow.isVisible()) overlayWindow.showInactive();
    return;
  }
  if (overlayPromise) return overlayPromise;
  overlayPromise = createOverlayWindow();
  try {
    await overlayPromise;
  } finally {
    overlayPromise = null;
  }
}

function destroyOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.destroy();
  overlayWindow = null;
  overlayReady = false;
  pendingOverlayActivities.length = 0;
}

async function runOverlayPreview() {
  await ensureOverlayWindow();
  const bounds = displayState().primary.bounds;
  const clientName = 'HUD preview · local only';
  const emitPair = async (tool, details, hold = 620) => {
    const activityId = `preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const started = Date.now();
    broadcastActivity({ timestamp: new Date().toISOString(), event: 'tool_start', tool, success: null, activityId, clientName, details });
    await delay(hold);
    broadcastActivity({ timestamp: new Date().toISOString(), event: 'tool_call', tool, success: true, activityId, durationMs: Date.now() - started, clientName, details });
  };
  await emitPair('hud_status_update', {
    title: '화면 상태를 확인하고 안전한 입력 경로를 준비합니다',
    message: '현재 작업의 공개 요약과 실제 도구 실행 로그가 이 메시지 창에 표시됩니다. 내부 사고와 키 입력 내용은 표시되지 않습니다.',
    phase: 'planning', progress_percent: 18, current_target: 'PRIMARY MONITOR · HUD PREVIEW'
  }, 1_500);
  await delay(250);
  await emitPair('type_text', { characters: 24 }, 1_800);
  await delay(300);
  await emitPair('mouse_move', {
    x: Math.round(bounds.x + bounds.width * .38),
    y: Math.round(bounds.y + bounds.height * .42)
  }, 1_800);
  await delay(300);
  await emitPair('mouse_click', {
    x: Math.round(bounds.x + bounds.width * .56),
    y: Math.round(bounds.y + bounds.height * .54),
    button: 'left',
    clicks: 1
  }, 1_800);
  await delay(250);
  await emitPair('hud_status_update', {
    title: 'HUD 미리보기가 완료되었습니다',
    message: '중앙 작업 요약, 최근 실행 로그, AI 포인터, 키보드 개인정보 보호 표시가 정상적으로 렌더링되었습니다.',
    phase: 'completed', progress_percent: 100, current_target: 'LOCAL VISUAL SAFETY LAYER'
  }, 5_000);
}

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#071012"/><circle cx="16" cy="16" r="10" fill="none" stroke="#41f3cf" stroke-width="2"/><circle cx="16" cy="16" r="4" fill="#41f3cf"/><path d="M16 2v6M16 24v6M2 16h6M24 16h6" stroke="#8b9bff" stroke-width="2" stroke-linecap="round"/></svg>`;
  return nativeImage.createFromBuffer(Buffer.from(svg)).resize({ width: 24, height: 24 });
}

function createTray() {
  tray = new Tray(trayImage());
  tray.setToolTip('Remote MCP Control');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '대시보드 열기', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: '현재 MCP URL 복사', click: async () => { try { const status = await controller.getStatus(); if (status.mcpUrl) clipboard.writeText(status.mcpUrl); } catch {} } },
    { type: 'separator' },
    { label: '기본 모드로 서버 시작', click: () => controller.startPreferred().catch(error => controller.action(error.message, 'error')) },
    { label: '주소 유지 서버 재시작', click: () => controller.restartServer().catch(error => controller.action(error.message, 'error')) },
    { label: '서버 종료', click: () => controller.stop().catch(error => controller.action(error.message, 'error')) },
    { label: '앱 종료 (서버 유지)', click: () => { isQuitting = true; app.quit(); } },
    { label: '서버 종료 후 앱 종료', click: async () => { try { await controller.stop(); } finally { isQuitting = true; app.quit(); } } }
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

async function runSmokeCapture() {
  send('mcp:action', { timestamp: new Date().toISOString(), level: 'success', message: 'Electron 대시보드 렌더링 검증 중' });
  await ensureOverlayWindow();
  const briefId = `smoke-brief-${Date.now()}`;
  const briefDetails = {
    title: '시각 정보를 확인하고 다음 작업을 준비합니다',
    message: '연결된 AI가 공개한 작업 요약과 실제 MCP 도구 로그를 중앙 HUD에 표시하고 있습니다.',
    phase: 'working', progress_percent: 62, current_target: 'PRIMARY MONITOR · VISUAL CHECK'
  };
  broadcastActivity({
    timestamp: new Date().toISOString(), event: 'tool_start', tool: 'hud_status_update', success: null, activityId: briefId,
    clientName: 'OpenAI connector · UI smoke test', details: briefDetails
  });
  broadcastActivity({
    timestamp: new Date().toISOString(), event: 'tool_call', tool: 'hud_status_update', success: true, activityId: briefId, durationMs: 12,
    clientName: 'OpenAI connector · UI smoke test', details: briefDetails
  });
  const activityId = `smoke-${Date.now()}`;
  broadcastActivity({
    timestamp: new Date().toISOString(), event: 'tool_start', tool: 'mouse_click', success: null, activityId,
    clientName: 'OpenAI connector · UI smoke test', details: { x: 960, y: 420, button: 'left', clicks: 1 }
  });
  await delay(650);
  const image = await mainWindow.webContents.capturePage();
  const target = process.env.MCP_SMOKE_OUTPUT || join(controller.dataDir, 'electron-dashboard-smoke.png');
  await writeFile(target, image.toPNG());
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const overlayImage = await overlayWindow.webContents.capturePage();
    const overlayTarget = /\.png$/i.test(target) ? target.replace(/\.png$/i, '-overlay.png') : `${target}-overlay.png`;
    await writeFile(overlayTarget, overlayImage.toPNG());
    console.log(`OVERLAY_SMOKE_SCREENSHOT=${overlayTarget}`);
  }
  await mainWindow.webContents.executeJavaScript("document.querySelector('[data-target=\"connections\"]')?.click()");
  await delay(180);
  const connectionsImage = await mainWindow.webContents.capturePage();
  const connectionsTarget = /\.png$/i.test(target) ? target.replace(/\.png$/i, '-connections.png') : `${target}-connections.png`;
  await writeFile(connectionsTarget, connectionsImage.toPNG());
  console.log(`CONNECTIONS_SMOKE_SCREENSHOT=${connectionsTarget}`);
  broadcastActivity({
    timestamp: new Date().toISOString(), event: 'tool_call', tool: 'mouse_click', success: true, activityId, durationMs: 650,
    clientName: 'OpenAI connector · UI smoke test', details: { x: 960, y: 420, button: 'left', clicks: 1 }
  });
  console.log(`SMOKE_SCREENSHOT=${target}`);
  isQuitting = true;
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  app.setAppUserModelId('local.openai.remote-mcp-control');
  Menu.setApplicationMenu(null);
  const paths = appPaths();
  controller = new McpController({
    ...paths,
    nodeExecutable: process.execPath,
    secureStore: secureStore()
  });
  await controller.initialize();
  configureDisplayCapture();
  registerIpc();
  createMainWindow();
  if (!IS_SMOKE_TEST) createTray();

  controller.on('activity', event => broadcastActivity(event));
  controller.on('action', event => send('mcp:action', event));
  controller.on('busy', event => send('mcp:busy', event));
  controller.on('status-changed', () => publishStatus());
  controller.on('settings', async settings => {
    if (settings.overlayEnabled) await ensureOverlayWindow();
    else destroyOverlayWindow();
  });

  const settings = await controller.getSettings();
  if (settings.overlayEnabled) await ensureOverlayWindow();
  const refreshDisplays = () => {
    syncOverlayBounds();
    publishStatus();
  };
  screen.on('display-added', refreshDisplays);
  screen.on('display-removed', refreshDisplays);
  screen.on('display-metrics-changed', refreshDisplays);
  statusTimer = setInterval(publishStatus, 2200);
  if (!IS_SMOKE_TEST && settings.autoRestoreServer && settings.preferredStartMode === 'named') {
    controller.restorePreferredServer().catch(error => controller.action(`고정 도메인 자동 복구 실패: ${error.message}`, 'error'));
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (statusTimer) clearInterval(statusTimer);
  controller?.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
