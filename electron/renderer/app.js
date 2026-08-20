const api = window.mcpApp;
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

const state = {
  status: null,
  activities: [],
  filter: 'all',
  previewTimer: null,
  previewBusy: false,
  previewAutoAttempted: false,
  busy: false,
  currentPage: 'overview'
};

const pages = {
  overview: ['DESKTOP OPERATIONS', '이 컴퓨터의 AI 제어를 한눈에.', '서버, 연결, 주소 유지 상태를 한 화면에서 확인합니다.'],
  'live-view': ['LIVE DESKTOP', 'AI가 보고 조작하는 화면.', '화면 미리보기와 마우스·키보드 HUD를 실시간으로 확인합니다.'],
  activity: ['AUDIT TRAIL', '실제 AI 작업 로그.', '상태 폴링을 제외한 도구 호출, 입력, 프로세스, 파일 변경만 표시합니다.'],
  connections: ['AI CONNECTORS', '인증과 재연결 상태.', '승인된 AI, 최근 활성 세션, 토큰 자동 갱신 상태를 관리합니다.'],
  'fixed-domain': ['PERSISTENT ENDPOINT', '재시작해도 같은 MCP 주소.', 'Named Tunnel을 기본 주소로 지정하고 앱 실행 시 자동 복구합니다.'],
  permissions: ['LOCAL POLICY', '이 PC에서 강제되는 권한.', '연결된 AI별 OAuth 승인과 별개로 로컬 제어 범위를 제한합니다.']
};

const toolInfo = {
  system_info: ['시스템 정보 확인', 'observe', '◎'],
  control_capabilities: ['제어 권한 확인', 'observe', '⌾'],
  connector_status: ['연결 상태 확인', 'observe', '⌁'],
  hud_status_update: ['AI 작업 요약 업데이트', 'observe', 'AI'],
  desktop_control_status: ['데스크톱 조정 상태', 'observe', '⌬'],
  desktop_control_acquire: ['데스크톱 제어권 확보', 'input', '◇'],
  desktop_control_release: ['데스크톱 제어권 해제', 'input', '◇'],
  list_windows: ['열린 창 목록 확인', 'observe', '▣'],
  desktop_screenshot: ['데스크톱 화면 캡처', 'observe', '◫'],
  desktop_region_screenshot: ['화면 영역 캡처', 'observe', '▧'],
  window_screenshot: ['창 화면 캡처', 'observe', '◩'],
  screen_info: ['모니터·커서 확인', 'observe', '⌖'],
  system_status: ['컴퓨터 상태 확인', 'observe', '◉'],
  process_list: ['프로세스 목록 확인', 'system', '≡'],
  process_details: ['프로세스 상세 확인', 'system', '≣'],
  service_list: ['서비스 상태 확인', 'system', '◇'],
  launch_app: ['앱 실행', 'input', '↗'],
  focus_window: ['창 포커스 이동', 'input', '▤'],
  type_text: ['키보드 텍스트 입력', 'input', '⌨'],
  send_hotkey: ['키보드 단축키 입력', 'input', '⌘'],
  mouse_click: ['마우스 클릭', 'input', '●'],
  mouse_move: ['마우스 이동', 'input', '⌁'],
  mouse_drag: ['마우스 드래그', 'input', '↝'],
  mouse_scroll: ['마우스 스크롤', 'input', '↕'],
  browser_open: ['브라우저 주소 열기', 'input', '◎'],
  process_stop: ['프로세스 종료', 'system', '■'],
  agent_start: ['코딩 에이전트 시작', 'system', 'AI'],
  cli_start: ['CLI 작업 시작', 'system', '>_'],
  background_job_list: ['백그라운드 작업 확인', 'system', '≋'],
  background_job_output: ['작업 출력 확인', 'system', '▥'],
  background_job_stop: ['백그라운드 작업 중지', 'system', '□']
};

const eventTitles = {
  mcp_session_started: 'MCP 세션 연결',
  mcp_session_closed: 'MCP 세션 종료',
  oauth_client_registered: 'OAuth 클라이언트 등록',
  oauth_authorization_started: 'OAuth 페어링 시작',
  oauth_authorization_approved: 'AI 권한 승인',
  oauth_authorization_denied: 'AI 권한 거부',
  oauth_token_issued: 'OAuth 토큰 발급',
  oauth_token_refreshed: 'OAuth 토큰 자동 갱신',
  oauth_token_failed: 'OAuth 인증 실패',
  connector_authorization_revoked: 'AI 연결 권한 해제',
  tool_start: '도구 실행 시작',
  auth_revoke: '로컬 인증 해제',
  auth_exchange: '로컬 페어링 인증',
  background_job_started: '백그라운드 작업 시작',
  background_job_finished: '백그라운드 작업 완료',
  file_activity: '파일 변경 감지',
  file_activity_suppressed: '파일 로그 상한 도달',
  file_activity_watcher_error: '파일 감시 오류',
  server_started: 'MCP 서버 시작',
  server_stopping: 'MCP 서버 종료'
};

