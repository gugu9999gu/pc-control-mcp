const $ = selector => document.querySelector(selector);

let status = null;
let currentOperation = null;
let finishTimer = null;
let staleTimer = null;
let clockTimer = null;
let lastPoint = null;
let messageTimer = null;
let publishedBrief = null;
const messageEntries = [];

const names = {
  system_info: ['시스템 정보 확인', 'SYSTEM INFO', '◎'], control_capabilities: ['제어 권한 확인', 'POLICY CHECK', '⌾'],
  connector_status: ['연결 상태 확인', 'CONNECTION', '⌁'], list_windows: ['열린 창 확인', 'WINDOW SCAN', '▣'],
  hud_status_update: ['AI 작업 요약 업데이트', 'AI BRIEF', 'AI'], desktop_control_status: ['데스크톱 조정 상태', 'LEASE STATUS', '⌬'],
  desktop_control_acquire: ['데스크톱 제어권 확보', 'LEASE ACQUIRE', '◇'], desktop_control_release: ['데스크톱 제어권 해제', 'LEASE RELEASE', '◇'],
  desktop_screenshot: ['데스크톱 화면 확인', 'SCREEN VIEW', '◫'], desktop_region_screenshot: ['화면 영역 확인', 'REGION VIEW', '▧'], window_screenshot: ['창 화면 확인', 'WINDOW VIEW', '◩'],
  screen_info: ['모니터와 커서 확인', 'DISPLAY SCAN', '⌖'], system_status: ['컴퓨터 상태 확인', 'SYSTEM SCAN', '◉'],
  process_list: ['프로세스 목록 확인', 'PROCESS SCAN', '≡'], process_details: ['프로세스 상세 확인', 'PROCESS VIEW', '≣'],
  service_list: ['서비스 상태 확인', 'SERVICE SCAN', '◇'], launch_app: ['앱 실행', 'APP LAUNCH', '↗'],
  focus_window: ['창 포커스 이동', 'WINDOW FOCUS', '▤'], type_text: ['키보드 텍스트 입력', 'TEXT INPUT', '⌨'],
  send_hotkey: ['키보드 단축키 입력', 'HOTKEY', '⌘'], mouse_click: ['마우스 클릭', 'CLICK', '●'],
  mouse_move: ['마우스 이동', 'MOVE', '⌁'], mouse_drag: ['마우스 드래그', 'DRAG', '↝'],
  mouse_scroll: ['마우스 스크롤', 'SCROLL', '↕'], browser_open: ['브라우저 주소 열기', 'BROWSER OPEN', '◎'],
  process_stop: ['프로세스 종료', 'PROCESS STOP', '■'], agent_start: ['코딩 에이전트 시작', 'AGENT START', 'AI'],
  cli_start: ['CLI 작업 시작', 'CLI START', '>_'], background_job_list: ['백그라운드 작업 확인', 'JOB LIST', '≋'],
  background_job_output: ['작업 출력 확인', 'JOB OUTPUT', '▥'], background_job_stop: ['백그라운드 작업 중지', 'JOB STOP', '□']
};

