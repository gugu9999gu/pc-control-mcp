# Windows Remote MCP Control

[English](README.md) · [한국어](README.ko.md)

This project exposes an allowlisted Windows desktop-control MCP server over Streamable HTTP. It supports OAuth 2.1 Authorization Code + PKCE for ChatGPT connector/plugin registration, visual PNG responses, a local AI-control HUD, and multi-agent coordination. The earlier pairing-token exchange remains available for local clients.

## Quick start

Download the portable `Remote-MCP-Control-0.2.0-x64.exe` from the repository's Releases page, or clone the source and double-click the Electron launcher:

The portable build is not Authenticode-signed. Windows SmartScreen can therefore show an unknown-publisher warning. Download it only from this repository's release, compare its SHA-256 value with `SHA256SUMS.txt` on the same release, and do not run it if the values differ. A future release needs a trusted Windows code-signing certificate to remove this warning.

```powershell
Get-FileHash -Algorithm SHA256 .\Remote-MCP-Control-0.2.0-x64.exe
```

```text
MCP-Remote-Control-Launcher.cmd
```

With no command-line arguments this opens the Electron control center. On the first run it installs the locked Electron dependencies, then provides:

- animated server/tunnel health and PID telemetry;
- a live primary-monitor preview;
- real-time per-AI tool, OAuth, mouse, keyboard, process, and background-job audit activity;
- a click-through transparent desktop HUD showing remote mouse and keyboard activity without recording typed text;
- a center-lower operation brief showing the AI's user-visible task summary, current target, progress, and recent real tool execution log;
- connector permissions, active sessions, revocation, pairing-token copy, and local safe/agent/full policy controls;
- Quick Tunnel, private-LAN, and stable Cloudflare Named Tunnel management.

Choose **Start temporary HTTPS** for a generated Quick Tunnel URL, or configure a stable domain in the **Fixed domain** section and choose **Start fixed domain**. The app creates the server and tunnel as background processes; quitting the app from its tray menu can either keep them running or stop them.

`MCP-Remote-Control-App.cmd` opens the same Electron app directly. Passing an existing command-line switch to `MCP-Remote-Control-Launcher.cmd` still opens the legacy PowerShell interface for automation compatibility.

If Quick Tunnel DNS propagation is delayed, the app keeps the server and tunnel running and reports the state in the activity stream. The Electron app can also be run with `npm run app`, tested with `npm run app:smoke`, or built as a portable Windows executable with `npm run app:dist`.

The OAuth consent page keeps scripts, external resources, frames, and base-URL changes blocked in its CSP. It intentionally omits only `form-action`, because ChatGPT can display the page in an embedded context where Chromium rejects same-server form posts under that directive.

The desktop HUD now follows each tool call from `tool_start` through success or failure. For mouse and keyboard tools launched by Electron, the server emits the start event and waits 220 ms before applying Windows input so the owner sees the custom AI pointer, target reticle, action card, and safety frame before the real cursor or focus changes. Completed HUD elements remain briefly visible and then hide automatically; the small connection indicator stays visible while the server is online. Open **Permissions → AI operation HUD preview** to replay the mouse, click, and private-keyboard designs without changing desktop input.

The center-lower message HUD combines two sources: automatic tool lifecycle records and summaries explicitly published through `hud_status_update`. The latter is for a concise action, plan, result, or safe decision rationale intended for the PC owner. It is not a chain-of-thought viewer: agents must never send hidden reasoning, credentials, typed private content, or raw sensitive data. Keyboard text remains excluded from both the HUD and audit file.

The URL to register is:

```text
https://YOUR-TUNNEL.trycloudflare.com/mcp
```

Do not register the root URL, `/healthz`, or the metadata URL. When the connector opens the OAuth authorization page, enter the pairing token stored in `data\bootstrap-token.txt` on this PC.