function setPage(page) {
  if (!pages[page]) return;
  state.currentPage = page;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.target === page));
  $$('.page-view').forEach(view => view.classList.toggle('active', view.dataset.page === page));
  const [eyebrow, title, description] = pages[page];
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;
  $('#pageDescription').textContent = description;
  $('.workspace').scrollTo({ top: 0, behavior: 'smooth' });
}

function toast(message, level = 'success', timeout = 4200) {
  const node = document.createElement('div');
  node.className = `toast ${level}`;
  node.textContent = message;
  $('#toastStack').append(node);
  setTimeout(() => node.remove(), timeout);
}

function setBusy(busy, label = '작업 처리 중') {
  state.busy = busy;
  $('#busyCover').classList.toggle('show', busy);
  $('#busyLabel').textContent = label || '작업 처리 중';
  $$('button').forEach(button => {
    if (!button.matches('.nav-item')) button.toggleAttribute('data-busy', busy);
  });
}

async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(successMessage);
    return result;
  } catch (error) {
    toast(error?.message || String(error), 'error', 7000);
    throw error;
  }
}

function modeLabel(mode) {
  return ({ quick: 'QUICK TUNNEL', named: 'FIXED DOMAIN', lan: 'LAN MODE', custom: 'CUSTOM HTTPS' })[mode] || 'STANDBY';
}

function ttlLabel(seconds) {
  if (!seconds) return '—';
  const days = Math.round(seconds / 86400);
  if (days >= 1) return `${days} DAYS`;
  const hours = Math.round(seconds / 3600);
  return `${hours} HOURS`;
}

function connectedConnectors(status) {
  return (status.connectors || []).filter(item => item.client_name !== 'local OAuth verification' && item.connected !== false);
}

const pairingPhaseLabels = {
  registered: 'AI 클라이언트 등록 감지 · 승인 화면 열림 대기',
  awaiting_authorization: '브라우저에서 페어링 토큰과 권한 승인 대기',
  authorization_failed: '페어링 토큰 오류 · 브라우저에서 다시 입력 대기',
  permission_selection_required: '화면 보기 권한 선택 후 다시 승인 필요',
  authorization_approved: '권한 승인 완료 · OAuth 토큰 교환 대기',
  token_exchange_failed: 'OAuth 토큰 교환 실패 · 커넥터 재시도 대기'
};

function connectionPresentation(status) {
  const stateCode = status.server?.running ? status.connectionState?.status || 'disconnected' : 'offline';
  const clientName = status.connectionState?.client_name || null;
  const phaseText = pairingPhaseLabels[status.connectionState?.pairing_phase] || '웹 GPT/플러그인이 인증 절차를 진행 중입니다.';
  const sessions = status.activeSessions || [];
  const values = {
    offline: {
      card: '서버 꺼짐', short: 'MCP 서버 오프라인', title: '서버가 대기 중입니다',
      detail: 'MCP 서버를 시작하면 AI 연결 감지를 시작합니다.', agent: '서버 꺼짐', agentLabel: 'MCP SERVER OFFLINE'
    },
    disconnected: {
      card: '연결 안 됨', short: 'AI CONNECTION NOT DETECTED', title: 'MCP 서버 온라인 · AI 연결 안 됨',
      detail: '웹 GPT 또는 플러그인의 페어링 요청이 아직 감지되지 않았습니다.', agent: '연결 안 됨', agentLabel: 'NO AI CONNECTION'
    },
    pairing: {
      card: '페어링 중', short: 'PAIRING IN PROGRESS', title: '웹 GPT 페어링 요청을 감지했습니다',
      detail: phaseText, agent: clientName || '웹 GPT / 플러그인', agentLabel: 'PAIRING REQUEST DETECTED'
    },
    authorized: {
      card: '재연결 가능', short: 'AUTH READY · RECONNECTABLE', title: 'AI 인증 유지 · 언제든 재연결 가능',
      detail: 'OAuth 인증과 고정 주체가 유지되어 다음 MCP 호출 때 새 세션으로 연결됩니다.', agent: clientName || '승인된 AI', agentLabel: 'AUTHORIZED · IDLE'
    },
    connected: {
      card: '사용 중', short: 'LIVE MCP CONNECTION', title: '연동된 AI가 이 PC와 통신 중입니다',
      detail: `최근 ${status.activeSessionWindowSeconds || 90}초 안에 ${sessions.length}개 MCP 세션의 활동을 감지했습니다.`, agent: clientName || sessions.at(-1)?.client_name || '연결된 AI', agentLabel: 'LIVE AI CONNECTION'
    }
  };
  return { code: stateCode, clientName, phaseText, ...(values[stateCode] || values.disconnected) };
}