const inputTools = new Set(['launch_app', 'focus_window', 'type_text', 'send_hotkey', 'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'browser_open']);
const observeTools = new Set(['system_info', 'control_capabilities', 'connector_status', 'desktop_control_status', 'list_windows', 'desktop_screenshot', 'desktop_region_screenshot', 'window_screenshot', 'screen_info', 'system_status']);

function toolName(entry) {
  return names[entry.tool] || [String(entry.tool || 'AI 작업'), String(entry.tool || 'OPERATION').toUpperCase(), '⌁'];
}

function agentBadge(name = '') {
  if (/openai|chatgpt|gpt/i.test(name)) return 'GPT';
  if (/claude|anthropic/i.test(name)) return 'CLD';
  if (/codex/i.test(name)) return 'CDX';
  return 'AI';
}

function operationScope(tool) {
  if (inputTools.has(tool)) return ['REMOTE INPUT', 'AI CONTROL ENVIRONMENT'];
  if (observeTools.has(tool)) return ['REMOTE OBSERVE', 'AI OBSERVATION ENVIRONMENT'];
  if (/desktop_control/.test(tool || '')) return ['CONTROL LEASE', 'MULTI-AGENT COORDINATION'];
  if (/agent|cli|background_job/.test(tool || '')) return ['REMOTE AGENT', 'AI AGENT ENVIRONMENT'];
  return ['SYSTEM OPERATION', 'AI SYSTEM ENVIRONMENT'];
}

function updateStatus(next) {
  status = next;
  const online = Boolean(next.server?.running);
  $('#serverHud').classList.toggle('online', online);
  $('#hudMode').textContent = String(next.mode || 'LOCAL').toUpperCase();
  $('#hudProfile').textContent = String(next.profile || 'safe').toUpperCase();
  $('#hudState').textContent = online ? 'AI CONTROL READY' : 'MCP CONTROL OFFLINE';
  const sessions = next.activeSessions || [];
  const connectors = (next.connectors || []).filter(item => item.client_name !== 'local OAuth verification' && item.connected !== false);
  $('#hudAgent').textContent = sessions.at(-1)?.client_name || connectors[0]?.client_name || '연결 대기 중';
  const primary = next.display?.primary?.bounds;
  const virtual = next.display?.virtual;
  if (primary && virtual) {
    // Anchor the brief to the primary monitor rather than the geometric center
    // of a multi-monitor virtual desktop, which may fall between displays.
    $('#messageHud').style.left = `${primary.x - virtual.x + primary.width / 2}px`;
    $('#messageHud').style.top = `${primary.y - virtual.y + primary.height * .64}px`;
  }
}

function coordinate(entry, phase) {
  const detail = entry.details || {};
  if (entry.tool === 'mouse_drag') {
    return phase === 'start' ? { x: detail.from_x, y: detail.from_y } : { x: detail.to_x, y: detail.to_y };
  }
  if (entry.tool?.startsWith('mouse_')) return { x: detail.x, y: detail.y };
  return null;
}

function detailText(entry) {
  const detail = entry.details || {};
  if (entry.tool === 'hud_status_update') return String(detail.current_target || detail.message || 'USER-VISIBLE TASK SUMMARY').slice(0, 160);
  if (entry.tool === 'desktop_control_acquire') return `${detail.purpose || 'MULTI-STEP OPERATION'} · TTL ${detail.ttl_seconds || 60}s`;
  if (entry.tool === 'desktop_control_release') return 'CONTROL LEASE RETURNED';
  if (entry.tool === 'desktop_control_status') return 'LEASE OWNER · EXPIRY · INPUT QUEUE';
  if (entry.tool === 'mouse_click') return `${detail.x}, ${detail.y} · ${(detail.button || 'left').toUpperCase()} ×${detail.clicks || 1}`;
  if (entry.tool === 'mouse_move') return `TARGET ${detail.x}, ${detail.y}`;
  if (entry.tool === 'mouse_drag') return `${detail.from_x},${detail.from_y} → ${detail.to_x},${detail.to_y}`;
  if (entry.tool === 'mouse_scroll') return `${detail.x}, ${detail.y} · Δ${detail.delta_y || detail.delta_x || 0}`;
  if (entry.tool === 'type_text') return `${detail.characters || 0} CHARACTERS · CONTENT HIDDEN`;
  if (entry.tool === 'send_hotkey') return (detail.keys || []).join(' + ') || 'KEY COMBINATION';
  if (entry.tool === 'launch_app') return String(detail.app || 'ALLOWLISTED APP').toUpperCase();
  if (entry.tool === 'desktop_region_screenshot') return `${detail.x},${detail.y} · ${detail.width}×${detail.height}`;
  if (entry.tool === 'agent_start' || entry.tool === 'cli_start') return `${detail.program || detail.agent || 'AGENT'} · ARGUMENTS ${detail.arg_count ?? '—'}`;
  if (entry.error) return String(entry.error).slice(0, 120);
  const pairs = Object.entries(detail).slice(0, 4).map(([key, value]) => `${key}:${Array.isArray(value) ? value.join('+') : value}`);
  return pairs.join(' · ') || 'CONNECTED AI TOOL CALL';
}

const briefPhaseLabels = {
  planning: 'PLANNING', working: 'WORKING', waiting: 'WAITING', completed: 'COMPLETED', warning: 'ATTENTION'
};

function messageEntryId(entry) {
  return entry.activityId || `${entry.tool}:${entry.timestamp || Date.now()}`;
}

function rememberMessageEntry(entry, phase) {
  const id = messageEntryId(entry);
  let item = messageEntries.find(candidate => candidate.id === id);
  if (!item) {
    item = { id, tool: entry.tool, timestamp: entry.timestamp || new Date().toISOString() };
    messageEntries.unshift(item);
  }
  item.title = toolName(entry)[0];
  item.detail = phase === 'error' && entry.error ? String(entry.error).slice(0, 160) : detailText(entry);
  item.state = phase === 'start' ? 'running' : phase === 'error' ? 'error' : 'done';
  messageEntries.splice(4);
}

function renderMessageLog() {
  const root = $('#messageLog');
  root.replaceChildren();
  for (const item of messageEntries.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = `message-log-row ${item.state}`;
    const time = document.createElement('time');
    time.textContent = new Date(item.timestamp).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const title = document.createElement('strong');
    title.textContent = item.title;
    const detail = document.createElement('span');
    detail.textContent = item.detail;
    const stateNode = document.createElement('em');
    stateNode.textContent = item.state === 'running' ? 'RUNNING' : item.state === 'error' ? 'FAILED' : 'DONE';
    row.append(time, title, detail, stateNode);
    root.append(row);
  }
}

function hideMessageHud() {
  $('#messageHud').classList.remove('active', 'error');
}

function showMessageHud(entry, lifecyclePhase) {
  clearTimeout(messageTimer);
  const detail = entry.details || {};
  const isPublishedBrief = entry.tool === 'hud_status_update';
  if (isPublishedBrief) {
    publishedBrief = {
      title: String(detail.title || 'AI 작업 진행 상황').slice(0, 80),
      message: String(detail.message || '').slice(0, 500),
      phase: detail.phase || 'working',
      progress: Number.isFinite(detail.progress_percent) ? detail.progress_percent : null,
      target: detail.current_target ? String(detail.current_target).slice(0, 160) : null,
      updatedAt: Date.now()
    };
  } else if (publishedBrief && Date.now() - publishedBrief.updatedAt > 120_000) {
    publishedBrief = null;
  } else if (publishedBrief && lifecyclePhase === 'start' && ['completed', 'warning'].includes(publishedBrief.phase)) {
    publishedBrief = null;
  }

  rememberMessageEntry(entry, lifecyclePhase);
  renderMessageLog();
  const panel = $('#messageHud');
  const explicit = publishedBrief;
  const operationTitle = toolName(entry)[0];
  const effectivePhase = lifecyclePhase === 'error'
    ? 'warning'
    : explicit?.phase || (lifecyclePhase === 'success' ? 'completed' : 'working');
  const autoMessage = lifecyclePhase === 'start'
    ? `연결된 AI가 ${operationTitle} 작업을 실행하고 있습니다.`
    : lifecyclePhase === 'error'
      ? `${operationTitle} 작업이 차단되었거나 실패했습니다. 실행 로그를 확인하세요.`
      : `${operationTitle} 작업이 완료되었습니다.`;
  const clientName = entry.clientName || $('#hudAgent').textContent || '연결된 AI';

  panel.dataset.briefPhase = effectivePhase;
  panel.classList.add('active');
  panel.classList.toggle('error', lifecyclePhase === 'error');
  $('#messageAgent').textContent = clientName;
  $('#messagePhase').textContent = briefPhaseLabels[effectivePhase] || 'WORKING';
  $('#messageTitle').textContent = explicit?.title || 'AI 작업 진행 상황';
  $('#messageBody').textContent = explicit?.message || autoMessage;
  $('#messageTarget').textContent = explicit?.target || `${operationTitle} · ${detailText(entry)}`;

  const progressRoot = $('.message-progress');
  const progress = $('#messageProgress');
  const percent = explicit?.progress;
  const indeterminate = !Number.isFinite(percent) && lifecyclePhase === 'start';
  progressRoot.classList.toggle('indeterminate', indeterminate);
  progress.style.width = indeterminate ? '' : `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : lifecyclePhase === 'success' ? 100 : 0}%`;

  const hold = lifecyclePhase === 'start'
    ? 60_000
    : effectivePhase === 'waiting'
      ? 30_000
      : isPublishedBrief || effectivePhase === 'completed'
        ? 12_000
        : 8_000;
  messageTimer = setTimeout(hideMessageHud, hold);
}

function addTrail(from, to) {
  if (!from || !to) return;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (distance < 18) return;
  const count = Math.min(9, Math.max(3, Math.round(distance / 85)));
  for (let index = 1; index <= count; index += 1) {
    const ratio = index / (count + 1);
    const dot = document.createElement('i');
    dot.className = 'trail-dot';
    dot.style.left = `${from.x + (to.x - from.x) * ratio}px`;
    dot.style.top = `${from.y + (to.y - from.y) * ratio}px`;
    dot.style.animationDelay = `${index * 22}ms`;
    $('#trailLayer').append(dot);
    setTimeout(() => dot.remove(), 1_150);
  }
}

function showPointer(entry, phase) {
  const point = coordinate(entry, phase);
  const pointer = $('#aiPointer');
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) || !status?.display?.virtual) {
    if (phase === 'start') pointer.classList.remove('active');
    return;
  }
  const bounds = status.display.virtual;
  const local = {
    x: Math.min(window.innerWidth - 3, Math.max(3, point.x - bounds.x)),
    y: Math.min(window.innerHeight - 3, Math.max(3, point.y - bounds.y))
  };
  addTrail(lastPoint, local);
  lastPoint = local;
  pointer.style.left = `${local.x}px`;
  pointer.style.top = `${local.y}px`;
  pointer.classList.add('active');
  pointer.classList.toggle('flip-x', local.x > window.innerWidth - 210);
  pointer.classList.toggle('right', entry.details?.button === 'right');
  pointer.classList.toggle('drag', entry.tool === 'mouse_drag');
  pointer.classList.toggle('scroll', entry.tool === 'mouse_scroll');
  pointer.classList.toggle('error', phase === 'error');
  $('#pointerAction').textContent = toolName(entry)[1];
  $('#pointerButton').textContent = String(entry.details?.button || (entry.tool === 'mouse_scroll' ? 'WHEEL' : 'POINTER')).toUpperCase();
  $('#pointerCoordinates').textContent = `${Math.round(point.x)} · ${Math.round(point.y)}`;
  if (phase !== 'start' && entry.tool === 'mouse_click') {
    pointer.classList.remove('click-impact');
    void pointer.offsetWidth;
    pointer.classList.add('click-impact');
    setTimeout(() => pointer.classList.remove('click-impact'), 850);
  }
}

