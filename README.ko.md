# Windows Remote MCP Control

[English](README.md) · [한국어](README.ko.md)

Windows PC를 OAuth로 보호된 MCP 서버로 연결해 AI가 화면을 확인하고, 허용된 마우스·키보드·창·프로세스·백그라운드 에이전트 도구를 사용할 수 있게 하는 프로젝트입니다. Electron 실행기, 실시간 감사 로그, 로컬 투명 HUD, 실제 PNG 스크린샷 응답, 다중 AI 충돌 방지 기능을 포함합니다.

## 빠른 시작

GitHub Releases에서 `Remote-MCP-Control-0.2.5-x64.exe`를 내려받아 실행하거나, 소스 코드를 받은 뒤 아래 파일을 더블클릭합니다.

현재 포터블 빌드는 Authenticode 상용 코드서명이 없어 Windows SmartScreen에 알 수 없는 게시자 경고가 나타날 수 있습니다. 반드시 이 저장소의 Releases에서만 내려받고, 같은 릴리스의 `SHA256SUMS.txt`와 파일의 SHA-256 값을 비교하십시오. 값이 다르면 실행하지 마십시오. 이 경고를 없애려면 향후 신뢰할 수 있는 Windows 코드서명 인증서가 필요합니다.

```powershell
Get-FileHash -Algorithm SHA256 .\Remote-MCP-Control-0.2.5-x64.exe
```

```text
MCP-Remote-Control-Launcher.cmd
```

처음 소스로 실행하면 잠긴 버전의 Node/Electron 의존성을 설치합니다. 실행기에서 다음 기능을 사용할 수 있습니다.

- 서버와 터널 실행·종료, PID와 상태 표시
- 관제·라이브 화면·실행 로그·AI 연결·고정 도메인·권한을 분리한 페이지형 UI
- 기본 모니터 실시간 미리보기
- 연결된 AI, 활성 MCP 세션, 승인 권한과 연결 해제
- OAuth·도구·마우스·키보드·프로세스·백그라운드 작업·AI 작업공간 파일 변경의 실시간 로그
- 실제 AI 입력 전에 표시되는 커스텀 포인터, 타깃, 안전 프레임, 키보드 개인정보 보호 HUD
- 화면 중앙보다 약간 아래에 표시되는 작업 요약·진행률·대상·최근 실행 로그 HUD
- 임시 HTTPS Quick Tunnel, 사설 LAN, 고정 Cloudflare Named Tunnel
- 같은 터널 주소를 보존하는 서버 전용 재시작과 Named Tunnel 기본 시작·자동 복구
- 공개 HTTPS 연결을 유지하면서 이 PC의 LAN IPv4 주소도 함께 여는 하이브리드 IP 모드
- `safe`, `agent`, `full` 로컬 제어 프로필

대시보드와 바탕화면 HUD는 외부 AI 연결을 다음처럼 구분해 표시합니다.

- **연결 안 됨**: 서버는 온라인이지만 외부 OAuth 커넥터나 활성 세션이 감지되지 않음
- **페어링 중**: 웹 GPT/플러그인이 등록되어 승인 화면, 페어링 토큰 입력 또는 토큰 교환을 진행 중
- **연결됨**: OAuth 인증과 갱신 토큰이 유효하며 다음 도구 호출을 기다리는 중
- **사용 중**: 최근 90초 안에 실제 MCP 세션 활동이 감지됨

중단된 페어링 표시는 기본 10분 뒤 자동 만료되어 **연결 안 됨**으로 돌아갑니다. 실행기 자체의 로컬 OAuth 검증은 외부 AI 연결 수와 상태에 포함되지 않습니다.

외부 연결을 빠르게 시험하려면 **기본 서버 시작**을 누릅니다. 고정 주소가 아직 없으면 임시 HTTPS가 시작되고, Named Tunnel을 한 번 구성하면 고정 주소가 자동으로 기본값이 됩니다. 실행 중인 터널의 URL을 유지하면서 MCP 코어만 다시 띄우려면 **주소 유지 재시작**을 사용합니다.

