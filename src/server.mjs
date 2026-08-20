import { createServer } from 'node:http';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, rm, access, readdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AsyncFifoMutex, DesktopControlCoordinator, findWorkspaceConflict } from './control-coordinator.mjs';

const execFile = promisify(execFileCallback);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = resolve(process.env.MCP_DATA_DIR || join(ROOT, 'data'));
const AUTH_FILE = process.env.MCP_AUTH_FILE || join(DATA_DIR, 'auth.json');
const BOOTSTRAP_FILE = join(DATA_DIR, 'bootstrap-token.txt');
const AUDIT_FILE = join(DATA_DIR, 'audit.ndjson');
const LOCAL_ADMIN_FILE = join(DATA_DIR, 'local-admin-token.txt');
const CONTROL_POLICY_FILE = process.env.MCP_CONTROL_POLICY_FILE || join(DATA_DIR, 'control-policy.json');
const JOBS_DIR = join(DATA_DIR, 'jobs');
const CONTROL_SCRIPT = resolve(process.env.MCP_CONTROL_SCRIPT || join(ROOT, 'scripts', 'windows-control.ps1'));
const POWER_SHELL = process.env.SystemRoot
  ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

const HOST = process.env.MCP_HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.MCP_PORT || '8787', 10);
const BASE_URL = new URL(process.env.MCP_PUBLIC_BASE_URL || `http://localhost:${PORT}`);
const RESOURCE_IDENTIFIER = BASE_URL.origin;
const MCP_URL = new URL('/mcp', BASE_URL).href;
const RESOURCE_METADATA_URL = new URL('/.well-known/oauth-protected-resource/mcp', BASE_URL).href;
const OAUTH_ISSUER = BASE_URL.href.replace(/\/$/, '');
const OAUTH_AUTHORIZATION_ENDPOINT = new URL('/oauth/authorize', BASE_URL).href;
const OAUTH_TOKEN_ENDPOINT = new URL('/oauth/token', BASE_URL).href;
const OAUTH_REGISTRATION_ENDPOINT = new URL('/oauth/register', BASE_URL).href;
const ACCESS_TOKEN_TTL_SECONDS = Number.parseInt(process.env.MCP_ACCESS_TOKEN_TTL_SECONDS || `${30 * 24 * 60 * 60}`, 10);
// Keep connector access tokens long-lived enough for clients that keep an MCP
// session warm but delay refresh-token rotation. Local revocation remains
// immediate and the values can be shortened through environment variables.
const OAUTH_ACCESS_TOKEN_TTL_SECONDS = Number.parseInt(process.env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS || `${7 * 24 * 60 * 60}`, 10);
const OAUTH_REFRESH_TOKEN_TTL_SECONDS = Number.parseInt(process.env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS || `${90 * 24 * 60 * 60}`, 10);
const OAUTH_CODE_TTL_SECONDS = Number.parseInt(process.env.MCP_OAUTH_CODE_TTL_SECONDS || '300', 10);
const OAUTH_SCOPES = ['desktop:read', 'desktop:control'];
const ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const INPUT_DISABLED = process.env.MCP_DISABLE_INPUT === '1' || process.env.MCP_DISABLE_INPUT === 'true';
const HUD_ACTIVITY_LEAD_MS = Math.min(1_000, Math.max(0,
  Number.parseInt(process.env.MCP_HUD_ACTIVITY_LEAD_MS || '0', 10) || 0
));
const INPUT_TOOL_NAMES = new Set([
  'launch_app', 'focus_window', 'type_text', 'send_hotkey',
  'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'browser_open'
]);
const HUD_LEAD_TOOLS = INPUT_TOOL_NAMES;
const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const DEFAULT_WORKSPACE_ROOT = resolve(ROOT, '..', '..');
const VALID_CONTROL_PROFILES = new Set(['safe', 'agent', 'full']);
const PERMISSION_DEFINITIONS = Object.freeze([
  { id: 'observe', label: 'Desktop and system viewing', description: 'Windows, screenshots, screen state, system status, processes, and services.' },
  { id: 'input', label: 'Desktop input and browser', description: 'Mouse, keyboard, window focus, allowlisted apps, and browser URL opening.' },
  { id: 'process', label: 'Process control', description: 'Stopping non-critical Windows processes.' },
  { id: 'agent', label: 'Codex and Claude jobs', description: 'Starting constrained background coding-agent jobs.' },
  { id: 'jobs', label: 'Background job visibility and stop', description: 'Viewing job output and stopping jobs started by this MCP server.' },
  { id: 'cli', label: 'Allowlisted CLI jobs', description: 'Starting locally allowlisted CLI programs; also requires the full local profile.' }
]);
const ALL_PERMISSION_IDS = Object.freeze(PERMISSION_DEFINITIONS.map(item => item.id));
const TOOL_PERMISSIONS = Object.freeze({
  system_info: ['observe'],
  control_capabilities: ['observe'],
  hud_status_update: ['observe'],
  desktop_control_status: ['observe'],
  desktop_control_acquire: ['input'],
  desktop_control_release: ['input'],
  list_windows: ['observe'],
  desktop_screenshot: ['observe'],
  desktop_region_screenshot: ['observe'],
  screen_info: ['observe'],
  window_screenshot: ['observe'],
  system_status: ['observe'],
  process_list: ['observe'],
  process_details: ['observe'],
  service_list: ['observe'],
  launch_app: ['input'],
  focus_window: ['input'],
  type_text: ['input'],
  send_hotkey: ['input'],
  mouse_click: ['input'],
  mouse_move: ['input'],
  mouse_drag: ['input'],
  mouse_scroll: ['input'],
  browser_open: ['input'],
  process_stop: ['process'],
  agent_start: ['agent'],
  background_job_list: ['jobs'],
  background_job_output: ['jobs'],
  background_job_stop: ['jobs'],
  cli_start: ['cli']
});
const DEFAULT_CONTROL_POLICY = Object.freeze({
  version: 1,
  profile: 'agent',
  allowed_workspaces: [DEFAULT_WORKSPACE_ROOT],
  allow_process_stop: true,
  max_concurrent_jobs: 2,
  max_job_runtime_seconds: 1800,
  max_job_output_bytes: 1_048_576,
  allowed_programs: {
    codex: { command: 'codex.exe', description: 'Codex CLI' },
    claude: { command: 'claude.exe', description: 'Claude Code CLI' },
    git: { command: 'git.exe', description: 'Git' },
    node: { command: 'node.exe', description: 'Node.js' },
    npm: {
      command: process.execPath,
      fixed_args: [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')],
      description: 'npm'
    },
    python: { command: 'python.exe', description: 'Python' }
  }
});

const transports = new Map();
const authRateBuckets = new Map();
const requestRateBuckets = new Map();
const agentJobs = new Map();
const desktopControlCoordinator = new DesktopControlCoordinator();
const jobAdmissionMutex = new AsyncFifoMutex();
let authState;
let controlPolicy;
let authPersistTimer;
let localAdminToken;

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function secureEqualsHex(left, right) {
  try {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function normalizePermissions(value, fallback = ALL_PERMISSION_IDS) {
  if (value === undefined || value === null) return [...fallback];
  const values = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  return [...new Set(values.map(item => String(item).trim().toLowerCase()).filter(item => ALL_PERMISSION_IDS.includes(item)))];
}

function permissionsFromRecord(record) {
  // Tokens issued before connector-level grants existed retain their previous
  // behavior until the connection is revoked and authorized again.
  const legacyScopes = String(record.scope || '').split(/\s+/);
  const fallback = legacyScopes.includes('desktop:control') ? ALL_PERMISSION_IDS : ['observe'];
  return normalizePermissions(record.permissions, fallback);
}

function hasPermissions(grantedPermissions, requiredPermissions = []) {
  const granted = new Set(normalizePermissions(grantedPermissions, []));
  return requiredPermissions.every(permission => granted.has(permission));
}

function requestedConnectorPermissions(params) {
  if (params.consent_form !== '1') return [...ALL_PERMISSION_IDS];
  return normalizePermissions(params.permission, []);
}

function scheduleAuthPersist() {
  if (authPersistTimer) return;
  authPersistTimer = setTimeout(() => {
    authPersistTimer = undefined;
    persistAuth().catch(error => console.error(`[auth] Could not persist token activity: ${error.message}`));
  }, 2_000);
  authPersistTimer.unref?.();
}

async function fileExists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function secureEqualsText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function initializeLocalAdmin() {
  if (await fileExists(LOCAL_ADMIN_FILE)) {
    localAdminToken = (await readFile(LOCAL_ADMIN_FILE, 'utf8')).replace(/^\uFEFF/, '').trim();
    if (localAdminToken.length >= 30) return;
  }
  localAdminToken = `mcp_local_admin_${randomBytes(32).toString('base64url')}`;
  await writeFile(LOCAL_ADMIN_FILE, `${localAdminToken}\n`, { encoding: 'utf8', mode: 0o600 });
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function normalizeWorkspaceRoots(value) {
  const items = Array.isArray(value) ? value : [];
  const roots = items
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => resolve(item.trim()));
  return [...new Set(roots.length > 0 ? roots : DEFAULT_CONTROL_POLICY.allowed_workspaces)];
}

function normalizeProgramMap(value) {
  const requested = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : DEFAULT_CONTROL_POLICY.allowed_programs;
  const programs = {};
  for (const [alias, entry] of Object.entries(requested)) {
    const normalizedAlias = String(alias || '').trim().toLowerCase();
    const command = typeof entry === 'string' ? entry : entry?.command;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(normalizedAlias)) continue;
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 1024) continue;
    programs[normalizedAlias] = {
      command: command.trim(),
      fixed_args: Array.isArray(entry?.fixed_args)
        ? entry.fixed_args.filter(item => typeof item === 'string' && item.length <= 2048).map(item => item.trim())
        : [],
      description: typeof entry?.description === 'string' ? entry.description.slice(0, 160) : normalizedAlias
    };
  }
  return Object.keys(programs).length > 0 ? programs : { ...DEFAULT_CONTROL_POLICY.allowed_programs };
}

function normalizeControlPolicy(raw = {}) {
  const requestedProfile = String(raw.profile || DEFAULT_CONTROL_POLICY.profile).toLowerCase();
  return {
    version: 1,
    profile: VALID_CONTROL_PROFILES.has(requestedProfile) ? requestedProfile : DEFAULT_CONTROL_POLICY.profile,
    allowed_workspaces: normalizeWorkspaceRoots(raw.allowed_workspaces),
    allow_process_stop: raw.allow_process_stop !== false,
    max_concurrent_jobs: boundedInteger(raw.max_concurrent_jobs, DEFAULT_CONTROL_POLICY.max_concurrent_jobs, 1, 8),
    max_job_runtime_seconds: boundedInteger(raw.max_job_runtime_seconds, DEFAULT_CONTROL_POLICY.max_job_runtime_seconds, 30, 14_400),
    max_job_output_bytes: boundedInteger(raw.max_job_output_bytes, DEFAULT_CONTROL_POLICY.max_job_output_bytes, 64 * 1024, 8 * 1024 * 1024),
    allowed_programs: normalizeProgramMap(raw.allowed_programs)
  };
}

async function initializeControlPolicy() {
  await mkdir(JOBS_DIR, { recursive: true });
  if (!(await fileExists(CONTROL_POLICY_FILE))) {
    controlPolicy = normalizeControlPolicy();
    await writeJson(CONTROL_POLICY_FILE, controlPolicy);
    return;
  }
  try {
    // Windows PowerShell 5.1 writes UTF-8 with a BOM for Set-Content. Accept
    // that local-policy file format while retaining strict JSON parsing.
    const policyText = (await readFile(CONTROL_POLICY_FILE, 'utf8')).replace(/^\uFEFF/, '');
    controlPolicy = normalizeControlPolicy(JSON.parse(policyText));
  } catch (error) {
    throw new Error(`Control policy is invalid: ${error.message}`);
  }
}

function isPathWithin(candidate, root) {
  const difference = relative(root, candidate);
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

async function resolveAllowedWorkspace(requestedWorkspace) {
  const defaultRoot = controlPolicy.allowed_workspaces[0];
  const candidate = requestedWorkspace
    ? resolve(isAbsolute(requestedWorkspace) ? requestedWorkspace : join(defaultRoot, requestedWorkspace))
    : defaultRoot;
  if (!controlPolicy.allowed_workspaces.some(root => isPathWithin(candidate, root))) {
    throw new Error('Workspace is outside the local control policy allowlist. Add it locally to data/control-policy.json.');
  }
  try {
    await access(candidate, fsConstants.F_OK);
  } catch {
    throw new Error(`Workspace does not exist: ${candidate}`);
  }
  return candidate;
}

function getAllowedProgram(alias) {
  const normalized = String(alias || '').trim().toLowerCase();
  const program = controlPolicy.allowed_programs[normalized];
  if (!program) throw new Error(`Program alias is not allowed by the local control policy: ${normalized || '(empty)'}`);
  return { alias: normalized, ...program };
}

function desktopOwnerFromContext(context) {
  const clientInfoName = String(context.clientInfo?.name || '').trim();
  const clientName = String(context.clientName || 'connected AI').trim();
  return {
    id: context.connectionId || context.tokenId,
    label: clientInfoName && clientInfoName !== clientName ? `${clientName} · ${clientInfoName}` : clientInfoName || clientName
  };
}

function jobOwnerFromContext(context) {
  return {
    principal: context.clientId || context.tokenId,
    label: String(context.clientInfo?.name || context.clientName || 'connected AI').trim().slice(0, 160)
  };
}

function controlPolicySummary() {
  const activeWorkspaceJobs = [...agentJobs.values()]
    .filter(job => ['starting', 'running', 'stopping'].includes(job.status))
    .map(job => ({ job_id: job.id, workspace: job.cwd, owner_client: job.ownerLabel || null, status: job.status }));
  return {
    profile: controlPolicy.profile,
    input_tools_disabled: INPUT_DISABLED,
    allow_process_stop: controlPolicy.allow_process_stop,
    allowed_workspaces: controlPolicy.allowed_workspaces,
    allowed_programs: Object.entries(controlPolicy.allowed_programs).map(([alias, entry]) => ({
      alias,
      description: entry.description
    })),
    max_concurrent_jobs: controlPolicy.max_concurrent_jobs,
    max_job_runtime_seconds: controlPolicy.max_job_runtime_seconds,
    coordination: {
      desktop_input_serialized: true,
      explicit_desktop_lease_max_seconds: 600,
      same_workspace_background_jobs_serialized: true,
      active_workspace_jobs: activeWorkspaceJobs
    }
  };
}

function connectorStatusSummary(options = {}) {
  const connectors = authState.oauth_clients
    .filter(client => !options.clientId || client.client_id === options.clientId)
    .map(connectorSummary)
    .sort((left, right) => Date.parse(right.last_used_at || 0) - Date.parse(left.last_used_at || 0));
  const activeSessions = [...transports.entries()]
    .filter(([, session]) => !options.clientId || session.auth.clientId === options.clientId)
    .map(([sessionId, session]) => ({
    session_id: sessionId,
    client_name: session.auth.clientName,
    token_id: session.auth.tokenId,
    connected_at: session.connectedAt || null,
    last_activity_at: session.lastActivityAt || null,
    client_info: session.clientInfo || null
    }));
  return {
    oauth_access_token_ttl_seconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
    oauth_refresh_token_ttl_seconds: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    connectors,
    active_mcp_sessions: activeSessions,
    desktop_control: desktopControlCoordinator.status(options.ownerId || null)
  };
}

async function initializeAuth() {
  await mkdir(DATA_DIR, { recursive: true });
  const exists = await fileExists(AUTH_FILE);
  if (exists) {
    const parsed = JSON.parse((await readFile(AUTH_FILE, 'utf8')).replace(/^\uFEFF/, ''));
    authState = {
      version: 1,
      bootstrap_hash: parsed.bootstrap_hash,
      bootstrap_created_at: parsed.bootstrap_created_at,
      access_tokens: Array.isArray(parsed.access_tokens) ? parsed.access_tokens : [],
      refresh_tokens: Array.isArray(parsed.refresh_tokens) ? parsed.refresh_tokens : [],
      authorization_codes: Array.isArray(parsed.authorization_codes) ? parsed.authorization_codes : [],
      oauth_clients: Array.isArray(parsed.oauth_clients) ? parsed.oauth_clients : []
    };
    return false;
  }

  const bootstrap = `mcp_bootstrap_${randomBytes(32).toString('base64url')}`;
  authState = {
    version: 1,
    bootstrap_hash: sha256(bootstrap),
    bootstrap_created_at: new Date().toISOString(),
    access_tokens: [],
    refresh_tokens: [],
    authorization_codes: [],
    oauth_clients: []
  };
  await writeJson(AUTH_FILE, authState);
  await writeFile(BOOTSTRAP_FILE, `${bootstrap}\n`, { encoding: 'utf8', mode: 0o600 });
  return true;
}

async function persistAuth() {
  await writeJson(AUTH_FILE, authState);
}

function issueAccessToken(clientName, options = {}) {
  const token = `mcp_at_${randomBytes(32).toString('base64url')}`;
  const tokenId = randomBytes(8).toString('hex');
  const issuedAt = nowSeconds();
  const expiresAt = issuedAt + (options.ttlSeconds || ACCESS_TOKEN_TTL_SECONDS);
  authState.access_tokens.push({
    id: tokenId,
    hash: sha256(token),
    client_name: clientName,
    issued_at: issuedAt,
    expires_at: expiresAt,
    revoked_at: null,
    auth_type: options.authType || 'pairing',
    client_id: options.clientId || null,
    resource: options.resource || null,
    scope: options.scope || OAUTH_SCOPES.join(' '),
    permissions: normalizePermissions(options.permissions, ALL_PERMISSION_IDS),
    last_used_at: issuedAt
  });
  return { token, tokenId, issuedAt, expiresAt };
}

function normalizeBootstrapToken(token) {
  return typeof token === 'string' ? token.replace(/^\uFEFF/, '').trim() : '';
}

function verifyBootstrap(token) {
  const normalized = normalizeBootstrapToken(token);
  return normalized.length > 0 && secureEqualsHex(authState.bootstrap_hash, sha256(normalized));
}

function hashBase64Url(value) {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

function isResourceMatch(resource) {
  if (!resource) return true;
  const normalized = String(resource).replace(/\/$/, '');
  return normalized === RESOURCE_IDENTIFIER || normalized === MCP_URL.replace(/\/$/, '') || normalized === OAUTH_ISSUER;
}

function normalizeResource(resource) {
  return String(resource || '').replace(/\/$/, '');
}

function verifyAccessToken(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const digest = sha256(token);
  const record = authState.access_tokens.find(item => secureEqualsHex(item.hash, digest));
  if (!record || record.revoked_at || record.expires_at <= nowSeconds()) return null;
  record.last_used_at = nowSeconds();
  scheduleAuthPersist();
  return record;
}

function getClientIp(req) {
  const address = req.socket?.remoteAddress || 'unknown';
  return address.startsWith('::ffff:') ? address.slice(7) : address;
}

function isLoopbackRequest(req) {
  const ip = getClientIp(req);
  return ip === '127.0.0.1' || ip === '::1';
}

function requireLocalAdmin(req, res) {
  const supplied = String(req.headers['x-mcp-local-admin'] || '');
  if (!isLoopbackRequest(req) || !secureEqualsText(supplied, localAdminToken)) {
    sendJson(res, 403, { error: 'local_admin_required' });
    return false;
  }
  return true;
}

function isOriginAllowed(origin, pathname = '') {
  if (!origin) return true;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Some embedded OAuth consent surfaces submit forms with an opaque origin.
  // The form still requires the pairing token, so allow this only for consent.
  if (origin === 'null') return pathname === '/oauth/authorize';
  // The authorization form is served and submitted by this same public origin.
  if (origin === BASE_URL.origin) return true;
  // ChatGPT may submit the OAuth consent form or call the connector from an
  // OpenAI-hosted browser origin. Keep the allowlist limited to HTTPS OpenAI
  // domains; arbitrary cross-site browser origins remain blocked.
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'https:' && (
      parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com') ||
      parsed.hostname === 'openai.com' || parsed.hostname.endsWith('.openai.com')
    );
  } catch {
    return false;
  }
}

function setCommonHeaders(res, origin) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  if (origin && isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(body);
}

function sendText(res, status, text, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readStructuredBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      if (params[key] === undefined) params[key] = value;
      else if (Array.isArray(params[key])) params[key].push(value);
      else params[key] = [params[key], value];
    }
    return params;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON body must be an object.');
    return parsed;
  } catch (error) {
    throw new Error(`Invalid JSON body: ${error.message}`);
  }
}