function updateStatus(status) {
  state.status = status;
  const online = Boolean(status.server?.running);
  const connection = connectionPresentation(status);
  document.body.dataset.server = online ? 'online' : 'offline';
  document.body.dataset.connection = connection.code;
  $('#appVersion').textContent = `v${status.appVersion || '0.2.5'}${status.packaged ? ' · PORTABLE' : ' · SOURCE'}`;
  $('#sideServerState').textContent = online ? 'ONLINE' : status.server?.processDetected ? 'STARTING' : 'OFFLINE';
  $('#heroState').textContent = online ? 'MCP CORE ONLINE' : status.server?.processDetected ? 'MCP CORE STARTING' : 'MCP CORE OFFLINE';
  $('#heroTitle').textContent = connection.title;
  $('#heroDescription').textContent = online
    ? `${connection.detail} · ${modeLabel(status.mode)}${status.settings?.lanDirectEnabled ? ' · LAN IP 병행 수신' : ''}`
    : connection.detail;
  $('#currentModeLabel').textContent = modeLabel(status.mode);
  $('#mcpUrl').textContent = status.mcpUrl || '아직 생성된 MCP URL이 없습니다';
  $('#lanMcpUrl').textContent = status.lanMcpUrl || (status.lanIp ? `대기 중 · http://${status.lanIp}:8787/mcp` : '사용 가능한 LAN IPv4를 찾지 못했습니다');
  $('#serverPid').textContent = status.server?.pid || '—';
  $('#serverHealth').textContent = status.localHealthy ? 'HEALTHY' : status.server?.processDetected ? 'BOOTING' : 'NO SIGNAL';
  $('#tunnelPid').textContent = status.tunnel?.pid || '—';
  $('#tunnelHealth').textContent = status.tunnel?.running ? 'CONNECTED' : status.mode === 'lan' && online ? 'LAN DIRECT' : 'DISCONNECTED';
  const connectors = connectedConnectors(status);
  $('#activeAiCount').textContent = connection.card;
  $('#activeSessionCount').textContent = connection.short;
  $('#footerStatus').textContent = online ? `${modeLabel(status.mode)} / PID ${status.server.pid}` : 'LOCAL ENGINE STANDBY';
  const defaultNamed = status.settings?.preferredStartMode === 'named' && Boolean(status.namedTunnel);
  $('#startDefaultLabel').textContent = defaultNamed ? '고정 도메인 기본 시작' : '임시 HTTPS 기본 시작';
  $('#startDefault').disabled = state.busy || online;
  $('#restartServer').disabled = state.busy || !status.lastPublicBaseUrl || (!online && status.mode === 'quick' && !status.tunnel?.running);
  $('#startQuick').disabled = state.busy || online;
  $('#startNamed').disabled = state.busy || online || !status.namedTunnel;
  $('#startLan').disabled = state.busy || online || !status.lanIp;
  $('#stopServer').disabled = state.busy || (!status.server?.processDetected && !status.tunnel?.running);
  $('#copyUrl').disabled = !status.mcpUrl;
  $('#inlineCopyUrl').disabled = !status.mcpUrl;
  $('#inlineCopyLanUrl').disabled = !status.lanMcpUrl;
  $('#currentModeLabel').classList.toggle('online', online);
  $('#profileBadge').textContent = String(status.profile || 'agent').toUpperCase();
  $$('.profile-option').forEach(button => button.classList.toggle('active', button.dataset.profile === status.profile));
  $('#accessTtl').textContent = ttlLabel(status.oauthAccessTokenTtlSeconds);
  $('#refreshTtl').textContent = ttlLabel(status.oauthRefreshTokenTtlSeconds);
  const reconnectGuide = connection.code === 'connected'
    ? { state: 'live', badge: 'LIVE SESSION', title: '현재 ChatGPT 도구 호출 수신 중', text: `최근 ${status.activeSessionWindowSeconds || 90}초 안에 MCP 세션 활동이 감지되었습니다.` }
    : connection.code === 'authorized'
      ? { state: 'ready', badge: 'AUTH READY', title: '서버 인증 유지 · 대화 도구만 확인', text: '재인증은 필요하지 않습니다. ChatGPT가 “도구 비활성화”라고 답하면 플러그인 관리에서 새로 고침한 뒤 해당 대화에서 다시 사용하세요.' }
      : connection.code === 'pairing'
        ? { state: 'ready', badge: 'PAIRING', title: 'ChatGPT OAuth 승인 진행 중', text: connection.phaseText }
        : connection.code === 'offline'
          ? { state: 'offline', badge: 'SERVER OFF', title: '먼저 MCP 서버를 시작하세요', text: '서버가 온라인이 되면 ChatGPT 플러그인 도구 목록과 인증 상태를 확인할 수 있습니다.' }
          : { state: 'offline', badge: 'NOT LINKED', title: '승인된 ChatGPT 커넥터 없음', text: 'MCP URL을 ChatGPT 플러그인에 등록하고 OAuth 승인 절차를 완료하세요.' };
  $('#reconnectPanel').dataset.state = reconnectGuide.state;
  $('#reconnectGuideState').textContent = reconnectGuide.badge;
  $('#reconnectGuideTitle').textContent = reconnectGuide.title;
  $('#reconnectGuideText').textContent = reconnectGuide.text;
  $('#overlayToggle').checked = status.settings?.overlayEnabled !== false;
  $('#previewAutoToggle').checked = status.settings?.previewAutoStart === true;
  $('#lanDirectToggle').checked = status.settings?.lanDirectEnabled === true;
  $('#autoRestoreToggle').checked = status.settings?.autoRestoreServer === true;
  $('#autoRestoreToggle').disabled = !status.namedTunnel;
  $('#localOriginText').textContent = status.settings?.lanDirectEnabled && status.lanIp ? `${status.lanIp}:8787` : '127.0.0.1:8787';
  const resolution = status.display?.primary?.bounds;
  $('#screenResolution').textContent = resolution ? `${resolution.width} × ${resolution.height} / PRIMARY` : 'PRIMARY DISPLAY';

  if (status.namedTunnel) {
    $('#domainState').textContent = status.settings?.preferredStartMode === 'named' ? 'DEFAULT · AUTO RESTORE' : 'CONFIGURED';
    $('#domainState').classList.add('good');
    $('#savedDomainText').textContent = new URL(status.namedTunnel.publicBaseUrl).hostname;
    if (!$('#domainUrl').value) $('#domainUrl').value = status.namedTunnel.publicBaseUrl;
    if (!$('#tunnelName').value) $('#tunnelName').value = status.namedTunnel.tunnelName || '';
  } else {
    $('#domainState').textContent = 'NOT CONFIGURED';
    $('#domainState').classList.remove('good');
  }

  renderConnectors(connectors, status.activeSessions || [], connection);
  updateCurrentAgent(status);
  if (status.settings?.previewAutoStart && !state.previewAutoAttempted) {
    state.previewAutoAttempted = true;
    startPreview().catch(() => {});
  }
}

