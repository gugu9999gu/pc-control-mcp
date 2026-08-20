import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { McpController, validators } from '../electron/lib/controller.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('fixed-domain values are normalized and unsafe quick URLs are rejected', () => {
  assert.equal(validators.normalizeHttpsOrigin('https://mcp.example.com/'), 'https://mcp.example.com');
  assert.equal(validators.normalizeTunnelName('remote-mcp-admin-pc'), 'remote-mcp-admin-pc');
  assert.throws(() => validators.normalizeHttpsOrigin('https://temporary.trycloudflare.com'), /고정 주소/);
  assert.throws(() => validators.normalizeHttpsOrigin('http://mcp.example.com'), /HTTPS/);
  assert.throws(() => validators.normalizeTunnelName('한글 이름'), /영문/);
});

test('controller recognizes servers launched with relative and absolute entry paths', () => {
  const recognizes = McpController.prototype.isServerRecord;
  assert.equal(recognizes.call({}, { CommandLine: '"C:\\Program Files\\nodejs\\node.exe" src/server.mjs' }), true);
  assert.equal(recognizes.call({}, { CommandLine: 'electron.exe C:\\work\\remote-mcp-control\\src\\server.mjs' }), true);
  assert.equal(recognizes.call({}, { CommandLine: 'node.exe src/server-other.mjs' }), false);
  assert.equal(recognizes.call({}, { CommandLine: 'node.exe --input-type=module -e "const entry = resolve(\'src/server.mjs\'); run(entry)"' }), false);
});

test('controller recognizes loopback and LAN-IP tunnel origins without matching unrelated tunnels', () => {
  const recognizes = McpController.prototype.isTunnelRecord;
  assert.equal(recognizes.call({}, { Name: 'cloudflared.exe', CommandLine: 'cloudflared tunnel --no-autoupdate --url http://127.0.0.1:8787' }), true);
  assert.equal(recognizes.call({}, { Name: 'cloudflared.exe', CommandLine: 'cloudflared tunnel --no-autoupdate --url http://192.168.68.80:8787' }), true);
  assert.equal(recognizes.call({}, { Name: 'cloudflared.exe', CommandLine: 'cloudflared tunnel --url http://127.0.0.1:9999' }), false);
  assert.equal(recognizes.call({}, { Name: 'other.exe', CommandLine: 'other tunnel --url http://127.0.0.1:8787' }), false);
});