function rateLimit(req, map, limit, windowMs) {
  const key = getClientIp(req);
  const now = Date.now();
  const current = map.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    map.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

async function audit(event) {
  const entry = { timestamp: new Date().toISOString(), ...event };
  const line = `${JSON.stringify(entry)}\n`;
  try {
    await appendFile(AUDIT_FILE, line, { encoding: 'utf8', mode: 0o600 });
    // The launcher redirects stdout to its server log, so this gives the
    // machine owner a live, token-free activity stream without tailing JSON
    // files manually.
    console.log(`[activity] ${JSON.stringify(entry)}`);
  } catch (error) {
    console.error(`[audit] ${error.message}`);
  }
}

function authContextFromRecord(record, req) {
  return {
    tokenId: record.id,
    clientId: record.client_id || null,
    clientName: record.client_name,
    ip: getClientIp(req),
    authType: record.auth_type || 'pairing',
    resource: record.resource || null,
    scope: record.scope || OAUTH_SCOPES.join(' '),
    permissions: permissionsFromRecord(record)
  };
}

function requireBearer(req, res) {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? header.match(/^Bearer\s+([^\s]+)$/i) : null;
  const record = match ? verifyAccessToken(match[1]) : null;
  if (!record) {
    res.setHeader('WWW-Authenticate', `Bearer error="invalid_token", resource_metadata="${RESOURCE_METADATA_URL}", scope="${OAUTH_SCOPES.join(' ')}"`);
    sendJson(res, 401, { error: 'invalid_token', error_description: 'A valid Bearer access token is required.' });
    return null;
  }
  return authContextFromRecord(record, req);
}

function parseScopes(value) {
  const requested = String(value || OAUTH_SCOPES.join(' ')).split(/\s+/).filter(Boolean);
  const unique = [...new Set(requested)];
  return unique.length > 0 && unique.every(scope => OAUTH_SCOPES.includes(scope)) ? unique : null;
}

function isOpenAiClientId(clientId) {
  try {
    const parsed = new URL(clientId);
    return parsed.protocol === 'https:' && (
      parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com') ||
      parsed.hostname === 'openai.com' || parsed.hostname.endsWith('.openai.com')
    );
  } catch {
    return false;
  }
}

function isLocalRedirectUri(redirectUri) {
  try {
    const parsed = new URL(redirectUri);
    return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function isAllowedDcrRedirectUri(redirectUri) {
  if (isLocalRedirectUri(redirectUri)) return true;
  try {
    const parsed = new URL(redirectUri);
    return parsed.protocol === 'https:' && (
      parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com') ||
      parsed.hostname === 'openai.com' || parsed.hostname.endsWith('.openai.com')
    );
  } catch {
    return false;
  }
}

function isAllowedRedirectUri(clientId, redirectUri) {
  const registered = authState.oauth_clients.find(client => client.client_id === clientId);
  if (registered) return registered.redirect_uris.includes(redirectUri);
  if (isOpenAiClientId(clientId)) {
    try {
      const parsed = new URL(redirectUri);
      return parsed.protocol === 'https:' && (
        parsed.hostname === 'chatgpt.com' || parsed.hostname.endsWith('.chatgpt.com') ||
        parsed.hostname === 'openai.com' || parsed.hostname.endsWith('.openai.com')
      );
    } catch {
      return false;
    }
  }
  return isLocalRedirectUri(redirectUri);
}

function findOauthClient(clientId) {
  return authState.oauth_clients.find(client => client.client_id === clientId);
}

async function closeTrackedSessions(predicate) {
  const sessionsToClose = [...transports.entries()]
    .filter(([, session]) => predicate(session))
    .map(([, session]) => Promise.resolve(session.transport.close()).catch(() => {}));
  await Promise.all(sessionsToClose);
}

async function revokeClientAuthorization(clientId, reason, context = {}) {
  let changed = false;
  const now = nowSeconds();
  for (const token of authState.access_tokens) {
    if (token.auth_type === 'oauth' && token.client_id === clientId && !token.revoked_at) {
      token.revoked_at = now;
      changed = true;
    }
  }
  for (const token of authState.refresh_tokens) {
    if (token.client_id === clientId && !token.revoked_at) {
      token.revoked_at = now;
      changed = true;
    }
  }
  if (changed) await persistAuth();
  await closeTrackedSessions(session => session.auth.clientId === clientId);
  await audit({ event: 'connector_authorization_revoked', client_id: clientId, reason, ...context });
  return changed;
}

function connectorSummary(client) {
  const accessTokens = authState.access_tokens.filter(token => token.auth_type === 'oauth' && token.client_id === client.client_id);
  const refreshTokens = authState.refresh_tokens.filter(token => token.client_id === client.client_id);
  const activeAccessTokens = accessTokens.filter(token => !token.revoked_at && token.expires_at > nowSeconds());
  const activeRefreshTokens = refreshTokens.filter(token => !token.revoked_at && token.expires_at > nowSeconds());
  const newest = [...activeAccessTokens, ...activeRefreshTokens].sort((left, right) => (right.issued_at || 0) - (left.issued_at || 0))[0];
  const lastUsedSeconds = accessTokens.reduce((latest, token) => Math.max(latest, token.last_used_at || 0), 0);
  return {
    client_id: client.client_id,
    client_name: client.client_name,
    issued_at: client.issued_at ? new Date(client.issued_at * 1000).toISOString() : null,
    redirect_uris: client.redirect_uris,
    connected: activeAccessTokens.length > 0 || activeRefreshTokens.length > 0,
    active_access_tokens: activeAccessTokens.length,
    active_refresh_tokens: activeRefreshTokens.length,
    permissions: permissionsFromRecord(newest || client),
    last_used_at: lastUsedSeconds ? new Date(lastUsedSeconds * 1000).toISOString() : null
  };
}

function validateOAuthAuthorization(params) {
  const clientId = String(params.client_id || '');
  const redirectUri = String(params.redirect_uri || '');
  const codeChallenge = String(params.code_challenge || '');
  const codeChallengeMethod = String(params.code_challenge_method || '');
  if (!clientId || !redirectUri || params.response_type !== 'code') {
    return { error: 'invalid_request', error_description: 'client_id, redirect_uri, and response_type=code are required.' };
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return { error: 'invalid_request', error_description: 'PKCE S256 code_challenge is required.' };
  }
  if (!isAllowedRedirectUri(clientId, redirectUri)) {
    return { error: 'invalid_request', error_description: 'The redirect_uri is not registered for this client.' };
  }
  const scopes = parseScopes(params.scope);
  if (!scopes) return { error: 'invalid_scope', error_description: 'Unsupported scope requested.' };
  const resource = normalizeResource(params.resource || RESOURCE_IDENTIFIER);
  if (!isResourceMatch(resource)) {
    return { error: 'invalid_target', error_description: 'The requested resource does not match this MCP server.' };
  }
  return {
    clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod,
    scope: scopes.join(' '),
    resource,
    state: params.state ? String(params.state) : ''
  };
}

function htmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // ChatGPT may render the consent page in an embedded context with an
  // opaque document origin. Chromium can still reject a same-server form
  // when form-action is present in that context, even with the explicit
  // public origin in the source list. The page has no scripts, network
  // resources, or frames, so keep those restrictions while omitting only
  // form-action to allow the required POST back to this server.
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'");
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP authorization</title><style>body{font-family:system-ui,sans-serif;max-width:620px;margin:40px auto;padding:0 20px;line-height:1.5}main{border:1px solid #ddd;border-radius:12px;padding:24px}label{display:block;margin:14px 0 6px;font-weight:600}input{box-sizing:border-box;width:100%;padding:10px;border:1px solid #bbb;border-radius:6px}fieldset{border:1px solid #bbb;border-radius:8px;margin:18px 0;padding:8px 14px}legend{font-weight:700}.permission{display:block;margin:12px 0;font-weight:400}.permission input{width:auto;margin-right:8px}.permission span{display:block;margin:2px 0 0 28px;color:#444;font-size:.9em}button{margin-top:18px;padding:10px 18px;border:0;border-radius:6px;background:#111;color:white;cursor:pointer}.error{color:#a00;background:#fff1f1;padding:10px;border-radius:6px}</style></head><body>${html}</body></html>`);
}

function authorizationForm(params, errorMessage = '') {
  const hidden = ['client_id', 'redirect_uri', 'response_type', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource']
    .filter(name => params[name] !== undefined && params[name] !== '')
    .map(name => `<input type="hidden" name="${name}" value="${htmlEscape(params[name])}">`)
    .join('');
  const requested = requestedConnectorPermissions(params);
  const permissionInputs = PERMISSION_DEFINITIONS.map(item => {
    const checked = requested.includes(item.id) ? ' checked' : '';
    return `<label class="permission"><input type="checkbox" name="permission" value="${item.id}"${checked}> <strong>${htmlEscape(item.label)}</strong><span>${htmlEscape(item.description)}</span></label>`;
  }).join('');
  return `<main><h1>Authorize Windows Desktop MCP</h1><p>The connector is requesting access to this Windows MCP server. Choose exactly what the connected AI may use. You can later revoke this connection from the launcher.</p>${errorMessage ? `<p class="error">${htmlEscape(errorMessage)}</p>` : ''}<form method="post" action="/oauth/authorize">${hidden}<input type="hidden" name="consent_form" value="1"><fieldset><legend>Connector permissions</legend>${permissionInputs}</fieldset><label for="bootstrap_token">Pairing token</label><input id="bootstrap_token" name="bootstrap_token" type="password" autocomplete="off" required><small>Read it from the local data/bootstrap-token.txt file on the Windows host.</small><br><button type="submit">Authorize selected permissions</button></form></main>`;
}

function issueRefreshToken(clientId, resource, scope, permissions = ALL_PERMISSION_IDS) {
  const token = `mcp_rt_${randomBytes(32).toString('base64url')}`;
  const issuedAt = nowSeconds();
  authState.refresh_tokens.push({
    id: randomBytes(8).toString('hex'),
    hash: sha256(token),
    client_id: clientId,
    resource,
    scope,
    permissions: normalizePermissions(permissions, ALL_PERMISSION_IDS),
    issued_at: issuedAt,
    expires_at: issuedAt + OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    revoked_at: null
  });
  return token;
}

function getClientName(clientId) {
  const registered = authState.oauth_clients.find(client => client.client_id === clientId);
  if (registered?.client_name) return registered.client_name;
  try { return `OpenAI (${new URL(clientId).hostname})`; } catch { return 'OpenAI MCP client'; }
}

async function handleOAuthAuthorize(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const params = req.method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : await readStructuredBody(req);
  const validation = validateOAuthAuthorization(params);
  if (validation.error) {
    sendHtml(res, 400, authorizationForm(params, `${validation.error}: ${validation.error_description}`));
    return true;
  }

  if (req.method === 'GET') {
    sendHtml(res, 200, authorizationForm(params));
    return true;
  }

  if (!verifyBootstrap(params.bootstrap_token)) {
    await audit({ event: 'oauth_authorization_denied', ip: getClientIp(req), client_id: validation.clientId, redirect_uri: validation.redirectUri, resource: validation.resource, reason: 'invalid_pairing_token' });
    sendHtml(res, 401, authorizationForm(params, 'Pairing token is invalid.'));
    return true;
  }
  const permissions = requestedConnectorPermissions(params);
  if (!permissions.includes('observe')) {
    sendHtml(res, 400, authorizationForm(params, 'Desktop and system viewing permission is required to connect.'));
    return true;
  }
  const registeredClient = findOauthClient(validation.clientId);
  if (registeredClient) registeredClient.permissions = permissions;

  const code = `mcp_code_${randomBytes(32).toString('base64url')}`;
  authState.authorization_codes.push({
    hash: sha256(code),
    client_id: validation.clientId,
    redirect_uri: validation.redirectUri,
    code_challenge: validation.codeChallenge,
    code_challenge_method: validation.codeChallengeMethod,
    scope: validation.scope,
    resource: validation.resource,
    permissions,
    issued_at: nowSeconds(),
    expires_at: nowSeconds() + OAUTH_CODE_TTL_SECONDS,
    used_at: null
  });
  await persistAuth();
  await audit({ event: 'oauth_authorization_approved', ip: getClientIp(req), client_id: validation.clientId, redirect_uri: validation.redirectUri, resource: validation.resource, scope: validation.scope, permissions });
  const redirect = new URL(validation.redirectUri);
  redirect.searchParams.set('code', code);
  if (validation.state) redirect.searchParams.set('state', validation.state);
  res.statusCode = 302;
  res.setHeader('Location', redirect.href);
  res.end();
  return true;
}

async function handleOAuthRegistration(req, res) {
  if (req.method !== 'POST') { sendText(res, 405, 'Method Not Allowed'); return true; }
  if (!rateLimit(req, authRateBuckets, 10, 60_000)) {
    sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    return true;
  }
  const params = await readStructuredBody(req);
  const redirectUris = Array.isArray(params.redirect_uris) ? params.redirect_uris.map(String) : [];
  const clientName = String(params.client_name || 'OAuth MCP client').slice(0, 100);
  if (redirectUris.length === 0 || redirectUris.length > 10 || redirectUris.some(uri => !isAllowedDcrRedirectUri(uri))) {
    sendJson(res, 400, { error: 'invalid_client_metadata', error_description: 'redirect_uris must contain supported HTTPS or localhost callback URLs.' });
    return true;
  }
  const clientId = `mcp_client_${randomBytes(16).toString('base64url')}`;
  const issuedAt = nowSeconds();
  authState.oauth_clients.push({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    scope: OAUTH_SCOPES.join(' '),
    permissions: ALL_PERMISSION_IDS,
    token_endpoint_auth_method: 'none',
    issued_at: issuedAt
  });
  await persistAuth();
  await audit({ event: 'oauth_client_registered', ip: getClientIp(req), client_id: clientId, client_name: clientName });
  sendJson(res, 201, {
    client_id: clientId,
    client_id_issued_at: issuedAt,
    client_name: clientName,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: OAUTH_SCOPES.join(' ')
  });
  return true;
}

async function handleOAuthToken(req, res) {
  if (req.method !== 'POST') { sendText(res, 405, 'Method Not Allowed'); return true; }
  if (!rateLimit(req, authRateBuckets, 30, 60_000)) {
    sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    return true;
  }
  const params = await readStructuredBody(req);
  const grantType = params.grant_type;
  await audit({
    event: 'oauth_token_request',
    ip: getClientIp(req),
    grant_type: grantType || null,
    client_id: params.client_id || null,
    resource: params.resource || null,
    client_assertion: Boolean(params.client_assertion)
  });
  if (grantType === 'authorization_code') {
    const record = authState.authorization_codes.find(item => secureEqualsHex(item.hash, sha256(String(params.code || ''))));
    if (!record || record.used_at || record.expires_at <= nowSeconds()) {
      await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'invalid_or_expired_code' });
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' });
      return true;
    }
    if (String(params.client_id || '') !== record.client_id || String(params.redirect_uri || '') !== record.redirect_uri) {
      await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'client_or_redirect_mismatch' });
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'Client or redirect URI does not match the authorization code.' });
      return true;
    }
    if (!params.code_verifier || hashBase64Url(String(params.code_verifier)) !== record.code_challenge) {
      await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'invalid_pkce_verifier' });
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'PKCE code_verifier is invalid.' });
      return true;
    }
    if (!isResourceMatch(params.resource || record.resource) || normalizeResource(params.resource || record.resource) !== normalizeResource(record.resource)) {
      await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'resource_mismatch' });
      sendJson(res, 400, { error: 'invalid_target', error_description: 'The requested resource does not match this MCP server.' });
      return true;
    }
    record.used_at = nowSeconds();
    const issued = issueAccessToken(getClientName(record.client_id), {
      ttlSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      authType: 'oauth',
      clientId: record.client_id,
      resource: record.resource,
      scope: record.scope,
      permissions: record.permissions
    });
    const refreshToken = issueRefreshToken(record.client_id, record.resource, record.scope, record.permissions);
    await persistAuth();
    await audit({ event: 'oauth_token_issued', ip: getClientIp(req), client_id: record.client_id, token_id: issued.tokenId, scope: record.scope, permissions: permissionsFromRecord(record) });
    sendJson(res, 200, {
      access_token: issued.token,
      token_type: 'Bearer',
      expires_in: issued.expiresAt - nowSeconds(),
      refresh_token: refreshToken,
      scope: record.scope,
      resource: record.resource
    });
    return true;
  }

  if (grantType === 'refresh_token') {
    const refresh = authState.refresh_tokens.find(item => secureEqualsHex(item.hash, sha256(String(params.refresh_token || ''))));
    if (!refresh || refresh.revoked_at || refresh.expires_at <= nowSeconds()) {
      await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'invalid_or_expired_refresh_token' });
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' });
      return true;
    }
    if (params.client_id && String(params.client_id) !== refresh.client_id) {
      await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'refresh_client_mismatch' });
      sendJson(res, 400, { error: 'invalid_grant', error_description: 'Client does not match the refresh token.' });
      return true;
    }
    refresh.revoked_at = nowSeconds();
    const issued = issueAccessToken(getClientName(refresh.client_id), {
      ttlSeconds: OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      authType: 'oauth',
      clientId: refresh.client_id,
      resource: refresh.resource,
      scope: refresh.scope,
      permissions: refresh.permissions
    });
    const rotatedRefreshToken = issueRefreshToken(refresh.client_id, refresh.resource, refresh.scope, refresh.permissions);
    await persistAuth();
    await audit({ event: 'oauth_token_refreshed', ip: getClientIp(req), client_id: refresh.client_id, token_id: issued.tokenId, permissions: permissionsFromRecord(refresh) });
    sendJson(res, 200, {
      access_token: issued.token,
      token_type: 'Bearer',
      expires_in: issued.expiresAt - nowSeconds(),
      refresh_token: rotatedRefreshToken,
      scope: refresh.scope,
      resource: refresh.resource
    });
    return true;
  }

  await audit({ event: 'oauth_token_failed', ip: getClientIp(req), client_id: params.client_id || null, reason: 'unsupported_grant_type' });
  sendJson(res, 400, { error: 'unsupported_grant_type', error_description: 'Use authorization_code or refresh_token.' });
  return true;
}