function renderConnectors(connectors, sessions, connection) {
  const list = $('#connectorList');
  $('#connectorCount').textContent = `${connectors.length} CONNECTOR${connectors.length === 1 ? '' : 'S'}`;
  list.replaceChildren();
  if (!connectors.length) {
    const empty = document.createElement('div');
    empty.className = `empty-card connection-${connection.code}`;
    empty.textContent = connection.code === 'pairing'
      ? `${connection.agent} 페어링 중 · ${connection.phaseText}`
      : connection.code === 'disconnected'
        ? '연결이 감지되지 않았습니다. 웹 GPT/플러그인에서 MCP URL을 등록해 주세요.'
        : connection.code === 'offline'
          ? '서버가 실행되면 승인된 AI와 권한이 표시됩니다.'
          : '인증된 외부 AI 커넥터 정보를 불러오는 중입니다.';
    list.append(empty);
    return;
  }
  for (const connector of connectors) {
    const card = document.createElement('div');
    card.className = 'connector-card';
    const logo = document.createElement('div');
    logo.className = 'connector-logo';
    logo.textContent = /openai|chatgpt/i.test(connector.client_name || '') ? 'GPT' : 'AI';
    const body = document.createElement('div');
    const title = document.createElement('h4');
    title.textContent = connector.client_name || 'Unknown AI connector';
    const meta = document.createElement('p');
    const live = sessions.filter(session => session.client_id === connector.client_id || session.client_name === connector.client_name).length;
    meta.textContent = `${connector.connected === false ? '권한 해제됨' : '승인됨'} · ${live}개 활성 세션 · 마지막 사용 ${connector.last_used_at ? new Date(connector.last_used_at).toLocaleString('ko-KR') : '없음'}`;
    const tags = document.createElement('div');
    tags.className = 'permission-tags';
    for (const permission of connector.permissions || []) {
      const tag = document.createElement('span');
      tag.textContent = permission;
      tags.append(tag);
    }
    body.append(title, meta, tags);
    const revoke = document.createElement('button');
    revoke.className = 'revoke-button';
    revoke.textContent = '연결 해제';
    revoke.addEventListener('click', async () => {
      if (!confirm(`${title.textContent}의 토큰과 활성 세션을 해제할까요?`)) return;
      await run(() => api.revokeConnector(connector.client_id), 'AI 연결을 해제했습니다.');
      updateStatus(await api.getStatus());
    });
    card.append(logo, body, revoke);
    list.append(card);
  }
}