같은 공유기 안의 다른 PC에서도 이 서버를 써야 하면 **고정 도메인 → 하이브리드 IP 모드**를 켭니다. 서버는 `0.0.0.0:8787`에 수신하고 실행기가 현재 기본 네트워크의 IPv4를 감지해 `http://LAN-IP:8787/mcp`를 함께 표시·복사합니다. 공개 HTTPS URL과 OAuth 리소스는 그대로라 웹 ChatGPT 연결을 다시 등록하지 않아도 됩니다. 단, 다른 LAN 기기의 실제 접속은 Windows 네트워크 프로필과 방화벽 정책에 따라 차단될 수 있습니다.

## ChatGPT 커넥터 연결

등록할 주소는 반드시 `/mcp`로 끝나야 합니다.

```text
https://YOUR-HOST.example.com/mcp
```

루트 주소, `/healthz`, OAuth 메타데이터 주소를 등록하면 안 됩니다. 커넥터가 OAuth 승인 화면을 열면 이 PC의 `data\bootstrap-token.txt`에 있는 한 줄 전체를 입력합니다. 앞뒤 공백과 마지막 줄바꿈은 서버가 제거하지만, 토큰을 다른 사람에게 보내거나 공개 저장소에 올리면 안 됩니다. 붙여넣은 뒤 클립보드를 비우는 것을 권장합니다.

승인 화면에서는 다음 권한 범주를 각각 허용하거나 제한할 수 있습니다.

- 화면·창·시스템·프로세스 상태 보기
- 마우스·키보드·브라우저·앱 실행
- 중요하지 않은 프로세스 종료
- Codex·Claude 백그라운드 작업 시작
- 백그라운드 작업 로그 확인과 중지
- 로컬 허용 목록의 CLI 실행(`full` 프로필 전용)

OAuth 액세스 토큰 기본 수명은 30일, 갱신 토큰은 365일이며 정상 클라이언트는 자동 갱신합니다. 액세스 토큰이 교체되어도 같은 OAuth 클라이언트의 MCP 세션은 유지됩니다. Quick Tunnel 주소가 바뀌면 OAuth 리소스 자체가 바뀌므로 다시 인증해야 합니다. 반복 인증을 피하려면 고정 Named Tunnel을 사용하십시오.

ChatGPT가 **도구 비활성화**라고 답했는데 실행기의 AI 연결 페이지에는 **승인됨 · 0개 활성 세션**으로 보이면 서버나 OAuth가 끊긴 것이 아닙니다. 그 요청이 이 PC에 도달하기 전에 해당 ChatGPT 대화에서 플러그인 도구가 비활성화된 상태입니다. 실행기의 **AI 연결 → ChatGPT 플러그인 열기**를 누른 뒤 다음 순서로 복구합니다.

1. `Remote MCP Control`을 엽니다.
2. **플러그인 작업 → 관리 → 새로 고침**으로 현재 URL의 도구를 다시 동기화합니다.
3. 기존 대화에서 다시 도구를 선택하거나 **채팅에서 사용해 보기**로 플러그인이 활성화된 새 대화를 엽니다.

이 동작은 기존 OAuth 승인을 재사용하므로 페어링 토큰을 다시 입력하지 않습니다. 관리 화면의 새로 고침으로 실행기에 `OpenAI (chatgpt.com)`의 새 MCP 세션이 표시되면 서버까지 도달한 것입니다. ChatGPT의 대화별 도구 활성 상태는 원격 서버가 강제로 고정할 수 없으므로, 실행기는 서버 인증 유지 상태와 최근 실제 세션을 분리해 표시합니다.

## 중앙 작업 메시지 HUD

AI가 도구를 호출하면 모니터 중앙보다 약간 아래에 다음 정보가 표시됩니다.

- 현재 연결된 AI 이름
- 사용자에게 공개된 작업 제목과 요약
- 현재 대상과 진행률
- 최근 실제 MCP 도구의 실행 중·완료·실패 로그

