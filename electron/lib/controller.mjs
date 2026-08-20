import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createNetServer, isIP } from 'node:net';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const LOCAL_BASE_URL = 'http://127.0.0.1:8787';
const VALID_PROFILES = new Set(['safe', 'agent', 'full']);
const VALID_START_MODES = new Set(['quick', 'named', 'lan']);
const VALID_CONNECTION_STATES = new Set(['offline', 'disconnected', 'pairing', 'authorized', 'connected']);
const HIDDEN_TELEMETRY_EVENTS = new Set(['connector_status_requested']);

function parseJson(text, fallback = null) {
  try { return JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function normalizeHttpsOrigin(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || !url.hostname.includes('.')) {
    throw new Error('고정 주소는 경로가 없는 HTTPS 주소여야 합니다. 예: https://mcp.example.com');
  }
  if (url.hostname.endsWith('.trycloudflare.com')) {
    throw new Error('trycloudflare.com Quick Tunnel 주소는 고정 주소로 저장할 수 없습니다. 본인 도메인을 입력하세요.');
  }
  return url.origin;
}

function normalizeTunnelName(value) {
  const name = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/.test(name)) {
    throw new Error('터널 이름은 영문·숫자·하이픈으로 된 2~63자여야 합니다.');
  }
  return name;
}

function sanitizeActivity(entry) {
  const safe = {
    timestamp: entry.timestamp || new Date().toISOString(),
    event: entry.event || 'unknown',
    tool: entry.tool || null,
    success: typeof entry.success === 'boolean' ? entry.success : null,
    clientName: entry.clientName || entry.client_name || entry.client_info?.name || entry.owner_client || null,
    authType: entry.authType || null,
    permissions: Array.isArray(entry.permissions) ? entry.permissions : [],
    details: entry.details && typeof entry.details === 'object' ? entry.details : {},
    error: entry.error || null,
    reason: entry.reason || null,
    jobId: entry.job_id || null,
    kind: entry.kind || null,
    program: entry.program || null,
    status: entry.status || null,
    exitCode: entry.exit_code ?? null,
    activityId: entry.activity_id || entry.activityId || null,
    durationMs: entry.duration_ms ?? entry.durationMs ?? null
  };
  // Typed text is intentionally absent from the server audit log. Keep this
  // sanitizer strict so future fields cannot accidentally expose secrets.
  return safe;
}

function normalizeConnectionState(localHealthy, connectorStatus) {
  if (!localHealthy) {
    return {
      status: 'offline', detected: false, client_id: null, client_name: null,
      pairing_phase: null, active_session_count: 0, authorized_connector_count: 0,
      pairing_attempt_count: 0
    };
  }
  const supplied = connectorStatus?.connection_state;
  if (supplied && VALID_CONNECTION_STATES.has(supplied.status)) {
    return {
      ...supplied,
      detected: supplied.status !== 'offline' && supplied.status !== 'disconnected',
      active_session_count: Number(supplied.active_session_count) || 0,
      authorized_connector_count: Number(supplied.authorized_connector_count) || 0,
      pairing_attempt_count: Number(supplied.pairing_attempt_count) || 0
    };
  }

  // Compatibility fallback while a previously packaged server is being
  // replaced by this launcher build.
  const sessions = connectorStatus?.active_mcp_sessions || [];
  const connectors = (connectorStatus?.connectors || []).filter(item =>
    String(item.client_name || '').toLowerCase() !== 'local oauth verification' && item.connected === true
  );
  const subject = sessions.at(-1) || connectors[0] || null;
  const status = sessions.length > 0 ? 'connected' : connectors.length > 0 ? 'authorized' : 'disconnected';
  return {
    status,
    detected: status !== 'disconnected',
    client_id: subject?.client_id || null,
    client_name: subject?.client_name || null,
    pairing_phase: null,
    active_session_count: sessions.length,
    authorized_connector_count: connectors.length,
    pairing_attempt_count: 0
  };
}