function updateCurrentAgent(status) {
  const sessions = status.activeSessions || [];
  const connectors = connectedConnectors(status);
  const current = sessions.at(-1);
  const connection = connectionPresentation(status);
  const name = current?.client_name || connection.agent || connectors[0]?.client_name;
  $('#currentAgentLabel').textContent = connection.agentLabel;
  $('#currentAgent').textContent = name;
  $('#currentAgentMeta').textContent = connection.code === 'connected'
    ? `${sessions.length}개 MCP 세션 활성 · ${status.profile.toUpperCase()} 로컬 정책`
    : connection.code === 'authorized'
      ? `연결됨 · MCP 도구 호출 대기 · ${status.profile.toUpperCase()} 로컬 정책`
      : connection.code === 'pairing'
        ? connection.phaseText
        : connection.detail;
}

function activityKind(entry) {
  if (entry.success === false || entry.error || /failed|denied/i.test(entry.event)) return 'error';
  if (/^file_activity/.test(entry.event)) return 'file';
  if (entry.tool) return toolInfo[entry.tool]?.[1] || 'system';
  if (/oauth|session|connector|auth/i.test(entry.event)) return 'system';
  return 'system';
}

function activityTitle(entry) {
  if (entry.tool) return toolInfo[entry.tool]?.[0] || entry.tool;
  return eventTitles[entry.event] || entry.event.replaceAll('_', ' ');
}

function activityDetail(entry) {
  const detail = entry.details || {};
  if (entry.event === 'file_activity') return `${detail.action || 'changed'} · ${detail.path || 'unknown path'}`;
  if (entry.event === 'file_activity_suppressed') return `${detail.workspace || 'workspace'} · 최대 ${detail.limit || '—'}건`;
  if (entry.event === 'server_started' || entry.event === 'server_stopping') return detail.endpoint || entry.reason || '로컬 MCP 엔진';
  if (entry.tool === 'hud_status_update') return `${detail.phase || 'working'} · ${detail.title || detail.message || '공개 작업 요약'}`;
  if (entry.tool === 'desktop_control_acquire') return `${detail.purpose || '다단계 작업'} · TTL ${detail.ttl_seconds || 60}초`;
  if (entry.tool === 'desktop_control_release') return '현재 인증 커넥터의 입력 임대 해제';
  if (entry.tool === 'desktop_control_status') return '입력 임대 소유자·만료·대기열 확인';
  if (entry.tool === 'mouse_click') return `x:${detail.x} y:${detail.y} · ${detail.button || 'left'} ×${detail.clicks || 1}`;
  if (entry.tool === 'mouse_move') return `x:${detail.x} y:${detail.y}`;
  if (entry.tool === 'mouse_drag') return `${detail.from_x},${detail.from_y} → ${detail.to_x},${detail.to_y}`;
  if (entry.tool === 'mouse_scroll') return `x:${detail.x} y:${detail.y} · Δ${detail.delta_y || detail.delta_x}`;
  if (entry.tool === 'type_text') return `${detail.characters || 0}자 입력 · 내용 비공개`;
  if (entry.tool === 'send_hotkey') return (detail.keys || []).join(' + ');
  if (entry.tool === 'launch_app') return detail.app || '허용된 앱';
  if (entry.tool === 'desktop_region_screenshot') return `x:${detail.x} y:${detail.y} · ${detail.width}×${detail.height}`;
  if (entry.tool === 'agent_start') return `${detail.agent || 'agent'} · ${detail.workspace || '기본 작업공간'} · ${detail.mode || 'workspace-write'}`;
  if (entry.tool === 'cli_start') return `${detail.program || entry.program || 'CLI'} · ${detail.workspace || '기본 작업공간'} · 인수 ${detail.arg_count ?? '—'}개`;
  if (entry.jobId) return `job ${entry.jobId.slice(0, 8)} · ${entry.status || entry.kind || ''}`;
  if (entry.error) return String(entry.error).slice(0, 160);
  if (entry.reason) return String(entry.reason).slice(0, 160);
  const pairs = Object.entries(detail).slice(0, 5).map(([key, value]) => `${key}:${Array.isArray(value) ? value.join('+') : value}`);
  const duration = Number.isFinite(entry.durationMs) ? ` · ${entry.durationMs}ms` : '';
  return (pairs.join(' · ') || '정상 처리') + duration;
}

