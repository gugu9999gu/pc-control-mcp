param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('list', 'focus', 'launch', 'type', 'hotkey', 'click', 'move', 'drag', 'scroll', 'screenshot', 'screenshot-region', 'screenshot-window', 'screen-info', 'system-status', 'process-list', 'process-info', 'process-stop', 'service-list', 'browser-open')]
    [string]$Action,
    [string]$TitleContains,
    [string]$ProcessName,
    [Int64]$Handle,
    [string]$App,
    [string]$Text,
    [string]$KeysJson,
    [int]$X,
    [int]$Y,
    [ValidateRange(1, 16384)]
    [int]$Width,
    [ValidateRange(1, 16384)]
    [int]$Height,
    [ValidateSet('left', 'right', 'middle')]
    [string]$Button = 'left',
    [string]$OutputPath,
    [int]$ToX,
    [int]$ToY,
    [int]$DeltaX,
    [int]$DeltaY,
    [ValidateRange(1, 10)]
    [int]$Clicks = 1,
    [int]$TargetProcessId,
    [string]$NameFilter,
    [ValidateRange(1, 500)]
    [int]$Limit = 100,
    [string]$Url,
    [ValidateSet('edge', 'chrome')]
    [string]$Browser = 'edge'
)

$ErrorActionPreference = 'Stop'