`hud_status_update` 도구를 사용하면 AI가 작업 계획, 현재 행동, 결과, 사용자에게 설명 가능한 판단 근거를 직접 게시할 수 있습니다. 이 요소는 숨겨진 내부 사고과정(chain of thought)을 표시하는 기능이 아닙니다. AI는 비공개 추론, 인증 정보, 토큰, 입력 중인 키보드 본문, 원문 민감정보를 이 도구로 보내면 안 됩니다. `type_text`의 실제 문자열은 감사 로그와 HUD 모두에 저장되지 않고 글자 수만 표시됩니다.

Electron의 **권한 → AI 조작 HUD 미리보기**를 누르면 PC 입력을 바꾸지 않고 중앙 메시지창, 포인터, 클릭 효과, 키보드 HUD를 확인할 수 있습니다.

## AI의 화면 시각 확인

다음 MCP 도구는 설명 텍스트만 반환하는 것이 아니라 실제 `image/png` 콘텐츠를 반환합니다.

- `desktop_screenshot`: 전체 가상 데스크톱
- `desktop_region_screenshot`: 지정한 좌표와 크기의 화면 영역
- `window_screenshot`: 특정 최상위 창
- `screen_info`: 다중 모니터 경계와 현재 커서 좌표

멀티모달 AI는 반환된 이미지를 직접 보고 버튼 위치, 창 상태, 오류 메시지 등 시각 정보를 확인할 수 있습니다. 다중 모니터에서 영역 캡처를 할 때는 먼저 `screen_info`를 호출하고 가상 데스크톱 범위 안의 좌표를 사용합니다.

## 여러 AI의 충돌 방지

서버는 실제 마우스·키보드·창 포커스·앱 실행·브라우저 열기 호출을 하나의 FIFO 대기열에서 순서대로 실행합니다. 따라서 두 AI의 입력 함수가 같은 순간 실행되지 않습니다.

여러 단계가 이어지는 조작은 다음 순서를 사용합니다.

1. AI가 `desktop_control_acquire`로 목적과 짧은 TTL을 지정해 입력 임대를 확보합니다.
2. 화면을 확인하고 관련 마우스·키보드 작업을 수행합니다.
3. 마지막에 `desktop_control_release`를 호출합니다.

임대 소유자는 일시적인 MCP 전송 세션이 아니라 인증된 OAuth 커넥터(또는 페어링 자격 증명)입니다. 따라서 ChatGPT가 도구 호출마다 새 MCP 세션을 만들어도 같은 커넥터는 재인증 없이 조작과 해제를 계속할 수 있습니다. 별도로 인증된 다른 ChatGPT·Codex·Claude 커넥터가 임대를 보유하면 입력을 섞지 않고 `desktop_control_busy` 의미의 명확한 오류를 반환합니다. 스크린샷과 읽기 전용 상태 확인은 임대 중에도 동시에 사용할 수 있습니다. 임대는 입력할 때 갱신되며 명시적으로 해제하지 않아도 최대 10분 안에 만료됩니다. `desktop_control_status`로 현재 소유자 표시명, 목적, 만료 시각과 입력 대기열을 확인할 수 있으며 토큰 값은 반환하지 않습니다.

Codex·Claude·CLI 백그라운드 작업도 정규화된 작업 폴더를 예약합니다. 같은 폴더에서 두 에이전트가 동시에 파일을 수정하는 것은 거부됩니다. 병렬 편집이 필요하면 서로 다른 Git worktree를 만들고 각 에이전트에 별도 경로를 허용하십시오. 백그라운드 작업은 이를 시작한 커넥터 주체만 중지할 수 있습니다.

## 도구 목록

- 시각 확인: `desktop_screenshot`, `desktop_region_screenshot`, `window_screenshot`, `screen_info`
- 데스크톱: `list_windows`, `launch_app`, `focus_window`, `type_text`, `send_hotkey`, `mouse_click`, `mouse_move`, `mouse_drag`, `mouse_scroll`, `browser_open`
- 사용자 공개 상태: `hud_status_update`
- 다중 AI 조정: `desktop_control_status`, `desktop_control_acquire`, `desktop_control_release`
- 관찰: `system_info`, `system_status`, `process_list`, `process_details`, `service_list`, `control_capabilities`, `connector_status`
- 프로세스: `process_stop`(핵심 Windows 프로세스와 MCP 서버는 항상 보호)
- 에이전트: `agent_start`, `background_job_list`, `background_job_output`, `background_job_stop`
- 허용 CLI: `cli_start`(`full` 로컬 프로필에서만 사용)