The legacy launcher menu remains available for command-line use and provides pairing-token copy, OAuth verification, ChatGPT opening, status, URL copy, shutdown, local control-profile management, connector status/revocation, and live activity logs. The token is trimmed before copying so the final newline in `bootstrap-token.txt` cannot break authorization. Clear the clipboard after pasting the token.

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Start
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -CopyToken
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Verify
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Stop
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -SetProfile full
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -AddWorkspace C:\work\my-project
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -LoginAgent claude
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -Connections
powershell.exe -ExecutionPolicy Bypass -File .\scripts\launcher.ps1 -WatchActivity
```

## Why the previous plugin connection failed

The first version exposed a custom `/auth/exchange` endpoint using a bootstrap secret and `client_credentials`. ChatGPT connector authentication uses OAuth 2.1 authorization code flow with PKCE; it does not accept client credentials, service accounts, custom API keys, or a bootstrap secret as a connector credential. The server now publishes the protected-resource metadata, authorization-server metadata, dynamic registration endpoint, authorization page, PKCE token exchange, refresh-token rotation, CORS headers for trusted OpenAI browser origins, and per-tool OAuth metadata required by the connector.

OAuth access tokens now last seven days by default and refresh tokens 90 days. A connector normally refreshes silently, so it should not ask for the pairing token on each tool call. A changed Quick Tunnel URL is a new OAuth resource, however, and requires a new authorization; use a stable named tunnel to avoid that.

## Connector permissions and activity

The local OAuth consent page now lets you approve or leave unchecked each authority category:

- desktop/system viewing;
- desktop input and browser use;
- non-critical process stopping;
- Codex and Claude background jobs;
- background-job output and stop;
- allowlisted CLI jobs.

Viewing is required to establish a useful connector. The local control profile remains a second, machine-owner boundary: a connector cannot gain authority that the local profile denies. To reduce a connected AI's permissions later, use launcher option 17 to revoke its connector authorization, then reconnect and select the new permissions. Options 14 and 15 show recent or live activity; option 16 shows connector status, active sessions, granted categories, and token state without exposing token values.

## Tools

- Visual inspection: `desktop_screenshot`, `desktop_region_screenshot`, `window_screenshot`, and `screen_info`. Screenshot tools return actual MCP `image/png` content plus bounds metadata, so a connected multimodal AI can inspect the fresh frame directly.
- Desktop control: `list_windows`, `launch_app`, `focus_window`, `type_text`, `send_hotkey`, `mouse_click`, `mouse_move`, `mouse_drag`, `mouse_scroll`, and `browser_open`.
- User-visible status: `hud_status_update` publishes a safe task brief to the center-lower local HUD.
- Multi-agent coordination: `desktop_control_status`, `desktop_control_acquire`, and `desktop_control_release`.
- Background observability: `system_info`, `system_status`, `process_list`, `process_details`, `service_list`, and `control_capabilities`.
- Process control: `process_stop` for non-critical processes only. The MCP server and core Windows processes are protected.
- Agent jobs: `agent_start`, `background_job_list`, `background_job_output`, and `background_job_stop` for non-interactive Codex or Claude Code tasks.
- Direct allowlisted CLI jobs: `cli_start`, available only after the local full profile is enabled.

All tool calls are recorded in `data\audit.ndjson`. Set `-DisableInput` on the launcher or server start script to disable desktop-input tools.

## Multi-agent coordination

All real mouse, keyboard, window-focus, app-launch, and browser-open calls enter one FIFO queue, so input calls cannot execute at the same instant. For a multi-step desktop workflow, an agent should acquire a lease before the first input and release it in `finally` after the last input:

1. Call `desktop_control_acquire` with a short purpose and TTL.
2. Perform the related visual checks and input calls. Screenshot and other read-only tools remain concurrent, even while the lease is held.
3. Call `desktop_control_release`. The server also releases the lease when the MCP session closes and expires it automatically after at most ten minutes.

If another session owns the lease, input fails with a clear busy result instead of interleaving. Codex, Claude, and allowlisted CLI background jobs also reserve their normalized working directory. A second job cannot start in the same workspace until the first ends; use separate Git worktrees when true parallel editing is required. Only the connector principal that started a background job can stop it.

## Local control profiles

The public URL is protected by OAuth, but the machine owner still controls the maximum authority available through `data\control-policy.json`:

- `safe`: read-only system, screen, window, process, and service inspection.
- `agent` (default): safe inspection plus desktop input, browser/app launching, non-critical process stopping, and constrained Codex/Claude jobs.
- `full`: adds `cli_start` for the locally allowlisted program aliases only.

Use launcher options 8–12, or run `scripts\control-profile.ps1`. The policy restricts job working directories to `allowed_workspaces`, limits concurrent jobs and runtime, and lists every executable alias. It intentionally does not accept arbitrary shell/PowerShell command strings and rejects Codex/Claude dangerous permission-bypass flags. To make another project available to an agent, add it locally through option 12; do not weaken the workspace restriction by exposing a broad drive root.

Codex and Claude must already be authenticated on this PC. The launcher’s option 13 (or `-LoginAgent codex` / `-LoginAgent claude`) opens the provider’s normal interactive login flow in a visible terminal. This server does not transmit provider credentials through the MCP endpoint.

## Manual operation

Local start:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start.ps1 -PublicBaseUrl http://127.0.0.1:8787
```