async function exchangeToken(params) {
  const grantType = params.grant_type || 'client_credentials';
  const clientId = params.client_id || 'pairing';
  const suppliedSecret = params.client_secret || params.subject_token || params.bootstrap_token;
  if (!['client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange'].includes(grantType)) {
    return { status: 400, body: { error: 'unsupported_grant_type' } };
  }
  if (clientId !== 'pairing' || !verifyBootstrap(suppliedSecret)) {
    await audit({ event: 'auth_exchange_failed', ip: 'http', reason: 'invalid_pairing_secret' });
    return { status: 401, body: { error: 'invalid_client', error_description: 'Invalid pairing credentials.' } };
  }
  const clientName = String(params.client_name || 'remote-client').slice(0, 80);
  const issued = issueAccessToken(clientName);
  await persistAuth();
  await audit({ event: 'auth_exchange', client_name: clientName, token_id: issued.tokenId });
  return {
    status: 200,
    body: {
      access_token: issued.token,
      token_type: 'Bearer',
      expires_in: issued.expiresAt - nowSeconds(),
      scope: 'desktop:read desktop:control'
    }
  };
}

async function runWindowsControl(action, params = {}) {
  const args = [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', CONTROL_SCRIPT, '-Action', action
  ];
  const append = (name, value) => {
    if (value !== undefined && value !== null && value !== '') args.push(`-${name}`, String(value));
  };
  append('TitleContains', params.titleContains);
  append('ProcessName', params.processName);
  if (params.handle !== undefined) append('Handle', params.handle);
  append('App', params.app);
  append('Text', params.text);
  if (params.keys) append('KeysJson', JSON.stringify(params.keys));
  if (params.x !== undefined) append('X', params.x);
  if (params.y !== undefined) append('Y', params.y);
  if (params.width !== undefined) append('Width', params.width);
  if (params.height !== undefined) append('Height', params.height);
  append('Button', params.button);
  append('OutputPath', params.outputPath);
  append('ToX', params.toX);
  append('ToY', params.toY);
  append('DeltaX', params.deltaX);
  append('DeltaY', params.deltaY);
  append('Clicks', params.clicks);
  append('TargetProcessId', params.targetProcessId);
  append('NameFilter', params.nameFilter);
  append('Limit', params.limit);
  append('Url', params.url);
  append('Browser', params.browser);

  try {
    const result = await execFile(POWER_SHELL, args, {
      windowsHide: true,
      timeout: action === 'screenshot' ? 30_000 : 15_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsVerbatimArguments: false,
      // The helper uses this only to refuse an accidental request to stop the
      // server that is executing the control request.
      env: { ...process.env, MCP_CONTROL_SERVER_PID: String(process.pid) }
    });
    const stdout = String(result.stdout || '').trim();
    if (!stdout) throw new Error('Windows control helper returned no result.');
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error.stderr || error.stdout || error.message || 'Windows control failed').trim();
    throw new Error(detail.slice(0, 1000));
  }
}

