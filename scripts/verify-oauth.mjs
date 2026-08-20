import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rawBaseUrl = process.argv[2] || process.env.MCP_PUBLIC_BASE_URL || 'http://127.0.0.1:8787';
const baseUrl = rawBaseUrl.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
const mcpUrl = `${baseUrl}/mcp`;
const resource = baseUrl;
const redirectUri = 'http://127.0.0.1:45999/callback';
const requestedPermissions = process.env.VERIFY_LIMITED_PERMISSIONS === '1'
  ? ['observe']
  : ['observe', 'input', 'process', 'agent', 'jobs', 'cli'];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function responseBody(response) {
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { response, text, parsed };
}

async function fetchWithRetry(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      if (attempt === 9) throw error;
      // A newly-created Quick Tunnel can publish its hostname a few seconds
      // before every local resolver/Node process can resolve it.
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function requestJson(url, options = {}) {
  const result = await responseBody(await fetchWithRetry(url, options));
  if (!result.response.ok) {
    throw new Error(`${options.method || 'GET'} ${url} -> ${result.response.status}: ${result.text.slice(0, 500)}`);
  }
  return result.parsed;
}

function decodeMcpResponse(text) {
  const dataLines = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  return JSON.parse(dataLines.length ? dataLines[dataLines.length - 1] : text);
}

const metadata = await requestJson(`${baseUrl}/.well-known/oauth-authorization-server`);
assert(metadata.authorization_endpoint === `${baseUrl}/oauth/authorize`, 'authorization endpoint metadata mismatch');
assert(metadata.token_endpoint === `${baseUrl}/oauth/token`, 'token endpoint metadata mismatch');
assert(metadata.code_challenge_methods_supported?.includes('S256'), 'PKCE S256 is not advertised');
const protectedResource = await requestJson(`${baseUrl}/.well-known/oauth-protected-resource/mcp`);
assert(protectedResource.resource === resource, 'protected-resource metadata resource mismatch');

const registration = await requestJson(`${baseUrl}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'local OAuth verification',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none'
  })
});
assert(registration.client_id, 'dynamic client registration did not return client_id');

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authorizeParams = {
  client_id: registration.client_id,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: 'desktop:read desktop:control',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  resource,
  state: 'oauth-verification'
};
const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
for (const [key, value] of Object.entries(authorizeParams)) authorizeUrl.searchParams.set(key, value);
const consent = await fetchWithRetry(authorizeUrl, { redirect: 'manual' });
assert(consent.status === 200, `authorization page returned ${consent.status}`);

const bootstrapToken = (await readFile(join(projectRoot, 'data', 'bootstrap-token.txt'), 'utf8')).trim();
// Include a trailing newline to verify that copying the whole text file is accepted.
const approvalBody = new URLSearchParams({
  ...authorizeParams,
  consent_form: '1',
  bootstrap_token: `${bootstrapToken}\r\n`
});
for (const permission of requestedPermissions) approvalBody.append('permission', permission);
const approved = await fetchWithRetry(`${baseUrl}/oauth/authorize`, {
  method: 'POST',
  redirect: 'manual',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    origin: baseUrl
  },
  body: approvalBody
});
assert(approved.status === 302, `authorization approval returned ${approved.status}`);
const callback = new URL(approved.headers.get('location'));
assert(callback.hostname === '127.0.0.1' && callback.pathname === '/callback', 'authorization callback location mismatch');
assert(callback.searchParams.get('state') === authorizeParams.state, 'authorization state mismatch');
const code = callback.searchParams.get('code');
assert(code, 'authorization response did not contain a code');

const token = await requestJson(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: registration.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource
  })
});
assert(token.access_token && token.refresh_token, 'OAuth token response is incomplete');

const mcpHeaders = {
  authorization: `Bearer ${token.access_token}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-11-25'
};
const initializeResponse = await fetchWithRetry(mcpUrl, {
  method: 'POST',
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'verify-oauth', version: '0.1.0' }
    }
  })
});
const initialize = decodeMcpResponse(await initializeResponse.text());
const sessionId = initializeResponse.headers.get('mcp-session-id');
assert(initializeResponse.ok && sessionId, `MCP initialize failed: ${initializeResponse.status}`);
assert(initialize.result?.serverInfo?.name === 'codex-windows-remote-control', 'MCP initialize failed');

const toolsResponse = await fetchWithRetry(mcpUrl, {
  method: 'POST',
  headers: { ...mcpHeaders, 'mcp-session-id': sessionId },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
});
const tools = decodeMcpResponse(await toolsResponse.text());
assert(toolsResponse.ok, `tools/list failed: ${toolsResponse.status}`);
const toolNames = (tools.result?.tools || []).map(tool => tool.name);
const requiredTools = [
  'system_info', 'control_capabilities', 'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll',
  'hud_status_update', 'desktop_control_status', 'desktop_control_acquire', 'desktop_control_release',
  'screen_info', 'desktop_screenshot', 'desktop_region_screenshot', 'window_screenshot', 'system_status', 'process_list',
  'process_details', 'process_stop', 'service_list', 'browser_open', 'agent_start',
  'background_job_list', 'background_job_output', 'background_job_stop', 'cli_start', 'connector_status'
];
for (const toolName of requiredTools) assert(toolNames.includes(toolName), `MCP tool list is missing ${toolName}`);
const advertisedSecurity = (tools.result?.tools || []).every(tool =>
  tool.securitySchemes?.some(scheme => scheme.type === 'oauth2') &&
  tool._meta?.securitySchemes?.some(scheme => scheme.type === 'oauth2')
);
assert(advertisedSecurity, 'MCP tools did not advertise OAuth security metadata');