LAN start (the Windows firewall rule requires an elevated PowerShell):

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\start.ps1 -PublicBaseUrl http://192.168.68.71:8787
powershell.exe -ExecutionPolicy Bypass -File .\scripts\install-firewall.ps1
```

The LAN MCP URL is `http://192.168.68.71:8787/mcp`. LAN HTTP is intended for a trusted private network; use the public HTTPS launcher or a named/private tunnel for Internet access.

Manual legacy pairing for non-ChatGPT clients remains available:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\pair.ps1 -BaseUrl https://YOUR-TUNNEL.trycloudflare.com -ClientName my-laptop
```

The token is written to `data\client-my-laptop.token`. Never share `data\bootstrap-token.txt` or access-token files.

## Verification

```powershell
node .\scripts\verify-oauth.mjs https://YOUR-TUNNEL.trycloudflare.com
node .\scripts\verify.mjs https://YOUR-TUNNEL.trycloudflare.com
npm run verify:hud
```

To verify real PNG image delivery and two independent MCP sessions contending for the desktop lease:

```powershell
$env:VERIFY_SCREENSHOT = '1'
$env:VERIFY_COORDINATION = '1'
node .\scripts\verify-oauth.mjs https://YOUR-TUNNEL.example.com
Remove-Item Env:VERIFY_SCREENSHOT, Env:VERIFY_COORDINATION
```

The first command exercises the same OAuth + PKCE flow used by the connector. The second checks the legacy pairing flow and MCP tool calls. `verify:hud` invokes `screen_info` and moves the cursor to its existing coordinates, allowing the real start/completion/auto-hide HUD lifecycle to be checked without clicking or typing.

If the authorization page accepts the token but ChatGPT does not finish linking, keep the same launcher session alive and retry from the current `/mcp` URL. Do not reuse a URL from an earlier Quick Tunnel session. The launcher audit file records `oauth_authorization_approved` and `oauth_token_issued` events without recording token values.

## Tunnel behavior

The Electron **Start temporary HTTPS** button and legacy launcher option 1 use Cloudflare Quick Tunnel. The generated hostname is temporary and changes when the tunnel restarts.

For a stable URL, open the Electron **Fixed domain** section. It checks cloudflared and login state, can open the Cloudflare browser login, create a uniquely named tunnel, create a DNS route for a Cloudflare-managed hostname, obtain the run token without displaying it, and encrypt it with the current Windows user's secure storage. Use a simple unique name such as `remote-mcp-admin-pc` (English letters, numbers, and hyphens). The hostname must be under a domain active in the same Cloudflare account, such as `https://mcp.example.com`; existing DNS records are never overwritten. Existing tunnel URLs and tokens can also be registered manually. The resulting `https://your-hostname/mcp` URL remains unchanged across app restarts, preserving the connector's OAuth resource identifier. Legacy launcher options 19 and 20 remain available and use Windows DPAPI storage.

Option 18 provides the current private-LAN address as `http://LAN-IP:8787/mcp`; it remains stable while DHCP keeps the same IP and is suitable for trusted devices on that LAN after running `scripts\install-firewall.ps1` as Administrator. It is not HTTPS and is not reachable by ChatGPT's cloud connector. Use a named HTTPS tunnel for remote ChatGPT access.
