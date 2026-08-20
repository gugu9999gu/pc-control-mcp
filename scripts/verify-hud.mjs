import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.MCP_DATA_DIR || join(root, 'data'));
const base = (process.argv[2] || process.env.MCP_VERIFY_BASE_URL || 'http://127.0.0.1:8787')
  .replace(/\/mcp\/?$/, '')
  .replace(/\/$/, '');
const bootstrap = (await readFile(join(dataDir, 'bootstrap-token.txt'), 'utf8')).trim();

function decodeMcpResponse(text) {
  const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text);
}

async function expectOk(response, label) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text.slice(0, 500)}`);
  return text;
}

const exchange = await fetch(`${base}/auth/exchange`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: 'pairing',
    client_secret: bootstrap,
    client_name: 'HUD verification · local only'
  })
});
const tokenPayload = JSON.parse(await expectOk(exchange, 'pairing exchange'));
const headers = {
  authorization: `Bearer ${tokenPayload.access_token}`,
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json',
  'mcp-protocol-version': '2025-11-25'
};

const initialize = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'hud-verification', version: '0.1.0' } }
  })
});
const sessionId = initialize.headers.get('mcp-session-id');
const initializeText = await expectOk(initialize, 'MCP initialize');
if (!sessionId) throw new Error(`MCP initialize did not return a session id: ${initializeText.slice(0, 300)}`);
const sessionHeaders = { ...headers, 'mcp-session-id': sessionId };

async function callTool(id, name, arguments_ = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })
  });
  const result = decodeMcpResponse(await expectOk(response, name));
  if (result.result?.isError) throw new Error(`${name} returned an error: ${result.result.content?.[0]?.text || 'unknown'}`);
  return result.result;
}

function textJson(result) {
  const value = result.content?.find(item => item.type === 'text')?.text;
  if (!value) throw new Error('Tool response did not contain text JSON.');
  return JSON.parse(value);
}

try {
  const screen = textJson(await callTool(2, 'screen_info'));
  const x = Number(screen.cursor?.x);
  const y = Number(screen.cursor?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('screen_info did not return a valid cursor position.');
  await callTool(3, 'hud_status_update', {
    title: '실제 MCP HUD 수명주기를 검증합니다',
    message: '현재 커서 위치를 유지한 채 입력 직렬화와 중앙 실행 로그 표시를 확인하고 있습니다.',
    phase: 'working',
    progress_percent: 65,
    current_target: `CURSOR ${x}, ${y}`
  });
  const repetitions = Math.min(20, Math.max(1, Number.parseInt(process.env.MCP_HUD_VERIFY_REPETITIONS || '3', 10) || 3));
  for (let index = 0; index < repetitions; index += 1) {
    await callTool(4 + index, 'mouse_move', { x, y });
    if (index + 1 < repetitions) await new Promise(resolvePromise => setTimeout(resolvePromise, 420));
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
  console.log(JSON.stringify({
    ok: true,
    mcp_url: `${base}/mcp`,
    tool: 'mouse_move',
    calls: repetitions,
    cursor_position_preserved: { x, y },
    expected_hud: ['public AI work summary', 'recent execution log', 'tool_start', 'custom AI pointer', 'tool_call', 'auto hide']
  }, null, 2));
} finally {
  await fetch(`${base}/mcp`, { method: 'DELETE', headers: sessionHeaders }).catch(() => {});
  await fetch(`${base}/auth/revoke`, { method: 'POST', headers: { authorization: `Bearer ${tokenPayload.access_token}` } }).catch(() => {});
}
