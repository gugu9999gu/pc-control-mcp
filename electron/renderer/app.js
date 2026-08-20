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
  busy: false
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
  connector_status_requested: '커넥터 상태 확인'
};

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

function updateStatus(status) {
  state.status = status;
  const online = Boolean(status.server?.running);
  document.body.dataset.server = online ? 'online' : 'offline';
  $('#appVersion').textContent = `v${status.appVersion || '0.2.1'}${status.packaged ? ' · PORTABLE' : ' · SOURCE'}`;
  $('#sideServerState').textContent = online ? 'ONLINE' : status.server?.processDetected ? 'STARTING' : 'OFFLINE';
  $('#heroState').textContent = online ? 'MCP CORE ONLINE' : status.server?.processDetected ? 'MCP CORE STARTING' : 'MCP CORE OFFLINE';
  $('#heroTitle').textContent = online ? '이 PC가 AI 도구 호출을 수신 중입니다' : '서버가 대기 중입니다';
  $('#heroDescription').textContent = online
    ? `${modeLabel(status.mode)} 모드 · 로컬 OAuth 및 도구 권한 정책이 적용되고 있습니다.`
    : '실행 방식을 선택하면 OAuth 보호 MCP 서버와 외부 터널을 함께 시작합니다.';
  $('#currentModeLabel').textContent = modeLabel(status.mode);
  $('#mcpUrl').textContent = status.mcpUrl || '아직 생성된 MCP URL이 없습니다';
  $('#serverPid').textContent = status.server?.pid || '—';
  $('#serverHealth').textContent = status.localHealthy ? 'HEALTHY' : status.server?.processDetected ? 'BOOTING' : 'NO SIGNAL';
  $('#tunnelPid').textContent = status.tunnel?.pid || '—';
  $('#tunnelHealth').textContent = status.tunnel?.running ? 'CONNECTED' : status.mode === 'lan' && online ? 'LAN DIRECT' : 'DISCONNECTED';
  const connectors = connectedConnectors(status);
  $('#activeAiCount').textContent = connectors.length;
  $('#activeSessionCount').textContent = `${(status.activeSessions || []).length} LIVE SESSIONS`;
  $('#footerStatus').textContent = online ? `${modeLabel(status.mode)} / PID ${status.server.pid}` : 'LOCAL ENGINE STANDBY';
  $('#startQuick').disabled = state.busy || online;
  $('#startNamed').disabled = state.busy || online || !status.namedTunnel;
  $('#stopServer').disabled = state.busy || (!status.server?.processDetected && !status.tunnel?.running);
  $('#copyUrl').disabled = !status.mcpUrl;
  $('#inlineCopyUrl').disabled = !status.mcpUrl;
  $('#currentModeLabel').classList.toggle('online', online);
  $('#profileBadge').textContent = String(status.profile || 'agent').toUpperCase();
  $$('.profile-option').forEach(button => button.classList.toggle('active', button.dataset.profile === status.profile));
  $('#accessTtl').textContent = ttlLabel(status.oauthAccessTokenTtlSeconds);
  $('#refreshTtl').textContent = ttlLabel(status.oauthRefreshTokenTtlSeconds);
  $('#overlayToggle').checked = status.settings?.overlayEnabled !== false;
  $('#previewAutoToggle').checked = status.settings?.previewAutoStart === true;
  const resolution = status.display?.primary?.bounds;
  $('#screenResolution').textContent = resolution ? `${resolution.width} × ${resolution.height} / PRIMARY` : 'PRIMARY DISPLAY';

  if (status.namedTunnel) {
    $('#domainState').textContent = 'CONFIGURED';
    $('#domainState').classList.add('good');
    $('#savedDomainText').textContent = new URL(status.namedTunnel.publicBaseUrl).hostname;
    if (!$('#domainUrl').value) $('#domainUrl').value = status.namedTunnel.publicBaseUrl;
    if (!$('#tunnelName').value) $('#tunnelName').value = status.namedTunnel.tunnelName || '';
  } else {
    $('#domainState').textContent = 'NOT CONFIGURED';
    $('#domainState').classList.remove('good');
  }

  renderConnectors(connectors, status.activeSessions || []);
  updateCurrentAgent(status);
  if (status.settings?.previewAutoStart && !state.previewAutoAttempted) {
    state.previewAutoAttempted = true;
    startPreview().catch(() => {});
  }
}