function showKeyboard(entry, phase) {
  const input = $('#inputHud');
  const isKeyboard = entry.tool === 'type_text' || entry.tool === 'send_hotkey';
  if (!isKeyboard) {
    if (phase === 'start') input.classList.remove('active', 'done', 'error');
    return;
  }
  input.classList.add('active');
  input.classList.toggle('done', phase === 'success');
  input.classList.toggle('error', phase === 'error');
  $('#inputState').textContent = phase === 'start' ? 'LIVE' : phase === 'error' ? 'BLOCKED' : 'DONE';
  $('#inputLabel').textContent = entry.tool === 'type_text'
    ? `${entry.details?.characters || 0} CHARACTERS · CONTENT HIDDEN`
    : (entry.details?.keys || []).join(' + ');
}

function updateClock() {
  if (!currentOperation) return;
  $('#operationTimer').textContent = `${((Date.now() - currentOperation.startedAt) / 1_000).toFixed(1).padStart(4, '0')}s`;
}

function showOperation(entry, phase) {
  clearTimeout(finishTimer);
  clearTimeout(staleTimer);
  clearInterval(clockTimer);
  const [title, action, glyph] = toolName(entry);
  const [scope, environment] = operationScope(entry.tool);
  const rail = $('#controlRail');
  document.body.classList.add('controlling');
  document.body.dataset.phase = phase;
  rail.classList.add('active');
  rail.classList.toggle('success', phase === 'success');
  rail.classList.toggle('error', phase === 'error');
  $('#serverHud').classList.add('busy');
  $('#operationScope').textContent = scope;
  $('#environmentLabel').textContent = environment;
  $('#operationGlyph').textContent = glyph;
  $('#operationTitle').textContent = title;
  $('#operationDetail').textContent = phase === 'error' && entry.error ? String(entry.error).slice(0, 120) : detailText(entry);
  const clientName = entry.clientName || $('#hudAgent').textContent || '연결된 AI';
  $('#operationAgentBadge').textContent = agentBadge(clientName);
  $('#operationAgentName').textContent = clientName;
  $('#phaseLabel').textContent = phase === 'start' ? 'LIVE' : phase === 'error' ? 'BLOCKED' : 'DONE';
  if (entry.clientName) $('#hudAgent').textContent = entry.clientName;
  if (phase === 'start') {
    currentOperation = { id: entry.activityId || `${entry.tool}:${entry.timestamp}`, tool: entry.tool, startedAt: Date.now() };
    updateClock();
    clockTimer = setInterval(updateClock, 100);
    staleTimer = setTimeout(hideOperation, 15_000);
  } else {
    clearInterval(clockTimer);
    if (Number.isFinite(entry.durationMs)) $('#operationTimer').textContent = `${(entry.durationMs / 1_000).toFixed(1).padStart(4, '0')}s`;
    finishTimer = setTimeout(hideOperation, phase === 'error' ? 3_200 : 2_450);
  }
  $('#pointerAction').textContent = action;
}