async function callToolRaw(id, name, arguments_ = {}, activeSessionId = sessionId) {
  const response = await fetchWithRetry(mcpUrl, {
    method: 'POST',
    headers: { ...mcpHeaders, 'mcp-session-id': activeSessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } })
  });
  const result = decodeMcpResponse(await response.text());
  assert(response.ok, `${name} failed at the transport layer: ${response.status}`);
  return result.result;
}

async function callTool(id, name, arguments_ = {}, activeSessionId = sessionId) {
  const result = await callToolRaw(id, name, arguments_, activeSessionId);
  assert(!result?.isError, `${name} returned an MCP tool error: ${JSON.stringify(result).slice(0, 700)}`);
  return result;
}

function toolJson(result) {
  const text = result.content?.find(item => item.type === 'text')?.text;
  assert(text, 'Tool response did not include text JSON.');
  return JSON.parse(text);
}

const capabilities = toolJson(await callTool(3, 'control_capabilities'));
const connectionStatus = toolJson(await callTool(4, 'connector_status'));
assert(connectionStatus.oauth_access_token_ttl_seconds >= 6 * 24 * 60 * 60, 'OAuth access token lifetime is unexpectedly short');
assert(connectionStatus.connectors?.[0]?.permissions?.length === requestedPermissions.length, 'Connector permission grant did not persist');
await callTool(5, 'system_status');
const screenState = toolJson(await callTool(6, 'screen_info'));
await callTool(7, 'process_list', { limit: 5 });
await callTool(8, 'service_list', { limit: 5 });

let visualVerification = null;
if (process.env.VERIFY_SCREENSHOT === '1') {
  await callTool(300, 'hud_status_update', {
    title: 'MCP 시각 정보 응답을 검증합니다',
    message: '연결된 AI가 실제 PNG 스크린샷을 수신할 수 있는지 확인하고 있습니다.',
    phase: 'working',
    progress_percent: 70,
    current_target: 'VIRTUAL DESKTOP · PNG IMAGE CONTENT'
  });
  const screenshot = await callTool(301, 'desktop_screenshot');
  const image = screenshot.content?.find(item => item.type === 'image');
  const metadataText = screenshot.content?.find(item => item.type === 'text')?.text;
  const screenshotMetadata = JSON.parse(metadataText || '{}');
  const imageBytes = image?.data ? Buffer.from(image.data, 'base64').length : 0;
  assert(image?.mimeType === 'image/png', 'desktop_screenshot did not return image/png content');
  assert(imageBytes > 1_000, 'desktop_screenshot PNG payload is unexpectedly small');
  assert(screenshotMetadata.width > 0 && screenshotMetadata.height > 0, 'desktop_screenshot metadata is incomplete');
  visualVerification = {
    mime_type: image.mimeType,
    bytes: imageBytes,
    width: screenshotMetadata.width,
    height: screenshotMetadata.height,
    virtual_bounds: screenState.virtual_screen
  };
}

let coordinationVerification = null;
if (process.env.VERIFY_COORDINATION === '1' && capabilities.profile !== 'safe' && requestedPermissions.includes('input')) {
  const peerResponse = await fetchWithRetry(mcpUrl, {
    method: 'POST',
    headers: mcpHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 400, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'verify-oauth-peer', version: '0.2.2' }
      }
    })
  });
  const peerInitialize = decodeMcpResponse(await peerResponse.text());
  const peerSessionId = peerResponse.headers.get('mcp-session-id');
  assert(peerResponse.ok && peerSessionId && peerInitialize.result, 'second MCP session initialize failed');

  const ownerLease = toolJson(await callTool(401, 'desktop_control_acquire', {
    purpose: 'OAuth multi-agent coordination verification', ttl_seconds: 30, wait_seconds: 0
  }));
  assert(ownerLease.acquired === true, 'first MCP session did not acquire desktop control');
  const peerLease = toolJson(await callTool(402, 'desktop_control_acquire', {
    purpose: 'same OAuth connector continuation', ttl_seconds: 30, wait_seconds: 0
  }, peerSessionId));
  assert(peerLease.acquired === true, 'same OAuth connector did not continue its lease across MCP sessions');
  const peerStatus = toolJson(await callTool(403, 'desktop_control_status', {}, peerSessionId));
  assert(peerStatus.state === 'leased' && peerStatus.owned_by_requester === true, 'stateless MCP session did not inherit its connector lease');
  assert(toolJson(await callTool(404, 'desktop_control_release', {}, peerSessionId)).released === true, 'connector did not release its lease from a later MCP session');
  assert(toolJson(await callTool(405, 'desktop_control_acquire', {
    purpose: 'connector reacquire verification', ttl_seconds: 30, wait_seconds: 0
  }, peerSessionId)).acquired === true, 'peer session did not acquire after handoff');
  assert(toolJson(await callTool(406, 'desktop_control_release', {}, peerSessionId)).released === true, 'peer session did not release its lease');
  let sameWorkspaceBlocked = null;
  if (capabilities.profile === 'full' && requestedPermissions.includes('cli')) {
    const reservedJob = toolJson(await callTool(407, 'cli_start', {
      program: 'node', args: ['-e', 'setTimeout(() => {}, 15000)'], timeout_seconds: 30
    }));
    assert(reservedJob.job_id, 'workspace reservation test job did not start');
    const peerWorkspaceAttempt = await callToolRaw(408, 'cli_start', {
      program: 'node', args: ['--version'], timeout_seconds: 30
    }, peerSessionId);
    assert(peerWorkspaceAttempt?.isError, 'second MCP session unexpectedly started a job in the reserved workspace');
    await callTool(409, 'background_job_stop', { job_id: reservedJob.job_id });
    sameWorkspaceBlocked = true;
  }
  coordinationVerification = {
    sessions: 2,
    same_connector_continuity: true,
    explicit_release_succeeded: true,
    same_workspace_background_job_blocked: sameWorkspaceBlocked
  };
}

