import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
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
    assert.match(await readFile(join(dataDir, 'local-admin-token.txt'), 'utf8'), /^[A-Za-z0-9_-]{40,}/);
  } finally {
    child.kill();
    await new Promise(resolvePromise => child.once('close', resolvePromise));
    await rm(dataDir, { recursive: true, force: true });
  }
});
