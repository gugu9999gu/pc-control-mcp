import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = (process.argv[2] || process.env.MCP_VERIFY_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const bootstrap = (await readFile(join(root, 'data', 'bootstrap-token.txt'), 'utf8')).trim();

const exchange = await fetch(`${base}/auth/exchange`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: 'pairing',
    client_secret: bootstrap,
    client_name: 'local-verification'
  })
});
if (!exchange.ok) throw new Error(`Token exchange failed: ${exchange.status} ${await exchange.text()}`);
const tokenPayload = await exchange.json();
const token = tokenPayload.access_token;
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/json, text/event-stream',
  'content-type': 'application/json'
};

function decodeMcpResponse(text) {
  const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text);
}

const initialize = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'local-verification', version: '0.1.0' }
    }
  })
});
const sessionId = initialize.headers.get('mcp-session-id');
const initializeBody = await initialize.text();
if (!initialize.ok || !sessionId) throw new Error(`MCP initialize failed: ${initialize.status} ${initializeBody.slice(0, 500)}`);

const sessionHeaders = { ...headers, 'mcp-session-id': sessionId };
const listTools = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: sessionHeaders,
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
});
const listBody = decodeMcpResponse(await listTools.text());
if (!listTools.ok) throw new Error(`tools/list failed: ${listTools.status}`);

const callWindows = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: sessionHeaders,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'list_windows', arguments: {} }
  })
});
const callBody = decodeMcpResponse(await callWindows.text());
if (!callWindows.ok) throw new Error(`list_windows failed: ${callWindows.status}`);

await fetch(`${base}/auth/revoke`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

const toolNames = (listBody.result?.tools || []).map(tool => tool.name);
const windowText = callBody.result?.content?.find(item => item.type === 'text')?.text || '';
console.log(JSON.stringify({
  exchange: true,
  initialize: initialize.status,
  session: true,
  tool_count: toolNames.length,
  tools: toolNames,
  list_windows_returned_data: windowText.length > 0,
  revoked_test_token: true
}, null, 2));