function addActivity(entry, prepend = true) {
  if (!entry?.event) return;
  if (entry.event === 'connector_status_requested') return;
  if (prepend) state.activities.unshift(entry);
  else state.activities.push(entry);
  state.activities = state.activities.slice(0, 220);
  renderActivity();
  if (entry.event === 'tool_start') {
    showCurrentOperation(entry);
    visualizeInput(entry);
  } else if (entry.event === 'tool_call') {
    showCurrentOperation(entry);
    if (!entry.activityId) visualizeInput(entry);
  }
}

function renderActivity() {
  const list = $('#activityList');
  list.replaceChildren();
  if (!state.activities.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-row';
    empty.textContent = '서버 활동을 기다리고 있습니다.';
    list.append(empty);
    return;
  }
  for (const entry of state.activities) {
    const kind = activityKind(entry);
    const row = document.createElement('div');
    row.className = `activity-row${kind === 'error' ? ' error' : ''}`;
    row.dataset.kind = kind;
    if (state.filter !== 'all' && state.filter !== kind) row.classList.add('hidden');
    const time = document.createElement('span');
    time.className = 'activity-time';
    time.textContent = new Date(entry.timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const agent = document.createElement('span');
    agent.className = 'activity-agent';
    agent.textContent = entry.clientName || (entry.event.startsWith('oauth') ? 'OAuth broker' : 'Local engine');
    const action = document.createElement('span');
    action.className = 'activity-action';
    action.append(document.createElement('i'), document.createTextNode(activityTitle(entry)));
    const detail = document.createElement('span');
    detail.className = 'activity-detail';
    detail.textContent = activityDetail(entry);
    detail.title = detail.textContent;
    const status = document.createElement('span');
    status.className = 'activity-state';
    status.textContent = kind === 'error' ? 'FAILED' : entry.event === 'tool_start' ? 'RUNNING' : entry.success === null ? 'EVENT' : 'SUCCESS';
    row.append(time, agent, action, detail, status);
    list.append(row);
  }
}

function showCurrentOperation(entry) {
  const info = toolInfo[entry.tool] || [entry.tool, 'system', '⌁'];
  $('#operationIcon').textContent = info[2];
  $('#currentOperation').textContent = info[0];
  $('#currentOperationDetail').textContent = activityDetail(entry);
  if (entry.clientName) $('#currentAgent').textContent = entry.clientName;
  const meter = $('#operationMeter');
  meter.classList.remove('run');
  void meter.offsetWidth;
  meter.classList.add('run');
}

function targetCoordinate(entry) {
  const detail = entry.details || {};
  if (entry.tool === 'mouse_drag') return { x: detail.to_x, y: detail.to_y };
  if (entry.tool?.startsWith('mouse_')) return { x: detail.x, y: detail.y };
  return null;
}

function visualizeInput(entry) {
  const coordinate = targetCoordinate(entry);
  if (coordinate && Number.isFinite(coordinate.x) && Number.isFinite(coordinate.y)) {
    const bounds = state.status?.display?.primary?.bounds;
    const cursor = $('#previewCursor');
    if (bounds) {
      const x = ((coordinate.x - bounds.x) / bounds.width) * 100;
      const y = ((coordinate.y - bounds.y) / bounds.height) * 100;
      if (x >= 0 && x <= 100 && y >= 0 && y <= 100) {
        cursor.style.left = `${x}%`;
        cursor.style.top = `${y}%`;
      }
    }
    cursor.classList.remove('show', 'click');
    void cursor.offsetWidth;
    cursor.classList.add('show');
    if (entry.tool === 'mouse_click') cursor.classList.add('click');
    $('#lastInputAction').textContent = activityTitle(entry);
  }
  if (entry.tool === 'type_text' || entry.tool === 'send_hotkey') {
    const hud = $('#keyboardHud');
    $('#keyboardLabel').textContent = entry.tool === 'type_text' ? `${entry.details?.characters || 0} CHARACTERS` : (entry.details?.keys || []).join(' + ');
    hud.classList.remove('show');
    void hud.offsetWidth;
    hud.classList.add('show');
    $('#lastInputAction').textContent = activityTitle(entry);
  }
}

async function startPreview() {
  if (state.previewTimer) return;
  const updateFrame = async () => {
    if (state.previewBusy) return;
    state.previewBusy = true;
    try {
      const frame = await api.captureDesktopFrame();
      $('#desktopFrame').src = frame.dataUrl;
    } finally {
      state.previewBusy = false;
    }
  };
  await updateFrame();
  state.previewTimer = setInterval(() => updateFrame().catch(() => {}), 800);
  $('#desktopStage').classList.add('previewing');
  $('#previewPill').classList.add('on');
  $('#previewPill').lastChild.textContent = 'PREVIEW LIVE';
  $('#togglePreview').textContent = '화면 숨기기';
}

function stopPreview() {
  if (state.previewTimer) clearInterval(state.previewTimer);
  state.previewTimer = null;
  state.previewBusy = false;
  $('#desktopFrame').removeAttribute('src');
  $('#desktopStage').classList.remove('previewing');
  $('#previewPill').classList.remove('on');
  $('#previewPill').lastChild.textContent = 'PREVIEW OFF';
  $('#togglePreview').textContent = '화면 보기';
}

async function refreshCloudflare() {
  const result = await run(() => api.cloudflareStatus());
  const node = $('#cloudflareStatus');
  node.classList.remove('good', 'warn');
  if (!result.installed) {
    node.classList.add('warn');
    node.querySelector('b').textContent = 'cloudflared가 설치되지 않았습니다';
  } else if (!result.loggedIn) {
    node.classList.add('warn');
    node.querySelector('b').textContent = '설치됨 · Cloudflare 로그인 필요';
  } else {
    node.classList.add('good');
    node.querySelector('b').textContent = `로그인됨 · ${result.tunnels.length}개 Tunnel 확인`;
  }
  return result;
}

function bindEvents() {
  $$('.nav-item').forEach(button => button.addEventListener('click', () => setPage(button.dataset.target)));
  $$('.filter').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter').forEach(item => item.classList.toggle('active', item === button));
    renderActivity();
  }));

  $('#startDefault').addEventListener('click', () => run(() => api.startPreferred()));
  $('#restartServer').addEventListener('click', () => run(() => api.restartServer(), '같은 MCP URL로 서버를 재시작했습니다.'));
  $('#startQuick').addEventListener('click', async () => {
    if (state.status?.namedTunnel && !confirm('새 임시 주소는 서버나 터널을 다시 시작하면 바뀌며 기존 OAuth 연결을 다시 승인해야 할 수 있습니다. 그래도 임시 HTTPS로 시작할까요?')) return;
    await run(() => api.start('quick'));
  });
  $('#startLan').addEventListener('click', async () => {
    if (!confirm('LAN 전용 모드는 공개 HTTPS 터널을 종료하므로 웹 ChatGPT 연결이 끊깁니다. 같은 사설망의 기기에서만 사용할까요?')) return;
    await run(() => api.start('lan'));
  });
  $('#startNamed').addEventListener('click', async () => {
    if (!state.status?.namedTunnel) {
      setPage('fixed-domain');
      toast('먼저 고정 도메인 설정을 완료하세요.', 'warn');
      return;
    }
    await run(() => api.start('named'));
  });
  $('#stopServer').addEventListener('click', () => run(() => api.stop()));
  const copyUrl = () => run(() => api.copyUrl(), 'MCP URL을 클립보드에 복사했습니다.');
  const copyLanUrl = () => run(() => api.copyLanUrl(), '이 PC의 LAN MCP URL을 클립보드에 복사했습니다.');
  $('#copyUrl').addEventListener('click', copyUrl);
  $('#inlineCopyUrl').addEventListener('click', copyUrl);
  $('#inlineCopyLanUrl').addEventListener('click', copyLanUrl);
  $('#copyToken').addEventListener('click', () => run(() => api.copyToken(), '페어링 토큰을 복사했습니다. OAuth 승인 화면에만 붙여넣으세요.'));
  $('#copyPairingToken').addEventListener('click', () => run(() => api.copyToken(), '페어링 토큰을 복사했습니다.'));
  $('#openChatGpt').addEventListener('click', () => api.openChatGpt());
  $('#openChatGptPlugins').addEventListener('click', () => api.openChatGptPlugins());
  $('#copyReconnectUrl').addEventListener('click', copyUrl);
  $('#openDataFolder').addEventListener('click', () => api.openDataFolder());
  $('#togglePreview').addEventListener('click', () => state.previewTimer ? stopPreview() : run(startPreview));

  $$('.profile-option').forEach(button => button.addEventListener('click', async () => {
    const profile = button.dataset.profile;
    if (profile === 'full' && !confirm('FULL 프로필은 허용된 CLI와 프로세스 조작을 원격 AI에 허용합니다. 계속할까요?')) return;
    await run(() => api.setProfile(profile), `${profile.toUpperCase()} 권한 프로필을 적용했습니다.`);
  }));
  $('#overlayToggle').addEventListener('change', event => run(() => api.setSettings({ overlayEnabled: event.target.checked })));
  $('#previewAutoToggle').addEventListener('change', event => run(() => api.setSettings({ previewAutoStart: event.target.checked })));
  $('#autoRestoreToggle').addEventListener('change', async event => {
    if (!state.status?.namedTunnel) {
      event.target.checked = false;
      toast('먼저 고정 도메인을 설정하세요.', 'warn');
      return;
    }
    await run(() => api.setSettings({ preferredStartMode: 'named', autoRestoreServer: event.target.checked }), event.target.checked ? '고정 도메인 자동 복구를 켰습니다.' : '자동 복구를 껐습니다. 고정 주소 설정은 유지됩니다.');
    updateStatus(await api.getStatus());
  });
  $('#lanDirectToggle').addEventListener('change', async event => {
    const enabled = event.target.checked;
    if (enabled && !confirm('MCP 서버를 이 PC의 LAN IPv4에서도 수신하게 합니다. OAuth는 유지되지만 Windows 방화벽 정책에 따라 다른 기기 접속은 차단될 수 있습니다. 계속할까요?')) {
      event.target.checked = false;
      return;
    }
    await run(() => api.setSettings({ lanDirectEnabled: enabled }), enabled ? '하이브리드 IP 모드를 켰습니다.' : 'LAN IP 직접 수신을 껐습니다.');
    updateStatus(await api.getStatus());
  });
  $('#hudPreview').addEventListener('click', async () => {
    try {
      await api.previewOverlay();
      toast('바탕화면에서 커스텀 AI 커서와 작업 HUD를 재생합니다.');
    } catch (error) {
      toast(error.message || String(error), 'error');
    }
  });

  $('#checkCloudflare').addEventListener('click', refreshCloudflare);
  $('#loginCloudflare').addEventListener('click', async () => {
    await run(() => api.cloudflareLogin(), 'Cloudflare 로그인이 완료되었습니다.');
    await refreshCloudflare();
  });
  $('#domainForm').addEventListener('submit', async event => {
    event.preventDefault();
    await run(() => api.createNamedTunnel({
      tunnelName: $('#tunnelName').value,
      publicBaseUrl: $('#domainUrl').value,
      useExisting: $('#useExistingTunnel').checked
    }), '고정 도메인을 기본 시작 주소로 설정했습니다.');
    updateStatus(await api.getStatus());
  });
  $('#saveManualTunnel').addEventListener('click', async () => {
    await run(() => api.saveNamedTunnel({
      tunnelName: $('#tunnelName').value,
      publicBaseUrl: $('#domainUrl').value,
      token: $('#manualTunnelToken').value
    }), '기존 Tunnel URL과 토큰을 저장하고 고정 도메인을 기본값으로 설정했습니다.');
    $('#manualTunnelToken').value = '';
    updateStatus(await api.getStatus());
  });
}

async function initialize() {
  bindEvents();
  setPage('overview');
  const [status, activity] = await Promise.all([api.getStatus(), api.getActivity(180)]);
  updateStatus(status);
  state.activities = [...activity].reverse();
  renderActivity();
  api.onStatus(updateStatus);
  api.onActivity(entry => addActivity(entry, true));
  api.onAction(entry => {
    const synthetic = { ...entry, event: 'launcher_action', clientName: 'Electron launcher', details: { message: entry.message }, success: entry.level !== 'error', error: entry.level === 'error' ? entry.message : null };
    state.activities.unshift(synthetic);
    state.activities = state.activities.slice(0, 220);
    renderActivity();
    if (entry.level === 'error') toast(entry.message, 'error', 7000);
  });
  api.onBusy(({ busy, label }) => setBusy(busy, label));
}

initialize().catch(error => toast(`앱 초기화 실패: ${error.message}`, 'error', 10000));