export class McpController extends EventEmitter {
  constructor(options) {
    super();
    this.projectRoot = resolve(options.projectRoot);
    this.dataDir = resolve(options.dataDir);
    this.serverEntry = resolve(options.serverEntry);
    this.controlScript = resolve(options.controlScript);
    this.nodeExecutable = resolve(options.nodeExecutable);
    this.secureStore = options.secureStore;
    this.runtimeCwd = resolve(options.runtimeCwd || this.projectRoot);
    this.powerShell = process.env.SystemRoot
      ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';
    this.paths = {
      serverPid: join(this.dataDir, 'launcher-server.pid'),
      tunnelPid: join(this.dataDir, 'launcher-tunnel.pid'),
      publicUrl: join(this.dataDir, 'current-public-url.txt'),
      serverStdout: join(this.dataDir, 'launcher-server.stdout.log'),
      serverStderr: join(this.dataDir, 'launcher-server.stderr.log'),
      tunnelStdout: join(this.dataDir, 'launcher-tunnel.stdout.log'),
      tunnelStderr: join(this.dataDir, 'launcher-tunnel.stderr.log'),
      audit: join(this.dataDir, 'audit.ndjson'),
      bootstrap: join(this.dataDir, 'bootstrap-token.txt'),
      localAdmin: join(this.dataDir, 'local-admin-token.txt'),
      policy: join(this.dataDir, 'control-policy.json'),
      settings: join(this.dataDir, 'electron-settings.json'),
      namedConfig: join(this.dataDir, 'electron-named-tunnel-config.json'),
      namedToken: join(this.dataDir, 'electron-named-tunnel-token.bin'),
      namedCloudflaredConfig: join(this.dataDir, 'cloudflared-named-tunnel.yml')
    };
    this.busy = false;
    this.auditOffset = 0;
    this.auditRemainder = '';
    this.auditInitialized = false;
    this.auditTimer = null;
    this.processCache = { at: 0, value: [] };
    this.lanIpCache = { at: 0, value: null };
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true });
    await Promise.all([
      appendFile(this.paths.serverStdout, ''),
      appendFile(this.paths.serverStderr, ''),
      appendFile(this.paths.tunnelStdout, ''),
      appendFile(this.paths.tunnelStderr, ''),
      appendFile(this.paths.audit, '')
    ]);
    // Establish the current EOF before the interval starts. Historical rows
    // are loaded separately by getRecentActivity(); the watcher is only for
    // new events appended after the Electron launcher is ready.
    await this.pollAudit();
    this.startAuditWatch();
  }

  dispose() {
    if (this.auditTimer) clearInterval(this.auditTimer);
    this.auditTimer = null;
  }

  action(message, level = 'info') {
    this.emit('action', { timestamp: new Date().toISOString(), level, message });
  }

  async readText(path, fallback = '') {
    try { return (await readFile(path, 'utf8')).replace(/^\uFEFF/, '').trim(); } catch { return fallback; }
  }

  async readJson(path, fallback = null) {
    return parseJson(await this.readText(path), fallback);
  }

  async writeJson(path, value) {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  async getSettings() {
    const current = await this.readJson(this.paths.settings, {});
    const namedConfigured = Boolean((await this.readJson(this.paths.namedConfig, null))?.public_base_url);
    const preferredStartMode = VALID_START_MODES.has(current?.preferredStartMode)
      ? current.preferredStartMode
      : namedConfigured ? 'named' : 'quick';
    return {
      overlayEnabled: current?.overlayEnabled !== false,
      previewAutoStart: current?.previewAutoStart === true,
      lanDirectEnabled: current?.lanDirectEnabled === true,
      preferredStartMode: preferredStartMode === 'named' && !namedConfigured ? 'quick' : preferredStartMode,
      autoRestoreServer: namedConfigured && current?.autoRestoreServer !== false
    };
  }

  async updateSettings(patch) {
    const current = await this.getSettings();
    const next = {
      overlayEnabled: typeof patch.overlayEnabled === 'boolean' ? patch.overlayEnabled : current.overlayEnabled,
      previewAutoStart: typeof patch.previewAutoStart === 'boolean' ? patch.previewAutoStart : current.previewAutoStart,
      lanDirectEnabled: typeof patch.lanDirectEnabled === 'boolean' ? patch.lanDirectEnabled : current.lanDirectEnabled,
      preferredStartMode: VALID_START_MODES.has(patch.preferredStartMode) ? patch.preferredStartMode : current.preferredStartMode,
      autoRestoreServer: typeof patch.autoRestoreServer === 'boolean' ? patch.autoRestoreServer : current.autoRestoreServer
    };
    if (next.lanDirectEnabled === current.lanDirectEnabled) {
      await this.writeJson(this.paths.settings, next);
      this.emit('settings', next);
      return next;
    }
    return this.runExclusive('PC IP 수신 경로 변경', async () => {
      await this.writeJson(this.paths.settings, next);
      try {
        const currentUrl = await this.readText(this.paths.publicUrl);
        const managed = await this.managedProcesses(true);
        if (currentUrl && managed.servers.length) {
          const host = this.listenHost(next);
          this.action(`MCP 서버 수신 주소를 ${host === '0.0.0.0' ? '이 PC의 LAN IP' : '이 PC 내부 전용'}으로 변경합니다…`);
          await this.stopServersOnly();
          await this.ensureLocalServer(currentUrl, host);
        }
      } catch (error) {
        await this.writeJson(this.paths.settings, current);
        const currentUrl = await this.readText(this.paths.publicUrl);
        const managed = await this.managedProcesses(true);
        if (currentUrl && !managed.servers.length) {
          await this.ensureLocalServer(currentUrl, this.listenHost(current)).catch(() => {});
        }
        throw error;
      }
      this.action(next.lanDirectEnabled
        ? '하이브리드 IP 모드가 켜졌습니다. 공개 HTTPS와 LAN IP 주소를 함께 사용할 수 있습니다.'
        : 'LAN IP 직접 수신을 끄고 이 PC 내부 전용 수신으로 되돌렸습니다.', 'success');
      this.emit('settings', next);
      return next;
    });
  }

  listenHost(settings) {
    return settings?.lanDirectEnabled ? '0.0.0.0' : '127.0.0.1';
  }

  async runExclusive(label, operation) {
    if (this.busy) throw new Error('다른 서버 작업이 진행 중입니다. 완료된 뒤 다시 시도하세요.');
    this.busy = true;
    this.emit('busy', { busy: true, label });
    try {
      return await operation();
    } finally {
      this.busy = false;
      this.emit('busy', { busy: false, label: null });
      this.emit('status-changed');
    }
  }

  async runCapture(executable, args, options = {}) {
    const timeoutMs = options.timeoutMs || 60_000;
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(executable, args, {
        cwd: options.cwd || this.runtimeCwd,
        env: options.env || process.env,
        windowsHide: options.windowsHide !== false,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const consume = (chunk, streamName) => {
        const text = chunk.toString();
        if (streamName === 'stdout') stdout += text;
        else stderr += text;
        if (!options.silent) {
          for (const line of text.split(/\r?\n/).map(item => item.trim()).filter(Boolean)) {
            this.action(line, streamName === 'stderr' ? 'warn' : 'info');
          }
        }
      };
      child.stdout.on('data', chunk => consume(chunk, 'stdout'));
      child.stderr.on('data', chunk => consume(chunk, 'stderr'));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.once('error', error => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.once('close', code => {
        clearTimeout(timer);
        if (timedOut) {
          rejectPromise(new Error(`명령이 ${Math.round(timeoutMs / 1000)}초 안에 완료되지 않았습니다.`));
          return;
        }
        resolvePromise({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  async processRecords(force = false) {
    if (!force && Date.now() - this.processCache.at < 1200) return this.processCache.value;
    const command = [
      "$items = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -in @('node.exe','electron.exe','cloudflared.exe','Remote MCP Control.exe') })",
      "$items | Select-Object ProcessId,Name,CreationDate,CommandLine | ConvertTo-Json -Compress"
    ].join('; ');
    try {
      const { stdout } = await execFileAsync(this.powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024
      });
      const parsed = parseJson(stdout, []);
      const records = !parsed ? [] : Array.isArray(parsed) ? parsed : [parsed];
      this.processCache = { at: Date.now(), value: records };
      return records;
    } catch {
      return [];
    }
  }

  isServerRecord(record) {
    const commandLine = String(record?.CommandLine || '').trim();
    // The server entry is the final process argument. Requiring the final
    // argument prevents maintenance scripts whose inline source merely
    // mentions "src/server.mjs" from being mistaken for the live server.
    return /(?:^|\s)(?:"[^"]*src[\\/]server\.mjs"|'[^']*src[\\/]server\.mjs'|[^\s"']*src[\\/]server\.mjs)\s*$/i.test(commandLine);
  }

  isTunnelRecord(record) {
    const commandLine = String(record?.CommandLine || '');
    return /cloudflared/i.test(String(record?.Name || '')) &&
      /\btunnel\b/i.test(commandLine) &&
      /--url\b/i.test(commandLine) &&
      /http:\/\/(?:127\.0\.0\.1|localhost|\d{1,3}(?:\.\d{1,3}){3}):8787\b/i.test(commandLine);
  }

  async managedProcesses(force = false) {
    const records = await this.processRecords(force);
    return {
      servers: records.filter(record => this.isServerRecord(record)),
      tunnels: records.filter(record => this.isTunnelRecord(record))
    };
  }

  async stopRecord(record, label) {
    const pid = Number(record?.ProcessId);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const valid = label === 'server' ? this.isServerRecord(record) : this.isTunnelRecord(record);
    if (!valid) throw new Error(`PID ${pid}은 이 앱이 관리하는 ${label} 프로세스로 확인되지 않았습니다.`);
    try {
      process.kill(pid);
      this.action(`${label === 'server' ? 'MCP 서버' : 'Cloudflare 터널'} 종료: PID ${pid}`);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  async stopServersOnly() {
    const managed = await this.managedProcesses(true);
    for (const record of managed.servers) await this.stopRecord(record, 'server');
    await rm(this.paths.serverPid, { force: true });
    this.processCache.at = 0;
    await sleep(400);
  }

  async stopManaged({ removePublicUrl = true } = {}) {
    const managed = await this.managedProcesses(true);
    for (const record of managed.servers) await this.stopRecord(record, 'server');
    for (const record of managed.tunnels) await this.stopRecord(record, 'tunnel');
    await Promise.all([
      rm(this.paths.serverPid, { force: true }),
      rm(this.paths.tunnelPid, { force: true }),
      ...(removePublicUrl ? [rm(this.paths.publicUrl, { force: true })] : [])
    ]);
    this.processCache.at = 0;
    await sleep(500);
  }

  async stop() {
    return this.runExclusive('서버 종료', async () => {
      this.action('MCP 서버와 터널을 종료하고 있습니다…');
      await this.stopManaged();
      this.action('MCP 서버와 터널이 종료되었습니다.', 'success');
      return this.getStatus();
    });
  }

  async isPortAvailable() {
    return new Promise(resolvePromise => {
      const probe = createNetServer();
      probe.once('error', () => resolvePromise(false));
      probe.listen(8787, '127.0.0.1', () => probe.close(() => resolvePromise(true)));
    });
  }

  async spawnDetached(executable, args, { stdoutPath, stderrPath, env = process.env } = {}) {
    await Promise.all([appendFile(stdoutPath, ''), appendFile(stderrPath, '')]);
    const stdoutFd = openSync(stdoutPath, 'a');
    const stderrFd = openSync(stderrPath, 'a');
    try {
      const child = spawn(executable, args, {
        cwd: this.runtimeCwd,
        env,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd]
      });
      await new Promise((resolvePromise, rejectPromise) => {
        child.once('spawn', resolvePromise);
        child.once('error', rejectPromise);
      });
      child.unref();
      return child.pid;
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }

  async spawnServer(publicBaseUrl, host = '127.0.0.1') {
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MCP_PUBLIC_BASE_URL: publicBaseUrl,
      MCP_DATA_DIR: this.dataDir,
      MCP_CONTROL_SCRIPT: this.controlScript,
      MCP_HOST: host,
      MCP_PORT: '8787',
      MCP_HUD_ACTIVITY_LEAD_MS: '220'
    };
    const pid = await this.spawnDetached(this.nodeExecutable, [this.serverEntry], {
      stdoutPath: this.paths.serverStdout,
      stderrPath: this.paths.serverStderr,
      env
    });
    await writeFile(this.paths.serverPid, String(pid), 'ascii');
    this.action(`MCP 서버 프로세스 시작: PID ${pid}`);
    return pid;
  }

  async waitForHttp(url, timeoutMs, { external = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(external ? 6000 : 2500), cache: 'no-store' });
        if (response.status >= 200 && response.status < 500) return true;
      } catch { /* Retry while the process or DNS route is becoming ready. */ }
      await sleep(800);
    }
    return false;
  }

  async ensureLocalServer(publicBaseUrl, host = '127.0.0.1') {
    if (!(await this.isPortAvailable())) throw new Error('포트 8787을 다른 프로그램이 사용 중입니다. 해당 프로그램을 종료한 뒤 다시 시도하세요.');
    await this.spawnServer(publicBaseUrl, host);
    if (!(await this.waitForHttp(`${LOCAL_BASE_URL}/healthz`, 25_000))) {
      await this.stopServersOnly();
      const detail = (await this.readText(this.paths.serverStderr)).slice(-1600);
      throw new Error(`로컬 MCP 서버가 응답하지 않습니다.${detail ? `\n${detail}` : ''}`);
    }
  }

  async resolveCloudflared() {
    try {
      const { stdout } = await execFileAsync('where.exe', ['cloudflared.exe'], { windowsHide: true, timeout: 5000 });
      const first = stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
      if (first) return first;
    } catch { /* Try the WinGet package cache below. */ }
    const winGetRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : null;
    if (!winGetRoot) return null;
    const literal = winGetRoot.replace(/'/g, "''");
    const command = `(Get-ChildItem -LiteralPath '${literal}' -Filter cloudflared.exe -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName)`;
    try {
      const { stdout } = await execFileAsync(this.powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15_000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async clearTunnelLogs() {
    await Promise.all([
      writeFile(this.paths.tunnelStdout, '', 'utf8'),
      writeFile(this.paths.tunnelStderr, '', 'utf8')
    ]);
  }

  async spawnQuickTunnel(cloudflared) {
    await this.clearTunnelLogs();
    const pid = await this.spawnDetached(cloudflared, ['tunnel', '--no-autoupdate', '--protocol', 'auto', '--url', LOCAL_BASE_URL], {
      stdoutPath: this.paths.tunnelStdout,
      stderrPath: this.paths.tunnelStderr
    });
    await writeFile(this.paths.tunnelPid, String(pid), 'ascii');
    this.action(`Cloudflare Quick Tunnel 시작: PID ${pid}`);
    return pid;
  }

  async spawnNamedTunnel(cloudflared, named) {
    await this.clearTunnelLogs();
    let args;
    let env = process.env;
    if (named.management === 'local-config-v1') {
      args = ['tunnel', '--no-autoupdate', '--config', named.configPath, 'run', named.tunnelName];
    } else {
      env = { ...process.env, TUNNEL_TOKEN: named.token };
      args = ['tunnel', '--no-autoupdate', 'run'];
    }
    const pid = await this.spawnDetached(cloudflared, args, {
      stdoutPath: this.paths.tunnelStdout,
      stderrPath: this.paths.tunnelStderr,
      env
    });
    await writeFile(this.paths.tunnelPid, String(pid), 'ascii');
    this.action(`Cloudflare Named Tunnel 시작: PID ${pid}`);
    return pid;
  }

  async waitForQuickTunnelUrl(timeoutMs = 50_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const logs = `${await this.readText(this.paths.tunnelStdout)}\n${await this.readText(this.paths.tunnelStderr)}`;
      const matches = logs.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
      if (matches?.length) return matches[matches.length - 1].replace(/\/$/, '');
      await sleep(700);
    }
    return null;
  }

  modeFromPublicUrl(publicBaseUrl, named) {
    const value = String(publicBaseUrl || '');
    if (value.includes('trycloudflare.com')) return 'quick';
    if (value && named?.publicBaseUrl === value) return 'named';
    if (value.startsWith('http://') && !value.includes('127.0.0.1')) return 'lan';
    return value ? 'custom' : null;
  }

  async localHealth() {
    try {
      const response = await fetch(`${LOCAL_BASE_URL}/healthz`, { signal: AbortSignal.timeout(1800), cache: 'no-store' });
      return response.ok;
    } catch {
      return false;
    }
  }

  async start(mode) {
    if (!VALID_START_MODES.has(mode)) throw new Error('지원하지 않는 서버 시작 모드입니다.');
    return this.runExclusive('서버 시작', async () => {
      const savedUrl = await this.readText(this.paths.publicUrl);
      const savedNamed = await this.getNamedTunnel(false);
      const currentMode = this.modeFromPublicUrl(savedUrl, savedNamed);
      const managed = await this.managedProcesses(true);
      const healthy = await this.localHealth();

      if (mode === currentMode && savedUrl) {
        const routeReady = mode === 'lan' || managed.tunnels.length > 0;
        if (healthy && routeReady) {
          this.action(`이미 같은 주소로 실행 중입니다: ${savedUrl}/mcp`, 'success');
          return this.getStatus();
        }
        if (!healthy && routeReady) {
          this.action(`터널 주소를 유지한 채 MCP 서버만 복구합니다: ${savedUrl}/mcp`);
          await this.stopServersOnly();
          const settings = await this.getSettings();
          await this.ensureLocalServer(savedUrl, mode === 'lan' ? '0.0.0.0' : this.listenHost(settings));
          this.action('기존 MCP URL과 OAuth 인증을 유지해 서버를 복구했습니다.', 'success');
          return this.getStatus();
        }
      }

      if (mode === 'quick' && currentMode === 'quick' && savedUrl && managed.tunnels.length === 0) {
        this.action('Quick Tunnel 프로세스가 없어 기존 임시 주소를 복구할 수 없습니다. 새 주소를 발급합니다.', 'warn');
      } else {
        this.action('요청한 실행 모드에 맞게 MCP 프로세스 상태를 정리하고 있습니다…');
      }
      await this.stopManaged();

      if (mode === 'lan') {
        const ip = await this.preferredLanIp();
        const publicBaseUrl = `http://${ip}:8787`;
        await this.ensureLocalServer(publicBaseUrl, '0.0.0.0');
        await writeFile(this.paths.publicUrl, publicBaseUrl, 'ascii');
        this.action(`LAN MCP 서버가 실행 중입니다: ${publicBaseUrl}/mcp`, 'success');
        return this.getStatus();
      }

      const settings = await this.getSettings();
      const listenHost = this.listenHost(settings);

      const cloudflared = await this.resolveCloudflared();
      if (!cloudflared) throw new Error('cloudflared.exe를 찾지 못했습니다. Cloudflare Tunnel을 먼저 설치하세요.');

      if (mode === 'named') {
        const named = await this.getNamedTunnel(true);
        this.action(`고정 도메인 서버를 시작합니다: ${named.publicBaseUrl}`);
        await this.ensureLocalServer(named.publicBaseUrl, listenHost);
        await this.spawnNamedTunnel(cloudflared, named);
        await writeFile(this.paths.publicUrl, named.publicBaseUrl, 'ascii');
        if (!(await this.waitForHttp(`${named.publicBaseUrl}/healthz`, 55_000, { external: true }))) {
          this.action('고정 도메인이 아직 외부에서 응답하지 않습니다. DNS 전파와 Tunnel 로그를 확인하세요.', 'warn');
        } else {
          this.action(`고정 MCP 주소가 온라인입니다: ${named.publicBaseUrl}/mcp`, 'success');
        }
        return this.getStatus();
      }

      this.action('로컬 MCP 서버를 준비하고 있습니다…');
      await this.ensureLocalServer(LOCAL_BASE_URL, listenHost);
      await this.spawnQuickTunnel(cloudflared);
      const publicBaseUrl = await this.waitForQuickTunnelUrl();
      if (!publicBaseUrl) {
        await this.stopManaged();
        throw new Error(`Quick Tunnel URL을 받지 못했습니다. 로그: ${this.paths.tunnelStderr}`);
      }
      this.action(`임시 HTTPS 주소 발급: ${publicBaseUrl}`);
      await this.stopServersOnly();
      await this.ensureLocalServer(publicBaseUrl, listenHost);
      await writeFile(this.paths.publicUrl, publicBaseUrl, 'ascii');
      if (!(await this.waitForHttp(`${publicBaseUrl}/healthz`, 55_000, { external: true }))) {
        this.action('Quick Tunnel DNS가 아직 전파 중입니다. 서버는 유지되며 잠시 뒤 다시 확인됩니다.', 'warn');
      } else {
        this.action(`공개 MCP 주소가 온라인입니다: ${publicBaseUrl}/mcp`, 'success');
      }
      return this.getStatus();
    });
  }

  async startPreferred() {
    const settings = await this.getSettings();
    return this.start(settings.preferredStartMode || 'quick');
  }

  async restartServer() {
    return this.runExclusive('주소 유지 서버 재시작', async () => {
      const publicBaseUrl = await this.readText(this.paths.publicUrl);
      if (!publicBaseUrl) throw new Error('유지할 MCP 주소가 없습니다. 먼저 서버를 시작하세요.');
      const named = await this.getNamedTunnel(false);
      const mode = this.modeFromPublicUrl(publicBaseUrl, named);
      const managed = await this.managedProcesses(true);
      if (mode === 'quick' && managed.tunnels.length === 0) {
        throw new Error('Quick Tunnel이 종료되어 기존 임시 주소를 유지할 수 없습니다. 새 임시 주소를 시작하거나 고정 도메인을 설정하세요.');
      }
      this.action(`MCP 주소를 유지하고 서버 프로세스만 재시작합니다: ${publicBaseUrl}/mcp`);
      await this.stopServersOnly();
      const settings = await this.getSettings();
      await this.ensureLocalServer(publicBaseUrl, mode === 'lan' ? '0.0.0.0' : this.listenHost(settings));

      if (mode === 'named' && managed.tunnels.length === 0) {
        const cloudflared = await this.resolveCloudflared();
        if (!cloudflared) throw new Error('cloudflared.exe를 찾지 못했습니다.');
        await this.spawnNamedTunnel(cloudflared, await this.getNamedTunnel(true));
      }
      this.action('MCP URL과 저장된 OAuth 인증을 유지한 채 서버 재시작을 완료했습니다.', 'success');
      return this.getStatus();
    });
  }

  async restorePreferredServer() {
    const settings = await this.getSettings();
    if (!settings.autoRestoreServer || settings.preferredStartMode !== 'named') return this.getStatus();
    const named = await this.getNamedTunnel(false);
    if (!named) return this.getStatus();
    this.action(`고정 도메인 자동 복구를 시작합니다: ${named.publicBaseUrl}/mcp`);
    return this.start('named');
  }

  async preferredLanIp() {
    if (this.lanIpCache.value && Date.now() - this.lanIpCache.at < 30_000) return this.lanIpCache.value;
    const command = "$preferred = Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } | ForEach-Object { $_.IPv4Address.IPAddress } | Where-Object { $_ -notmatch '^(127\\.|169\\.254\\.)' } | Select-Object -First 1; if (-not $preferred) { $preferred = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\\.|169\\.254\\.)' -and $_.PrefixLength -gt 0 } | Sort-Object InterfaceIndex | Select-Object -First 1 -ExpandProperty IPAddress }; $preferred";
    const { stdout } = await execFileAsync(this.powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10_000 });
    const ip = stdout.trim();
    if (isIP(ip) !== 4 || /^(?:127\.|169\.254\.)/.test(ip)) throw new Error('사용 가능한 사설 IPv4 주소를 찾지 못했습니다.');
    this.lanIpCache = { at: Date.now(), value: ip };
    return ip;
  }

  async getConnectorStatus() {
    try {
      const token = await this.readText(this.paths.localAdmin);
      if (token.length < 30) return null;
      const response = await fetch(`${LOCAL_BASE_URL}/admin/connectors`, {
        headers: { 'X-Mcp-Local-Admin': token },
        signal: AbortSignal.timeout(2500),
        cache: 'no-store'
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  async revokeConnector(clientId) {
    const value = String(clientId || '').trim();
    if (!value || value.length > 500) throw new Error('연결 해제할 AI Client ID가 올바르지 않습니다.');
    const token = await this.readText(this.paths.localAdmin);
    if (token.length < 30) throw new Error('로컬 관리자 토큰을 찾지 못했습니다. 서버를 먼저 시작하세요.');
    const response = await fetch(`${LOCAL_BASE_URL}/admin/connectors`, {
      method: 'POST',
      headers: { 'X-Mcp-Local-Admin': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: value }),
      signal: AbortSignal.timeout(5000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'AI 연결을 해제하지 못했습니다.');
    this.action('선택한 AI 커넥터의 인증과 세션을 해제했습니다.', 'success');
    return body;
  }

  async getStatus() {
    const managed = await this.managedProcesses();
    const serverRecord = managed.servers[0] || null;
    const tunnelRecord = managed.tunnels[0] || null;
    const lastPublicBaseUrl = await this.readText(this.paths.publicUrl);
    const named = await this.getNamedTunnel(false);
    const settings = await this.getSettings();
    const policy = await this.readJson(this.paths.policy, null);
    const localHealthy = await this.localHealth();
    const connectorStatus = localHealthy ? await this.getConnectorStatus() : null;
    const connectionState = normalizeConnectionState(localHealthy, connectorStatus);
    const mode = this.modeFromPublicUrl(lastPublicBaseUrl, named);
    const activePublicBaseUrl = localHealthy ? lastPublicBaseUrl : '';
    const lanIp = await this.preferredLanIp().catch(() => null);
    const lanMcpUrl = localHealthy && settings.lanDirectEnabled && lanIp ? `http://${lanIp}:8787/mcp` : null;
    return {
      server: {
        running: Boolean(serverRecord) && localHealthy,
        processDetected: Boolean(serverRecord),
        pid: serverRecord ? Number(serverRecord.ProcessId) : null,
        startedAt: serverRecord?.CreationDate || null
      },
      tunnel: {
        running: Boolean(tunnelRecord),
        pid: tunnelRecord ? Number(tunnelRecord.ProcessId) : null
      },
      localHealthy,
      publicBaseUrl: activePublicBaseUrl || null,
      mcpUrl: activePublicBaseUrl ? `${activePublicBaseUrl}/mcp` : null,
      lanIp,
      lanMcpUrl,
      listenHost: this.listenHost(settings),
      lastPublicBaseUrl: lastPublicBaseUrl || null,
      mode: activePublicBaseUrl ? mode : null,
      busy: this.busy,
      profile: policy?.profile || 'agent',
      policy,
      connectors: connectorStatus?.connectors || [],
      activeSessions: connectorStatus?.active_mcp_sessions || [],
      connectionState,
      oauthAccessTokenTtlSeconds: connectorStatus?.oauth_access_token_ttl_seconds || null,
      oauthRefreshTokenTtlSeconds: connectorStatus?.oauth_refresh_token_ttl_seconds || null,
      pairingStateTtlSeconds: connectorStatus?.pairing_state_ttl_seconds || null,
      activeSessionWindowSeconds: connectorStatus?.active_session_window_seconds || null,
      retainedSessionCount: connectorStatus?.retained_mcp_session_count || 0,
      namedTunnel: named ? { publicBaseUrl: named.publicBaseUrl, tunnelName: named.tunnelName } : null,
      endpointPersistent: activePublicBaseUrl ? mode === 'named' || mode === 'lan' : settings.preferredStartMode === 'named',
      settings
    };
  }

  async getBootstrapToken() {
    const token = await this.readText(this.paths.bootstrap);
    if (token.length < 20) throw new Error('페어링 토큰이 아직 없습니다. 서버를 한 번 시작하세요.');
    return token;
  }

  async setProfile(profile) {
    if (!VALID_PROFILES.has(profile)) throw new Error('지원하지 않는 권한 프로필입니다.');
    const policy = await this.readJson(this.paths.policy, {
      version: 1,
      profile: 'agent',
      allowed_workspaces: [dirname(this.projectRoot)],
      allow_process_stop: true,
      max_concurrent_jobs: 2,
      max_job_runtime_seconds: 1800,
      max_job_output_bytes: 1048576,
      allowed_programs: {
        codex: { command: 'codex.exe', description: 'Codex CLI' },
        claude: { command: 'claude.exe', description: 'Claude Code CLI' },
        git: { command: 'git.exe', description: 'Git' },
        node: { command: 'node.exe', description: 'Node.js' },
        npm: { command: 'npm.cmd', description: 'npm' },
        python: { command: 'python.exe', description: 'Python' }
      }
    });
    policy.profile = profile;
    await this.writeJson(this.paths.policy, policy);
    this.action(`로컬 제어 권한 프로필을 '${profile}'로 변경했습니다.`, 'success');
    const currentUrl = await this.readText(this.paths.publicUrl);
    const managed = await this.managedProcesses(true);
    if (currentUrl && managed.servers.length) {
      this.action('새 권한 정책을 적용하기 위해 MCP 서버만 재시작합니다…');
      await this.stopServersOnly();
      const settings = await this.getSettings();
      const host = currentUrl.startsWith('http://') && !currentUrl.includes('127.0.0.1') ? '0.0.0.0' : this.listenHost(settings);
      await this.ensureLocalServer(currentUrl, host);
    }
    this.emit('status-changed');
    return this.getStatus();
  }

  async cloudflareStatus() {
    const executable = await this.resolveCloudflared();
    if (!executable) return { installed: false, loggedIn: false, executable: null, tunnels: [] };
    const result = await this.runCapture(executable, ['tunnel', 'list', '--output', 'json'], { timeoutMs: 20_000, silent: true });
    const tunnels = result.code === 0 ? parseJson(result.stdout, []) || [] : [];
    return {
      installed: true,
      loggedIn: result.code === 0,
      executable,
      tunnels: Array.isArray(tunnels) ? tunnels.map(item => ({ id: item.id, name: item.name, status: item.status })) : []
    };
  }

  async cloudflareLogin() {
    return this.runExclusive('Cloudflare 로그인', async () => {
      const executable = await this.resolveCloudflared();
      if (!executable) throw new Error('cloudflared.exe를 찾지 못했습니다. 먼저 Cloudflare Tunnel을 설치하세요.');
      this.action('브라우저에서 Cloudflare 로그인과 도메인 선택을 완료하세요.', 'info');
      const result = await this.runCapture(executable, ['tunnel', 'login'], { timeoutMs: 5 * 60_000, windowsHide: true });
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Cloudflare 로그인이 완료되지 않았습니다.');
      this.action('Cloudflare 계정 로그인이 완료되었습니다.', 'success');
      return this.cloudflareStatus();
    });
  }

  async saveNamedTunnel({ publicBaseUrl, tunnelName, token }) {
    const normalizedUrl = normalizeHttpsOrigin(publicBaseUrl);
    const normalizedName = tunnelName ? normalizeTunnelName(tunnelName) : '';
    const value = String(token || '').trim();
    if (value.length < 20) throw new Error('Cloudflare Tunnel 실행 토큰이 너무 짧거나 비어 있습니다.');
    if (!this.secureStore?.available()) throw new Error('Windows 보안 저장소를 사용할 수 없어 Tunnel 토큰을 저장할 수 없습니다.');
    const encrypted = this.secureStore.encrypt(value);
    await writeFile(this.paths.namedToken, encrypted);
    await this.writeJson(this.paths.namedConfig, {
      version: 1,
      public_base_url: normalizedUrl,
      tunnel_name: normalizedName,
      management: 'remote-token-v1',
      token_storage: 'electron-safe-storage-v1',
      updated_at: new Date().toISOString()
    });
    await this.updateSettings({ preferredStartMode: 'named', autoRestoreServer: true });
    this.action(`고정 도메인 설정을 안전하게 저장했습니다: ${normalizedUrl}`, 'success');
    this.emit('status-changed');
    return { publicBaseUrl: normalizedUrl, tunnelName: normalizedName };
  }

  async getNamedTunnel(includeToken = false) {
    const config = await this.readJson(this.paths.namedConfig, null);
    if (!config?.public_base_url) return null;
    const result = {
      publicBaseUrl: config.public_base_url,
      tunnelName: config.tunnel_name || '',
      management: config.management || 'remote-token-v1',
      tunnelId: config.tunnel_id || null,
      configPath: config.cloudflared_config || this.paths.namedCloudflaredConfig
    };
    if (!includeToken) return result;
    if (result.management === 'local-config-v1') {
      try { await stat(result.configPath); } catch { throw new Error('저장된 Named Tunnel 설정 파일을 찾지 못했습니다. 고정 도메인 마법사를 다시 실행하세요.'); }
      return result;
    }
    if (!this.secureStore?.available()) throw new Error('Windows 보안 저장소를 사용할 수 없습니다.');
    let encrypted;
    try { encrypted = await readFile(this.paths.namedToken); } catch { throw new Error('저장된 Named Tunnel 토큰을 찾지 못했습니다. 설정 마법사를 다시 실행하세요.'); }
    result.token = this.secureStore.decrypt(encrypted);
    if (result.token.length < 20) throw new Error('저장된 Named Tunnel 토큰이 올바르지 않습니다.');
    return result;
  }

  async createNamedTunnel({ publicBaseUrl, tunnelName, useExisting = false }) {
    return this.runExclusive('고정 도메인 설정', async () => {
      const normalizedUrl = normalizeHttpsOrigin(publicBaseUrl);
      const normalizedName = normalizeTunnelName(tunnelName);
      const executable = await this.resolveCloudflared();
      if (!executable) throw new Error('cloudflared.exe를 찾지 못했습니다. 먼저 Cloudflare Tunnel을 설치하세요.');
      const account = await this.cloudflareStatus();
      if (!account.loggedIn) throw new Error('Cloudflare 로그인이 필요합니다. 먼저 브라우저 로그인 버튼을 누르세요.');
      const existing = account.tunnels.find(item => item.name === normalizedName);
      if (existing && !useExisting) throw new Error('같은 이름의 Tunnel이 이미 있습니다. 기존 Tunnel 사용을 선택하거나 다른 이름을 입력하세요.');

      if (!existing) {
        this.action(`Cloudflare Tunnel '${normalizedName}'을 생성합니다…`);
        const createResult = await this.runCapture(executable, ['tunnel', 'create', normalizedName], { timeoutMs: 60_000 });
        if (createResult.code !== 0) throw new Error(createResult.stderr.trim() || 'Cloudflare Tunnel 생성에 실패했습니다.');
      } else {
        this.action(`기존 Cloudflare Tunnel '${normalizedName}'을 사용합니다.`);
      }

      const refreshedAccount = await this.cloudflareStatus();
      const configuredTunnel = refreshedAccount.tunnels.find(item => item.name === normalizedName);
      if (!configuredTunnel?.id) throw new Error('생성된 Cloudflare Tunnel ID를 확인하지 못했습니다.');

      const hostname = new URL(normalizedUrl).hostname;
      this.action(`${hostname} DNS 레코드를 Tunnel에 연결합니다…`);
      const routeResult = await this.runCapture(executable, ['tunnel', 'route', 'dns', normalizedName, hostname], { timeoutMs: 60_000 });
      if (routeResult.code !== 0) {
        throw new Error(routeResult.stderr.trim() || 'DNS 연결에 실패했습니다. 기존 DNS 레코드가 있다면 Cloudflare에서 확인하세요.');
      }

      const profileRoot = process.env.USERPROFILE || (
        process.env.HOMEDRIVE && process.env.HOMEPATH
          ? `${process.env.HOMEDRIVE}${process.env.HOMEPATH}`
          : ''
      );
      const credentialsFile = profileRoot ? join(profileRoot, '.cloudflared', `${configuredTunnel.id}.json`) : '';
      try { await stat(credentialsFile); } catch {
        throw new Error('이 PC에서 Tunnel 자격 증명 파일을 찾지 못했습니다. 같은 PC에서 새 Tunnel을 만들거나 수동 토큰 등록을 사용하세요.');
      }
      const yamlPath = value => String(value).replaceAll('\\', '/');
      const tunnelConfig = [
        `tunnel: ${configuredTunnel.id}`,
        `credentials-file: ${JSON.stringify(yamlPath(credentialsFile))}`,
        'ingress:',
        `  - hostname: ${hostname}`,
        `    service: ${LOCAL_BASE_URL}`,
        '  - service: http_status:404',
        ''
      ].join('\n');
      await writeFile(this.paths.namedCloudflaredConfig, tunnelConfig, 'utf8');
      await rm(this.paths.namedToken, { force: true });
      await this.writeJson(this.paths.namedConfig, {
        version: 2,
        public_base_url: normalizedUrl,
        tunnel_name: normalizedName,
        tunnel_id: configuredTunnel.id,
        management: 'local-config-v1',
        credentials_file: credentialsFile,
        cloudflared_config: this.paths.namedCloudflaredConfig,
        updated_at: new Date().toISOString()
      });
      await this.updateSettings({ preferredStartMode: 'named', autoRestoreServer: true });
      this.action(`고정 도메인을 기본 시작 주소로 설정했습니다: ${normalizedUrl}`, 'success');
      this.emit('status-changed');
      return { publicBaseUrl: normalizedUrl, tunnelName: normalizedName };
    });
  }

  async getRecentActivity(limit = 160) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 160, 500));
    try {
      const info = await stat(this.paths.audit);
      // Status polling from older builds can occupy several megabytes. Read a
      // bounded history window, remove launcher telemetry, and only then take
      // the requested number of real user/audit events.
      const bytes = Math.min(info.size, 8 * 1024 * 1024);
      const handle = await open(this.paths.audit, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, info.size - bytes);
        const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
        if (info.size > bytes) lines.shift();
        return lines
          .map(line => parseJson(line))
          .filter(entry => entry && !HIDDEN_TELEMETRY_EVENTS.has(entry.event))
          .slice(-safeLimit)
          .map(sanitizeActivity);
      } finally {
        await handle.close();
      }
    } catch {
      return [];
    }
  }

  startAuditWatch() {
    if (this.auditTimer) return;
    this.auditTimer = setInterval(() => this.pollAudit().catch(() => {}), 90);
    this.auditTimer.unref?.();
  }

  async pollAudit() {
    let info;
    try { info = await stat(this.paths.audit); } catch { return; }
    if (!this.auditInitialized) {
      this.auditOffset = info.size;
      this.auditInitialized = true;
      return;
    }
    if (info.size < this.auditOffset) {
      this.auditOffset = 0;
      this.auditRemainder = '';
    }
    if (info.size === this.auditOffset) return;
    const length = info.size - this.auditOffset;
    const handle = await open(this.paths.audit, 'r');
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, this.auditOffset);
      let text = this.auditRemainder + buffer.toString('utf8');
      this.auditOffset = info.size;
      const lines = text.split(/\r?\n/);
      this.auditRemainder = lines.pop() || '';
      for (const line of lines) {
        const parsed = parseJson(line);
        if (parsed && !HIDDEN_TELEMETRY_EVENTS.has(parsed.event)) this.emit('activity', sanitizeActivity(parsed));
      }
    } finally {
      await handle.close();
    }
  }
}

export const validators = { normalizeHttpsOrigin, normalizeTunnelName, sanitizeActivity, normalizeConnectionState };
