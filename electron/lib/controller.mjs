import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer as createNetServer } from 'node:net';
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
      namedToken: join(this.dataDir, 'electron-named-tunnel-token.bin')
    };
    this.busy = false;
    this.auditOffset = 0;
    this.auditRemainder = '';
    this.auditInitialized = false;
    this.auditTimer = null;
    this.processCache = { at: 0, value: [] };
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
    return {
      overlayEnabled: current?.overlayEnabled !== false,
      previewAutoStart: current?.previewAutoStart === true
    };
  }

  async updateSettings(patch) {
    const current = await this.getSettings();
    const next = {
      overlayEnabled: typeof patch.overlayEnabled === 'boolean' ? patch.overlayEnabled : current.overlayEnabled,
      previewAutoStart: typeof patch.previewAutoStart === 'boolean' ? patch.previewAutoStart : current.previewAutoStart
    };
    await this.writeJson(this.paths.settings, next);
    this.emit('settings', next);
    return next;
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
    return /(?:^|[\s"'\\/])src[\\/]server\.mjs(?:[\s"']|$)/i.test(String(record?.CommandLine || ''));
  }

  isTunnelRecord(record) {
    return /cloudflared/i.test(String(record?.Name || '')) && /127\.0\.0\.1:8787/i.test(String(record?.CommandLine || ''));
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

  async start(mode) {
    if (!VALID_START_MODES.has(mode)) throw new Error('지원하지 않는 서버 시작 모드입니다.');
    return this.runExclusive('서버 시작', async () => {
      this.action('기존 MCP 프로세스 상태를 정리하고 있습니다…');
      await this.stopManaged();

      if (mode === 'lan') {
        const ip = await this.preferredLanIp();
        const publicBaseUrl = `http://${ip}:8787`;
        await this.ensureLocalServer(publicBaseUrl, '0.0.0.0');
        await writeFile(this.paths.publicUrl, publicBaseUrl, 'ascii');
        this.action(`LAN MCP 서버가 실행 중입니다: ${publicBaseUrl}/mcp`, 'success');
        return this.getStatus();
      }

      const cloudflared = await this.resolveCloudflared();
      if (!cloudflared) throw new Error('cloudflared.exe를 찾지 못했습니다. Cloudflare Tunnel을 먼저 설치하세요.');

      if (mode === 'named') {
        const named = await this.getNamedTunnel(true);
        this.action(`고정 도메인 서버를 시작합니다: ${named.publicBaseUrl}`);
        await this.ensureLocalServer(named.publicBaseUrl);
        await this.clearTunnelLogs();
        const env = { ...process.env, TUNNEL_TOKEN: named.token };
        const pid = await this.spawnDetached(cloudflared, ['tunnel', '--no-autoupdate', 'run', '--url', LOCAL_BASE_URL], {
          stdoutPath: this.paths.tunnelStdout,
          stderrPath: this.paths.tunnelStderr,
          env
        });
        await writeFile(this.paths.tunnelPid, String(pid), 'ascii');
        await writeFile(this.paths.publicUrl, named.publicBaseUrl, 'ascii');
        this.action(`Cloudflare Named Tunnel 시작: PID ${pid}`);
        if (!(await this.waitForHttp(`${named.publicBaseUrl}/healthz`, 55_000, { external: true }))) {
          this.action('고정 도메인이 아직 외부에서 응답하지 않습니다. DNS 전파와 Tunnel 로그를 확인하세요.', 'warn');
        } else {
          this.action(`고정 MCP 주소가 온라인입니다: ${named.publicBaseUrl}/mcp`, 'success');
        }
        return this.getStatus();
      }

      this.action('로컬 MCP 서버를 준비하고 있습니다…');
      await this.ensureLocalServer(LOCAL_BASE_URL);
      await this.spawnQuickTunnel(cloudflared);
      const publicBaseUrl = await this.waitForQuickTunnelUrl();
      if (!publicBaseUrl) {
        await this.stopManaged();
        throw new Error(`Quick Tunnel URL을 받지 못했습니다. 로그: ${this.paths.tunnelStderr}`);
      }
      this.action(`임시 HTTPS 주소 발급: ${publicBaseUrl}`);
      await this.stopServersOnly();
      await this.ensureLocalServer(publicBaseUrl);
      await writeFile(this.paths.publicUrl, publicBaseUrl, 'ascii');
      if (!(await this.waitForHttp(`${publicBaseUrl}/healthz`, 55_000, { external: true }))) {
        this.action('Quick Tunnel DNS가 아직 전파 중입니다. 서버는 유지되며 잠시 뒤 다시 확인됩니다.', 'warn');
      } else {
        this.action(`공개 MCP 주소가 온라인입니다: ${publicBaseUrl}/mcp`, 'success');
      }
      return this.getStatus();
    });
  }

  async preferredLanIp() {
    const command = "Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\\.|169\\.254\\.)' -and $_.PrefixLength -gt 0 } | Sort-Object InterfaceIndex | Select-Object -First 1 -ExpandProperty IPAddress";
    const { stdout } = await execFileAsync(this.powerShell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 10_000 });
    const ip = stdout.trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) throw new Error('사용 가능한 사설 IPv4 주소를 찾지 못했습니다.');
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
    let localHealthy = false;
    try {
      const response = await fetch(`${LOCAL_BASE_URL}/healthz`, { signal: AbortSignal.timeout(1800), cache: 'no-store' });
      localHealthy = response.ok;
    } catch { /* Offline. */ }
    const connectorStatus = localHealthy ? await this.getConnectorStatus() : null;
    const mode = lastPublicBaseUrl.includes('trycloudflare.com')
      ? 'quick'
      : lastPublicBaseUrl && named?.publicBaseUrl === lastPublicBaseUrl
        ? 'named'
        : lastPublicBaseUrl.startsWith('http://') && !lastPublicBaseUrl.includes('127.0.0.1')
          ? 'lan'
          : lastPublicBaseUrl ? 'custom' : null;
    const activePublicBaseUrl = localHealthy ? lastPublicBaseUrl : '';
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
      lastPublicBaseUrl: lastPublicBaseUrl || null,
      mode: activePublicBaseUrl ? mode : null,
      busy: this.busy,
      profile: policy?.profile || 'agent',
      policy,
      connectors: connectorStatus?.connectors || [],
      activeSessions: connectorStatus?.active_mcp_sessions || [],
      oauthAccessTokenTtlSeconds: connectorStatus?.oauth_access_token_ttl_seconds || null,
      oauthRefreshTokenTtlSeconds: connectorStatus?.oauth_refresh_token_ttl_seconds || null,
      namedTunnel: named ? { publicBaseUrl: named.publicBaseUrl, tunnelName: named.tunnelName } : null,
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
      await this.ensureLocalServer(currentUrl, currentUrl.startsWith('http://') && !currentUrl.includes('127.0.0.1') ? '0.0.0.0' : '127.0.0.1');
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
      token_storage: 'electron-safe-storage-v1',
      updated_at: new Date().toISOString()
    });
    this.action(`고정 도메인 설정을 안전하게 저장했습니다: ${normalizedUrl}`, 'success');
    this.emit('status-changed');
    return { publicBaseUrl: normalizedUrl, tunnelName: normalizedName };
  }

  async getNamedTunnel(includeToken = false) {
    const config = await this.readJson(this.paths.namedConfig, null);
    if (!config?.public_base_url) return null;
    const result = {
      publicBaseUrl: config.public_base_url,
      tunnelName: config.tunnel_name || ''
    };
    if (!includeToken) return result;
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

      const hostname = new URL(normalizedUrl).hostname;
      this.action(`${hostname} DNS 레코드를 Tunnel에 연결합니다…`);
      const routeResult = await this.runCapture(executable, ['tunnel', 'route', 'dns', normalizedName, hostname], { timeoutMs: 60_000 });
      if (routeResult.code !== 0) {
        throw new Error(routeResult.stderr.trim() || 'DNS 연결에 실패했습니다. 기존 DNS 레코드가 있다면 Cloudflare에서 확인하세요.');
      }

      this.action('Tunnel 실행 토큰을 안전하게 가져오고 있습니다…');
      const tokenResult = await this.runCapture(executable, ['tunnel', 'token', normalizedName], { timeoutMs: 30_000, silent: true });
      const token = tokenResult.stdout.trim();
      if (tokenResult.code !== 0 || token.length < 20) throw new Error('Tunnel은 생성됐지만 실행 토큰을 가져오지 못했습니다.');
      return this.saveNamedTunnel({ publicBaseUrl: normalizedUrl, tunnelName: normalizedName, token });
    });
  }

  async getRecentActivity(limit = 160) {
    const safeLimit = Math.max(1, Math.min(Number(limit) || 160, 500));
    try {
      const info = await stat(this.paths.audit);
      const bytes = Math.min(info.size, 512 * 1024);
      const handle = await open(this.paths.audit, 'r');
      try {
        const buffer = Buffer.alloc(bytes);
        await handle.read(buffer, 0, bytes, info.size - bytes);
        const lines = buffer.toString('utf8').split(/\r?\n/).filter(Boolean);
        if (info.size > bytes) lines.shift();
        return lines.slice(-safeLimit).map(line => parseJson(line)).filter(Boolean).map(sanitizeActivity);
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
        if (parsed) this.emit('activity', sanitizeActivity(parsed));
      }
    } finally {
      await handle.close();
    }
  }
}

export const validators = { normalizeHttpsOrigin, normalizeTunnelName, sanitizeActivity };