if (-not ([System.Management.Automation.PSTypeName]'CodexRemoteControl.Native').Type) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace CodexRemoteControl {
    public static class Native {
        public delegate bool EnumWindowsDelegate(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT { public uint type; public InputUnion U; }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT {
            public int dx; public int dy; public uint mouseData; public uint dwFlags;
            public uint time; public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT {
            public ushort wVk; public ushort wScan; public uint dwFlags;
            public uint time; public IntPtr dwExtraInfo;
        }

        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x01000;

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsDelegate lpEnumFunc, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
        [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        public static string GetTitle(IntPtr hWnd) {
            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return string.Empty;
            var buffer = new StringBuilder(length + 1);
            GetWindowText(hWnd, buffer, buffer.Capacity);
            return buffer.ToString();
        }

        public static bool Focus(IntPtr hWnd) {
            ShowWindow(hWnd, 9);
            return SetForegroundWindow(hWnd);
        }

        public static void SendUnicodeText(string text) {
            foreach (char ch in text) {
                var inputs = new INPUT[2];
                inputs[0].type = INPUT_KEYBOARD;
                inputs[0].U.ki.wScan = ch;
                inputs[0].U.ki.dwFlags = KEYEVENTF_UNICODE;
                inputs[1].type = INPUT_KEYBOARD;
                inputs[1].U.ki.wScan = ch;
                inputs[1].U.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
            }
        }

        public static void SendVirtualKey(ushort virtualKey, bool keyUp) {
            var input = new INPUT[1];
            input[0].type = INPUT_KEYBOARD;
            input[0].U.ki.wVk = virtualKey;
            input[0].U.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
            SendInput(1, input, Marshal.SizeOf(typeof(INPUT)));
        }

        public static void Click(string button, int clicks) {
            uint down; uint up;
            switch (button) {
                case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
                case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
                default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
            }
            for (int i = 0; i < Math.Max(1, clicks); i++) {
                var inputs = new INPUT[2];
                inputs[0].type = INPUT_MOUSE; inputs[0].U.mi.dwFlags = down;
                inputs[1].type = INPUT_MOUSE; inputs[1].U.mi.dwFlags = up;
                SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
                if (clicks > 1) System.Threading.Thread.Sleep(60);
            }
        }

        public static void Drag(int fromX, int fromY, int toX, int toY, string button) {
            uint down; uint up;
            switch (button) {
                case "right": down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; break;
                case "middle": down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; break;
                default: down = MOUSEEVENTF_LEFTDOWN; up = MOUSEEVENTF_LEFTUP; break;
            }
            SetCursorPos(fromX, fromY);
            System.Threading.Thread.Sleep(50);
            var downInput = new INPUT[1];
            downInput[0].type = INPUT_MOUSE; downInput[0].U.mi.dwFlags = down;
            SendInput(1, downInput, Marshal.SizeOf(typeof(INPUT)));
            System.Threading.Thread.Sleep(80);
            SetCursorPos(toX, toY);
            System.Threading.Thread.Sleep(80);
            var upInput = new INPUT[1];
            upInput[0].type = INPUT_MOUSE; upInput[0].U.mi.dwFlags = up;
            SendInput(1, upInput, Marshal.SizeOf(typeof(INPUT)));
        }

        public static void Scroll(int vertical, int horizontal) {
            var inputs = new System.Collections.Generic.List<INPUT>();
            if (vertical != 0) {
                var input = new INPUT();
                input.type = INPUT_MOUSE;
                input.U.mi.mouseData = unchecked((uint)vertical);
                input.U.mi.dwFlags = MOUSEEVENTF_WHEEL;
                inputs.Add(input);
            }
            if (horizontal != 0) {
                var input = new INPUT();
                input.type = INPUT_MOUSE;
                input.U.mi.mouseData = unchecked((uint)horizontal);
                input.U.mi.dwFlags = MOUSEEVENTF_HWHEEL;
                inputs.Add(input);
            }
            if (inputs.Count > 0) SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        }
    }
}
'@
}

function Write-Result($Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

function Get-WindowItems {
    $items = [System.Collections.Generic.List[object]]::new()
    $callback = [CodexRemoteControl.Native+EnumWindowsDelegate] {
        param($hWnd, $lParam)
        if ([CodexRemoteControl.Native]::IsWindowVisible($hWnd)) {
            $title = [CodexRemoteControl.Native]::GetTitle($hWnd)
            if (-not [string]::IsNullOrWhiteSpace($title)) {
                [uint32]$processId = 0
                [CodexRemoteControl.Native]::GetWindowThreadProcessId($hWnd, [ref]$processId) | Out-Null
                $process = $null
                try { $process = Get-Process -Id $processId -ErrorAction Stop } catch { }
                $rect = New-Object CodexRemoteControl.Native+RECT
                $hasRect = [CodexRemoteControl.Native]::GetWindowRect($hWnd, [ref]$rect)
                $bounds = if ($hasRect) {
                    [ordered]@{ left = $rect.Left; top = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
                } else { $null }
                $items.Add([ordered]@{
                    handle = $hWnd.ToInt64()
                    title = $title
                    process_id = [int]$processId
                    process_name = if ($process) { $process.ProcessName } else { $null }
                    bounds = $bounds
                })
            }
        }
        return $true
    }
    [CodexRemoteControl.Native]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
    return $items
}

function Get-ScreenInfo {
    Add-Type -AssemblyName System.Windows.Forms
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $cursor = New-Object CodexRemoteControl.Native+POINT
    [CodexRemoteControl.Native]::GetCursorPos([ref]$cursor) | Out-Null
    return [ordered]@{
        virtual_screen = [ordered]@{ left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height }
        cursor = [ordered]@{ x = $cursor.X; y = $cursor.Y }
        primary_screen = [ordered]@{
            width = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width
            height = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height
        }
        displays = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
            [ordered]@{
                device_name = $_.DeviceName
                primary = $_.Primary
                bounds = [ordered]@{ left = $_.Bounds.Left; top = $_.Bounds.Top; width = $_.Bounds.Width; height = $_.Bounds.Height }
                working_area = [ordered]@{ left = $_.WorkingArea.Left; top = $_.WorkingArea.Top; width = $_.WorkingArea.Width; height = $_.WorkingArea.Height }
            }
        })
    }
}

function Save-ScreenshotBounds {
    param(
        [Parameter(Mandatory = $true)]$Bounds,
        [Parameter(Mandatory = $true)][string]$Path
    )
    Add-Type -AssemblyName System.Drawing
    if ($Bounds.width -le 0 -or $Bounds.height -le 0) { throw 'Screenshot bounds are invalid.' }
    $bitmap = New-Object System.Drawing.Bitmap $Bounds.width, $Bounds.height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($Bounds.left, $Bounds.top, 0, 0, $bitmap.Size)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Convert-ProcessItem {
    param([Parameter(Mandatory = $true)]$Process)
    $startTime = $null
    $path = $null
    $responding = $null
    $cpu = $null
    $workingSet = $null
    $privateMemory = $null
    $handles = $null
    $threads = $null
    try { $startTime = $Process.StartTime.ToUniversalTime().ToString('o') } catch { }
    try { $path = $Process.Path } catch { }
    try { $responding = [bool]$Process.Responding } catch { }
    try { if ($null -ne $Process.CPU) { $cpu = [math]::Round([double]$Process.CPU, 2) } } catch { }
    try { $workingSet = [math]::Round($Process.WorkingSet64 / 1MB, 1) } catch { }
    try { $privateMemory = [math]::Round($Process.PrivateMemorySize64 / 1MB, 1) } catch { }
    try { $handles = $Process.HandleCount } catch { }
    try { $threads = $Process.Threads.Count } catch { }
    [ordered]@{
        pid = [int]$Process.Id
        name = $Process.ProcessName
        responding = $responding
        cpu_seconds = $cpu
        working_set_mb = $workingSet
        private_memory_mb = $privateMemory
        handles = $handles
        threads = $threads
        start_time = $startTime
        path = $path
    }
}

function Get-ProcessItems {
    $items = @(Get-Process -ErrorAction SilentlyContinue)
    if ($NameFilter) {
        $items = @($items | Where-Object { $_.ProcessName -like "*$NameFilter*" })
    }
    return @($items | Sort-Object -Property WorkingSet64 -Descending | Select-Object -First $Limit | ForEach-Object { Convert-ProcessItem $_ })
}

function Get-SystemStatus {
    $operatingSystem = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $computerSystem = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    $processors = @(Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue)
    $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType = 3' -ErrorAction SilentlyContinue | ForEach-Object {
        [ordered]@{
            drive = $_.DeviceID
            free_gb = if ($_.FreeSpace) { [math]::Round($_.FreeSpace / 1GB, 1) } else { 0 }
            size_gb = if ($_.Size) { [math]::Round($_.Size / 1GB, 1) } else { 0 }
        }
    })
    $addresses = @(Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = True' -ErrorAction SilentlyContinue |
        ForEach-Object { @($_.IPAddress) } | Where-Object { $_ -and $_ -notmatch '^fe80:' })
    $boot = $operatingSystem.LastBootUpTime
    [ordered]@{
        hostname = $env:COMPUTERNAME
        os = $operatingSystem.Caption
        os_version = $operatingSystem.Version
        last_boot = if ($boot) { $boot.ToUniversalTime().ToString('o') } else { $null }
        uptime_seconds = if ($boot) { [math]::Round(((Get-Date).ToUniversalTime() - $boot.ToUniversalTime()).TotalSeconds) } else { $null }
        memory_total_mb = [math]::Round($computerSystem.TotalPhysicalMemory / 1MB, 1)
        memory_free_mb = [math]::Round($operatingSystem.FreePhysicalMemory / 1KB, 1)
        logical_processors = $computerSystem.NumberOfLogicalProcessors
        cpu_load_percent = if ($processors.Count -gt 0) { [math]::Round((($processors | Measure-Object -Property LoadPercentage -Average).Average), 1) } else { $null }
        process_count = @(Get-Process -ErrorAction SilentlyContinue).Count
        disks = $disks
        ip_addresses = $addresses
    }
}

function Stop-ManagedProcess {
    if ($TargetProcessId -le 4) { throw 'System processes cannot be stopped.' }
    $process = Get-Process -Id $TargetProcessId -ErrorAction Stop
    $blockedNames = @('system', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'dwm', 'fontdrvhost')
    if ($blockedNames -contains $process.ProcessName.ToLowerInvariant()) { throw 'This critical Windows process cannot be stopped.' }
    $serverPid = 0
    [int]::TryParse($env:MCP_CONTROL_SERVER_PID, [ref]$serverPid) | Out-Null
    if ($serverPid -gt 0 -and $process.Id -eq $serverPid) { throw 'The MCP server process cannot stop itself.' }
    $summary = Convert-ProcessItem $process
    Stop-Process -Id $process.Id -Force -ErrorAction Stop
    [ordered]@{ stopped = $true; process = $summary }
}

switch ($Action) {
    'list' {
        Write-Result (Get-WindowItems)
        break
    }
    'focus' {
        $matches = @()
        foreach ($window in (Get-WindowItems)) {
            $matched = $false
            if ($PSBoundParameters.ContainsKey('Handle') -and $window.handle -eq $Handle) { $matched = $true }
            if (-not $matched -and $TitleContains -and $window.title.IndexOf($TitleContains, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { $matched = $true }
            if (-not $matched -and $ProcessName -and $window.process_name -and $window.process_name.Equals($ProcessName, [System.StringComparison]::OrdinalIgnoreCase)) { $matched = $true }
            if ($matched) { $matches += $window }
        }
        if ($matches.Count -eq 0) { throw 'No matching window was found.' }
        $target = $matches[0]
        $ok = [CodexRemoteControl.Native]::Focus([IntPtr]$target.handle)
        Write-Result ([ordered]@{ focused = [bool]$ok; window = $target })
        break
    }
    'launch' {
        $apps = @{
            notepad = 'notepad.exe'
            calculator = 'calc.exe'
            explorer = 'explorer.exe'
            edge = 'msedge.exe'
            chrome = 'chrome.exe'
            paint = 'mspaint.exe'
            terminal = 'wt.exe'
        }
        if (-not $App -or -not $apps.ContainsKey($App)) { throw 'App is not on the allowlist.' }
        $process = Start-Process -FilePath $apps[$App] -PassThru -ErrorAction Stop
        Write-Result ([ordered]@{ launched = $App; process_id = $process.Id })
        break
    }
    'type' {
        if ($null -eq $Text) { throw 'Text is required.' }
        [CodexRemoteControl.Native]::SendUnicodeText($Text)
        Write-Result ([ordered]@{ sent = $true; characters = $Text.Length })
        break
    }
    'hotkey' {
        if (-not $KeysJson) { throw 'Keys are required.' }
        $keys = @($KeysJson | ConvertFrom-Json)
        $virtualKeys = @{
            CTRL = 0x11; CONTROL = 0x11; ALT = 0x12; SHIFT = 0x10
            ENTER = 0x0D; ESC = 0x1B; TAB = 0x09; SPACE = 0x20; BACKSPACE = 0x08
            DELETE = 0x2E; INSERT = 0x2D; HOME = 0x24; END = 0x23; PAGEUP = 0x21; PAGEDOWN = 0x22
            UP = 0x26; DOWN = 0x28; LEFT = 0x25; RIGHT = 0x27
            F1 = 0x70; F2 = 0x71; F3 = 0x72; F4 = 0x73; F5 = 0x74; F6 = 0x75
            F7 = 0x76; F8 = 0x77; F9 = 0x78; F10 = 0x79; F11 = 0x7A; F12 = 0x7B
        }
        $codes = @()
        foreach ($key in $keys) {
            $normalized = ([string]$key).ToUpperInvariant()
            if ($virtualKeys.ContainsKey($normalized)) { $codes += [uint16]$virtualKeys[$normalized] }
            elseif ($normalized.Length -eq 1 -and [int][char]$normalized[0] -ge 32 -and [int][char]$normalized[0] -le 126) { $codes += [uint16][char]$normalized[0] }
            else { throw "Unsupported key: $key" }
        }
        foreach ($code in $codes) { [CodexRemoteControl.Native]::SendVirtualKey($code, $false) }
        foreach ($code in ($codes | Sort-Object -Descending)) { [CodexRemoteControl.Native]::SendVirtualKey($code, $true) }
        Write-Result ([ordered]@{ sent = $true; keys = $keys })
        break
    }
    'click' {
        [CodexRemoteControl.Native]::SetCursorPos($X, $Y) | Out-Null
        [CodexRemoteControl.Native]::Click($Button, $Clicks)
        Write-Result ([ordered]@{ clicked = $true; x = $X; y = $Y; button = $Button; clicks = $Clicks })
        break
    }
    'move' {
        $moved = [CodexRemoteControl.Native]::SetCursorPos($X, $Y)
        Write-Result ([ordered]@{ moved = [bool]$moved; x = $X; y = $Y })
        break
    }
    'drag' {
        [CodexRemoteControl.Native]::Drag($X, $Y, $ToX, $ToY, $Button)
        Write-Result ([ordered]@{ dragged = $true; from = [ordered]@{ x = $X; y = $Y }; to = [ordered]@{ x = $ToX; y = $ToY }; button = $Button })
        break
    }
    'scroll' {
        [CodexRemoteControl.Native]::SetCursorPos($X, $Y) | Out-Null
        [CodexRemoteControl.Native]::Scroll($DeltaY, $DeltaX)
        Write-Result ([ordered]@{ scrolled = $true; x = $X; y = $Y; delta_x = $DeltaX; delta_y = $DeltaY })
        break
    }
    'screen-info' {
        Write-Result (Get-ScreenInfo)
        break
    }
    'system-status' {
        Write-Result (Get-SystemStatus)
        break
    }
    'process-list' {
        Write-Result (Get-ProcessItems)
        break
    }
    'process-info' {
        if ($TargetProcessId -le 0) { throw 'TargetProcessId is required.' }
        $process = Get-Process -Id $TargetProcessId -ErrorAction Stop
        $services = @(Get-CimInstance Win32_Service -Filter "ProcessId = $TargetProcessId" -ErrorAction SilentlyContinue |
            ForEach-Object { [ordered]@{ name = $_.Name; display_name = $_.DisplayName; state = $_.State; start_mode = $_.StartMode } })
        Write-Result ([ordered]@{ process = Convert-ProcessItem $process; services = $services })
        break
    }
    'process-stop' {
        Write-Result (Stop-ManagedProcess)
        break
    }
    'service-list' {
        $services = @(Get-Service -ErrorAction SilentlyContinue |
            Where-Object { -not $NameFilter -or $_.Name -like "*$NameFilter*" -or $_.DisplayName -like "*$NameFilter*" } |
            Sort-Object -Property Status, DisplayName |
            Select-Object -First $Limit |
            ForEach-Object { [ordered]@{ name = $_.Name; display_name = $_.DisplayName; status = $_.Status.ToString(); can_stop = $_.CanStop } })
        Write-Result $services
        break
    }
    'browser-open' {
        if (-not $Url) { throw 'Url is required.' }
        $uri = $null
        if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -notin @('http', 'https')) {
            throw 'Only absolute HTTP(S) URLs are allowed.'
        }
        $browsers = @{ edge = 'msedge.exe'; chrome = 'chrome.exe' }
        $process = Start-Process -FilePath $browsers[$Browser] -ArgumentList @($uri.AbsoluteUri) -PassThru -ErrorAction Stop
        Write-Result ([ordered]@{ opened = $true; browser = $Browser; process_id = $process.Id; url = $uri.AbsoluteUri })
        break
    }
    'screenshot' {
        if (-not $OutputPath) { throw 'OutputPath is required.' }
        Add-Type -AssemblyName System.Windows.Forms
        $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
        Save-ScreenshotBounds ([ordered]@{ left = $bounds.Left; top = $bounds.Top; width = $bounds.Width; height = $bounds.Height }) $OutputPath
        Write-Result ([ordered]@{ saved = $true; width = $bounds.Width; height = $bounds.Height })
        break
    }
    'screenshot-region' {
        if (-not $OutputPath) { throw 'OutputPath is required.' }
        if ($Width -le 0 -or $Height -le 0) { throw 'Width and Height are required.' }
        Add-Type -AssemblyName System.Windows.Forms
        $virtual = [System.Windows.Forms.SystemInformation]::VirtualScreen
        if ($X -lt $virtual.Left -or $Y -lt $virtual.Top -or ($X + $Width) -gt $virtual.Right -or ($Y + $Height) -gt $virtual.Bottom) {
            throw 'The screenshot region must stay inside the virtual desktop bounds.'
        }
        $bounds = [ordered]@{ left = $X; top = $Y; width = $Width; height = $Height }
        Save-ScreenshotBounds $bounds $OutputPath
        Write-Result ([ordered]@{ saved = $true; x = $X; y = $Y; width = $Width; height = $Height })
        break
    }
    'screenshot-window' {
        if (-not $OutputPath) { throw 'OutputPath is required.' }
        if ($Handle -le 0) { throw 'Handle is required.' }
        $window = @(Get-WindowItems | Where-Object { $_.handle -eq $Handle } | Select-Object -First 1)
        if ($window.Count -eq 0) { throw 'The requested visible window was not found.' }
        $bounds = $window[0].bounds
        Save-ScreenshotBounds $bounds $OutputPath
        Write-Result ([ordered]@{ saved = $true; window = $window[0]; width = $bounds.width; height = $bounds.height })
        break
    }
}