모든 도구 수명주기는 `data\audit.ndjson`에 토큰 없이 기록됩니다. 실행기의 내부 상태 폴링은 감사 로그와 UI에서 제외됩니다. `agent_start`·`cli_start` 작업이 실행되는 동안에는 해당 작업 폴더의 생성·수정·삭제도 파일 내용 없이 기록하며, `.git`, `node_modules`, 빌드 캐시와 산출물 폴더는 소음을 줄이기 위해 제외합니다. Electron 실행기가 시작한 서버는 실제 입력보다 약 220ms 먼저 `tool_start`를 기록해 로컬 HUD가 먼저 보이게 합니다.

## 로컬 제어 프로필

OAuth 권한은 외부 AI에 대한 경계이고, 로컬 프로필은 PC 소유자가 정하는 두 번째 상한선입니다.

- `safe`: 화면·창·시스템·프로세스·서비스 읽기 전용
- `agent`(기본): 읽기 + 데스크톱 입력 + 앱/브라우저 + 비핵심 프로세스 종료 + 제한된 Codex/Claude 작업
- `full`: `agent` + 로컬 허용 목록의 `cli_start`

정책은 `data\control-policy.json`에 저장되고, 작업 가능 폴더, 동시 작업 수, 최대 실행 시간, 프로그램 별칭을 제한합니다. 임의 PowerShell·셸 문자열은 직접 받지 않으며 위험한 Codex/Claude 권한 우회 플래그를 거부합니다. 넓은 드라이브 전체를 허용하기보다 필요한 프로젝트 경로만 추가하십시오.

Codex와 Claude CLI는 이 PC에서 미리 로그인되어 있어야 합니다. 로그인 자격 증명은 MCP로 전달되지 않습니다.

## 고정 MCP 도메인

Quick Tunnel의 `trycloudflare.com` 호스트명은 재시작할 때 바뀝니다. 고정 주소가 필요하면 Electron의 **고정 도메인** 절차를 사용합니다.

1. Cloudflare 계정에 활성화된 본인 도메인을 준비합니다.
2. 실행기에서 cloudflared 설치·로그인 상태를 확인합니다.
3. 영문, 숫자, 하이픈으로 된 고유 터널 이름을 입력합니다. 예: `remote-mcp-admin-pc`
4. `https://mcp.example.com`처럼 경로가 없는 HTTPS 원본 주소를 입력합니다.
5. Named Tunnel과 DNS·로컬 ingress 경로를 만든 뒤 고정 도메인 모드로 시작합니다.

자동 구성은 로컬 관리형 Tunnel 자격 증명과 `data\cloudflared-named-tunnel.yml`을 사용해 고정 호스트를 `127.0.0.1:8787`에 연결합니다. 기존 원격 관리형 Tunnel을 수동 등록할 때만 실행 토큰을 Windows 보안 저장소로 암호화하며 UI나 로그에 평문으로 표시하지 않습니다. 구성이 끝나면 Named Tunnel이 기본 시작 모드가 되고 실행기 재실행 시 같은 URL로 자동 복구됩니다. 기존 DNS 레코드는 자동 덮어쓰지 않습니다. 고정 주소의 최종 MCP URL은 `https://mcp.example.com/mcp`입니다.

LAN 전용 모드는 `http://LAN-IP:8787/mcp`만 제공하고 공개 터널을 종료합니다. 하이브리드 IP 모드는 같은 LAN 주소와 기존 Quick/Named HTTPS 주소를 동시에 유지합니다. 신뢰할 수 있는 사설망에서만 IP 수신을 켜고, 다른 PC의 접속이 필요하면 네트워크를 Private으로 확인한 뒤 관리자 PowerShell에서 `scripts\install-firewall.ps1`을 별도로 실행하십시오. 이 스크립트는 TCP/8787을 Private 프로필의 LocalSubnet에만 엽니다.