function jobSummary(job) {
  return {
    job_id: job.id,
    kind: job.kind,
    program: job.programAlias,
    workspace: job.cwd,
    owner_client: job.ownerLabel || null,
    pid: job.pid,
    status: job.status,
    created_at: job.createdAt,
    started_at: job.startedAt,
    ended_at: job.endedAt || null,
    exit_code: job.exitCode ?? null,
    signal: job.signal || null,
    timed_out: Boolean(job.timedOut),
    output_bytes: job.outputBytes,
    output_truncated: Boolean(job.outputTruncated)
  };
}

async function persistJob(job) {
  await writeJson(job.recordPath, jobSummary(job));
}

function appendJobOutput(job, stream, chunk) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const remaining = Math.max(0, controlPolicy.max_job_output_bytes - job.outputBytes);
  if (remaining === 0) {
    job.outputTruncated = true;
    return;
  }
  const accepted = buffer.subarray(0, remaining);
  job.outputBytes += accepted.length;
  if (accepted.length < buffer.length) job.outputTruncated = true;
  const text = accepted.toString('utf8');
  job.tail = `${job.tail}${text}`.slice(-65_536);
  appendFile(job.logPath, `[${stream}] ${text}`, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
}

async function finishJob(job, status, details = {}) {
  if (job.endedAt) return;
  job.status = status;
  job.endedAt = new Date().toISOString();
  job.exitCode = details.exitCode ?? null;
  job.signal = details.signal || null;
  if (job.timer) clearTimeout(job.timer);
  await appendFile(job.logPath, `\n[runner] status=${status} exit_code=${job.exitCode ?? ''}\n`, { encoding: 'utf8', mode: 0o600 }).catch(() => {});
  await persistJob(job).catch(() => {});
  await audit({
    event: 'background_job_finished',
    job_id: job.id,
    kind: job.kind,
    program: job.programAlias,
    status,
    exit_code: job.exitCode,
    timed_out: Boolean(job.timedOut)
  });
}