let cliVerification = null;
if (capabilities.profile === 'full' && requestedPermissions.includes('cli')) {
  const started = toolJson(await callTool(9, 'cli_start', {
    program: 'node',
    args: ['--version'],
    timeout_seconds: 30
  }));
  assert(started.job_id, 'cli_start did not return a background job id');
  let latest = started;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    latest = toolJson(await callTool(10 + attempt, 'background_job_output', {
      job_id: started.job_id,
      max_chars: 4_096
    }));
    if (latest.ended_at) break;
  }
  assert(latest.status === 'succeeded', `allowlisted CLI verification failed: ${latest.status}`);
  assert(/v\d+\.\d+\.\d+/.test(latest.output || ''), 'allowlisted CLI output did not include a Node version');
  cliVerification = { job_id: started.job_id, status: latest.status };
}

let agentVerification = null;
const requestedAgentVerification = process.env.VERIFY_AGENT === '1' ? 'codex' : process.env.VERIFY_AGENT;
if (requestedAgentVerification) {
  assert(requestedPermissions.includes('agent'), 'Agent verification requires the agent connector permission');
  assert(['codex', 'claude'].includes(requestedAgentVerification), 'VERIFY_AGENT must be codex or claude');
  assert(capabilities.profile !== 'safe', 'Agent verification requires the local agent or full profile');
  const started = toolJson(await callTool(50, 'agent_start', {
    agent: requestedAgentVerification,
    task: 'Return only the word READY. Do not create, edit, delete, or run any files.',
    mode: 'read-only',
    timeout_seconds: 240
  }));
  assert(started.job_id, 'agent_start did not return a background job id');
  let latest = started;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    latest = toolJson(await callTool(51 + attempt, 'background_job_output', {
      job_id: started.job_id,
      max_chars: 16_000
    }));
    if (latest.ended_at) break;
  }
  assert(latest.status === 'succeeded', `${requestedAgentVerification} agent verification failed: ${latest.status}`);
  assert(/READY/i.test(latest.output || ''), `${requestedAgentVerification} agent output did not include READY`);
  agentVerification = { agent: requestedAgentVerification, job_id: started.job_id, status: latest.status };
}

let permissionEnforcement = null;
if (!requestedPermissions.includes('input')) {
  const deniedResponse = await fetchWithRetry(mcpUrl, {
    method: 'POST',
    headers: { ...mcpHeaders, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: 200, method: 'tools/call', params: { name: 'mouse_move', arguments: { x: 0, y: 0 } } })
  });
  const denied = decodeMcpResponse(await deniedResponse.text());
  assert(deniedResponse.ok && denied.result?.isError, 'Limited connector unexpectedly received mouse-input authority');
  permissionEnforcement = 'input tool denied as expected';
}

const refreshed = await requestJson(`${baseUrl}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: registration.client_id,
    refresh_token: token.refresh_token,
    resource
  })
});
assert(refreshed.access_token && refreshed.refresh_token, 'OAuth refresh-token rotation failed');

await fetchWithRetry(`${baseUrl}/auth/revoke`, {
  method: 'POST',
  headers: { authorization: `Bearer ${refreshed.access_token}` }
});

console.log(JSON.stringify({
  ok: true,
  base_url: baseUrl,
  mcp_url: mcpUrl,
  oauth: true,
  security_metadata: true,
  verified_read_tools: ['control_capabilities', 'connector_status', 'system_status', 'screen_info', 'process_list', 'service_list'],
  visual_verification: visualVerification,
  coordination_verification: coordinationVerification,
  refresh_token_rotation: true,
  requested_permissions: requestedPermissions,
  permission_enforcement: permissionEnforcement,
  cli_verification: cliVerification,
  agent_verification: agentVerification,
  client_id: registration.client_id,
  tools: toolNames
}, null, 2));