function renderConnectors(connectors, sessions) {
  const list = $('#connectorList');
  $('#connectorCount').textContent = `${connectors.length} CONNECTOR${connectors.length === 1 ? '' : 'S'}`;
  list.replaceChildren();
  if (!connectors.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-card';
    empty.textContent = state.status?.server?.running ? '아직 승인된 외부 AI 커넥터가 없습니다.' : '서버가 실행되면 승인된 AI와 권한이 표시됩니다.';
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
  const name = current?.client_name || connectors[0]?.client_name;
  $('#currentAgent').textContent = name || '연결 대기 중';
  $('#currentAgentMeta').textContent = name ? `${sessions.length}개 MCP 세션 활성 · ${status.profile.toUpperCase()} 로컬 정책` : '활성 MCP 세션 없음';
}

function activityKind(entry) {
  if (entry.success === false || entry.error || /failed|denied/i.test(entry.event)) return 'error';
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
  if (entry.tool === 'hud_status_update') return `${detail.phase || 'working'} · ${detail.title || detail.message || '공개 작업 요약'}`;
  if (entry.tool === 'desktop_control_acquire') return `${detail.purpose || '다단계 작업'} · TTL ${detail.ttl_seconds || 60}초`;
  if (entry.tool === 'desktop_control_release') return '현재 MCP 세션의 입력 임대 해제';
  if (entry.tool === 'desktop_control_status') return '입력 임대 소유자·만료·대기열 확인';
  if (entry.tool === 'mouse_click') return `x:${detail.x} y:${detail.y} · ${detail.button || 'left'} ×${detail.clicks || 1}`;
  if (entry.tool === 'mouse_move') return `x:${detail.x} y:${detail.y}`;
  if (entry.tool === 'mouse_drag') return `${detail.from_x},${detail.from_y} → ${detail.to_x},${detail.to_y}`;
  if (entry.tool === 'mouse_scroll') return `x:${detail.x} y:${detail.y} · Δ${detail.delta_y || detail.delta_x}`;
  if (entry.tool === 'type_text') return `${detail.characters || 0}자 입력 · 내용 비공개`;
  if (entry.tool === 'send_hotkey') return (detail.keys || []).join(' + ');
  if (entry.tool === 'launch_app') return detail.app || '허용된 앱';
  if (entry.tool === 'desktop_region_screenshot') return `x:${detail.x} y:${detail.y} · ${detail.width}×${detail.height}`;
  if (entry.tool === 'agent_start' || entry.tool === 'cli_start') return `${detail.program || entry.program || 'agent'} · 인수 ${detail.arg_count ?? '—'}개`;
  if (entry.jobId) return `job ${entry.jobId.slice(0, 8)} · ${entry.status || entry.kind || ''}`;
  if (entry.error) return String(entry.error).slice(0, 160);
  if (entry.reason) return String(entry.reason).slice(0, 160);
  const pairs = Object.entries(detail).slice(0, 5).map(([key, value]) => `${key}:${Array.isArray(value) ? value.join('+') : value}`);
  const duration = Number.isFinite(entry.durationMs) ? ` · ${entry.durationMs}ms` : '';
  return (pairs.join(' · ') || '정상 처리') + duration;
}

function addActivity(entry, prepend = true) {
  if (!entry?.event) return;
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
  $$('.nav-item').forEach(button => button.addEventListener('click', () => {
    $$('.nav-item').forEach(item => item.classList.toggle('active', item === button));
    document.getElementById(button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
  $$('.filter').forEach(button => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    $$('.filter').forEach(item => item.classList.toggle('active', item === button));
    renderActivity();
  }));

  $('#startQuick').addEventListener('click', () => run(() => api.start('quick')));
  $('#startNamed').addEventListener('click', async () => {
    if (!state.status?.namedTunnel) {
      $('#fixed-domain').scrollIntoView({ behavior: 'smooth' });
      toast('먼저 고정 도메인 설정을 완료하세요.', 'warn');
      return;
    }
    await run(() => api.start('named'));
  });
  $('#stopServer').addEventListener('click', () => run(() => api.stop()));
  const copyUrl = () => run(() => api.copyUrl(), 'MCP URL을 클립보드에 복사했습니다.');
  $('#copyUrl').addEventListener('click', copyUrl);
  $('#inlineCopyUrl').addEventListener('click', copyUrl);
  $('#copyToken').addEventListener('click', () => run(() => api.copyToken(), '페어링 토큰을 복사했습니다. OAuth 승인 화면에만 붙여넣으세요.'));
  $('#copyPairingToken').addEventListener('click', () => run(() => api.copyToken(), '페어링 토큰을 복사했습니다.'));
  $('#openChatGpt').addEventListener('click', () => api.openChatGpt());
  $('#openDataFolder').addEventListener('click', () => api.openDataFolder());
  $('#togglePreview').addEventListener('click', () => state.previewTimer ? stopPreview() : run(startPreview));

  $$('.profile-option').forEach(button => button.addEventListener('click', async () => {
    const profile = button.dataset.profile;
    if (profile === 'full' && !confirm('FULL 프로필은 허용된 CLI와 프로세스 조작을 원격 AI에 허용합니다. 계속할까요?')) return;
    await run(() => api.setProfile(profile), `${profile.toUpperCase()} 권한 프로필을 적용했습니다.`);
  }));
  $('#overlayToggle').addEventListener('change', event => run(() => api.setSettings({ overlayEnabled: event.target.checked })));
  $('#previewAutoToggle').addEventListener('change', event => run(() => api.setSettings({ previewAutoStart: event.target.checked })));
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
    }), '고정 도메인 구성이 완료되었습니다. 이제 고정 도메인 시작 버튼을 사용할 수 있습니다.');
    updateStatus(await api.getStatus());
  });
  $('#saveManualTunnel').addEventListener('click', async () => {
    await run(() => api.saveNamedTunnel({
      tunnelName: $('#tunnelName').value,
      publicBaseUrl: $('#domainUrl').value,
      token: $('#manualTunnelToken').value
    }), '기존 Tunnel URL과 토큰을 안전하게 저장했습니다.');
    $('#manualTunnelToken').value = '';
    updateStatus(await api.getStatus());
  });
}

async function initialize() {
  bindEvents();
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