async function terminateProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024
  }).catch(() => {});
}

async function startTrackedJob(options) {
  return jobAdmissionMutex.run(() => startTrackedJobUnlocked(options));
}

async function startTrackedJobUnlocked({ kind, programAlias, command, fixedArgs = [], args = [], cwd, timeoutSeconds, owner }) {
  const activeJobs = [...agentJobs.values()].filter(job => ['starting', 'running', 'stopping'].includes(job.status));
  const workspaceJob = findWorkspaceConflict(activeJobs, cwd);
  if (workspaceJob) {
    throw new Error(`Workspace is already reserved by background job ${workspaceJob.id} (${workspaceJob.ownerLabel || 'another connected AI'}). Use a separate Git worktree or wait for that job to finish.`);
  }
  if (activeJobs.length >= controlPolicy.max_concurrent_jobs) {
    throw new Error(`The local policy allows at most ${controlPolicy.max_concurrent_jobs} concurrent background jobs.`);
  }
  await mkdir(JOBS_DIR, { recursive: true });
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    kind,
    programAlias,
    command,
    args: [...fixedArgs, ...args],
    cwd,
    ownerPrincipal: owner?.principal || null,
    ownerLabel: owner?.label || null,
    status: 'starting',
    createdAt: now,
    startedAt: now,
    endedAt: null,
    exitCode: null,
    signal: null,
    pid: null,
    timedOut: false,
    outputBytes: 0,
    outputTruncated: false,
    tail: '',
    logPath: join(JOBS_DIR, `${id}.log`),
    recordPath: join(JOBS_DIR, `${id}.json`),
    child: null,
    timer: null,
    stopReason: null
  };
  agentJobs.set(id, job);
  await appendFile(job.logPath, `[runner] started ${now} program=${programAlias}\n`, { encoding: 'utf8', mode: 0o600 });
  await persistJob(job);

  let child;
  try {
    child = spawn(command, job.args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
    });
  } catch (error) {
    await finishJob(job, 'failed', { exitCode: null });
    throw new Error(`Could not start ${programAlias}: ${error.message}`);
  }
  job.child = child;
  job.pid = child.pid || null;
  job.status = 'running';
  await persistJob(job);
  await audit({ event: 'background_job_started', job_id: id, kind, program: programAlias, cwd, pid: job.pid, owner_client: job.ownerLabel });

  child.stdout?.on('data', chunk => appendJobOutput(job, 'stdout', chunk));
  child.stderr?.on('data', chunk => appendJobOutput(job, 'stderr', chunk));
  child.once('error', error => {
    appendJobOutput(job, 'runner-error', Buffer.from(`${error.message}\n`));
    finishJob(job, 'failed', { exitCode: null }).catch(() => {});
  });
  child.once('close', (exitCode, signal) => {
    const status = job.stopReason === 'timeout'
      ? 'timed_out'
      : job.stopReason
        ? 'cancelled'
        : exitCode === 0
          ? 'succeeded'
          : 'failed';
    finishJob(job, status, { exitCode, signal }).catch(() => {});
  });
  // A very short-lived command can emit close before this line. Do not leave
  // an orphaned timeout behind in that case.
  if (!job.endedAt) {
    job.timer = setTimeout(() => {
      job.timedOut = true;
      stopTrackedJob(id, 'timeout').catch(() => {});
    }, timeoutSeconds * 1000);
    job.timer.unref?.();
  }
  return jobSummary(job);
}

async function stopTrackedJob(jobId, reason = 'cancelled', requesterPrincipal = null) {
  const job = agentJobs.get(jobId);
  if (!job) throw new Error('The background job is not managed by this server instance.');
  if (requesterPrincipal && job.ownerPrincipal && requesterPrincipal !== job.ownerPrincipal) {
    throw new Error(`Only the connector that started this background job (${job.ownerLabel || 'unknown owner'}) can stop it.`);
  }
  if (!['starting', 'running', 'stopping'].includes(job.status)) return jobSummary(job);
  job.stopReason = reason;
  job.status = 'stopping';
  await persistJob(job);
  await terminateProcessTree(job.pid);
  return jobSummary(job);
}

async function readJobOutput(jobId, maxChars = 16_000) {
  const job = agentJobs.get(jobId);
  if (!job) throw new Error('The background job is not managed by this server instance.');
  let content = job.tail;
  try {
    content = await readFile(job.logPath, 'utf8');
  } catch {}
  const truncated = content.length > maxChars;
  return {
    ...jobSummary(job),
    output_truncated_for_response: truncated,
    output: truncated ? content.slice(-maxChars) : content
  };
}

function assertAgentControl() {
  if (controlPolicy.profile === 'safe') throw new Error('Agent and CLI tools are disabled by the local control policy profile. Switch to agent or full locally.');
}

function assertFullControl() {
  if (controlPolicy.profile !== 'full') throw new Error('Direct CLI tools require the local control policy profile to be set to full.');
}

function assertProcessControl() {
  if (!controlPolicy.allow_process_stop || controlPolicy.profile === 'safe') {
    throw new Error('Process termination is disabled by the local control policy.');
  }
}

function validateDirectProgramArgs(alias, args) {
  const joined = args.join('\u0000').toLowerCase();
  if (alias === 'codex' && joined.includes('--dangerously-bypass-approvals-and-sandbox')) {
    throw new Error('The dangerous Codex bypass flag is not allowed through this remote control server.');
  }
  if (alias === 'claude' && (joined.includes('--dangerously-skip-permissions') || joined.includes('--allow-dangerously-skip-permissions'))) {
    throw new Error('Claude dangerous permission-bypass flags are not allowed through this remote control server.');
  }
}

function validateBrowserUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provide a valid absolute HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free absolute HTTP(S) URLs are allowed.');
  }
  return url.href;
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function inputGuard() {
  if (INPUT_DISABLED) throw new Error('Input-control tools are disabled by MCP_DISABLE_INPUT.');
  if (controlPolicy.profile === 'safe') throw new Error('Input-control tools are disabled by the local safe control profile.');
}

function createMcpServer(context) {
  const server = new McpServer({ name: 'codex-windows-remote-control', version: '0.2.0' });
  const securitySchemes = [{ type: 'oauth2', scopes: OAUTH_SCOPES }];
  const desktopOwner = desktopOwnerFromContext(context);
  const jobOwner = jobOwnerFromContext(context);

  // SDK 1.30.0 does not yet expose securitySchemes in registerTool().
  // Wrap the tools/list handler so OpenAI receives the documented top-level field.
  const setRequestHandler = server.server.setRequestHandler.bind(server.server);
  server.server.setRequestHandler = (schema, handler) => {
    if (schema === ListToolsRequestSchema) {
      return setRequestHandler(schema, async (request, extra) => {
        const result = await handler(request, extra);
        return {
          ...result,
          tools: result.tools.map(tool => ({ ...tool, securitySchemes }))
        };
      });
    }
    return setRequestHandler(schema, handler);
  };

  const permissionDescription = name => (TOOL_PERMISSIONS[name] || []).map(permission =>
    PERMISSION_DEFINITIONS.find(item => item.id === permission)?.label || permission
  ).join(', ');

  const registerProtectedTool = (name, config, handler) => server.registerTool(name, {
    ...config,
    description: config.description + (TOOL_PERMISSIONS[name]?.length ? ` Required connector permission: ${permissionDescription(name)}.` : ''),
    _meta: {
      ...(config._meta || {}),
      securitySchemes
    }
  }, handler);

  const executeTool = async (toolName, details, callback) => {
    const activityId = randomUUID();
    const startedAt = Date.now();
    await audit({
      event: 'tool_start',
      activity_id: activityId,
      tool: toolName,
      success: null,
      ...context,
      details
    });
    try {
      const requiredPermissions = TOOL_PERMISSIONS[toolName] || [];
      if (!hasPermissions(context.permissions, requiredPermissions)) {
        throw new Error(`The connected AI was not granted permission for this tool category (${requiredPermissions.join(', ')}). Update the connector permission locally and reconnect.`);
      }
      const runCallback = async () => {
        // Electron watches the audit stream and paints the local safety HUD.
        // A short, launcher-only lead lets the visual indicator appear before
        // SendInput changes the real cursor or keyboard focus.
        if (HUD_ACTIVITY_LEAD_MS > 0 && HUD_LEAD_TOOLS.has(toolName)) {
          await sleep(HUD_ACTIVITY_LEAD_MS);
        }
        return callback();
      };
      // Every real mouse/keyboard/focus operation enters one FIFO. If an AI
      // holds an explicit multi-step lease, other sessions receive a clear busy
      // result instead of interleaving input into the same Windows desktop.
      const result = INPUT_TOOL_NAMES.has(toolName)
        ? await desktopControlCoordinator.runInput(desktopOwner, toolName, runCallback)
        : await runCallback();
      await audit({
        event: 'tool_call',
        activity_id: activityId,
        duration_ms: Date.now() - startedAt,
        tool: toolName,
        success: true,
        ...context,
        details
      });
      return result;
    } catch (error) {
      await audit({
        event: 'tool_call',
        activity_id: activityId,
        duration_ms: Date.now() - startedAt,
        tool: toolName,
        success: false,
        ...context,
        details,
        error: error.message
      });
      return { content: [{ type: 'text', text: `Tool failed: ${error.message}` }], isError: true };
    }
  };

  registerProtectedTool('system_info', {
    title: 'System information',
    description: 'Returns non-secret information about the Windows host and the MCP server.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('system_info', {}, async () => textResult({
    hostname: os.hostname(),
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    user: os.userInfo().username,
    server_url: MCP_URL,
    input_tools_disabled: INPUT_DISABLED,
    control_profile: controlPolicy.profile
  })));

  registerProtectedTool('control_capabilities', {
    title: 'Control policy and capabilities',
    description: 'Returns the locally enforced remote-control profile, allowed workspaces, permitted CLI aliases, and job limits. It never returns secrets.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('control_capabilities', {}, async () => textResult(controlPolicySummary())));

  registerProtectedTool('connector_status', {
    title: 'Connector status',
    description: 'Returns the connected OAuth client status, its granted permission categories, token lifetimes, and active MCP sessions. It never returns token values.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('connector_status', {}, async () => textResult(connectorStatusSummary({ clientId: context.clientId, ownerId: desktopOwner.id }))));

  registerProtectedTool('hud_status_update', {
    title: 'Publish a user-visible AI work summary',
    description: 'Shows a concise, user-visible task summary in the local center-lower HUD. Publish only the action, plan, result, or safe decision rationale intended for the PC owner. Never send hidden chain-of-thought, secrets, credentials, typed private content, or raw sensitive data.',
    inputSchema: z.object({
      title: z.string().min(1).max(80),
      message: z.string().min(1).max(500),
      phase: z.enum(['planning', 'working', 'waiting', 'completed', 'warning']).default('working'),
      progress_percent: z.number().min(0).max(100).optional(),
      current_target: z.string().max(160).optional()
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ title, message, phase, progress_percent, current_target }) => executeTool('hud_status_update', {
    title,
    message,
    phase,
    progress_percent: progress_percent ?? null,
    current_target: current_target || null
  }, async () => textResult({ displayed: true, phase, progress_percent: progress_percent ?? null })));

  registerProtectedTool('desktop_control_status', {
    title: 'Desktop coordination status',
    description: 'Returns the active desktop-control lease and input queue state without exposing credentials. Observation and screenshot tools remain available while another AI holds the input lease.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('desktop_control_status', {}, async () => textResult(desktopControlCoordinator.status(desktopOwner.id))));

  registerProtectedTool('desktop_control_acquire', {
    title: 'Acquire multi-step desktop control',
    description: 'Reserves mouse, keyboard, app launch, browser open, and window focus for this MCP session so another AI cannot interleave input during a multi-step operation. The lease renews when its owner uses an input tool and expires automatically.',
    inputSchema: z.object({
      purpose: z.string().min(1).max(240),
      ttl_seconds: z.number().int().min(5).max(600).default(60),
      wait_seconds: z.number().int().min(0).max(30).default(0)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ purpose, ttl_seconds, wait_seconds }) => executeTool('desktop_control_acquire', {
    purpose,
    ttl_seconds,
    wait_seconds
  }, async () => {
    inputGuard();
    const result = await desktopControlCoordinator.acquire(desktopOwner, {
      purpose,
      ttlMs: ttl_seconds * 1_000,
      waitMs: wait_seconds * 1_000
    });
    if (!result.acquired) {
      throw new Error(`Desktop control is already reserved by ${result.owner_label || 'another connected AI'} until ${result.expires_at || 'the current lease is released'}.`);
    }
    return textResult(result);
  }));

  registerProtectedTool('desktop_control_release', {
    title: 'Release multi-step desktop control',
    description: 'Releases the desktop-control lease owned by this MCP session. A lease is also released when its session closes or its TTL expires.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async () => executeTool('desktop_control_release', {}, async () => textResult(await desktopControlCoordinator.release(desktopOwner))));

  registerProtectedTool('list_windows', {
    title: 'List visible windows',
    description: 'Lists visible top-level windows in the interactive Windows desktop session.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('list_windows', {}, async () => textResult(await runWindowsControl('list'))));

  registerProtectedTool('desktop_screenshot', {
    title: 'Desktop screenshot',
    description: 'Captures the current virtual desktop and returns it as a PNG image.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('desktop_screenshot', {}, async () => {
    const outputPath = join(DATA_DIR, `screenshot-${randomUUID()}.png`);
    try {
      const metadata = await runWindowsControl('screenshot', { outputPath });
      const data = (await readFile(outputPath)).toString('base64');
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(metadata) }
        ]
      };
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
    }
  }));

  registerProtectedTool('desktop_region_screenshot', {
    title: 'Desktop region screenshot',
    description: 'Captures a bounded virtual-desktop region and returns fresh PNG image content for visual inspection. Call screen_info first to obtain multi-monitor coordinates.',
    inputSchema: z.object({
      x: z.number().int().min(-100_000).max(100_000),
      y: z.number().int().min(-100_000).max(100_000),
      width: z.number().int().min(1).max(16_384),
      height: z.number().int().min(1).max(16_384)
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ x, y, width, height }) => executeTool('desktop_region_screenshot', { x, y, width, height }, async () => {
    const outputPath = join(DATA_DIR, `region-screenshot-${randomUUID()}.png`);
    try {
      const metadata = await runWindowsControl('screenshot-region', { x, y, width, height, outputPath });
      const data = (await readFile(outputPath)).toString('base64');
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(metadata) }
        ]
      };
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
    }
  }));

  registerProtectedTool('launch_app', {
    title: 'Launch allowlisted app',
    description: 'Launches one of the safe built-in app aliases: notepad, calculator, explorer, edge, chrome, paint, or terminal.',
    inputSchema: z.object({
      app: z.enum(['notepad', 'calculator', 'explorer', 'edge', 'chrome', 'paint', 'terminal'])
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ app }) => executeTool('launch_app', { app }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('launch', { app }));
  }));

  const focusSchema = z.object({
    title_contains: z.string().max(200).optional(),
    process_name: z.string().max(100).optional(),
    handle: z.number().int().nonnegative().optional()
  }).refine(value => Boolean(value.title_contains || value.process_name || value.handle !== undefined), {
    message: 'Provide title_contains, process_name, or handle.'
  });
  registerProtectedTool('focus_window', {
    title: 'Focus a window',
    description: 'Brings a visible window to the foreground by title substring, process name, or handle.',
    inputSchema: focusSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ title_contains, process_name, handle }) => executeTool('focus_window', {
    has_title: Boolean(title_contains), has_process: Boolean(process_name), has_handle: handle !== undefined
  }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('focus', {
      titleContains: title_contains,
      processName: process_name,
      handle
    }));
  }));

  registerProtectedTool('type_text', {
    title: 'Type text',
    description: 'Types Unicode text into the currently focused Windows control. Text is not written to the audit log.',
    inputSchema: z.object({ text: z.string().min(1).max(10_000) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ text }) => executeTool('type_text', { characters: text.length }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('type', { text }));
  }));

  registerProtectedTool('send_hotkey', {
    title: 'Send keyboard shortcut',
    description: 'Sends a keyboard shortcut using key names such as CTRL, ALT, SHIFT, ENTER, TAB, ESC, A, C, or F5.',
    inputSchema: z.object({ keys: z.array(z.string().min(1).max(20)).min(1).max(6) }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ keys }) => executeTool('send_hotkey', { keys }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('hotkey', { keys }));
  }));

  registerProtectedTool('mouse_click', {
    title: 'Mouse click',
    description: 'Moves the mouse to absolute virtual-desktop coordinates and clicks.',
    inputSchema: z.object({
      x: z.number().int().min(-100_000).max(100_000),
      y: z.number().int().min(-100_000).max(100_000),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      clicks: z.number().int().min(1).max(10).default(1)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ x, y, button, clicks }) => executeTool('mouse_click', { x, y, button, clicks }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('click', { x, y, button, clicks }));
  }));

  registerProtectedTool('screen_info', {
    title: 'Screen and cursor information',
    description: 'Returns virtual-display bounds, individual monitor bounds, and the current mouse position.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('screen_info', {}, async () => textResult(await runWindowsControl('screen-info'))));

  registerProtectedTool('window_screenshot', {
    title: 'Window screenshot',
    description: 'Captures the visible bounds of a specific top-level window as a PNG image.',
    inputSchema: z.object({ handle: z.number().int().positive() }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ handle }) => executeTool('window_screenshot', { handle }, async () => {
    const outputPath = join(DATA_DIR, `window-screenshot-${randomUUID()}.png`);
    try {
      const metadata = await runWindowsControl('screenshot-window', { handle, outputPath });
      const data = (await readFile(outputPath)).toString('base64');
      return {
        content: [
          { type: 'image', data, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(metadata) }
        ]
      };
    } finally {
      await rm(outputPath, { force: true }).catch(() => {});
    }
  }));

  registerProtectedTool('mouse_move', {
    title: 'Move mouse',
    description: 'Moves the mouse to absolute virtual-desktop coordinates without clicking.',
    inputSchema: z.object({
      x: z.number().int().min(-100_000).max(100_000),
      y: z.number().int().min(-100_000).max(100_000)
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ x, y }) => executeTool('mouse_move', { x, y }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('move', { x, y }));
  }));

  registerProtectedTool('mouse_drag', {
    title: 'Drag mouse',
    description: 'Drags from one absolute virtual-desktop coordinate to another.',
    inputSchema: z.object({
      from_x: z.number().int().min(-100_000).max(100_000),
      from_y: z.number().int().min(-100_000).max(100_000),
      to_x: z.number().int().min(-100_000).max(100_000),
      to_y: z.number().int().min(-100_000).max(100_000),
      button: z.enum(['left', 'right', 'middle']).default('left')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ from_x, from_y, to_x, to_y, button }) => executeTool('mouse_drag', {
    from_x, from_y, to_x, to_y, button
  }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('drag', {
      x: from_x,
      y: from_y,
      toX: to_x,
      toY: to_y,
      button
    }));
  }));

  registerProtectedTool('mouse_scroll', {
    title: 'Scroll mouse wheel',
    description: 'Moves the mouse to an absolute coordinate and scrolls. Values use Windows wheel units (usually 120 per notch).',
    inputSchema: z.object({
      x: z.number().int().min(-100_000).max(100_000),
      y: z.number().int().min(-100_000).max(100_000),
      delta_y: z.number().int().min(-20_000).max(20_000).default(0),
      delta_x: z.number().int().min(-20_000).max(20_000).default(0)
    }).refine(value => value.delta_x !== 0 || value.delta_y !== 0, {
      message: 'Provide a non-zero delta_x or delta_y.'
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ x, y, delta_x, delta_y }) => executeTool('mouse_scroll', {
    x, y, delta_x, delta_y
  }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('scroll', {
      x,
      y,
      deltaX: delta_x,
      deltaY: delta_y
    }));
  }));

  registerProtectedTool('system_status', {
    title: 'System status',
    description: 'Returns current Windows uptime, memory, CPU, disks, network addresses, and process count.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async () => executeTool('system_status', {}, async () => textResult(await runWindowsControl('system-status'))));

  registerProtectedTool('process_list', {
    title: 'List processes',
    description: 'Lists local processes with resource and responsiveness information. Optionally filters by process-name substring.',
    inputSchema: z.object({
      name_filter: z.string().min(1).max(120).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ name_filter, limit }) => executeTool('process_list', { name_filter, limit }, async () => textResult(await runWindowsControl('process-list', {
    nameFilter: name_filter,
    limit
  }))));

  registerProtectedTool('process_details', {
    title: 'Process details',
    description: 'Returns a local process summary and Windows services hosted by that process.',
    inputSchema: z.object({ process_id: z.number().int().positive() }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ process_id }) => executeTool('process_details', { process_id }, async () => textResult(await runWindowsControl('process-info', {
    targetProcessId: process_id
  }))));

  registerProtectedTool('process_stop', {
    title: 'Stop a process',
    description: 'Stops a non-critical local process. The server and core Windows processes are always protected; local policy can disable this tool.',
    inputSchema: z.object({ process_id: z.number().int().positive() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ process_id }) => executeTool('process_stop', { process_id }, async () => {
    assertProcessControl();
    if (process_id === process.pid) throw new Error('The MCP server process cannot stop itself.');
    return textResult(await runWindowsControl('process-stop', { targetProcessId: process_id }));
  }));

  registerProtectedTool('service_list', {
    title: 'List Windows services',
    description: 'Lists local Windows services and whether each service can be stopped. This tool does not change service state.',
    inputSchema: z.object({
      name_filter: z.string().min(1).max(120).optional(),
      limit: z.number().int().min(1).max(500).default(100)
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ name_filter, limit }) => executeTool('service_list', { name_filter, limit }, async () => textResult(await runWindowsControl('service-list', {
    nameFilter: name_filter,
    limit
  }))));

  registerProtectedTool('browser_open', {
    title: 'Open URL in browser',
    description: 'Opens an HTTP(S) URL in the local Edge or Chrome browser. This affects the interactive desktop.',
    inputSchema: z.object({
      url: z.string().min(1).max(4_096),
      browser: z.enum(['edge', 'chrome']).default('edge')
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ url, browser }) => executeTool('browser_open', { browser, url_length: url.length }, async () => {
    inputGuard();
    return textResult(await runWindowsControl('browser-open', {
      url: validateBrowserUrl(url),
      browser
    }));
  }));

  const workspaceSchema = z.string().min(1).max(1_024).optional();
  const timeoutSchema = z.number().int().min(30).max(14_400).optional();

  registerProtectedTool('agent_start', {
    title: 'Start Codex or Claude background task',
    description: 'Starts a non-interactive Codex or Claude Code task in an allowlisted local workspace. Use background_job_list and background_job_output to monitor it.',
    inputSchema: z.object({
      agent: z.enum(['codex', 'claude']),
      task: z.string().min(1).max(24_000),
      workspace: workspaceSchema,
      mode: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
      model: z.string().min(1).max(100).optional(),
      timeout_seconds: timeoutSchema
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ agent, task, workspace, mode, model, timeout_seconds }) => executeTool('agent_start', {
    agent,
    mode,
    workspace: workspace || null,
    model: model || null,
    timeout_seconds: timeout_seconds || null,
    task_characters: task.length
  }, async () => {
    assertAgentControl();
    const cwd = await resolveAllowedWorkspace(workspace);
    const program = getAllowedProgram(agent);
    const timeoutSeconds = Math.min(timeout_seconds || controlPolicy.max_job_runtime_seconds, controlPolicy.max_job_runtime_seconds);
    const args = agent === 'codex'
      ? ['exec', '--skip-git-repo-check', '--sandbox', mode]
      : ['--print', '--output-format', 'json', '--permission-mode', mode === 'read-only' ? 'plan' : 'acceptEdits'];
    if (model) args.push('--model', model);
    args.push(task);
    return textResult(await startTrackedJob({
      kind: 'agent',
      programAlias: program.alias,
      command: program.command,
      fixedArgs: program.fixed_args,
      args,
      cwd,
      timeoutSeconds,
      owner: jobOwner
    }));
  }));

  registerProtectedTool('background_job_list', {
    title: 'List background jobs',
    description: 'Lists agent and CLI jobs started by the current MCP server instance.',
    inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(50) }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ limit }) => executeTool('background_job_list', { limit }, async () => {
    const jobs = [...agentJobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map(jobSummary);
    return textResult({ jobs });
  }));

  registerProtectedTool('background_job_output', {
    title: 'Read background job output',
    description: 'Reads the most recent captured stdout and stderr for a job started by this MCP server instance.',
    inputSchema: z.object({
      job_id: z.string().uuid(),
      max_chars: z.number().int().min(1_024).max(65_536).default(16_000)
    }),
    annotations: { readOnlyHint: true, openWorldHint: false }
  }, async ({ job_id, max_chars }) => executeTool('background_job_output', { job_id, max_chars }, async () => textResult(await readJobOutput(job_id, max_chars))));

  registerProtectedTool('background_job_stop', {
    title: 'Stop background job',
    description: 'Stops a still-running agent or direct CLI job started by this MCP server instance.',
    inputSchema: z.object({ job_id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
  }, async ({ job_id }) => executeTool('background_job_stop', { job_id }, async () => textResult(await stopTrackedJob(job_id, 'cancelled', jobOwner.principal))));

  registerProtectedTool('cli_start', {
    title: 'Start allowlisted CLI command',
    description: 'Starts a background command through a local program alias. Available only in the local full profile; no arbitrary shell command strings are accepted.',
    inputSchema: z.object({
      program: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
      args: z.array(z.string().max(2_048)).max(128).default([]),
      workspace: workspaceSchema,
      timeout_seconds: timeoutSchema
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }
  }, async ({ program: requestedProgram, args, workspace, timeout_seconds }) => executeTool('cli_start', {
    program: requestedProgram,
    arg_count: args.length,
    workspace: workspace || null,
    timeout_seconds: timeout_seconds || null
  }, async () => {
    assertFullControl();
    const program = getAllowedProgram(requestedProgram);
    validateDirectProgramArgs(program.alias, args);
    const cwd = await resolveAllowedWorkspace(workspace);
    const timeoutSeconds = Math.min(timeout_seconds || controlPolicy.max_job_runtime_seconds, controlPolicy.max_job_runtime_seconds);
    return textResult(await startTrackedJob({
      kind: 'cli',
      programAlias: program.alias,
      command: program.command,
      fixedArgs: program.fixed_args,
      args,
      cwd,
      timeoutSeconds,
      owner: jobOwner
    }));
  }));

  return server;
}

function handleMetadata(req, res) {
  const path = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    sendJson(res, 200, {
      resource: RESOURCE_IDENTIFIER,
      authorization_servers: [OAUTH_ISSUER],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ['header']
    });
    return true;
  }
  if (path === '/.well-known/oauth-authorization-server') {
    sendJson(res, 200, {
      issuer: OAUTH_ISSUER,
      authorization_endpoint: OAUTH_AUTHORIZATION_ENDPOINT,
      token_endpoint: OAUTH_TOKEN_ENDPOINT,
      registration_endpoint: OAUTH_REGISTRATION_ENDPOINT,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      scopes_supported: OAUTH_SCOPES
    });
    return true;
  }
  return false;
}

async function handleAuth(req, res, context) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/oauth/authorize') {
    try {
      return await handleOAuthAuthorize(req, res);
    } catch (error) {
      sendHtml(res, 400, authorizationForm({}, `invalid_request: ${error.message}`));
      return true;
    }
  }
  if (url.pathname === '/oauth/register') {
    try {
      return await handleOAuthRegistration(req, res);
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_client_metadata', error_description: error.message });
      return true;
    }
  }
  if (url.pathname === '/oauth/token') {
    try {
      return await handleOAuthToken(req, res);
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_request', error_description: error.message });
      return true;
    }
  }
  if (url.pathname === '/auth/token' || url.pathname === '/auth/exchange') {
    if (!rateLimit(req, authRateBuckets, 10, 60_000)) {
      sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
      return true;
    }
    if (req.method !== 'POST') {
      sendText(res, 405, 'Method Not Allowed');
      return true;
    }
    try {
      const result = await exchangeToken(await readStructuredBody(req));
      sendJson(res, result.status, result.body, result.status === 200 ? { 'Cache-Control': 'no-store' } : {});
    } catch (error) {
      sendJson(res, 400, { error: 'invalid_request', error_description: error.message });
    }
    return true;
  }
  if (url.pathname === '/auth/status') {
    if (req.method !== 'GET') { sendText(res, 405, 'Method Not Allowed'); return true; }
    const auth = requireBearer(req, res);
    if (!auth) return true;
    sendJson(res, 200, { client_name: auth.clientName, token_id: auth.tokenId, server_url: MCP_URL });
    return true;
  }
  if (url.pathname === '/auth/revoke') {
    if (req.method !== 'POST') { sendText(res, 405, 'Method Not Allowed'); return true; }
    const auth = requireBearer(req, res);
    if (!auth) return true;
    if (auth.authType === 'oauth' && auth.clientId) {
      await revokeClientAuthorization(auth.clientId, 'oauth_revoke_endpoint', auth);
    } else {
      const record = authState.access_tokens.find(item => item.id === auth.tokenId);
      if (record) {
        record.revoked_at = nowSeconds();
        await persistAuth();
        await closeTrackedSessions(session => session.auth.tokenId === auth.tokenId);
        await audit({ event: 'auth_revoke', ...auth });
      }
    }
    sendJson(res, 200, { revoked: true });
    return true;
  }
  if (url.pathname === '/admin/connectors') {
    if (!requireLocalAdmin(req, res)) return true;
    if (req.method === 'GET') {
      await audit({ event: 'connector_status_requested', local_admin: true });
      sendJson(res, 200, connectorStatusSummary());
      return true;
    }
    if (req.method === 'POST') {
      const params = await readStructuredBody(req);
      const clientId = String(params.client_id || '');
      if (!findOauthClient(clientId)) {
        sendJson(res, 404, { error: 'connector_not_found' });
        return true;
      }
      const revoked = await revokeClientAuthorization(clientId, 'local_admin_request', { local_admin: true });
      sendJson(res, 200, { client_id: clientId, revoked });
      return true;
    }
    sendText(res, 405, 'Method Not Allowed');
    return true;
  }
  return false;
}

async function handleMcp(req, res) {
  const auth = requireBearer(req, res);
  if (!auth) return;
  if (!rateLimit(req, requestRateBuckets, 300, 60_000)) {
    sendJson(res, 429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    return;
  }

  const sessionId = req.headers['mcp-session-id'];
  if (req.method === 'POST') {
    let body;
    try {
      body = await readStructuredBody(req);
    } catch (error) {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: error.message }, id: null });
      return;
    }

    if (sessionId) {
      const session = transports.get(sessionId);
      if (!session || session.auth.tokenId !== auth.tokenId) {
        sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'Unknown or unauthorized MCP session.' }, id: null });
        return;
      }
      session.lastActivityAt = new Date().toISOString();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'A new MCP session must start with initialize.' }, id: null });
      return;
    }

    let transport;
    const connectedAt = new Date().toISOString();
    const clientInfo = body.params?.clientInfo || null;
    const connectionId = randomUUID();
    const mcpContext = { ...auth, connectionId, clientInfo };
    const mcpServer = createMcpServer(mcpContext);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // Quick Tunnel does not reliably forward SSE; this server only needs request/response control calls.
      enableJsonResponse: true,
      onsessioninitialized: id => {
        transports.set(id, { transport, server: mcpServer, auth: mcpContext, connectedAt, lastActivityAt: connectedAt, clientInfo });
        audit({ event: 'mcp_session_started', session_id: id, connection_id: connectionId, ...auth, client_info: clientInfo }).catch(() => {});
      }
    });
    transport.onclose = async () => {
      const id = transport.sessionId;
      const session = id ? transports.get(id) : null;
      if (id) transports.delete(id);
      await desktopControlCoordinator.releaseOwner(connectionId).catch(() => {});
      if (id) await audit({ event: 'mcp_session_closed', session_id: id, ...(session?.auth || auth) });
      await mcpServer.close().catch(() => {});
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, body);
    return;
  }

  if (!sessionId) {
    sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32000, message: 'Mcp-Session-Id is required.' }, id: null });
    return;
  }
  const session = transports.get(sessionId);
  if (!session || session.auth.tokenId !== auth.tokenId) {
    sendJson(res, 404, { jsonrpc: '2.0', error: { code: -32000, message: 'Unknown or unauthorized MCP session.' }, id: null });
    return;
  }
  session.lastActivityAt = new Date().toISOString();
  await session.transport.handleRequest(req, res);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  setCommonHeaders(res, origin);
  if (!isOriginAllowed(origin, url.pathname)) {
    console.warn(`[origin] denied origin=${origin || '(none)'} path=${req.url}`);
    sendJson(res, 403, { error: 'origin_not_allowed' });
    return;
  }
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (url.pathname === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, service: 'codex-windows-remote-control', mcp_endpoint: MCP_URL, auth_required: true });
    return;
  }
  if (handleMetadata(req, res)) return;
  if (await handleAuth(req, res)) return;
  if (url.pathname === '/mcp') {
    await handleMcp(req, res);
    return;
  }
  sendText(res, 404, 'Not Found');
}