`192.168.x.x` 같은 사설 IP는 인터넷의 ChatGPT 클라우드가 직접 연결할 수 없습니다. 웹 ChatGPT에는 공개 HTTPS Named Tunnel을 쓰거나, 개발자 모드에서 OpenAI Secure MCP Tunnel을 별도로 구성해야 합니다. Secure MCP Tunnel은 Platform의 `tunnel_id`, 런타임 API 키, `tunnel-client`가 필요하며 공개 플러그인 배포용 URL을 대신하지 않습니다.

## 수동 실행

로컬 실행:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start.ps1 -PublicBaseUrl http://127.0.0.1:8787
```

기존 PowerShell 실행기:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Start
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -CopyToken
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Verify
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Connections
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -WatchActivity
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Stop
```

## 검증

기본 OAuth, 도구 목록, 갱신 토큰과 HUD 검증:

```powershell
node .\scripts\verify-oauth.mjs https://YOUR-HOST.example.com
node .\scripts\verify.mjs https://YOUR-HOST.example.com
npm run verify:hud
npm test
```

실제 PNG 이미지 반환과 서로 다른 두 MCP 세션의 입력 임대 충돌·인계 검증:

```powershell
$env:VERIFY_SCREENSHOT = '1'
$env:VERIFY_COORDINATION = '1'
node .\scripts\verify-oauth.mjs https://YOUR-HOST.example.com
Remove-Item Env:VERIFY_SCREENSHOT, Env:VERIFY_COORDINATION
```

OAuth 검증 스크립트는 테스트용 커넥터를 만들고 검증 후 토큰을 해제합니다. 스크린샷 검증 결과에는 MIME 형식, 바이트 수, 화면 크기만 출력하며 이미지 원문이나 토큰을 로그에 출력하지 않습니다.

## 빌드

```powershell
npm ci
npm test
npm run app:smoke
npm run app:dist
```

Portable EXE는 `dist-electron`에 생성됩니다. 런타임 `data` 폴더, 인증 파일, 토큰, 감사 로그, Named Tunnel 토큰, `node_modules`는 Git에 올리면 안 됩니다.

## 문제 해결

- **토큰이 유효하지 않음**: 현재 실행 중인 서버의 `bootstrap-token.txt`를 사용하고 오래된 Quick Tunnel URL을 재사용하지 마십시오.
- **Origin not allowed**: 최신 서버를 재시작하고 ChatGPT가 연 현재 `/oauth/authorize` 주소의 호스트가 등록한 `/mcp` 주소와 같은지 확인하십시오.
- **매 호출마다 재인증**: 고정 Named Tunnel을 기본값으로 사용하고 커넥터 권한을 임의로 해제하지 마십시오. 기본 액세스/갱신 수명은 30일/365일이며 갱신 후에도 같은 OAuth 클라이언트 세션을 허용합니다.
- **로그에 상태 확인만 보임**: v0.2.5 이상으로 서버를 주소 유지 재시작하십시오. 이전 빌드가 쌓은 상태 폴링 행은 새 UI가 자동으로 숨깁니다.
- **Desktop control is reserved**: 다른 AI가 다단계 입력 임대를 보유 중입니다. `desktop_control_status`를 확인하고 해제 또는 만료 후 다시 시도하십시오.
- **Workspace is already reserved**: 같은 폴더에서 다른 백그라운드 작업이 실행 중입니다. 완료를 기다리거나 별도 Git worktree를 사용하십시오.
- **HUD가 보이지 않음**: 실행기에서 바탕화면 AI HUD를 켜고 **AI 조작 HUD 미리보기**를 실행하십시오.
- **스크린샷 실패**: Windows 대화형 데스크톱이 잠겨 있지 않은지 확인하고, 영역 캡처 좌표가 `screen_info`의 가상 화면 안에 있는지 확인하십시오.

이 서버는 원격 PC 제어 권한을 제공합니다. 꼭 필요한 권한만 승인하고, 가능하면 `safe` 또는 `agent` 프로필을 사용하며, 토큰과 고정 터널 자격 증명을 공개하지 마십시오.