function hideOperation() {
  clearTimeout(finishTimer);
  clearTimeout(staleTimer);
  clearInterval(clockTimer);
  currentOperation = null;
  lastPoint = null;
  document.body.classList.remove('controlling');
  document.body.dataset.phase = 'idle';
  $('#controlRail').classList.remove('active', 'success', 'error');
  $('#serverHud').classList.remove('busy');
  $('#aiPointer').classList.remove('active', 'click-impact', 'right', 'drag', 'scroll', 'error');
  $('#inputHud').classList.remove('active', 'done', 'error');
}

function finishActivity(entry) {
  const phase = entry.success === false || entry.error ? 'error' : 'success';
  showMessageHud(entry, phase);
  showPointer(entry, phase);
  showKeyboard(entry, phase);
  showOperation(entry, phase);
}

function showActivity(entry) {
  if (!entry?.tool || !['tool_start', 'tool_call'].includes(entry.event)) return;
  if (entry.event === 'tool_start') {
    showMessageHud(entry, 'start');
    showOperation(entry, 'start');
    showPointer(entry, 'start');
    showKeyboard(entry, 'start');
    return;
  }
  const matchesCurrent = currentOperation && (
    (entry.activityId && currentOperation.id === entry.activityId) || (!entry.activityId && currentOperation.tool === entry.tool)
  );
  if (matchesCurrent) {
    finishActivity(entry);
  } else {
    // Compatibility with activity logs produced by older server builds.
    showMessageHud(entry, 'start');
    showOperation(entry, 'start');
    showPointer(entry, 'start');
    showKeyboard(entry, 'start');
    setTimeout(() => finishActivity(entry), 90);
  }
}

window.mcpOverlay.onStatus(updateStatus);
window.mcpOverlay.onActivity(showActivity);