async function shutdown(httpServer) {
  for (const session of transports.values()) await session.transport.close().catch(() => {});
  transports.clear();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

await initializeAuth();
await initializeLocalAdmin();
await initializeControlPolicy();
console.log(`Bootstrap credential file: ${BOOTSTRAP_FILE}`);
console.log(`MCP endpoint: ${MCP_URL}`);
console.log(`Protected-resource metadata: ${RESOURCE_METADATA_URL}`);
console.log(`Control policy: ${CONTROL_POLICY_FILE} (profile=${controlPolicy.profile})`);
console.log(`Local launcher administration: ${LOCAL_ADMIN_FILE}`);
if (ALLOWED_ORIGINS.length === 0) console.log('Unexpected Browser Origin headers are denied; same-origin and trusted OpenAI OAuth origins are allowed.');
if (INPUT_DISABLED) console.log('Input-control tools are disabled by MCP_DISABLE_INPUT.');

const httpServer = createServer((req, res) => {
  route(req, res).catch(async error => {
    console.error(`[http] ${error.stack || error.message}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    else res.destroy();
  });
});

httpServer.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'));
httpServer.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) console.log(`LAN MCP endpoint: http://${address.address}:${PORT}/mcp`);
    }
  }
});

process.on('SIGINT', () => shutdown(httpServer));
process.on('SIGTERM', () => shutdown(httpServer));