test('LAN direct setting is explicit and maps to the all-interface listen host', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'remote-mcp-settings-'));
  const controller = new McpController({
    projectRoot: ROOT,
    dataDir,
    serverEntry: join(ROOT, 'src', 'server.mjs'),
    controlScript: join(ROOT, 'scripts', 'windows-control.ps1'),
    nodeExecutable: process.execPath,
    secureStore: null,
    runtimeCwd: ROOT
  });
  try {
    assert.equal((await controller.getSettings()).lanDirectEnabled, false);
    assert.equal(controller.listenHost(await controller.getSettings()), '127.0.0.1');
    const updated = await controller.updateSettings({ lanDirectEnabled: true });
    assert.equal(updated.lanDirectEnabled, true);
    assert.equal(controller.listenHost(updated), '0.0.0.0');
    assert.equal((await controller.getSettings()).lanDirectEnabled, true);
  } finally {
    controller.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a configured named tunnel becomes the persistent default and can auto-restore', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'remote-mcp-named-default-'));
  const controller = new McpController({
    projectRoot: ROOT,
    dataDir,
    serverEntry: join(ROOT, 'src', 'server.mjs'),
    controlScript: join(ROOT, 'scripts', 'windows-control.ps1'),
    nodeExecutable: process.execPath,
    secureStore: null,
    runtimeCwd: ROOT
  });
  try {
    await controller.writeJson(controller.paths.namedConfig, {
      version: 2,
      public_base_url: 'https://mcp.example.com',
      tunnel_name: 'remote-mcp-test',
      management: 'local-config-v1'
    });
    const defaults = await controller.getSettings();
    assert.equal(defaults.preferredStartMode, 'named');
    assert.equal(defaults.autoRestoreServer, true);
    const disabled = await controller.updateSettings({ autoRestoreServer: false });
    assert.equal(disabled.preferredStartMode, 'named');
    assert.equal(disabled.autoRestoreServer, false);
  } finally {
    controller.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('HUD activity lifecycle metadata is retained without leaking secret fields', () => {
  const safe = validators.sanitizeActivity({
    timestamp: '2026-08-20T00:00:00.000Z',
    event: 'tool_start',
    tool: 'type_text',
    activity_id: 'activity-123',
    duration_ms: 220,
    client_name: 'OpenAI connector',
    details: { characters: 12 },
    text: 'must never appear',
    access_token: 'must-never-appear'
  });
  assert.equal(safe.activityId, 'activity-123');
  assert.equal(safe.durationMs, 220);
  assert.equal(safe.clientName, 'OpenAI connector');
  assert.deepEqual(safe.details, { characters: 12 });
  assert.equal('text' in safe, false);
  assert.equal('access_token' in safe, false);
});

test('controller always returns an explicit offline or connection state', () => {
  assert.equal(validators.normalizeConnectionState(false, null).status, 'offline');
  assert.equal(validators.normalizeConnectionState(true, { connectors: [], active_mcp_sessions: [] }).status, 'disconnected');
  const pairing = validators.normalizeConnectionState(true, {
    connection_state: {
      status: 'pairing', client_name: 'ChatGPT', pairing_phase: 'awaiting_authorization',
      active_session_count: 0, authorized_connector_count: 0, pairing_attempt_count: 1
    }
  });
  assert.equal(pairing.status, 'pairing');
  assert.equal(pairing.detected, true);
  assert.equal(pairing.client_name, 'ChatGPT');
});

test('audit watcher emits single-line lifecycle appends without dropping the first event', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'remote-mcp-audit-watch-'));
  const controller = new McpController({
    projectRoot: ROOT,
    dataDir,
    serverEntry: join(ROOT, 'src', 'server.mjs'),
    controlScript: join(ROOT, 'scripts', 'windows-control.ps1'),
    nodeExecutable: process.execPath,
    secureStore: null,
    runtimeCwd: ROOT
  });
  const received = [];
  controller.on('activity', entry => received.push(entry));
  try {
    await controller.initialize();
    await appendFile(controller.paths.audit, `${JSON.stringify({ event: 'tool_start', tool: 'mouse_move', activity_id: 'one' })}\n`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 180));
    await appendFile(controller.paths.audit, `${JSON.stringify({ event: 'tool_call', tool: 'mouse_move', activity_id: 'one', success: true })}\n`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 220));
    assert.deepEqual(received.map(entry => entry.event), ['tool_start', 'tool_call']);
  } finally {
    controller.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('historical launcher polling is excluded without hiding real AI activity', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'remote-mcp-audit-history-'));
  const controller = new McpController({
    projectRoot: ROOT,
    dataDir,
    serverEntry: join(ROOT, 'src', 'server.mjs'),
    controlScript: join(ROOT, 'scripts', 'windows-control.ps1'),
    nodeExecutable: process.execPath,
    secureStore: null,
    runtimeCwd: ROOT
  });
  try {
    await controller.initialize();
    await appendFile(controller.paths.audit, `${JSON.stringify({ event: 'tool_call', tool: 'mouse_click', success: true, details: { x: 20, y: 30 } })}\n`);
    for (let index = 0; index < 600; index += 1) {
      await appendFile(controller.paths.audit, `${JSON.stringify({ event: 'connector_status_requested', local_admin: true, index })}\n`);
    }
    const history = await controller.getRecentActivity(20);
    assert.deepEqual(history.map(entry => entry.event), ['tool_call']);
  } finally {
    controller.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('server boots with an Electron-managed external data directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'remote-mcp-electron-test-'));
  const port = 18877;
  const childEnv = {
    ...process.env,
    MCP_DATA_DIR: dataDir,
    MCP_CONTROL_SCRIPT: join(ROOT, 'scripts', 'windows-control.ps1'),
    MCP_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    MCP_PORT: String(port)
  };
  delete childEnv.MCP_HOST;
  const child = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    windowsHide: true,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  try {
    const deadline = Date.now() + 15_000;
    let health = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json(); break; }
      } catch { /* Server is still starting. */ }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    }
    assert.equal(health?.ok, true, stderr);
    assert.match(stdout, new RegExp(`Listening on http://127\\.0\\.0\\.1:${port}`));
    assert.match(await readFile(join(dataDir, 'bootstrap-token.txt'), 'utf8'), /^[A-Za-z0-9_-]{40,}/);
    const localAdmin = (await readFile(join(dataDir, 'local-admin-token.txt'), 'utf8')).trim();
    assert.match(localAdmin, /^[A-Za-z0-9_-]{40,}/);

    const adminHeaders = { 'X-Mcp-Local-Admin': localAdmin };
    const initialStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(initialStatus.connection_state.status, 'disconnected');

    const registrationResponse = await fetch(`http://127.0.0.1:${port}/oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'ChatGPT pairing integration test', redirect_uris: ['http://127.0.0.1/callback'] })
    });
    assert.equal(registrationResponse.status, 201);
    const registration = await registrationResponse.json();
    const registeredStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(registeredStatus.connection_state.status, 'pairing');
    assert.equal(registeredStatus.connection_state.pairing_phase, 'registered');

    const verifier = 'A'.repeat(64);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authorizationParams = {
      client_id: registration.client_id,
      redirect_uri: 'http://127.0.0.1/callback',
      response_type: 'code',
      scope: 'desktop:read desktop:control',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `http://127.0.0.1:${port}`
    };
    const authorization = new URL(`http://127.0.0.1:${port}/oauth/authorize`);
    authorization.search = new URLSearchParams(authorizationParams);
    assert.equal((await fetch(authorization)).status, 200);
    const awaitingStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(awaitingStatus.connection_state.status, 'pairing');
    assert.equal(awaitingStatus.connection_state.pairing_phase, 'awaiting_authorization');

    const bootstrap = (await readFile(join(dataDir, 'bootstrap-token.txt'), 'utf8')).trim();
    const consentBody = new URLSearchParams({ ...authorizationParams, consent_form: '1', bootstrap_token: bootstrap });
    consentBody.append('permission', 'observe');
    const consent = await fetch(`http://127.0.0.1:${port}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: consentBody,
      redirect: 'manual'
    });
    assert.equal(consent.status, 302);
    const code = new URL(consent.headers.get('location')).searchParams.get('code');
    assert.ok(code);
    const approvedStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(approvedStatus.connection_state.status, 'pairing');
    assert.equal(approvedStatus.connection_state.pairing_phase, 'authorization_approved');

    const tokenResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', client_id: registration.client_id,
        redirect_uri: 'http://127.0.0.1/callback', code, code_verifier: verifier,
        resource: `http://127.0.0.1:${port}`
      })
    });
    assert.equal(tokenResponse.status, 200);
    const token = await tokenResponse.json();
    const authorizedStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(authorizedStatus.connection_state.status, 'authorized');

    const mcpHeaders = {
      Authorization: `Bearer ${token.access_token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'Mcp-Protocol-Version': '2025-11-25'
    };
    const initialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST', headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'pairing-state-test', version: '1.0.0' } }
      })
    });
    assert.equal(initialize.status, 200);
    const sessionId = initialize.headers.get('mcp-session-id');
    assert.ok(sessionId);
    const connectedStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(connectedStatus.connection_state.status, 'connected');
    assert.equal(connectedStatus.connection_state.active_session_count, 1);

    const refreshResponse = await fetch(`http://127.0.0.1:${port}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', client_id: registration.client_id,
        refresh_token: token.refresh_token, resource: `http://127.0.0.1:${port}`
      })
    });
    assert.equal(refreshResponse.status, 200);
    const refreshedToken = await refreshResponse.json();
    const listWithRefreshedToken = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, Authorization: `Bearer ${refreshedToken.access_token}`, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    });
    assert.equal(listWithRefreshedToken.status, 200, await listWithRefreshedToken.text());

    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE', headers: { ...mcpHeaders, Authorization: `Bearer ${refreshedToken.access_token}`, 'Mcp-Session-Id': sessionId }
    });
    const idleStatus = await fetch(`http://127.0.0.1:${port}/admin/connectors`, { headers: adminHeaders }).then(response => response.json());
    assert.equal(idleStatus.connection_state.status, 'authorized');

    const reconnectInitialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, Authorization: `Bearer ${refreshedToken.access_token}`, 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stale-session-reconnect-test', version: '1.0.0' } }
      })
    });
    assert.equal(reconnectInitialize.status, 200, await reconnectInitialize.text());
    const reconnectedSessionId = reconnectInitialize.headers.get('mcp-session-id');
    assert.ok(reconnectedSessionId);
    assert.notEqual(reconnectedSessionId, sessionId);
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE', headers: { ...mcpHeaders, Authorization: `Bearer ${refreshedToken.access_token}`, 'Mcp-Session-Id': reconnectedSessionId }
    });
  } finally {
    child.kill();
    await new Promise(resolvePromise => child.once('close', resolvePromise));
    await rm(dataDir, { recursive: true, force: true });
  }
});
