#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";

const DEFAULT_PORT = 9333;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_COMMAND_TIMEOUT_MS = 10000;
const MIN_COMMAND_TIMEOUT_MS = 100;
const MAX_COMMAND_TIMEOUT_MS = 600000;
const FOCUS_VISIBILITY_WAIT_MS = 5000;
const FOCUS_EMULATION_VISIBILITY_WAIT_MS = 4000;
const RAF_PROBE_SETTLE_MS = 350;
const RAF_PROBE_MIN_FRAMES = 2;
const WINDOW_BOUNDS_TOLERANCE_PX = 8;
const WINDOW_RESOLUTION_RETRY_COUNT = 10;
const WINDOW_RESOLUTION_RETRY_DELAY_MS = 75;
const KEEP_ALIVE_DEFAULT_DURATION_MS = 10 * 60 * 1000;
const KEEP_ALIVE_MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const KEEP_ALIVE_STOP_POLL_MS = 250;
const KEEP_ALIVE_HEALTH_CHECK_MS = 5000;
const KEEP_ALIVE_START_GRACE_MS = 30000;
const CDP_EVENT_BUFFER_LIMIT = 4096;
const WHEEL_PROBE_DEFAULT_INTERVAL_MS = 16;
const WHEEL_PROBE_DEFAULT_SETTLE_MS = 250;
const WHEEL_PROBE_MAX_COUNT = 10000;
const BACKGROUND_SAFE_CHROME_FLAGS = Object.freeze([
  "--disable-background-timer-throttling",
  "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
  "--disable-features=CalculateNativeWinOcclusion",
]);

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function endpoint(options) {
  const host = String(options.host || DEFAULT_HOST);
  const port = Number(options.port || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${options.port}`);
  }
  return { host, port, baseUrl: `http://${host}:${port}` };
}

function commandTimeout(options) {
  const raw =
    options.timeout ??
    process.env.CODEX_CDP_TIMEOUT_MS ??
    DEFAULT_COMMAND_TIMEOUT_MS;
  return validateCommandTimeout(raw);
}

function validateCommandTimeout(raw) {
  const timeoutMs = Number(raw);
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_COMMAND_TIMEOUT_MS ||
    timeoutMs > MAX_COMMAND_TIMEOUT_MS
  ) {
    throw new Error(
      `Invalid timeout: ${raw}. Use an integer from ${MIN_COMMAND_TIMEOUT_MS} to ${MAX_COMMAND_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeoutMs;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 5000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode} from ${url}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    request.on("timeout", () =>
      request.destroy(new Error(`Timeout requesting ${url}`)),
    );
    request.on("error", reject);
  });
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    value += chunk;
  }
  return value.trim();
}

function findChrome() {
  const candidates = [
    process.env.PROGRAMFILES &&
      path.join(
        process.env.PROGRAMFILES,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    process.env["PROGRAMFILES(X86)"] &&
      path.join(
        process.env["PROGRAMFILES(X86)"],
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        "Google",
        "Chrome",
        "Application",
        "chrome.exe",
      ),
  ].filter(Boolean);
  const chrome = candidates.find((candidate) => fs.existsSync(candidate));
  if (!chrome) {
    throw new Error("Google Chrome executable was not found");
  }
  return chrome;
}

function inspectWindowsPortOwner(port) {
  if (process.platform !== "win32") {
    throw new Error(
      "Safe Chrome reuse currently requires Windows process inspection",
    );
  }
  const script = String.raw`
$ErrorActionPreference = "Stop"
$port = [int]$env:CODEX_CDP_VERIFY_PORT
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
if ($listeners.Count -eq 0) {
    [pscustomobject]@{ listenerCount = 0 } | ConvertTo-Json -Compress
    exit 0
}
if ($listeners.Count -ne 1) {
    throw "Expected one listener on port $port, found $($listeners.Count)"
}
$listener = $listeners[0]
$owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction Stop
[pscustomobject]@{
    listenerCount = 1
    localAddress = [string]$listener.LocalAddress
    processId = [int]$listener.OwningProcess
    name = [string]$owner.Name
    executablePath = [string]$owner.ExecutablePath
    commandLine = [string]$owner.CommandLine
} | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_CDP_VERIFY_PORT: String(port) },
      windowsHide: true,
    },
  );
  if (result.status === 0) {
    try {
      return JSON.parse(result.stdout.trim());
    } catch (error) {
      throw new Error(
        `Invalid listener inspection result for port ${port}: ${error.message}`,
      );
    }
  }

  const primaryError = (
    result.stderr ||
    result.stdout ||
    "unknown error"
  ).trim();
  const fallbackScript = String.raw`
$ErrorActionPreference = "Stop"
$port = [int]$env:CODEX_CDP_VERIFY_PORT
$portSuffix = [regex]::Escape(":$port") + "$"
$listeners = @(
    & netstat.exe -ano -p tcp |
        ForEach-Object {
            $parts = ($_ -replace "^\s+", "") -split "\s+"
            if ($parts.Count -ge 5 -and $parts[0] -eq "TCP" -and $parts[3] -eq "LISTENING" -and $parts[1] -match $portSuffix) {
                [pscustomobject]@{
                    localEndpoint = [string]$parts[1]
                    processId = [int]$parts[4]
                }
            }
        }
)
if ($listeners.Count -eq 0) {
    [pscustomobject]@{ listenerCount = 0 } | ConvertTo-Json -Compress
    exit 0
}
if ($listeners.Count -ne 1) {
    throw "Expected one listener on port $port, found $($listeners.Count)"
}
$listener = $listeners[0]
$process = Get-Process -Id $listener.processId -ErrorAction Stop
$executablePath = [string]$process.Path
if ([string]::IsNullOrWhiteSpace($executablePath)) {
    $executablePath = [string]$process.MainModule.FileName
}
if ([string]::IsNullOrWhiteSpace($executablePath)) {
    throw "Could not read executable path for listener process $($listener.processId)"
}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexChromeProcessInspection {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, int processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")]
    public static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr information, int informationLength, out int returnLength);
    [StructLayout(LayoutKind.Sequential)]
    public struct UnicodeString {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }
}
"@
$processHandle = [CodexChromeProcessInspection]::OpenProcess(0x1000, $false, $listener.processId)
if ($processHandle -eq [IntPtr]::Zero) {
    throw "Could not open listener process $($listener.processId): $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$commandLineBufferLength = 0
$commandLineBuffer = [IntPtr]::Zero
try {
    [void][CodexChromeProcessInspection]::NtQueryInformationProcess($processHandle, 60, [IntPtr]::Zero, 0, [ref]$commandLineBufferLength)
    if ($commandLineBufferLength -lt 8 -or $commandLineBufferLength -gt 1048576) {
        throw "Invalid command-line buffer length for listener process $($listener.processId): $commandLineBufferLength"
    }
    $commandLineBuffer = [Runtime.InteropServices.Marshal]::AllocHGlobal($commandLineBufferLength)
    $status = [CodexChromeProcessInspection]::NtQueryInformationProcess($processHandle, 60, $commandLineBuffer, $commandLineBufferLength, [ref]$commandLineBufferLength)
    if ($status -ne 0) {
        throw "Could not read command line for listener process $($listener.processId): NTSTATUS $status"
    }
    $unicodeString = [Runtime.InteropServices.Marshal]::PtrToStructure($commandLineBuffer, [type][CodexChromeProcessInspection+UnicodeString])
    $commandLine = [Runtime.InteropServices.Marshal]::PtrToStringUni($unicodeString.Buffer, [int]($unicodeString.Length / 2))
} finally {
    if ($commandLineBuffer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::FreeHGlobal($commandLineBuffer)
    }
    [CodexChromeProcessInspection]::CloseHandle($processHandle) | Out-Null
}
if ([string]::IsNullOrWhiteSpace($commandLine)) {
    throw "Could not read command line for listener process $($listener.processId)"
}
$localAddress = $listener.localEndpoint.Substring(0, $listener.localEndpoint.Length - (":$port").Length)
[pscustomobject]@{
    listenerCount = 1
    localAddress = $localAddress
    processId = [int]$listener.processId
    name = "$($process.ProcessName).exe"
    executablePath = $executablePath
    commandLine = $commandLine
} | ConvertTo-Json -Compress
`;
  const fallbackResult = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", fallbackScript],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_CDP_VERIFY_PORT: String(port) },
      windowsHide: true,
    },
  );
  if (fallbackResult.status !== 0) {
    throw new Error(
      `Unable to inspect listener on port ${port}: ${primaryError}; fallback failed: ${(fallbackResult.stderr || fallbackResult.stdout || "unknown error").trim()}`,
    );
  }
  try {
    return JSON.parse(fallbackResult.stdout.trim());
  } catch (error) {
    throw new Error(
      `Invalid fallback listener inspection result for port ${port}: ${error.message}`,
    );
  }
}

function commandLineContainsArguments(commandLine, requiredArguments) {
  const normalizedCommandLine = String(commandLine || "")
    .replaceAll('"', "")
    .toLowerCase();
  return requiredArguments.every((argument) =>
    normalizedCommandLine.includes(String(argument).toLowerCase()),
  );
}

function backgroundSchedulingState(owner) {
  const missingFlags = BACKGROUND_SAFE_CHROME_FLAGS.filter(
    (flag) => !commandLineContainsArguments(owner.commandLine, [flag]),
  );
  return {
    safe: missingFlags.length === 0,
    requiredFlags: [...BACKGROUND_SAFE_CHROME_FLAGS],
    missingFlags,
  };
}

function assertDedicatedChromeListener(
  owner,
  { port, chrome, profile, requireBackgroundSafe = false },
) {
  if (owner.listenerCount !== 1) {
    throw new Error(`No listener is available on ${DEFAULT_HOST}:${port}`);
  }
  const expectedChrome = path.resolve(chrome).toLowerCase();
  const actualChrome = path
    .resolve(String(owner.executablePath || ""))
    .toLowerCase();
  const requiredArguments = [
    `--remote-debugging-address=${DEFAULT_HOST}`,
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.resolve(profile).toLowerCase()}`,
  ];
  const valid =
    owner.localAddress === DEFAULT_HOST &&
    String(owner.name || "").toLowerCase() ===
      path.basename(chrome).toLowerCase() &&
    actualChrome === expectedChrome &&
    commandLineContainsArguments(owner.commandLine, requiredArguments);
  if (!valid) {
    throw new Error(
      `Port ${port} is occupied by a process that is not the dedicated Chrome CDP instance (PID ${owner.processId || "unknown"}, ${owner.name || "unknown"}, ${owner.localAddress || "unknown address"}). Use a different --port or close the unrelated listener; it will not be killed automatically.`,
    );
  }
  const backgroundScheduling = backgroundSchedulingState(owner);
  if (requireBackgroundSafe && !backgroundScheduling.safe) {
    throw new Error(
      `Dedicated Chrome on port ${port} was started without the required background scheduling flags: ${backgroundScheduling.missingFlags.join(", ")}. Close that dedicated instance and run start again before background performance testing.`,
    );
  }
  return {
    processId: owner.processId,
    profile: path.resolve(profile),
    backgroundScheduling,
  };
}

function normalizedChromeWindowTitle(title) {
  return String(title || "")
    .trim()
    .toLowerCase();
}

function targetChromeWindowTitle(target) {
  const title = String(target?.title || "").trim();
  return title ? `${title} - Google Chrome` : "";
}

function selectWindowsTargetWindow(windows, expectedBounds, target) {
  const eligible = windows.filter(
    (candidate) =>
      candidate.visible === true &&
      candidate.ownerHandle === 0 &&
      candidate.className === "Chrome_WidgetWin_1" &&
      Number.isFinite(candidate.left) &&
      Number.isFinite(candidate.top) &&
      Number.isFinite(candidate.width) &&
      Number.isFinite(candidate.height) &&
      candidate.width > 0 &&
      candidate.height > 0,
  );
  if (eligible.length === 0) {
    return {
      ok: false,
      reason: "interactive-desktop-unavailable",
      eligible,
    };
  }
  const expected = {
    left: Number(expectedBounds?.left),
    top: Number(expectedBounds?.top),
    width: Number(expectedBounds?.width),
    height: Number(expectedBounds?.height),
  };
  if (!Object.values(expected).every(Number.isFinite)) {
    return {
      ok: false,
      reason: "target-window-bounds-unavailable",
      eligible,
    };
  }
  const matches = eligible.filter((candidate) =>
    ["left", "top", "width", "height"].every(
      (key) =>
        Math.abs(candidate[key] - expected[key]) <= WINDOW_BOUNDS_TOLERANCE_PX,
    ),
  );
  if (matches.length === 1) {
    return {
      ok: true,
      candidate: matches[0],
      reason: "target-window-bounds",
      eligible,
    };
  }
  const expectedTitle = normalizedChromeWindowTitle(
    targetChromeWindowTitle(target),
  );
  const titledMatches = matches.filter(
    (candidate) =>
      normalizedChromeWindowTitle(candidate.title) === expectedTitle,
  );
  if (titledMatches.length === 1) {
    return {
      ok: true,
      candidate: titledMatches[0],
      reason: "target-window-bounds-and-title",
      eligible,
    };
  }
  const eligibleTitledMatches = eligible.filter(
    (candidate) =>
      normalizedChromeWindowTitle(candidate.title) === expectedTitle,
  );
  if (eligibleTitledMatches.length === 1) {
    return {
      ok: true,
      candidate: eligibleTitledMatches[0],
      reason: "target-window-unique-title-fallback",
      eligible,
      matches,
    };
  }
  return {
    ok: false,
    reason:
      matches.length > 1 || eligibleTitledMatches.length > 1
        ? "target-window-ambiguous"
        : "target-window-not-resolved",
    eligible,
    matches,
    eligibleTitledMatches,
  };
}

function inspectWindowsProcessWindows(processId) {
  if (process.platform !== "win32") {
    return { supported: false, processId, windows: [] };
  }
  const script = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$processId = [int]$env:CODEX_CDP_ACTIVATE_PROCESS_ID
[void](Get-Process -Id $processId -ErrorAction Stop)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexChromeWindowInspection {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int maxCount);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
}
"@
$windows = New-Object System.Collections.Generic.List[object]
[void][CodexChromeWindowInspection]::EnumWindows({
    param($windowHandle, $state)
    $windowProcessId = [uint32]0
    [void][CodexChromeWindowInspection]::GetWindowThreadProcessId($windowHandle, [ref]$windowProcessId)
    if ($windowProcessId -ne $processId) {
        return $true
    }
    $className = New-Object System.Text.StringBuilder 256
    [void][CodexChromeWindowInspection]::GetClassName($windowHandle, $className, $className.Capacity)
    $title = New-Object System.Text.StringBuilder 1024
    [void][CodexChromeWindowInspection]::GetWindowText($windowHandle, $title, $title.Capacity)
    $rect = New-Object CodexChromeWindowInspection+Rect
    if (-not [CodexChromeWindowInspection]::GetWindowRect($windowHandle, [ref]$rect)) {
        return $true
    }
    $windows.Add([pscustomobject]@{
        handle = [long]$windowHandle
        ownerHandle = [long][CodexChromeWindowInspection]::GetWindow($windowHandle, 4)
        visible = [bool][CodexChromeWindowInspection]::IsWindowVisible($windowHandle)
        className = $className.ToString()
        title = $title.ToString()
        left = [int]$rect.Left
        top = [int]$rect.Top
        width = [int]($rect.Right - $rect.Left)
        height = [int]($rect.Bottom - $rect.Top)
    })
    return $true
}, [IntPtr]::Zero)
[pscustomobject]@{
    supported = $true
    processId = $processId
    windows = [object[]]$windows.ToArray()
} | ConvertTo-Json -Compress -Depth 4
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: { ...process.env, CODEX_CDP_ACTIVATE_PROCESS_ID: String(processId) },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to enumerate dedicated Chrome windows for PID ${processId}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  try {
    const inspection = JSON.parse(result.stdout.trim());
    if (!Array.isArray(inspection.windows)) {
      throw new Error("window list is missing");
    }
    return inspection;
  } catch (error) {
    throw new Error(
      `Invalid Chrome window inspection result for PID ${processId}: ${error.message}`,
    );
  }
}

function activateWindowsWindowHandle(processId, windowHandle) {
  if (process.platform !== "win32") {
    return { supported: false, processId, windowHandle };
  }
  const script = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$processId = [int]$env:CODEX_CDP_ACTIVATE_PROCESS_ID
$targetWindow = [IntPtr][long]$env:CODEX_CDP_ACTIVATE_WINDOW_HANDLE
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexChromeWindowActivation {
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, [MarshalAs(UnmanagedType.Bool)] bool attach);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
if (-not [CodexChromeWindowActivation]::IsWindow($targetWindow)) {
    throw "Chrome target window $targetWindow is no longer valid"
}
$targetProcessId = [uint32]0
$targetThread = [CodexChromeWindowActivation]::GetWindowThreadProcessId($targetWindow, [ref]$targetProcessId)
if ($targetProcessId -ne $processId) {
    throw "Chrome target window $targetWindow belongs to PID $targetProcessId instead of $processId"
}
$wasMinimized = [CodexChromeWindowActivation]::IsIconic($targetWindow)
$wasMaximized = [CodexChromeWindowActivation]::IsZoomed($targetWindow)
$shown = $true
if ($wasMinimized) {
    $shown = [CodexChromeWindowActivation]::ShowWindowAsync($targetWindow, 9)
}
$foregroundWindow = [CodexChromeWindowActivation]::GetForegroundWindow()
$foregroundProcessId = [uint32]0
$foregroundThread = [CodexChromeWindowActivation]::GetWindowThreadProcessId($foregroundWindow, [ref]$foregroundProcessId)
$currentThread = [CodexChromeWindowActivation]::GetCurrentThreadId()
$attachedForeground = $false
$attachedTarget = $false
try {
    if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
        $attachedForeground = [CodexChromeWindowActivation]::AttachThreadInput($currentThread, $foregroundThread, $true)
    }
    if ($targetThread -ne 0 -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) {
        $attachedTarget = [CodexChromeWindowActivation]::AttachThreadInput($currentThread, $targetThread, $true)
    }
    $broughtToTop = [CodexChromeWindowActivation]::BringWindowToTop($targetWindow)
    $setForeground = [CodexChromeWindowActivation]::SetForegroundWindow($targetWindow)
    Start-Sleep -Milliseconds 50
    $actualForegroundWindow = [CodexChromeWindowActivation]::GetForegroundWindow()
    $actualForegroundProcessId = [uint32]0
    [void][CodexChromeWindowActivation]::GetWindowThreadProcessId($actualForegroundWindow, [ref]$actualForegroundProcessId)
    $focused = $actualForegroundWindow -eq $targetWindow
    [pscustomobject]@{
        supported = $true
        processId = $processId
        mainWindowHandle = [long]$targetWindow
        wasMinimized = [bool]$wasMinimized
        wasMaximized = [bool]$wasMaximized
        shown = [bool]$shown
        foregroundProcessIdBefore = [int]$foregroundProcessId
        foregroundProcessIdAfter = [int]$actualForegroundProcessId
        attachedForeground = [bool]$attachedForeground
        attachedTarget = [bool]$attachedTarget
        broughtToTop = [bool]$broughtToTop
        setForeground = [bool]$setForeground
        focused = [bool]$focused
    } | ConvertTo-Json -Compress
} finally {
    if ($attachedTarget) {
        [void][CodexChromeWindowActivation]::AttachThreadInput($currentThread, $targetThread, $false)
    }
    if ($attachedForeground) {
        [void][CodexChromeWindowActivation]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }
}
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CDP_ACTIVATE_PROCESS_ID: String(processId),
        CODEX_CDP_ACTIVATE_WINDOW_HANDLE: String(windowHandle),
      },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to activate dedicated Chrome window ${windowHandle} for PID ${processId}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `Invalid Chrome activation result for window ${windowHandle}: ${error.message}`,
    );
  }
}

function placeWindowsWindowHandle(processId, windowHandle, requestedBounds) {
  if (process.platform !== "win32") {
    return { supported: false, processId, windowHandle, requestedBounds };
  }
  const script = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$processId = [int]$env:CODEX_CDP_WINDOW_PROCESS_ID
$targetWindow = [IntPtr][long]$env:CODEX_CDP_WINDOW_HANDLE
$left = [int]$env:CODEX_CDP_WINDOW_LEFT
$top = [int]$env:CODEX_CDP_WINDOW_TOP
$width = [int]$env:CODEX_CDP_WINDOW_WIDTH
$height = [int]$env:CODEX_CDP_WINDOW_HEIGHT
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexChromeWindowPlacement {
    [StructLayout(LayoutKind.Sequential)] public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);
}
"@
if (-not [CodexChromeWindowPlacement]::IsWindow($targetWindow)) {
    throw "Chrome target window $targetWindow is no longer valid"
}
$targetProcessId = [uint32]0
[void][CodexChromeWindowPlacement]::GetWindowThreadProcessId($targetWindow, [ref]$targetProcessId)
if ($targetProcessId -ne $processId) {
    throw "Chrome target window $targetWindow belongs to PID $targetProcessId instead of $processId"
}
$flags = [uint32](0x0004 -bor 0x0010 -bor 0x0040)
if (-not [CodexChromeWindowPlacement]::SetWindowPos($targetWindow, [IntPtr]::Zero, $left, $top, $width, $height, $flags)) {
    throw "SetWindowPos failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}
$rect = New-Object CodexChromeWindowPlacement+Rect
if (-not [CodexChromeWindowPlacement]::GetWindowRect($targetWindow, [ref]$rect)) {
    throw "GetWindowRect failed after SetWindowPos"
}
[pscustomobject]@{
    supported = $true
    processId = $processId
    windowHandle = [long]$targetWindow
    flags = [int]$flags
    foregroundActivationRequested = $false
    bounds = [pscustomobject]@{
        left = [int]$rect.Left
        top = [int]$rect.Top
        width = [int]($rect.Right - $rect.Left)
        height = [int]($rect.Bottom - $rect.Top)
    }
} | ConvertTo-Json -Compress
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CODEX_CDP_WINDOW_PROCESS_ID: String(processId),
        CODEX_CDP_WINDOW_HANDLE: String(windowHandle),
        CODEX_CDP_WINDOW_LEFT: String(requestedBounds.left),
        CODEX_CDP_WINDOW_TOP: String(requestedBounds.top),
        CODEX_CDP_WINDOW_WIDTH: String(requestedBounds.width),
        CODEX_CDP_WINDOW_HEIGHT: String(requestedBounds.height),
      },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Unable to place dedicated Chrome window ${windowHandle} for PID ${processId}: ${(result.stderr || result.stdout || "unknown error").trim()}`,
    );
  }
  try {
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error(
      `Invalid Chrome placement result for window ${windowHandle}: ${error.message}`,
    );
  }
}

async function placeWindowsTargetWindow(target, port, timeoutMs, requestedBounds) {
  const browserWindow = await restoreBrowserTargetWindow(
    target,
    port,
    timeoutMs,
    { forceNormal: true },
  );
  const owner = inspectWindowsPortOwner(port);
  if (
    owner.listenerCount !== 1 ||
    owner.localAddress !== DEFAULT_HOST ||
    String(owner.name || "").toLowerCase() !== "chrome.exe"
  ) {
    throw new Error(
      `Cannot safely place the CDP target because port ${port} is not owned by one loopback chrome.exe process.`,
    );
  }
  const inspection = inspectWindowsProcessWindows(owner.processId);
  const resolution = selectWindowsTargetWindow(
    inspection.windows,
    browserWindow.bounds,
    target,
  );
  if (!resolution.ok) {
    throw new Error(
      `${resolution.reason}: no unique Chrome UI window could be resolved for exact target ${target.id}.`,
    );
  }
  const version = await getJson(`http://${DEFAULT_HOST}:${port}/json/version`);
  await sendCdp(
    version.webSocketDebuggerUrl,
    "Browser.setWindowBounds",
    {
      windowId: browserWindow.windowId,
      bounds: requestedBounds,
    },
    timeoutMs,
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  const browserPlacementReadback = await sendCdp(
    version.webSocketDebuggerUrl,
    "Browser.getWindowBounds",
    { windowId: browserWindow.windowId },
    timeoutMs,
  );
  const nativePlacement = placeWindowsWindowHandle(
    owner.processId,
    resolution.candidate.handle,
    requestedBounds,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  const nativeReadback = inspectWindowsProcessWindows(owner.processId).windows.find(
    (candidate) => candidate.handle === resolution.candidate.handle,
  );
  if (!nativeReadback) {
    throw new Error(
      `Placed Chrome UI window ${resolution.candidate.handle} disappeared before readback.`,
    );
  }
  const cdpReadback = await sendCdp(
    version.webSocketDebuggerUrl,
    "Browser.getWindowForTarget",
    { targetId: target.id },
    timeoutMs,
  );
  const pageReadback = await evaluate(
    target.webSocketDebuggerUrl,
    `({ screenX, screenY, outerWidth, outerHeight, innerWidth, innerHeight })`,
    timeoutMs,
  );
  const invalidReasons = [];
  for (const field of ["left", "top", "width", "height"]) {
    if (
      Math.abs(nativeReadback[field] - requestedBounds[field]) >
      WINDOW_BOUNDS_TOLERANCE_PX
    ) {
      invalidReasons.push(
        `native-${field}:expected=${requestedBounds[field]}:actual=${nativeReadback[field]}`,
      );
    }
    if (
      Math.abs(cdpReadback.bounds?.[field] - requestedBounds[field]) >
      WINDOW_BOUNDS_TOLERANCE_PX
    ) {
      invalidReasons.push(
        `cdp-${field}:expected=${requestedBounds[field]}:actual=${cdpReadback.bounds?.[field]}`,
      );
    }
  }
  if (
    Math.abs(pageReadback.screenX - requestedBounds.left) >
    WINDOW_BOUNDS_TOLERANCE_PX
  ) {
    invalidReasons.push(
      `page-screenX:expected=${requestedBounds.left}:actual=${pageReadback.screenX}`,
    );
  }
  if (
    Math.abs(pageReadback.screenY - requestedBounds.top) >
    WINDOW_BOUNDS_TOLERANCE_PX
  ) {
    invalidReasons.push(
      `page-screenY:expected=${requestedBounds.top}:actual=${pageReadback.screenY}`,
    );
  }
  if (invalidReasons.length > 0) {
    throw new Error(
      `Native window placement readback failed for exact target ${target.id}: ${invalidReasons.join(" ")}`,
    );
  }
  return {
    target: { id: target.id, title: target.title, url: target.url },
    requestedBounds,
    resolution: {
      method: resolution.reason,
      candidate: resolution.candidate,
    },
    browserPlacement: {
      windowId: browserWindow.windowId,
      requestedBounds,
      readbackBeforeNativePlacement: browserPlacementReadback.bounds,
    },
    nativePlacement,
    readback: {
      native: nativeReadback,
      cdp: cdpReadback.bounds,
      page: pageReadback,
    },
    valid: true,
    invalidReasons: [],
  };
}

async function activateWindowsTargetWindow(processId, browserWindow, target) {
  if (process.platform !== "win32") {
    return { supported: false, processId };
  }
  let lastResolution = null;
  let lastActivation = null;
  let lastError = null;
  for (
    let attempt = 1;
    attempt <= WINDOW_RESOLUTION_RETRY_COUNT;
    attempt += 1
  ) {
    try {
      const inspection = inspectWindowsProcessWindows(processId);
      const resolution = selectWindowsTargetWindow(
        inspection.windows,
        browserWindow.bounds,
        target,
      );
      lastResolution = resolution;
      if (resolution.ok) {
        const activation = activateWindowsWindowHandle(
          processId,
          resolution.candidate.handle,
        );
        lastActivation = {
          ...activation,
          resolution: {
            method: resolution.reason,
            attempt,
            expectedBounds: browserWindow.bounds,
            resolvedWindow: resolution.candidate,
          },
        };
        if (lastActivation.focused === true) {
          return lastActivation;
        }
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt < WINDOW_RESOLUTION_RETRY_COUNT) {
      await new Promise((resolve) =>
        setTimeout(resolve, WINDOW_RESOLUTION_RETRY_DELAY_MS),
      );
    }
  }
  if (lastActivation !== null) {
    return lastActivation;
  }
  const candidates = (lastResolution?.eligible || []).map((candidate) => ({
    handle: candidate.handle,
    title: candidate.title,
    left: candidate.left,
    top: candidate.top,
    width: candidate.width,
    height: candidate.height,
  }));
  throw new Error(
    `${lastResolution?.reason || "target-window-not-resolved"}: no Chrome UI window matched target ${target.id} at ${JSON.stringify(browserWindow.bounds)}; candidates=${JSON.stringify(candidates)}; lastError=${lastError?.message || "none"}`,
  );
}

async function readPageActivationState(webSocketUrl, timeoutMs) {
  return evaluate(
    webSocketUrl,
    `({
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
    })`,
    timeoutMs,
  );
}

async function activateBrowserTarget(target, port, timeoutMs) {
  const version = await getJson(`http://${DEFAULT_HOST}:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) {
    throw new Error(
      `Chrome on port ${port} did not expose a browser WebSocket URL`,
    );
  }
  await sendCdp(
    version.webSocketDebuggerUrl,
    "Target.activateTarget",
    { targetId: target.id },
    timeoutMs,
  );
}

async function restoreBrowserTargetWindow(
  target,
  port,
  timeoutMs,
  { forceNormal = false } = {},
) {
  const version = await getJson(`http://${DEFAULT_HOST}:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) {
    throw new Error(
      `Chrome on port ${port} did not expose a browser WebSocket URL`,
    );
  }
  const { windowId, bounds } = await sendCdp(
    version.webSocketDebuggerUrl,
    "Browser.getWindowForTarget",
    { targetId: target.id },
    timeoutMs,
  );
  let restoredBounds = bounds;
  if (
    bounds?.windowState === "minimized" ||
    (forceNormal && bounds?.windowState !== "normal")
  ) {
    await sendCdp(
      version.webSocketDebuggerUrl,
      "Browser.setWindowBounds",
      { windowId, bounds: { windowState: "normal" } },
      timeoutMs,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const restored = await sendCdp(
      version.webSocketDebuggerUrl,
      "Browser.getWindowBounds",
      { windowId },
      timeoutMs,
    );
    restoredBounds = restored.bounds;
  }
  return {
    windowId,
    previousState: bounds?.windowState || null,
    bounds: restoredBounds,
  };
}

async function applyNewWindowBounds(
  target,
  baseUrl,
  requestedBounds,
  timeoutMs,
) {
  const hasGeometry = [
    requestedBounds.left,
    requestedBounds.top,
    requestedBounds.width,
    requestedBounds.height,
  ].some((value) => value !== undefined);
  const browserUrl = await browserWebSocketUrl(baseUrl);
  const window = await sendCdp(
    browserUrl,
    "Browser.getWindowForTarget",
    { targetId: target.id },
    timeoutMs,
  );
  const geometry = Object.fromEntries(
    Object.entries({
      left: requestedBounds.left,
      top: requestedBounds.top,
      width: requestedBounds.width,
      height: requestedBounds.height,
    }).filter(([, value]) => value !== undefined),
  );

  // Chromium can ignore Target.createTarget geometry for a maximized window.
  if (hasGeometry || requestedBounds.windowState === "normal") {
    await sendCdp(
      browserUrl,
      "Browser.setWindowBounds",
      { windowId: window.windowId, bounds: { windowState: "normal" } },
      timeoutMs,
    );
  }
  if (hasGeometry) {
    await sendCdp(
      browserUrl,
      "Browser.setWindowBounds",
      { windowId: window.windowId, bounds: geometry },
      timeoutMs,
    );
  }
  if (
    requestedBounds.windowState !== undefined &&
    requestedBounds.windowState !== "normal"
  ) {
    await sendCdp(
      browserUrl,
      "Browser.setWindowBounds",
      {
        windowId: window.windowId,
        bounds: { windowState: requestedBounds.windowState },
      },
      timeoutMs,
    );
  }

  const applied = await sendCdp(
    browserUrl,
    "Browser.getWindowBounds",
    { windowId: window.windowId },
    timeoutMs,
  );
  return { windowId: window.windowId, bounds: applied.bounds };
}

function requestedOuterWindowBounds({ left, top, width, height, windowState }) {
  return {
    left: left ?? null,
    top: top ?? null,
    width: width ?? null,
    height: height ?? null,
    windowState: windowState ?? null,
  };
}

async function waitForVisiblePage(webSocketUrl, timeoutMs, maxWaitMs) {
  const deadline = Date.now() + Math.min(timeoutMs, maxWaitMs);
  let page;
  do {
    page = await readPageActivationState(
      webSocketUrl,
      Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(timeoutMs, maxWaitMs)),
    );
    if (page.visibilityState === "visible") {
      return page;
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  return page;
}

async function probeAnimationFrames(webSocketUrl, timeoutMs) {
  const result = await evaluate(
    webSocketUrl,
    `(() => new Promise((resolve) => {
        const startedAt = performance.now();
        let frames = 0;
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve({
                frames,
                elapsedMs: performance.now() - startedAt,
            });
        };
        const tick = () => {
            if (settled) return;
            frames += 1;
            if (frames >= ${RAF_PROBE_MIN_FRAMES}) {
                finish();
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        setTimeout(finish, ${RAF_PROBE_SETTLE_MS});
    }))()`,
    Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(timeoutMs, 2500)),
  );
  return {
    ...result,
    minimumFrames: RAF_PROBE_MIN_FRAMES,
    live: result.frames >= RAF_PROBE_MIN_FRAMES,
  };
}

async function activateTarget(
  target,
  port,
  timeoutMs,
  {
    allowFocusEmulation = true,
    allowWindowFocus = false,
    bringPageToFront = true,
  } = {},
) {
  const browserWindow = await restoreBrowserTargetWindow(
    target,
    port,
    timeoutMs,
  );
  await activateBrowserTarget(target, port, timeoutMs);
  let focusEmulationReset = { ok: true };
  try {
    await sendRawCdp(
      target.webSocketDebuggerUrl,
      "Emulation.setFocusEmulationEnabled",
      {
        enabled: false,
      },
      Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(timeoutMs, 2500)),
    );
  } catch (error) {
    focusEmulationReset = { ok: false, error: error.message };
  }
  const owner = inspectWindowsPortOwner(port);
  if (
    owner.listenerCount !== 1 ||
    owner.localAddress !== DEFAULT_HOST ||
    String(owner.name || "").toLowerCase() !== "chrome.exe"
  ) {
    throw new Error(
      `Cannot safely activate the CDP target because port ${port} is not owned by one loopback chrome.exe process.`,
    );
  }
  let window = {
    supported: process.platform === "win32",
    processId: owner.processId,
    focused: false,
    method: "Target.activateTarget-only",
  };
  if (allowWindowFocus) {
    try {
      window = await activateWindowsTargetWindow(
        owner.processId,
        browserWindow,
        target,
      );
    } catch (error) {
      window = {
        supported: process.platform === "win32",
        processId: owner.processId,
        focused: false,
        error: error.message,
      };
    }
  }
  await activateBrowserTarget(target, port, timeoutMs);
  if (allowWindowFocus && bringPageToFront) {
    await sendRawCdp(
      target.webSocketDebuggerUrl,
      "Page.bringToFront",
      {},
      timeoutMs,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 100));

  let page = await waitForVisiblePage(
    target.webSocketDebuggerUrl,
    timeoutMs,
    FOCUS_VISIBILITY_WAIT_MS,
  );
  let animationFrames =
    page.visibilityState === "visible"
      ? await probeAnimationFrames(target.webSocketDebuggerUrl, timeoutMs)
      : {
          frames: 0,
          elapsedMs: 0,
          minimumFrames: RAF_PROBE_MIN_FRAMES,
          live: false,
        };
  const fallbackReasons = [];
  if (allowWindowFocus && window.focused !== true)
    fallbackReasons.push("window-not-foreground");
  if (page.visibilityState !== "visible")
    fallbackReasons.push("page-not-visible");
  if (!animationFrames.live)
    fallbackReasons.push("request-animation-frame-not-live");

  let focusEmulation = false;
  if (fallbackReasons.length > 0 && allowFocusEmulation) {
    await sendRawCdp(
      target.webSocketDebuggerUrl,
      "Emulation.setFocusEmulationEnabled",
      {
        enabled: true,
      },
      timeoutMs,
    );
    focusEmulation = true;
    await activateBrowserTarget(target, port, timeoutMs);
    if (allowWindowFocus && bringPageToFront) {
      await sendRawCdp(
        target.webSocketDebuggerUrl,
        "Page.bringToFront",
        {},
        timeoutMs,
      );
    }
    page = await waitForVisiblePage(
      target.webSocketDebuggerUrl,
      timeoutMs,
      FOCUS_EMULATION_VISIBILITY_WAIT_MS,
    );
    animationFrames =
      page.visibilityState === "visible"
        ? await probeAnimationFrames(target.webSocketDebuggerUrl, timeoutMs)
        : {
            frames: 0,
            elapsedMs: 0,
            minimumFrames: RAF_PROBE_MIN_FRAMES,
            live: false,
          };
  }

  const assertions = {
    foregroundOrEmulated:
      !allowWindowFocus || window.focused === true || focusEmulation,
    visible: page.visibilityState === "visible",
    requestAnimationFrameLive: animationFrames.live,
  };
  if (!Object.values(assertions).every(Boolean)) {
    if (focusEmulation) {
      try {
        await sendRawCdp(
          target.webSocketDebuggerUrl,
          "Emulation.setFocusEmulationEnabled",
          {
            enabled: false,
          },
          timeoutMs,
        );
      } catch {}
    }
    throw new Error(
      `Unable to activate target ${target.id}: ${JSON.stringify({
        allowFocusEmulation,
        fallbackReasons,
        window,
        page,
        animationFrames,
        assertions,
      })}`,
    );
  }

  return {
    window,
    browserWindow,
    targetId: target.id,
    browserTargetActivated: true,
    focusEmulationReset,
    focusEmulation,
    focusEmulationAllowed: allowFocusEmulation,
    windowFocusAllowed: allowWindowFocus,
    fallbackReasons,
    page,
    animationFrames,
    assertions,
  };
}

async function waitForEndpoint(
  baseUrl,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await getJson(`${baseUrl}/json/version`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error(
    `CDP endpoint did not become ready: ${lastError?.message || "unknown error"}`,
  );
}

async function listTargets(baseUrl) {
  const targets = await getJson(`${baseUrl}/json/list`);
  return targets.filter((target) => target.type === "page");
}

async function browserWebSocketUrl(baseUrl) {
  const version = await getJson(`${baseUrl}/json/version`);
  if (!version.webSocketDebuggerUrl) {
    throw new Error("Chrome did not expose a browser WebSocket URL");
  }
  return version.webSocketDebuggerUrl;
}

async function waitForTarget(baseUrl, targetId, timeoutMs, shouldExist) {
  const deadline = Date.now() + timeoutMs;
  let target = null;
  while (Date.now() < deadline) {
    const targets = await listTargets(baseUrl);
    target = targets.find((candidate) => candidate.id === targetId) ?? null;
    if (Boolean(target) === shouldExist) {
      return target;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Target ${targetId} did not ${shouldExist ? "appear" : "close"} within ${timeoutMs}ms.`,
  );
}

function selectTarget(targets, selector, exact = false) {
  if (targets.length === 0) {
    throw new Error("No page targets are available");
  }
  if (!selector || selector === "-") {
    if (targets.length !== 1) {
      throw new Error(
        `Multiple page targets are available; pass --target or --target-exact. Candidates: ${targets.map((target) => `${target.title} | ${target.url}`).join(" ; ")}`,
      );
    }
    return targets[0];
  }
  const needle = selector.toLowerCase();
  const matches = targets.filter((target) => {
    if (exact) {
      return [target.id, target.title, target.url].some(
        (value) => String(value).toLowerCase() === needle,
      );
    }
    return `${target.id} ${target.title} ${target.url}`
      .toLowerCase()
      .includes(needle);
  });
  if (matches.length !== 1) {
    throw new Error(
      `Target selector matched ${matches.length} pages: ${selector}${exact ? " (exact)" : ""}`,
    );
  }
  return matches[0];
}

function sendCdp(
  webSocketUrl,
  method,
  params,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
) {
  const targetId = pageTargetIdFromWebSocketUrl(webSocketUrl);
  if (targetId) {
    const bridge = keepAliveBridgeForTarget(targetId);
    if (bridge) {
      return sendKeepAliveBridgeCommand(
        bridge,
        targetId,
        method,
        params,
        timeoutMs,
      );
    }
  }
  return sendRawCdp(webSocketUrl, method, params, timeoutMs);
}

function sendRawCdp(
  webSocketUrl,
  method,
  params,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const id = 1;
    const timer = setTimeout(() => {
      socket.close();
      const continuationWarning =
        method === "Runtime.evaluate"
          ? " The evaluation may still be running in the page; verify responsiveness with a small eval before retrying."
          : "";
      reject(
        new Error(
          `CDP command timed out after ${timeoutMs}ms: ${method}. Re-run with --timeout <milliseconds> for a known long command.${continuationWarning}`,
        ),
      );
    }, timeoutMs);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      if (message.error) {
        reject(
          new Error(`CDP ${message.error.code}: ${message.error.message}`),
        );
        return;
      }
      resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`WebSocket connection failed: ${webSocketUrl}`));
    });
  });
}

function createCdpEventBuffer() {
  let nextSequence = 1;
  const events = [];
  const waiters = new Set();

  const snapshot = (afterSequence, method, limit) => {
    const matched = [];
    for (const entry of events) {
      if (entry.sequence <= afterSequence) continue;
      if (method && entry.event.method !== method) continue;
      matched.push(entry);
      if (matched.length >= limit) break;
    }
    return {
      events: matched,
      nextSequence:
        matched.length > 0
          ? matched[matched.length - 1].sequence
          : Math.max(afterSequence, nextSequence - 1),
    };
  };

  const flushWaiters = () => {
    for (const waiter of [...waiters]) {
      const result = snapshot(
        waiter.afterSequence,
        waiter.method,
        waiter.limit,
      );
      if (result.events.length === 0) continue;
      clearTimeout(waiter.timer);
      waiters.delete(waiter);
      waiter.resolve(result);
    }
  };

  return {
    push(event) {
      events.push({
        sequence: nextSequence,
        receivedAt: Date.now(),
        event,
      });
      nextSequence += 1;
      if (events.length > CDP_EVENT_BUFFER_LIMIT) {
        events.splice(0, events.length - CDP_EVENT_BUFFER_LIMIT);
      }
      flushWaiters();
    },
    wait(afterSequence, method, timeoutMs, limit = 32) {
      const immediate = snapshot(afterSequence, method, limit);
      if (immediate.events.length > 0 || timeoutMs <= 0) {
        return Promise.resolve(immediate);
      }
      return new Promise((resolve) => {
        const waiter = {
          afterSequence,
          method,
          limit,
          resolve,
          timer: undefined,
        };
        waiter.timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve(snapshot(afterSequence, method, limit));
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    close() {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(
          snapshot(waiter.afterSequence, waiter.method, waiter.limit),
        );
      }
      waiters.clear();
    },
  };
}

function openCdpSession(
  webSocketUrl,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
  onEvent,
) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 1;
    let settled = false;
    const openTimer = setTimeout(() => {
      socket.close();
      reject(
        new Error(
          `CDP WebSocket session timed out after ${timeoutMs}ms: ${webSocketUrl}`,
        ),
      );
    }, timeoutMs);

    const failPending = (error) => {
      for (const request of pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      pending.clear();
    };

    socket.addEventListener("open", () => {
      clearTimeout(openTimer);
      settled = true;
      resolve({
        async send(method, params = {}, commandTimeoutMs = timeoutMs) {
          const effectiveTimeoutMs = validateCommandTimeout(commandTimeoutMs);
          const id = nextId;
          nextId += 1;
          return new Promise((resolveCommand, rejectCommand) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectCommand(
                new Error(
                  `CDP session command timed out after ${effectiveTimeoutMs}ms: ${method}`,
                ),
              );
            }, effectiveTimeoutMs);
            pending.set(id, {
              resolve: resolveCommand,
              reject: rejectCommand,
              timer,
              method,
            });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined && typeof message.method === "string") {
        onEvent?.(message);
        return;
      }
      const request = pending.get(message.id);
      if (!request) {
        return;
      }
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(
          new Error(`CDP ${message.error.code}: ${message.error.message}`),
        );
        return;
      }
      request.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      clearTimeout(openTimer);
      const error = new Error(`WebSocket session failed: ${webSocketUrl}`);
      if (!settled) {
        settled = true;
        reject(error);
      }
      failPending(error);
    });
    socket.addEventListener("close", () => {
      clearTimeout(openTimer);
      const error = new Error(
        `CDP WebSocket session closed before all commands completed: ${webSocketUrl}`,
      );
      if (!settled) {
        settled = true;
        reject(error);
      }
      failPending(error);
    });
  });
}

async function withCdpSession(webSocketUrl, timeoutMs, callback) {
  const targetId = pageTargetIdFromWebSocketUrl(webSocketUrl);
  if (targetId) {
    const bridge = keepAliveBridgeForTarget(targetId);
    if (bridge) {
      return callback({
        send(method, params = {}) {
          return sendKeepAliveBridgeCommand(
            bridge,
            targetId,
            method,
            params,
            timeoutMs,
          );
        },
        close() {},
      });
    }
  }
  const session = await openCdpSession(webSocketUrl, timeoutMs);
  try {
    return await callback(session);
  } finally {
    session.close();
  }
}

async function evaluate(webSocketUrl, expression, timeoutMs) {
  const result = await sendCdp(
    webSocketUrl,
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed",
    );
  }
  return result.result?.value;
}

async function evaluateInSession(session, expression) {
  const result = await session.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Runtime.evaluate failed",
    );
  }
  return result.result?.value;
}

function readSourceOption(options, inlineName, fileName, required = false) {
  const inlineSource = options[inlineName];
  const sourceFile = options[fileName];
  if (inlineSource !== undefined && sourceFile !== undefined) {
    throw new Error(`Use either --${inlineName} or --${fileName}, not both`);
  }
  let source = "";
  if (sourceFile !== undefined) {
    const resolvedFile = path.resolve(String(sourceFile));
    source = fs.readFileSync(resolvedFile, "utf8");
  } else if (typeof inlineSource === "string") {
    source = inlineSource;
  }
  if (required && !source.trim()) {
    throw new Error(`Provide --${inlineName} or --${fileName}`);
  }
  return source;
}

async function waitForSessionCondition(
  session,
  expression,
  timeoutMs,
  pollIntervalMs,
) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let attempts = 0;
  let lastValue;
  let lastError;
  while (Date.now() < deadline) {
    attempts += 1;
    try {
      lastValue = await evaluateInSession(session, expression);
      lastError = undefined;
      if (lastValue) {
        return {
          matched: true,
          attempts,
          elapsedMs: Date.now() - startedAt,
          value: lastValue,
        };
      }
    } catch (error) {
      lastError = error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, remainingMs)),
      );
    }
  }
  const detail = lastError?.message || JSON.stringify(lastValue);
  throw new Error(
    `Lifecycle wait condition timed out after ${timeoutMs}ms (${attempts} attempts): ${detail}`,
  );
}

async function runPageLifecycle(webSocketUrl, options, timeoutMs) {
  const preloadSource = readSourceOption(
    options,
    "preload-source",
    "preload-file",
    true,
  );
  const resultExpression = readSourceOption(
    options,
    "eval-source",
    "eval-file",
  );
  const waitExpression = readSourceOption(
    options,
    "wait-expression",
    "wait-file",
  );
  const shouldReload = Boolean(options.reload);
  const navigationUrl =
    typeof options.url === "string" ? String(options.url) : "";
  if (shouldReload === Boolean(navigationUrl)) {
    throw new Error("Lifecycle requires exactly one of --reload or --url");
  }
  if (
    navigationUrl &&
    !/^https?:\/\//i.test(navigationUrl) &&
    !/^file:/i.test(navigationUrl) &&
    !/^about:/i.test(navigationUrl)
  ) {
    throw new Error("Provide an absolute --url");
  }
  const pollIntervalMs = integerOption(options, "poll-interval", 100, 10, 5000);

  return withCdpSession(webSocketUrl, timeoutMs, async (session) => {
    await session.send("Page.enable");
    const preload = await session.send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: preloadSource },
    );
    let output;
    let failure;
    let cleanup;
    try {
      const navigation = shouldReload
        ? await session.send("Page.reload", {
            ignoreCache: Boolean(options["ignore-cache"]),
          })
        : await session.send("Page.navigate", { url: navigationUrl });
      const wait = await waitForSessionCondition(
        session,
        waitExpression || 'document.readyState === "complete"',
        timeoutMs,
        pollIntervalMs,
      );
      const result = resultExpression
        ? await evaluateInSession(session, resultExpression)
        : undefined;
      output = {
        preloadIdentifier: preload.identifier,
        action: shouldReload ? "reload" : "navigate",
        requestedUrl: navigationUrl || null,
        ignoreCache: shouldReload
          ? Boolean(options["ignore-cache"])
          : undefined,
        navigation,
        wait,
        result,
      };
    } catch (error) {
      failure = error;
    }
    try {
      await session.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: preload.identifier,
      });
      cleanup = { removedPreload: true };
    } catch (error) {
      cleanup = { removedPreload: false, error: error.message };
    }
    if (failure) {
      if (!cleanup.removedPreload) {
        failure.message += `; preload cleanup also failed: ${cleanup.error}`;
      }
      throw failure;
    }
    if (!cleanup.removedPreload) {
      throw new Error(`Unable to remove lifecycle preload: ${cleanup.error}`);
    }
    return { ...output, cleanup };
  });
}

function exactTargetIdsOption(options, commandName = "This command") {
  const raw = options["target-ids"];
  if (typeof raw !== "string") {
    throw new Error(
      `${commandName} requires --target-ids <target ID,target ID,...>.`,
    );
  }
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("Provide at least one target ID in --target-ids.");
  }
  if (new Set(ids.map(normalize)).size !== ids.length) {
    throw new Error("--target-ids must not contain duplicate target IDs.");
  }
  return ids;
}

function selectTargetsByExactIds(targets, ids) {
  const targetsById = new Map(
    targets.map((target) => [normalize(target.id), target]),
  );
  const missing = ids.filter((id) => !targetsById.has(normalize(id)));
  if (missing.length > 0) {
    throw new Error(
      `Unknown target IDs: ${missing.join(", ")}. Run list and use exact IDs.`,
    );
  }
  return ids.map((id) => targetsById.get(normalize(id)));
}

function parallelAnimationProbeExpression(durationMs) {
  return `(() => new Promise((resolve) => {
    const startedAt = performance.now();
    let frames = 0;
    let stopped = false;
    let frameHandle = 0;
    const tick = () => {
      if (stopped) return;
      frames += 1;
      frameHandle = requestAnimationFrame(tick);
    };
    frameHandle = requestAnimationFrame(tick);
    setTimeout(() => {
      stopped = true;
      cancelAnimationFrame(frameHandle);
      resolve({
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        frames,
        elapsedMs: performance.now() - startedAt,
      });
    }, ${durationMs});
  }))()`;
}

async function runParallelProbe(targets, durationMs, timeoutMs) {
  const attachments = [];
  try {
    for (const target of targets) {
      attachments.push({
        target,
        session: await openCdpSession(target.webSocketDebuggerUrl, timeoutMs),
      });
    }
    await Promise.all(
      attachments.map(({ session }) => session.send("Page.enable")),
    );
    const focusEmulation = await Promise.all(
      attachments.map(async ({ session }) => {
        try {
          await session.send("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });
          return { enabled: true };
        } catch (error) {
          return { enabled: false, error: error.message };
        }
      }),
    );
    const expression = parallelAnimationProbeExpression(durationMs);
    const values = await Promise.all(
      attachments.map(({ session }) => evaluateInSession(session, expression)),
    );
    return attachments.map(({ target }, index) => ({
      target: { id: target.id, title: target.title, url: target.url },
      focusEmulation: focusEmulation[index],
      probe: values[index],
    }));
  } finally {
    for (const { session } of attachments) {
      session.close();
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function keepAliveDirectory() {
  const temporaryDirectory =
    process.env.TEMP || process.env.TMP || process.cwd();
  return path.join(temporaryDirectory, "chrome-direct-cdp-keepalive");
}

function keepAliveLeasePath(leaseId) {
  return path.join(keepAliveDirectory(), `${leaseId}.json`);
}

function keepAliveStopPath(leaseId) {
  return path.join(keepAliveDirectory(), `${leaseId}.stop`);
}

function keepAliveLockPath(targetId) {
  const fileName = Buffer.from(targetId).toString("base64url");
  return path.join(keepAliveDirectory(), "locks", `${fileName}.json`);
}

function keepAliveLeaseIdOption(options) {
  const leaseId = options.lease;
  if (
    typeof leaseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      leaseId,
    )
  ) {
    throw new Error("Provide a lease ID returned by keep-alive.");
  }
  return leaseId;
}

function readJsonFile(filePath, description) {
  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    const value = JSON.parse(source);
    if (value == null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be a JSON object");
    }
    return value;
  } catch (error) {
    throw new Error(`Unable to read ${description}: ${error.message}`);
  }
}

function readKeepAliveLease(leaseId) {
  const lease = readJsonFile(keepAliveLeasePath(leaseId), `lease ${leaseId}`);
  if (!lease) {
    throw new Error(`Keep-alive lease ${leaseId} was not found.`);
  }
  if (lease.id !== leaseId) {
    throw new Error(`Keep-alive lease ${leaseId} has invalid metadata.`);
  }
  return lease;
}

function maybeReadKeepAliveLease(leaseId) {
  const lease = readJsonFile(keepAliveLeasePath(leaseId), `lease ${leaseId}`);
  if (!lease) {
    return undefined;
  }
  if (lease.id !== leaseId) {
    throw new Error(`Keep-alive lease ${leaseId} has invalid metadata.`);
  }
  return lease;
}

function writeKeepAliveLease(lease) {
  fs.mkdirSync(keepAliveDirectory(), { recursive: true });
  const nextLease = {
    ...lease,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    keepAliveLeasePath(nextLease.id),
    `${JSON.stringify(nextLease, null, 2)}\n`,
    "utf8",
  );
  return nextLease;
}

function updateKeepAliveLease(leaseId, patch) {
  return writeKeepAliveLease({
    ...readKeepAliveLease(leaseId),
    ...patch,
  });
}

function isKeepAliveTerminalState(state) {
  return ["stopped", "expired", "failed"].includes(state);
}

function isProcessAlive(processId) {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function keepAliveWorkerIsAlive(lease) {
  return isProcessAlive(lease.workerPid);
}

function keepAliveLeaseIsStale(lease) {
  if (isKeepAliveTerminalState(lease.state)) {
    return true;
  }
  if (keepAliveWorkerIsAlive(lease)) {
    return false;
  }
  const createdAt = Date.parse(lease.createdAt);
  return (
    Number.isNaN(createdAt) ||
    Date.now() - createdAt > KEEP_ALIVE_START_GRACE_MS
  );
}

function readKeepAliveTargetLock(targetId) {
  return readJsonFile(
    keepAliveLockPath(targetId),
    `target lock for ${targetId}`,
  );
}

function targetLockIsStale(lock) {
  if (typeof lock.leaseId !== "string") {
    throw new Error("Keep-alive target lock has invalid metadata.");
  }
  const lease = maybeReadKeepAliveLease(lock.leaseId);
  return !lease || keepAliveLeaseIsStale(lease);
}

function releaseKeepAliveTargetLocks(leaseId, targetIds) {
  for (const targetId of targetIds) {
    const lockPath = keepAliveLockPath(targetId);
    const lock = readKeepAliveTargetLock(targetId);
    if (lock?.leaseId === leaseId) {
      fs.rmSync(lockPath, { force: true });
    }
  }
}

function keepAliveBridgeMetadataIsValid(bridge) {
  return (
    bridge != null &&
    typeof bridge === "object" &&
    bridge.host === DEFAULT_HOST &&
    Number.isInteger(bridge.port) &&
    bridge.port >= 1 &&
    bridge.port <= 65535 &&
    typeof bridge.token === "string" &&
    bridge.token.length > 0
  );
}

function keepAliveTargetLocksAreOwnedByLease(lease) {
  if (!Array.isArray(lease.targetIds)) {
    return false;
  }
  return lease.targetIds.every((targetId) => {
    const lock = readKeepAliveTargetLock(targetId);
    return (
      lock?.leaseId === lease.id &&
      normalize(lock.targetId) === normalize(targetId)
    );
  });
}

function keepAliveLeaseReadiness(lease, ownership = {}) {
  if (lease.state !== "running") {
    return { ready: false, reason: `state-${lease.state || "unknown"}` };
  }
  if (!keepAliveBridgeMetadataIsValid(lease.bridge)) {
    return { ready: false, reason: "bridge-metadata-invalid" };
  }
  const workerAlive = ownership.workerAlive ?? keepAliveWorkerIsAlive(lease);
  if (!workerAlive) {
    return { ready: false, reason: "worker-not-alive" };
  }
  const locksHeld =
    ownership.locksHeld ?? keepAliveTargetLocksAreOwnedByLease(lease);
  if (!locksHeld) {
    return { ready: false, reason: "target-locks-not-held" };
  }
  return { ready: true, reason: null };
}

function keepAliveLeaseSnapshot(lease) {
  const readiness = keepAliveLeaseReadiness(lease);
  return {
    id: lease.id,
    state: lease.state,
    targetIds: lease.targetIds,
    durationMs: lease.durationMs,
    createdAt: lease.createdAt,
    attachedAt: lease.attachedAt || null,
    endedAt: lease.endedAt || null,
    expiresAt: lease.expiresAt,
    terminalReason: lease.terminalReason || null,
    bridgeActive: readiness.ready,
    readiness: readiness.reason,
  };
}

function keepAliveCleanupProof(lease) {
  const targetLocks = Array.isArray(lease.targetIds)
    ? lease.targetIds.map((targetId) => {
        const lock = readKeepAliveTargetLock(targetId);
        return {
          targetId,
          released: lock?.leaseId !== lease.id,
          heldByLeaseId: lock?.leaseId || null,
        };
      })
    : [];
  const bridgeReleased = lease.bridge == null;
  const workerExited = !keepAliveWorkerIsAlive(lease);
  const persistentSessionsReleased = workerExited;
  const stopMarkerReleased = !fs.existsSync(keepAliveStopPath(lease.id));
  const targetLocksReleased = targetLocks.every((lock) => lock.released);
  return {
    bridgeReleased,
    workerExited,
    persistentSessionsReleased,
    stopMarkerReleased,
    targetLocksReleased,
    targetLocks,
    complete:
      bridgeReleased &&
      workerExited &&
      persistentSessionsReleased &&
      stopMarkerReleased &&
      targetLocksReleased,
  };
}

async function waitForKeepAliveReady(leaseId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "lease metadata was not readable";
  while (Date.now() <= deadline) {
    let lease;
    try {
      lease = readKeepAliveLease(leaseId);
    } catch (error) {
      lastState = error.message || String(error);
      if (Date.now() >= deadline) {
        break;
      }
      await delay(
        Math.min(KEEP_ALIVE_STOP_POLL_MS, Math.max(1, deadline - Date.now())),
      );
      continue;
    }
    const readiness = keepAliveLeaseReadiness(lease);
    if (readiness.ready) {
      return lease;
    }
    if (isKeepAliveTerminalState(lease.state)) {
      throw new Error(
        `Keep-alive lease ${leaseId} reached ${lease.state}: ${lease.terminalReason || "no terminal reason"}.`,
      );
    }
    if (keepAliveLeaseIsStale(lease)) {
      throw new Error(
        `Keep-alive lease ${leaseId} became stale while starting.`,
      );
    }
    lastState = `${lease.state || "unknown"}/${readiness.reason}`;
    if (Date.now() >= deadline) {
      break;
    }
    await delay(
      Math.min(KEEP_ALIVE_STOP_POLL_MS, Math.max(1, deadline - Date.now())),
    );
  }
  throw new Error(
    `Keep-alive lease ${leaseId} did not become running with an active bridge within ${timeoutMs}ms (last state: ${lastState}).`,
  );
}

async function waitForKeepAliveTerminal(leaseId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "lease metadata was not readable";
  while (Date.now() <= deadline) {
    try {
      const lease = readKeepAliveLease(leaseId);
      if (isKeepAliveTerminalState(lease.state)) {
        const cleanup = keepAliveCleanupProof(lease);
        if (cleanup.complete) {
          return { lease, cleanup };
        }
        lastState = `${lease.state}/cleanup-pending`;
      } else {
        lastState = lease.state || "unknown";
      }
    } catch (error) {
      lastState = error.message || String(error);
    }
    if (Date.now() >= deadline) {
      break;
    }
    await delay(
      Math.min(KEEP_ALIVE_STOP_POLL_MS, Math.max(1, deadline - Date.now())),
    );
  }
  throw new Error(
    `Keep-alive lease ${leaseId} did not reach a terminal state with released bridge, worker, stop marker, and locks within ${timeoutMs}ms (last state: ${lastState}).`,
  );
}

function acquireKeepAliveTargetLocks(leaseId, targetIds) {
  const lockDirectory = path.join(keepAliveDirectory(), "locks");
  fs.mkdirSync(lockDirectory, { recursive: true });
  const acquired = [];
  try {
    for (const targetId of targetIds) {
      const lockPath = keepAliveLockPath(targetId);
      const existingLock = readKeepAliveTargetLock(targetId);
      if (existingLock) {
        if (!targetLockIsStale(existingLock)) {
          throw new Error(
            `Target ${targetId} is already held by keep-alive lease ${existingLock.leaseId}.`,
          );
        }
        fs.rmSync(lockPath, { force: true });
      }
      try {
        fs.writeFileSync(
          lockPath,
          `${JSON.stringify({ leaseId, targetId }, null, 2)}\n`,
          { encoding: "utf8", flag: "wx" },
        );
      } catch (error) {
        if (error.code === "EEXIST") {
          throw new Error(
            `Target ${targetId} was claimed by another keep-alive lease while this lease was starting.`,
          );
        }
        throw error;
      }
      acquired.push(targetId);
    }
  } catch (error) {
    releaseKeepAliveTargetLocks(leaseId, acquired);
    throw error;
  }
}

async function openKeepAliveAttachments(targets, timeoutMs) {
  const attachments = [];
  try {
    for (const target of targets) {
      const attachment = {
        target,
        events: createCdpEventBuffer(),
        session: undefined,
      };
      attachment.session = await openCdpSession(
        target.webSocketDebuggerUrl,
        timeoutMs,
        (event) => {
          attachment.events.push(event);
          if (event.method === "Page.screencastFrame") {
            void attachment.session
              ?.send("Page.screencastFrameAck", {
                sessionId: event.params.sessionId,
              })
              .catch(() => undefined);
          }
        },
      );
      attachments.push(attachment);
    }
    await Promise.all(
      attachments.map(({ session }) => session.send("Page.enable")),
    );
    await Promise.all(
      attachments.map(({ session }) =>
        session.send("Emulation.setFocusEmulationEnabled", { enabled: true }),
      ),
    );
    return attachments;
  } catch (error) {
    await releaseKeepAliveAttachments(attachments);
    throw error;
  }
}

async function releaseKeepAliveAttachments(attachments) {
  await Promise.allSettled(
    attachments.map(async ({ session, events }) => {
      try {
        await session.send("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
      } catch {}
      events.close();
      session.close();
    }),
  );
}

async function waitForKeepAliveEnd(
  attachments,
  stopPath,
  durationMs,
  signal,
  baseUrl,
  targetIds,
) {
  const deadline = Date.now() + durationMs;
  let nextHealthCheckAt = Date.now() + KEEP_ALIVE_HEALTH_CHECK_MS;
  while (true) {
    if (signal.name) {
      return `process-${signal.name.toLowerCase()}`;
    }
    if (fs.existsSync(stopPath)) {
      return "stop-requested";
    }
    const now = Date.now();
    if (now >= deadline) {
      return "duration-elapsed";
    }
    if (now >= nextHealthCheckAt) {
      const liveTargets = await listTargets(baseUrl);
      const liveTargetIds = new Set(
        liveTargets.map((target) => normalize(target.id)),
      );
      const missingTargetIds = targetIds.filter(
        (targetId) => !liveTargetIds.has(normalize(targetId)),
      );
      if (missingTargetIds.length > 0) {
        throw new Error(
          `Keep-alive target closed: ${missingTargetIds.join(", ")}.`,
        );
      }
      await Promise.all(
        attachments.map(({ session }) =>
          session.send("Runtime.evaluate", {
            expression: "void 0",
            returnByValue: true,
          }),
        ),
      );
      nextHealthCheckAt = Date.now() + KEEP_ALIVE_HEALTH_CHECK_MS;
    }
    await delay(
      Math.min(
        KEEP_ALIVE_STOP_POLL_MS,
        Math.max(1, deadline - Date.now()),
        Math.max(1, nextHealthCheckAt - Date.now()),
      ),
    );
  }
}

async function runKeepAliveWorker(options, endpointConfiguration, timeoutMs) {
  const leaseId = keepAliveLeaseIdOption(options);
  const targetIds = exactTargetIdsOption(options, "Keep-alive worker");
  const durationMs = integerOption(
    options,
    "duration",
    KEEP_ALIVE_DEFAULT_DURATION_MS,
    100,
    KEEP_ALIVE_MAX_DURATION_MS,
  );
  const lease = readKeepAliveLease(leaseId);
  if (
    targetIds.length !== lease.targetIds.length ||
    targetIds.some(
      (targetId, index) =>
        normalize(targetId) !== normalize(lease.targetIds[index]),
    )
  ) {
    throw new Error("Keep-alive worker target IDs do not match its lease.");
  }

  const stopPath = keepAliveStopPath(leaseId);
  const signal = { name: undefined };
  const requestShutdown = (name) => {
    signal.name ??= name;
  };
  const onSigint = () => requestShutdown("SIGINT");
  const onSigterm = () => requestShutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const attachments = [];
  let bridge;
  let failure;
  let terminalState = "failed";
  let terminalReason = "worker-failed";
  try {
    if (fs.existsSync(stopPath)) {
      terminalState = "stopped";
      terminalReason = "stopped-before-attachment";
      return;
    }
    updateKeepAliveLease(leaseId, {
      state: "starting",
      workerPid: process.pid,
      workerStartedAt: new Date().toISOString(),
    });
    const targets = await listTargets(endpointConfiguration.baseUrl);
    const selectedTargets = selectTargetsByExactIds(targets, targetIds);
    attachments.push(
      ...(await openKeepAliveAttachments(selectedTargets, timeoutMs)),
    );
    if (fs.existsSync(stopPath)) {
      terminalState = "stopped";
      terminalReason = "stopped-during-attachment";
      return;
    }
    bridge = await createKeepAliveCommandBridge(attachments);
    updateKeepAliveLease(leaseId, {
      state: "running",
      attachedAt: new Date().toISOString(),
      bridge: bridge.descriptor,
    });
    terminalReason = await waitForKeepAliveEnd(
      attachments,
      stopPath,
      durationMs,
      signal,
      endpointConfiguration.baseUrl,
      targetIds,
    );
    terminalState =
      terminalReason === "duration-elapsed" ? "expired" : "stopped";
  } catch (error) {
    failure = error;
    terminalState = "failed";
    terminalReason = error.message;
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    // Make the lease observably non-ready before tearing down the bridge or
    // persistent sessions. Otherwise a concurrent status call can report a
    // stale running bridge while the worker is already closing it.
    try {
      updateKeepAliveLease(leaseId, {
        state: "stopping",
        teardownStartedAt: new Date().toISOString(),
        bridge: null,
      });
    } catch (error) {
      failure ??= error;
      terminalState = "failed";
      terminalReason = `Unable to publish keep-alive teardown: ${error.message}`;
    }
    await closeKeepAliveCommandBridge(bridge);
    await releaseKeepAliveAttachments(attachments);
    fs.rmSync(stopPath, { force: true });
    updateKeepAliveLease(leaseId, {
      state: terminalState,
      endedAt: new Date().toISOString(),
      terminalReason,
      bridge: null,
    });
    releaseKeepAliveTargetLocks(leaseId, targetIds);
  }
  if (failure) {
    throw failure;
  }
}

function waitForChildExit(child, description) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${description} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`,
        ),
      );
    });
  });
}

function waitForChildSpawn(child, description) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  }).catch((error) => {
    throw new Error(`${description} failed to start: ${error.message}`);
  });
}

async function runKeepAliveLauncher(options, endpointConfiguration, timeoutMs) {
  const leaseId = keepAliveLeaseIdOption(options);
  const targetIds = exactTargetIdsOption(options, "Keep-alive launcher");
  const durationMs = integerOption(
    options,
    "duration",
    KEEP_ALIVE_DEFAULT_DURATION_MS,
    100,
    KEEP_ALIVE_MAX_DURATION_MS,
  );
  let worker;
  try {
    worker = spawn(
      process.execPath,
      [
        path.resolve(process.argv[1]),
        "keep-alive-worker",
        "--lease",
        leaseId,
        "--target-ids",
        targetIds.join(","),
        "--duration",
        String(durationMs),
        "--host",
        endpointConfiguration.host,
        "--port",
        String(endpointConfiguration.port),
        "--timeout",
        String(timeoutMs),
      ],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    await waitForChildSpawn(worker, "Keep-alive worker");
    worker.unref();
  } catch (error) {
    updateKeepAliveLease(leaseId, {
      state: "failed",
      endedAt: new Date().toISOString(),
      terminalReason: error.message,
    });
    releaseKeepAliveTargetLocks(leaseId, targetIds);
    throw error;
  }
}

async function startKeepAliveWorker(lease, endpointConfiguration, timeoutMs) {
  const child = spawn(
    process.execPath,
    [
      path.resolve(process.argv[1]),
      "keep-alive-launcher",
      "--lease",
      lease.id,
      "--target-ids",
      lease.targetIds.join(","),
      "--duration",
      String(lease.durationMs),
      "--host",
      endpointConfiguration.host,
      "--port",
      String(endpointConfiguration.port),
      "--timeout",
      String(timeoutMs),
    ],
    { detached: false, stdio: "ignore", windowsHide: true },
  );
  await waitForChildExit(child, "Keep-alive launcher");
  return child.pid;
}

function createKeepAliveLease(targetIds, durationMs, endpointConfiguration) {
  const leaseId = randomUUID();
  acquireKeepAliveTargetLocks(leaseId, targetIds);
  const createdAt = new Date().toISOString();
  try {
    return writeKeepAliveLease({
      id: leaseId,
      state: "starting",
      createdAt,
      requesterPid: process.pid,
      workerPid: undefined,
      targetIds,
      durationMs,
      endpoint: {
        host: endpointConfiguration.host,
        port: endpointConfiguration.port,
      },
      expiresAt: new Date(Date.now() + durationMs).toISOString(),
    });
  } catch (error) {
    releaseKeepAliveTargetLocks(leaseId, targetIds);
    throw error;
  }
}

function keepAliveStatus(leaseId) {
  const lease = readKeepAliveLease(leaseId);
  print({
    lease: keepAliveLeaseSnapshot(lease),
    cleanup: isKeepAliveTerminalState(lease.state)
      ? keepAliveCleanupProof(lease)
      : null,
    worker: {
      processId: lease.workerPid || null,
      alive: keepAliveWorkerIsAlive(lease),
    },
    stopRequested: fs.existsSync(keepAliveStopPath(leaseId)),
  });
}

function listKeepAliveLeases(options) {
  let targetIds;
  if (options["target-ids"] !== undefined) {
    targetIds = exactTargetIdsOption(options, "Keep-alive list");
  }
  if (!fs.existsSync(keepAliveDirectory())) {
    print({ leases: [] });
    return;
  }
  const leases = fs
    .readdirSync(keepAliveDirectory(), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .flatMap((entry) => {
      const leaseId = path.basename(entry.name, ".json");
      try {
        return [readKeepAliveLease(leaseId)];
      } catch {
        return [];
      }
    })
    .filter(
      (lease) =>
        !targetIds ||
        targetIds.every((targetId) =>
          lease.targetIds.some(
            (leasedTargetId) =>
              normalize(leasedTargetId) === normalize(targetId),
          ),
        ),
    )
    .sort((left, right) =>
      String(right.createdAt).localeCompare(left.createdAt),
    )
    .map((lease) => ({
      ...keepAliveLeaseSnapshot(lease),
      active: !keepAliveLeaseIsStale(lease),
    }));
  print({ leases });
}

function requestKeepAliveStop(leaseId) {
  const lease = readKeepAliveLease(leaseId);
  if (isKeepAliveTerminalState(lease.state)) {
    return {
      stopRequested: false,
      alreadyFinished: true,
      lease,
    };
  }
  if (keepAliveLeaseIsStale(lease)) {
    const stoppedLease = updateKeepAliveLease(leaseId, {
      state: "stopped",
      endedAt: new Date().toISOString(),
      terminalReason: "stopped-after-worker-startup-failed",
      bridge: null,
    });
    releaseKeepAliveTargetLocks(leaseId, lease.targetIds);
    fs.rmSync(keepAliveStopPath(leaseId), { force: true });
    return {
      stopRequested: false,
      recoveredStaleLease: true,
      lease: stoppedLease,
    };
  }
  fs.writeFileSync(
    keepAliveStopPath(leaseId),
    `${new Date().toISOString()}\n`,
    "utf8",
  );
  const stoppingLease = updateKeepAliveLease(leaseId, {
    state: "stopping",
    stopRequestedAt: new Date().toISOString(),
  });
  return {
    stopRequested: true,
    lease: stoppingLease,
  };
}

function pageTargetIdFromWebSocketUrl(webSocketUrl) {
  try {
    const url = new URL(webSocketUrl);
    const match = /^\/devtools\/page\/([^/]+)$/.exec(url.pathname);
    return match ? decodeURIComponent(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

function activeKeepAliveLeaseForTarget(targetId) {
  const lock = readKeepAliveTargetLock(targetId);
  if (!lock) {
    return undefined;
  }
  if (typeof lock.leaseId !== "string") {
    throw new Error("Keep-alive target lock has invalid metadata.");
  }
  const lease = maybeReadKeepAliveLease(lock.leaseId);
  if (!lease || keepAliveLeaseIsStale(lease)) {
    return undefined;
  }
  if (
    !Array.isArray(lease.targetIds) ||
    !lease.targetIds.some(
      (leasedTargetId) => normalize(leasedTargetId) === normalize(targetId),
    )
  ) {
    throw new Error(
      `Target ${targetId} lock does not belong to a declared target of keep-alive lease ${lease.id}.`,
    );
  }
  const readiness = keepAliveLeaseReadiness(lease);
  if (!readiness.ready) {
    throw new Error(
      `Target ${targetId} is held by keep-alive lease ${lease.id} but is not ready for commands (${readiness.reason}). Check keep-alive-status or stop the lease.`,
    );
  }
  return lease;
}

function keepAliveBridgeForTarget(targetId) {
  return activeKeepAliveLeaseForTarget(targetId)?.bridge;
}

function readBridgeRequest(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > 1024 * 1024) {
        reject(new Error("Keep-alive bridge request exceeds 1 MiB."));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on("end", () => {
      try {
        const value = JSON.parse(body);
        if (
          value == null ||
          typeof value !== "object" ||
          Array.isArray(value)
        ) {
          throw new Error("request must be a JSON object");
        }
        resolve(value);
      } catch (error) {
        reject(
          new Error(`Invalid keep-alive bridge request: ${error.message}`),
        );
      }
    });
    request.on("error", reject);
  });
}

function writeBridgeResponse(response, statusCode, body) {
  const source = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(source, "utf8"),
    "Cache-Control": "no-store",
  });
  response.end(source);
}

function enqueueBridgeCommand(queues, targetId, operation) {
  const previous = queues.get(targetId) || Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(targetId, next);
  void next.then(
    () => {
      if (queues.get(targetId) === next) {
        queues.delete(targetId);
      }
    },
    () => {
      if (queues.get(targetId) === next) {
        queues.delete(targetId);
      }
    },
  );
  return next;
}

function createKeepAliveCommandBridge(attachments) {
  const attachmentByTargetId = new Map(
    attachments.map((attachment) => [
      normalize(attachment.target.id),
      attachment,
    ]),
  );
  const queues = new Map();
  const token = randomUUID();
  const server = http.createServer(async (request, response) => {
    if (
      request.method !== "POST" ||
      !["/command", "/events"].includes(request.url)
    ) {
      writeBridgeResponse(response, 404, { ok: false, error: "Not found." });
      return;
    }
    try {
      const command = await readBridgeRequest(request);
      if (command.token !== token) {
        throw new Error("Keep-alive bridge authentication failed.");
      }
      if (typeof command.targetId !== "string") {
        throw new Error("Bridge request requires a targetId string.");
      }
      const attachment = attachmentByTargetId.get(normalize(command.targetId));
      if (!attachment) {
        throw new Error(
          `Target ${command.targetId} is not owned by this lease.`,
        );
      }
      if (request.url === "/events") {
        const afterSequence = Number(command.afterSequence ?? 0);
        const eventMethod = command.eventMethod;
        const limit = Number(command.limit ?? 32);
        if (!Number.isInteger(afterSequence) || afterSequence < 0) {
          throw new Error("Event cursor must be a non-negative integer.");
        }
        if (
          eventMethod !== undefined &&
          (typeof eventMethod !== "string" || eventMethod.length === 0)
        ) {
          throw new Error("Event method must be a non-empty string.");
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
          throw new Error("Event limit must be an integer from 1 to 100.");
        }
        const timeoutMs = validateCommandTimeout(
          command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        );
        const result = await attachment.events.wait(
          afterSequence,
          eventMethod,
          timeoutMs,
          limit,
        );
        writeBridgeResponse(response, 200, { ok: true, result });
        return;
      }
      if (typeof command.method !== "string" || command.method.length === 0) {
        throw new Error("Bridge command requires a method string.");
      }
      if (command.method === "Emulation.setFocusEmulationEnabled") {
        throw new Error(
          "Focus emulation is owned by the keep-alive lease and cannot be changed through the bridge.",
        );
      }
      const params =
        command.params == null || typeof command.params !== "object"
          ? {}
          : command.params;
      const timeoutMs = validateCommandTimeout(
        command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
      );
      const result = await enqueueBridgeCommand(queues, command.targetId, () =>
        attachment.session.send(command.method, params, timeoutMs),
      );
      writeBridgeResponse(response, 200, { ok: true, result });
    } catch (error) {
      if (!response.writableEnded) {
        writeBridgeResponse(response, 400, {
          ok: false,
          error: error.message || String(error),
        });
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, DEFAULT_HOST, () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Keep-alive bridge did not receive a loopback port."));
        return;
      }
      resolve({
        server,
        descriptor: {
          host: DEFAULT_HOST,
          port: address.port,
          token,
        },
      });
    });
  });
}

function closeKeepAliveCommandBridge(bridge) {
  if (!bridge) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    bridge.server.close(() => resolve());
  });
}

function sendKeepAliveBridgeCommand(
  bridge,
  targetId,
  method,
  params,
  timeoutMs,
) {
  return new Promise((resolve, reject) => {
    const source = JSON.stringify({
      token: bridge.token,
      targetId,
      method,
      params,
      timeoutMs,
    });
    const request = http.request(
      {
        host: bridge.host,
        port: bridge.port,
        path: "/command",
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(source, "utf8"),
        },
      },
      (response) => {
        let body = "";
        let size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk, "utf8");
          if (size > 64 * 1024 * 1024) {
            request.destroy(
              new Error("Keep-alive bridge response exceeds 64 MiB."),
            );
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          try {
            const message = JSON.parse(body);
            if (response.statusCode !== 200 || message.ok !== true) {
              throw new Error(
                message.error ||
                  `Keep-alive bridge returned HTTP ${response.statusCode}.`,
              );
            }
            resolve(message.result);
          } catch (error) {
            reject(
              new Error(
                `Keep-alive bridge command failed for ${targetId}: ${error.message}`,
              ),
            );
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs + 1000, () => {
      request.destroy(
        new Error(
          `Keep-alive bridge command timed out after ${timeoutMs}ms: ${method}.`,
        ),
      );
    });
    request.on("error", reject);
    request.end(source);
  });
}

function receiveKeepAliveBridgeEvents(
  bridge,
  targetId,
  afterSequence,
  eventMethod,
  timeoutMs,
  limit = 32,
) {
  return new Promise((resolve, reject) => {
    const source = JSON.stringify({
      token: bridge.token,
      targetId,
      afterSequence,
      eventMethod,
      timeoutMs,
      limit,
    });
    const request = http.request(
      {
        host: bridge.host,
        port: bridge.port,
        path: "/events",
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(source, "utf8"),
        },
      },
      (response) => {
        let body = "";
        let size = 0;
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          size += Buffer.byteLength(chunk, "utf8");
          if (size > 64 * 1024 * 1024) {
            request.destroy(
              new Error("Keep-alive bridge event response exceeds 64 MiB."),
            );
            return;
          }
          body += chunk;
        });
        response.on("end", () => {
          try {
            const message = JSON.parse(body);
            if (response.statusCode !== 200 || message.ok !== true) {
              throw new Error(
                message.error ||
                  `Keep-alive bridge returned HTTP ${response.statusCode}.`,
              );
            }
            resolve(message.result);
          } catch (error) {
            reject(
              new Error(
                `Keep-alive bridge event request failed for ${targetId}: ${error.message}`,
              ),
            );
          }
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(timeoutMs + 1000, () => {
      request.destroy(
        new Error(
          `Keep-alive bridge event request timed out after ${timeoutMs}ms: ${eventMethod}.`,
        ),
      );
    });
    request.on("error", reject);
    request.end(source);
  });
}

function cursorExpression(x, y, { click = false, hidden = false } = {}) {
  return `(() => {
        const id = "__chrome_direct_cdp_cursor__";
        let host = document.getElementById(id);
        if (!host) {
            host = document.createElement("div");
            host.id = id;
            host.style.cssText = "position:fixed;left:0;top:0;width:64px;height:64px;z-index:2147483647;pointer-events:none;transition:transform 45ms linear,opacity 120ms;filter:drop-shadow(0 3px 5px rgba(0,0,0,.45));";
            host.innerHTML = '<svg width="64" height="64" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><path d="M8 5 L8 48 L19 38 L28 57 L39 51 L30 33 L45 32 Z" fill="white" stroke="#1677ff" stroke-width="4" stroke-linejoin="round"/><circle cx="49" cy="15" r="11" fill="#1677ff" stroke="white" stroke-width="3"/><text x="49" y="19" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="white">AI</text></svg>';
            document.documentElement.appendChild(host);
        }
        let runtime = window.__chromeDirectCdpCursorRuntime;
        if (!runtime || runtime.host !== host || !runtime.host.isConnected) {
            const move = (clientX, clientY) => {
                if (!runtime.enabled) return;
                runtime.x = clientX;
                runtime.y = clientY;
                runtime.host.style.opacity = "1";
                runtime.host.style.transform = "translate(" + clientX + "px," + clientY + "px)";
            };
            const ring = (clientX, clientY) => {
                if (!runtime.enabled) return;
                const marker = document.createElement("div");
                marker.style.cssText = "position:fixed;left:" + (clientX - 21) + "px;top:" + (clientY - 21) + "px;width:42px;height:42px;border:5px solid #ff3b30;border-radius:50%;z-index:2147483646;pointer-events:none;animation:__chrome_direct_cdp_ring__ 520ms ease-out forwards;";
                document.documentElement.appendChild(marker);
                setTimeout(() => marker.remove(), 600);
            };
            runtime = { host, enabled: true, x: 0, y: 0, move, ring };
            window.__chromeDirectCdpCursorRuntime = runtime;
            document.addEventListener("mousemove", (event) => runtime.move(event.clientX, event.clientY), true);
            document.addEventListener("mousedown", (event) => {
                runtime.move(event.clientX, event.clientY);
                runtime.ring(event.clientX, event.clientY);
            }, true);
        }
        if (!document.getElementById("__chrome_direct_cdp_style__")) {
            const style = document.createElement("style");
            style.id = "__chrome_direct_cdp_style__";
            style.textContent = "@keyframes __chrome_direct_cdp_ring__{0%{transform:scale(.35);opacity:1}100%{transform:scale(1.8);opacity:0}}";
            document.documentElement.appendChild(style);
        }
        runtime.enabled = ${!hidden};
        if (runtime.enabled) {
            runtime.move(${Number(x)}, ${Number(y)});
            ${click ? `runtime.ring(${Number(x)}, ${Number(y)});` : ""}
        } else {
            runtime.host.style.opacity = "0";
        }
        return { x: runtime.x, y: runtime.y, visible: runtime.enabled, followsMouse: true };
    })()`;
}

function inspectElementsExpression(limit = 200) {
  return `(() => {
        const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
        };
        const implicitRole = (element) => {
            const tag = element.tagName.toLowerCase();
            const type = (element.getAttribute("type") || "").toLowerCase();
            if (tag === "button") return "button";
            if (tag === "a" && element.hasAttribute("href")) return "link";
            if (tag === "textarea") return "textbox";
            if (tag === "select") return "combobox";
            if (tag === "input") {
                if (["button", "submit", "reset", "image"].includes(type)) return "button";
                if (type === "checkbox") return "checkbox";
                if (type === "radio") return "radio";
                if (type === "range") return "slider";
                if (type === "search") return "searchbox";
                return "textbox";
            }
            if (element.isContentEditable) return "textbox";
            return element.getAttribute("role") || "generic";
        };
        const accessibleName = (element) => {
            const labelledBy = element.getAttribute("aria-labelledby");
            if (labelledBy) {
                const value = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ").trim();
                if (value) return value;
            }
            const aria = element.getAttribute("aria-label");
            if (aria) return aria.trim();
            if (element.labels?.length) {
                const value = Array.from(element.labels).map((label) => label.innerText || label.textContent || "").join(" ").trim();
                if (value) return value;
            }
            return (element.getAttribute("alt") || element.getAttribute("title") || element.getAttribute("placeholder") || element.value || element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200);
        };
        const selectorFor = (element) => {
            const isUnique = (selector) => {
                try {
                    return document.querySelectorAll(selector).length === 1;
                } catch {
                    return false;
                }
            };
            if (element.id) {
                const candidate = "#" + CSS.escape(element.id);
                if (isUnique(candidate)) return candidate;
            }
            for (const attribute of ["data-testid", "data-test", "name", "aria-label"]) {
                const value = element.getAttribute(attribute);
                if (value) {
                    const candidate = element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
                    if (isUnique(candidate)) return candidate;
                }
            }
            const parts = [];
            let current = element;
            while (current && current.nodeType === 1 && current !== document.documentElement) {
                let part = current.tagName.toLowerCase();
                const siblings = Array.from(current.parentElement?.children || []).filter((item) => item.tagName === current.tagName);
                if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")";
                parts.unshift(part);
                const candidate = parts.join(" > ");
                if (isUnique(candidate)) return candidate;
                current = current.parentElement;
            }
            return parts.join(" > ");
        };
        const query = '[role],button,input,select,textarea,a[href],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
        return Array.from(document.querySelectorAll(query)).filter(visible).slice(0, ${Number(limit)}).map((element, index) => {
            const rect = element.getBoundingClientRect();
            return {
                index,
                role: element.getAttribute("role") || implicitRole(element),
                name: accessibleName(element),
                text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200),
                selector: selectorFor(element),
                tagName: element.tagName,
                disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
                bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            };
        });
    })()`;
}

function normalize(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function resolveSemanticPoint(webSocketUrl, options, timeoutMs) {
  const elements = await evaluate(
    webSocketUrl,
    inspectElementsExpression(Number(options.limit || 300)),
    timeoutMs,
  );
  const exact = Boolean(options.exact);
  const expectedRole = normalize(options.role);
  const expectedName = normalize(options.name || options.label);
  const expectedText = normalize(options.text);
  const matches = elements.filter((element) => {
    const compare = (actual, expected) =>
      !expected ||
      (exact
        ? normalize(actual) === expected
        : normalize(actual).includes(expected));
    return (
      compare(element.role, expectedRole) &&
      compare(element.name, expectedName) &&
      compare(element.text, expectedText)
    );
  });
  if (matches.length !== 1) {
    const candidates = (matches.length > 0 ? matches : elements)
      .slice(0, 20)
      .map(({ role, name, text, selector, disabled }) => ({
        role,
        name,
        text,
        selector,
        disabled,
      }));
    throw new Error(
      `Semantic locator matched ${matches.length} elements. Candidates: ${JSON.stringify(candidates)}`,
    );
  }
  const element = matches[0];
  if (element.disabled) {
    throw new Error(`Matched element is disabled: ${JSON.stringify(element)}`);
  }
  const point = await resolvePoint(
    webSocketUrl,
    { selector: element.selector },
    timeoutMs,
  );
  return { ...element, ...point };
}

async function resolvePoint(webSocketUrl, options, timeoutMs) {
  if (options.selector) {
    const selector = JSON.stringify(String(options.selector));
    const point = await evaluate(
      webSocketUrl,
      `(() => {
            const matches = document.querySelectorAll(${selector});
            if (matches.length !== 1) throw new Error("Selector matched " + matches.length + " elements: " + ${selector});
            const element = matches[0];
            element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0) throw new Error("Element has no visible box: " + ${selector});
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, tagName: element.tagName, text: (element.innerText || element.getAttribute("aria-label") || "").trim().slice(0, 120) };
        })()`,
      timeoutMs,
    );
    return point;
  }
  if (options.role || options.name || options.label || options.text) {
    return resolveSemanticPoint(webSocketUrl, options, timeoutMs);
  }
  const x = Number(options.x);
  const y = Number(options.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Provide --selector or numeric --x and --y");
  }
  return { x, y };
}

function resolvedTargetSelectorForHitTest(options, point) {
  const explicitSelector =
    typeof options.selector === "string" ? options.selector.trim() : "";
  if (explicitSelector) {
    return explicitSelector;
  }
  const semanticSelector =
    typeof point?.selector === "string" ? point.selector.trim() : "";
  return semanticSelector || null;
}

function clickHitAllowsDispatch(resolvedTargetSelector, hitBefore) {
  return (
    resolvedTargetSelector === null ||
    hitBefore.topWithinResolvedTarget === true
  );
}

function hitTestExpression(point, resolvedSelector) {
  const resolvedPoint = {
    x: Number(point.x),
    y: Number(point.y),
  };
  const selector =
    resolvedSelector === null ? "null" : JSON.stringify(resolvedSelector);
  return `(() => {
        const point = ${JSON.stringify(resolvedPoint)};
        const selector = ${selector};
        const describe = (element) => {
            if (!element || element.nodeType !== 1) return null;
            const rect = element.getBoundingClientRect();
            return {
                tagName: element.tagName.toLowerCase(),
                id: element.id || null,
                className: element.getAttribute("class") || null,
                role: element.getAttribute("role"),
                ariaLabel: element.getAttribute("aria-label"),
                text: (element.innerText || element.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 200),
                bounds: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
            };
        };
        const topElement = document.elementFromPoint(point.x, point.y);
        const stackElements = document.elementsFromPoint(point.x, point.y);
        let resolvedTargetElement = null;
        if (selector !== null) {
            const matches = document.querySelectorAll(selector);
            if (matches.length !== 1) throw new Error("Resolved selector matched " + matches.length + " elements: " + selector);
            resolvedTargetElement = matches[0];
        }
        return {
            point,
            top: describe(topElement),
            stack: stackElements.map(describe).filter(Boolean),
            resolvedTarget: describe(resolvedTargetElement),
            topWithinResolvedTarget: resolvedTargetElement === null ? null : Boolean(topElement && resolvedTargetElement.contains(topElement)),
        };
    })()`;
}

async function readHitTest(webSocketUrl, point, resolvedSelector, timeoutMs) {
  return evaluate(
    webSocketUrl,
    hitTestExpression(point, resolvedSelector),
    timeoutMs,
  );
}

function mouseModifiers(options) {
  let modifiers = 0;
  if (options.alt) modifiers |= 1;
  if (options.ctrl) modifiers |= 2;
  if (options.meta) modifiers |= 4;
  if (options.shift) modifiers |= 8;
  return modifiers;
}

function mouseButton(options) {
  const button = String(options.button || "left").toLowerCase();
  if (!["left", "right", "middle", "back", "forward"].includes(button)) {
    throw new Error(
      `Invalid mouse button: ${options.button}. Use left, right, middle, back, or forward.`,
    );
  }
  return button;
}

function mouseButtonMask(button) {
  return {
    left: 1,
    right: 2,
    middle: 4,
    back: 8,
    forward: 16,
  }[button];
}

function integerOption(options, name, defaultValue, minimum, maximum) {
  const raw = options[name] ?? defaultValue;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid --${name}: ${raw}. Use an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function optionalIntegerOption(options, name, minimum, maximum) {
  if (options[name] === undefined) {
    return undefined;
  }
  return integerOption(options, name, undefined, minimum, maximum);
}

function optionalBooleanOption(options, name) {
  const raw = options[name];
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    return true;
  }
  const value = String(raw).toLowerCase();
  if (["true", "1", "yes"].includes(value)) {
    return true;
  }
  if (["false", "0", "no"].includes(value)) {
    return false;
  }
  throw new Error(`Invalid --${name}: ${raw}. Use true or false.`);
}

function numberOption(options, name, defaultValue, minimum, maximum) {
  const raw = options[name] ?? defaultValue;
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid --${name}: ${raw}. Use a number from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function pointerType(options) {
  const value = String(options["pointer-type"] || "mouse").toLowerCase();
  if (!["mouse", "pen", "touch"].includes(value)) {
    throw new Error(
      `Invalid --pointer-type: ${options["pointer-type"]}. Use mouse, pen, or touch.`,
    );
  }
  return value;
}

function pointerAction(options) {
  const value = String(options.action || "move").toLowerCase();
  if (!["down", "move", "up", "cancel", "tap", "drag"].includes(value)) {
    throw new Error(
      `Invalid --action: ${options.action}. Use down, move, up, cancel, tap, or drag.`,
    );
  }
  return value;
}

function pointerGeometry(options) {
  const geometry = {};
  const definitions = [
    ["pressure", "force", 0, 1],
    ["tangential-pressure", "tangentialPressure", -1, 1],
    ["tilt-x", "tiltX", -90, 90],
    ["tilt-y", "tiltY", -90, 90],
    ["twist", "twist", 0, 359],
  ];
  for (const [optionName, cdpName, minimum, maximum] of definitions) {
    const value = numberOption(
      options,
      optionName,
      undefined,
      minimum,
      maximum,
    );
    if (value !== undefined) {
      geometry[cdpName] = value;
    }
  }
  return geometry;
}

function touchPointFromOptions(point, options) {
  const touchPoint = {
    x: point.x,
    y: point.y,
    id: integerOption(options, "pointer-id", 0, 0, 2147483647),
    ...pointerGeometry(options),
  };
  const radiusX = numberOption(options, "radius-x", undefined, 0, 1000000);
  const radiusY = numberOption(options, "radius-y", undefined, 0, 1000000);
  const rotationAngle = numberOption(
    options,
    "rotation-angle",
    undefined,
    0,
    360,
  );
  if (radiusX !== undefined) touchPoint.radiusX = radiusX;
  if (radiusY !== undefined) touchPoint.radiusY = radiusY;
  if (rotationAngle !== undefined) touchPoint.rotationAngle = rotationAngle;
  return touchPoint;
}

function normalizeTouchPoint(value, index) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Touch point ${index} must be an object.`);
  }
  const normalized = {};
  const definitions = [
    ["x", -1000000, 1000000],
    ["y", -1000000, 1000000],
    ["radiusX", 0, 1000000],
    ["radiusY", 0, 1000000],
    ["rotationAngle", 0, 360],
    ["force", 0, 1],
    ["tangentialPressure", -1, 1],
    ["tiltX", -90, 90],
    ["tiltY", -90, 90],
    ["twist", 0, 359],
  ];
  for (const [name, minimum, maximum] of definitions) {
    if (value[name] === undefined) continue;
    const number = Number(value[name]);
    if (!Number.isFinite(number) || number < minimum || number > maximum) {
      throw new Error(
        `Invalid touch point ${index}.${name}: ${value[name]}. Use a number from ${minimum} to ${maximum}.`,
      );
    }
    normalized[name] = number;
  }
  if (normalized.x === undefined || normalized.y === undefined) {
    throw new Error(`Touch point ${index} requires numeric x and y.`);
  }
  if (value.id !== undefined) {
    const id = Number(value.id);
    if (!Number.isInteger(id) || id < 0 || id > 2147483647) {
      throw new Error(
        `Invalid touch point ${index}.id: ${value.id}. Use a non-negative integer.`,
      );
    }
    normalized.id = id;
  }
  return normalized;
}

function touchPointsOption(options, name = "touch-points") {
  if (options[name] === undefined) {
    return undefined;
  }
  const raw = String(options[name]).trim();
  let points;
  if (raw === "" || raw === "[]") {
    points = [];
  } else if (!raw.startsWith("[") && raw.includes(":")) {
    points = raw.split(";").map((entry, index) => {
      const values = entry.split(":");
      if (values.length < 3 || values.length > 4) {
        throw new Error(
          `Invalid --${name} item ${index}: ${entry}. Use id:x:y or id:x:y:force.`,
        );
      }
      const [id, x, y, force] = values.map(Number);
      return force === undefined ? { id, x, y } : { id, x, y, force };
    });
  } else {
    try {
      points = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Invalid --${name}: ${error.message}. On PowerShell prefer id:x:y;id:x:y compact syntax.`,
      );
    }
  }
  if (!Array.isArray(points)) {
    throw new Error(`--${name} must be a JSON array or compact point list.`);
  }
  const normalized = points.map(normalizeTouchPoint);
  const ids = normalized
    .map((point) => point.id)
    .filter((id) => id !== undefined);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`--${name} contains duplicate ids.`);
  }
  return normalized;
}

function interpolateTouchPoints(from, to, ratio) {
  if (from.length !== to.length) {
    throw new Error("Touch drag requires matching from/to point counts.");
  }
  return from.map((start, index) => {
    const end = to[index];
    if (start.id !== undefined && end.id !== undefined && start.id !== end.id) {
      throw new Error(
        `Touch drag point ${index} changes id from ${start.id} to ${end.id}.`,
      );
    }
    const point = { ...start };
    for (const name of [
      "x",
      "y",
      "radiusX",
      "radiusY",
      "rotationAngle",
      "force",
      "tangentialPressure",
      "tiltX",
      "tiltY",
      "twist",
    ]) {
      const startValue = start[name];
      const endValue = end[name];
      if (startValue !== undefined && endValue !== undefined) {
        point[name] = startValue + (endValue - startValue) * ratio;
      } else if (endValue !== undefined && ratio === 1) {
        point[name] = endValue;
      }
    }
    return point;
  });
}

function prefixedPointOptions(options, prefix) {
  const pointOptions = {};
  for (const key of [
    "selector",
    "role",
    "name",
    "label",
    "text",
    "x",
    "y",
    "exact",
    "limit",
  ]) {
    const value = options[`${prefix}-${key}`];
    if (value !== undefined) {
      pointOptions[key] = value;
    }
  }
  return pointOptions;
}

async function dispatchMouseMove(
  webSocketUrl,
  point,
  options,
  timeoutMs,
  buttons = 0,
) {
  const modifiers = mouseModifiers(options);
  await evaluate(webSocketUrl, cursorExpression(point.x, point.y), timeoutMs);
  await sendCdp(
    webSocketUrl,
    "Input.dispatchMouseEvent",
    {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      buttons,
      modifiers,
    },
    timeoutMs,
  );
}

function wheelProbeInstallExpression() {
  return `(() => {
    const key = "__chromeDirectCdpWheelProbe";
    globalThis[key]?.dispose?.();
    const records = [];
    const rafTimestamps = [];
    const listeners = [];
    const startedAt = performance.now();
    let disposed = false;
    let rafHandle = 0;
    const describeTarget = (target) => {
      if (!(target instanceof Element)) return null;
      const rect = target.getBoundingClientRect();
      return {
        tagName: target.tagName,
        id: target.id || null,
        className: typeof target.className === "string" ? target.className.slice(0, 240) : null,
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    };
    const recordEvent = (event) => {
      const record = {
        sequence: records.length + 1,
        type: event.type,
        isTrusted: event.isTrusted,
        timeStamp: event.timeStamp,
        clientX: event.clientX,
        clientY: event.clientY,
        deltaX: Number(event.deltaX ?? 0),
        deltaY: Number(event.deltaY ?? 0),
        deltaMode: Number(event.deltaMode ?? 0),
        cancelable: event.cancelable,
        defaultPreventedAtCapture: event.defaultPrevented,
        defaultPreventedAfterDispatch: null,
        target: describeTarget(event.target),
      };
      records.push(record);
      setTimeout(() => {
        record.defaultPreventedAfterDispatch = event.defaultPrevented;
      }, 0);
    };
    for (const type of ["wheel", "mousewheel", "DOMMouseScroll"]) {
      addEventListener(type, recordEvent, { capture: true, passive: true });
      listeners.push(type);
    }
    const tick = (timestamp) => {
      if (disposed) return;
      rafTimestamps.push(timestamp);
      rafHandle = requestAnimationFrame(tick);
    };
    rafHandle = requestAnimationFrame(tick);
    const snapshot = () => ({
      startedAt,
      elapsedMs: performance.now() - startedAt,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      scroll: { x: scrollX, y: scrollY },
      records: records.map((record) => ({ ...record })),
      rafTimestamps: [...rafTimestamps],
    });
    const dispose = () => {
      if (!disposed) {
        disposed = true;
        cancelAnimationFrame(rafHandle);
        for (const type of listeners) {
          removeEventListener(type, recordEvent, { capture: true });
        }
      }
      return snapshot();
    };
    globalThis[key] = { snapshot, dispose };
    return {
      installed: true,
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      scroll: { x: scrollX, y: scrollY },
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
    };
  })()`;
}

function wheelProbeSnapshotExpression(dispose = false) {
  return `(() => {
    const probe = globalThis.__chromeDirectCdpWheelProbe;
    if (!probe) throw new Error("Chrome Direct CDP wheel probe is not installed");
    const result = probe.${dispose ? "dispose" : "snapshot"}();
    ${dispose ? "delete globalThis.__chromeDirectCdpWheelProbe;" : ""}
    return result;
  })()`;
}

function hashScreenshot(data) {
  return createHash("sha256").update(Buffer.from(data, "base64")).digest("hex");
}

function wheelProbeVisualClip(point, viewport, size) {
  const x = Math.max(0, Math.min(viewport.width, point.x - size / 2));
  const y = Math.max(0, Math.min(viewport.height, point.y - size / 2));
  return {
    x,
    y,
    width: Math.max(1, Math.min(size, viewport.width - x)),
    height: Math.max(1, Math.min(size, viewport.height - y)),
    scale: 1,
  };
}

async function createWheelProbeTransport(target, timeoutMs) {
  const lease = activeKeepAliveLeaseForTarget(target.id);
  if (lease) {
    return {
      kind: "keep-alive-event-bridge",
      leaseId: lease.id,
      send(method, params = {}, commandTimeoutMs = timeoutMs) {
        return sendKeepAliveBridgeCommand(
          lease.bridge,
          target.id,
          method,
          params,
          commandTimeoutMs,
        );
      },
      waitEvents(afterSequence, method, waitMs, limit = 32) {
        return receiveKeepAliveBridgeEvents(
          lease.bridge,
          target.id,
          afterSequence,
          method,
          waitMs,
          limit,
        );
      },
      close() {},
    };
  }

  const events = createCdpEventBuffer();
  let session;
  let frameAckErrors = 0;
  session = await openCdpSession(
    target.webSocketDebuggerUrl,
    timeoutMs,
    (event) => {
      events.push(event);
      if (event.method === "Page.screencastFrame") {
        void session
          ?.send("Page.screencastFrameAck", {
            sessionId: event.params.sessionId,
          })
          .catch(() => {
            frameAckErrors += 1;
          });
      }
    },
  );
  return {
    kind: "direct-event-session",
    leaseId: null,
    send(method, params = {}, commandTimeoutMs = timeoutMs) {
      return session.send(method, params, commandTimeoutMs);
    },
    waitEvents(afterSequence, method, waitMs, limit = 32) {
      return events.wait(afterSequence, method, waitMs, limit);
    },
    frameAckErrors() {
      return frameAckErrors;
    },
    close() {
      events.close();
      session.close();
    },
  };
}

async function wheelProbeEventCursor(transport) {
  const marker = `ChromeDirectCdp.NoEvent.${randomUUID()}`;
  const result = await transport.waitEvents(0, marker, 100, 1);
  return result.nextSequence;
}

async function collectWheelProbeFrames(transport, afterSequence) {
  const frames = [];
  let cursor = afterSequence;
  while (true) {
    const batch = await transport.waitEvents(
      cursor,
      "Page.screencastFrame",
      100,
      100,
    );
    cursor = batch.nextSequence;
    frames.push(...batch.events);
    if (batch.events.length === 0) break;
  }
  return { cursor, frames };
}

function wheelProbeRafSummary(timestamps, elapsedMs) {
  const intervals = timestamps
    .slice(1)
    .map((timestamp, index) => timestamp - timestamps[index])
    .filter((interval) => Number.isFinite(interval) && interval >= 0);
  const sorted = [...intervals].sort((left, right) => left - right);
  const percentile = (ratio) =>
    sorted.length === 0
      ? null
      : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  return {
    role: "scheduler-diagnostic-only",
    validForGpuFps: false,
    frameCount: timestamps.length,
    elapsedMs,
    rafFps: elapsedMs > 0 ? (timestamps.length * 1000) / elapsedMs : null,
    p95IntervalMs: percentile(0.95),
    p99IntervalMs: percentile(0.99),
  };
}

async function runWheelProbe(target, point, options, timeoutMs) {
  const count = integerOption(options, "count", 20, 1, WHEEL_PROBE_MAX_COUNT);
  const intervalMs = integerOption(
    options,
    "interval",
    WHEEL_PROBE_DEFAULT_INTERVAL_MS,
    0,
    10000,
  );
  const settleMs = integerOption(
    options,
    "settle",
    WHEEL_PROBE_DEFAULT_SETTLE_MS,
    0,
    10000,
  );
  const visualSize = integerOption(options, "visual-size", 256, 32, 4096);
  const deltaX = numberOption(options, "delta-x", 0, -1000000, 1000000);
  const deltaY = numberOption(options, "delta-y", undefined, -1000000, 1000000);
  if (deltaY === undefined) {
    throw new Error("Wheel probe requires --delta-y.");
  }
  if (deltaX === 0 && deltaY === 0) {
    throw new Error("Wheel probe requires a non-zero --delta-x or --delta-y.");
  }
  const requirePixelChange =
    optionalBooleanOption(options, "require-pixel-change") ?? true;
  const requireVisible =
    optionalBooleanOption(options, "require-visible") ?? true;
  const expectedProbeMs = count * intervalMs + settleMs + 2500;
  if (timeoutMs <= expectedProbeMs) {
    throw new Error(
      `--timeout must exceed the wheel probe input, settle, and frame startup budget (${expectedProbeMs}ms).`,
    );
  }

  const transport = await createWheelProbeTransport(target, timeoutMs);
  let screencastStarted = false;
  let installed = false;
  let snapshot;
  let initial;
  let finalScreenshot;
  let baselineFrame = null;
  let frames = [];
  let cdpAckCount = 0;
  const dispatched = [];
  let inputStartedAt = 0;
  let inputEndedAt = 0;
  try {
    await transport.send("Page.enable");
    initial = await evaluateInSession(transport, wheelProbeInstallExpression());
    installed = true;
    const clip = wheelProbeVisualClip(point, initial.viewport, visualSize);
    const screenshotParams = {
      format: "jpeg",
      quality: 60,
      fromSurface: true,
      optimizeForSpeed: true,
      clip,
    };
    const initialScreenshot = await transport.send(
      "Page.captureScreenshot",
      screenshotParams,
    );
    await transport.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      everyNthFrame: 1,
    });
    screencastStarted = true;
    let frameCursor = await wheelProbeEventCursor(transport);
    const firstFrame = await transport.waitEvents(
      frameCursor,
      "Page.screencastFrame",
      2000,
      1,
    );
    frameCursor = firstFrame.nextSequence;
    baselineFrame = firstFrame.events[0] ?? null;
    frameCursor = await wheelProbeEventCursor(transport);

    const modifiers = mouseModifiers(options);
    await transport.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      buttons: 0,
      modifiers,
    });
    inputStartedAt = Date.now();
    for (let index = 0; index < count; index += 1) {
      const params = {
        type: "mouseWheel",
        x: point.x,
        y: point.y,
        deltaX,
        deltaY,
        modifiers,
      };
      await transport.send("Input.dispatchMouseEvent", params);
      cdpAckCount += 1;
      dispatched.push(params);
      if (intervalMs > 0 && index < count - 1) {
        await delay(intervalMs);
      }
    }
    inputEndedAt = Date.now();
    if (settleMs > 0) await delay(settleMs);
    const collected = await collectWheelProbeFrames(transport, frameCursor);
    frames = collected.frames;
    finalScreenshot = await transport.send(
      "Page.captureScreenshot",
      screenshotParams,
    );
    snapshot = await evaluateInSession(
      transport,
      wheelProbeSnapshotExpression(true),
    );
    installed = false;

    const initialHash = hashScreenshot(initialScreenshot.data);
    const finalHash = hashScreenshot(finalScreenshot.data);
    const wheelRecords = snapshot.records.filter(
      (record) => record.type === "wheel",
    );
    const matchingRecords = wheelRecords.filter(
      (record) =>
        record.isTrusted === true &&
        record.deltaX === deltaX &&
        record.deltaY === deltaY &&
        Math.abs(record.clientX - point.x) <= 1 &&
        Math.abs(record.clientY - point.y) <= 1,
    );
    const frameHashes = frames.map((entry) =>
      hashScreenshot(entry.event.params.data),
    );
    const invalidReasons = [];
    if (cdpAckCount !== count)
      invalidReasons.push("cdp-wheel-ack-count-mismatch");
    if (wheelRecords.length !== count)
      invalidReasons.push("dom-wheel-count-mismatch");
    if (matchingRecords.length !== count) {
      invalidReasons.push("trusted-wheel-contract-mismatch");
    }
    if (requireVisible && snapshot.visibilityState !== "visible") {
      invalidReasons.push("target-not-visible");
    }
    if (
      snapshot.scroll.x !== initial.scroll.x ||
      snapshot.scroll.y !== initial.scroll.y
    ) {
      invalidReasons.push("page-scrolled-instead-of-target-response");
    }
    const pixelChanged = initialHash !== finalHash;
    if (requirePixelChange && !pixelChanged) {
      invalidReasons.push("visual-anchor-did-not-change");
    }
    if (frames.length === 0) {
      invalidReasons.push("no-screencast-frame-during-interaction");
    }
    const durationMs = Math.max(0, inputEndedAt - inputStartedAt + settleMs);
    return {
      valid: invalidReasons.length === 0,
      invalidReasons,
      target: { id: target.id, title: target.title, url: target.url },
      transport: {
        kind: transport.kind,
        leaseId: transport.leaseId,
        frameAckErrors: transport.frameAckErrors?.() ?? 0,
      },
      state: {
        before: {
          visibilityState: initial.visibilityState,
          hasFocus: initial.hasFocus,
          scroll: initial.scroll,
        },
        after: {
          visibilityState: snapshot.visibilityState,
          hasFocus: snapshot.hasFocus,
          scroll: snapshot.scroll,
        },
      },
      input: {
        method: "Input.dispatchMouseEvent",
        type: "mouseWheel",
        point,
        deltaX,
        deltaY,
        requestedCount: count,
        cdpAckCount,
        intervalMs,
        settleMs,
        dispatched,
      },
      wheelEvents: {
        receivedCount: wheelRecords.length,
        trustedCount: wheelRecords.filter((record) => record.isTrusted).length,
        matchingCount: matchingRecords.length,
        records: snapshot.records,
      },
      visualChange: {
        required: requirePixelChange,
        changed: pixelChanged,
        clip,
        initialSha256: initialHash,
        finalSha256: finalHash,
      },
      frameEvidence: {
        source: "Page.startScreencast",
        role: "visual-update-evidence-only",
        instrumented: true,
        validForGpuFps: false,
        baselineFrameReceived: baselineFrame !== null,
        frameCount: frames.length,
        distinctFrameCount: new Set(frameHashes).size,
        observedFrameRate:
          durationMs > 0 ? (frames.length * 1000) / durationMs : null,
      },
      raf: wheelProbeRafSummary(snapshot.rafTimestamps, snapshot.elapsedMs),
      performanceKpi: {
        valid: false,
        gpuFps: null,
        compositorFps: null,
        reason:
          "Wheel probe validates trusted input and visual updates; screencast and rAF are instrumented diagnostics, not GPU Present metrics.",
      },
    };
  } finally {
    if (screencastStarted) {
      try {
        await transport.send("Page.stopScreencast");
      } catch {}
    }
    if (installed) {
      try {
        await evaluateInSession(transport, wheelProbeSnapshotExpression(true));
      } catch {}
    }
    transport.close();
  }
}

async function dispatchClick(webSocketUrl, point, options, timeoutMs) {
  const button = mouseButton(options);
  const buttons = mouseButtonMask(button);
  const modifiers = mouseModifiers(options);
  const clickCount = integerOption(options, "click-count", 1, 1, 3);
  const repeat = integerOption(options, "repeat", 1, 1, 10000);
  const intervalMs = integerOption(options, "interval", 0, 0, 10000);
  await evaluate(webSocketUrl, cursorExpression(point.x, point.y), timeoutMs);
  await withCdpSession(webSocketUrl, timeoutMs, async (session) => {
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
      buttons: 0,
      modifiers,
    });
    for (let currentRepeat = 0; currentRepeat < repeat; currentRepeat += 1) {
      for (
        let currentClick = 1;
        currentClick <= clickCount;
        currentClick += 1
      ) {
        await session.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: point.x,
          y: point.y,
          button,
          buttons,
          modifiers,
          clickCount: currentClick,
        });
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: point.x,
          y: point.y,
          button,
          buttons: 0,
          modifiers,
          clickCount: currentClick,
        });
      }
      if (intervalMs > 0 && currentRepeat < repeat - 1) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  });
}

async function dispatchDrag(webSocketUrl, from, to, options, timeoutMs) {
  const button = mouseButton(options);
  const buttons = mouseButtonMask(button);
  const modifiers = mouseModifiers(options);
  const steps = integerOption(options, "steps", 12, 1, 240);
  const durationMs = integerOption(options, "duration", 200, 0, 10000);
  const delayMs = durationMs / steps;
  let current = from;

  await evaluate(webSocketUrl, cursorExpression(from.x, from.y), timeoutMs);
  await withCdpSession(webSocketUrl, timeoutMs, async (session) => {
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: from.x,
      y: from.y,
      buttons: 0,
      modifiers,
    });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: from.x,
      y: from.y,
      button,
      buttons,
      modifiers,
      clickCount: 1,
    });

    let failure;
    try {
      for (let step = 1; step <= steps; step += 1) {
        const ratio = step / steps;
        current = {
          x: from.x + (to.x - from.x) * ratio,
          y: from.y + (to.y - from.y) * ratio,
        };
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: current.x,
          y: current.y,
          button,
          buttons,
          modifiers,
        });
        if (delayMs > 0 && step < steps) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      try {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: current.x,
          y: current.y,
          button,
          buttons: 0,
          modifiers,
          clickCount: 1,
        });
      } catch (releaseError) {
        if (!failure) {
          throw releaseError;
        }
      }
    }
    if (failure) {
      throw failure;
    }
  });
  await evaluate(
    webSocketUrl,
    cursorExpression(current.x, current.y),
    timeoutMs,
  );

  return { button, modifiers, steps, durationMs };
}

async function dispatchPointerInput(
  webSocketUrl,
  locations,
  options,
  timeoutMs,
) {
  const type = pointerType(options);
  const action = pointerAction(options);
  const modifiers = mouseModifiers(options);
  if (type === "touch") {
    if (["down", "move", "up"].includes(action)) {
      throw new Error(
        `Touch ${action} cannot be split across command invocations because CDP touch state belongs to one WebSocket session. Use --action tap, drag, or cancel.`,
      );
    }
    if (action === "drag") {
      let fromPoints = touchPointsOption(options, "from-touch-points");
      let toPoints = touchPointsOption(options, "to-touch-points");
      if (fromPoints === undefined) {
        if (locations.from == null) {
          throw new Error(
            "Touch drag requires from coordinates or --from-touch-points.",
          );
        }
        fromPoints = [touchPointFromOptions(locations.from, options)];
      }
      if (toPoints === undefined) {
        if (locations.to == null) {
          throw new Error(
            "Touch drag requires to coordinates or --to-touch-points.",
          );
        }
        toPoints = [touchPointFromOptions(locations.to, options)];
      }
      if (fromPoints.length === 0 || toPoints.length === 0) {
        throw new Error("Touch drag requires at least one active touch point.");
      }
      const steps = integerOption(options, "steps", 12, 1, 240);
      const durationMs = integerOption(options, "duration", 200, 0, 10000);
      const delayMs = durationMs / steps;
      const events = [];
      await withCdpSession(webSocketUrl, timeoutMs, async (session) => {
        const start = {
          type: "touchStart",
          touchPoints: fromPoints,
          modifiers,
        };
        events.push(start);
        await session.send("Input.dispatchTouchEvent", start);
        let failure;
        try {
          for (let step = 1; step <= steps; step += 1) {
            const move = {
              type: "touchMove",
              touchPoints: interpolateTouchPoints(
                fromPoints,
                toPoints,
                step / steps,
              ),
              modifiers,
            };
            events.push(move);
            await session.send("Input.dispatchTouchEvent", move);
            if (delayMs > 0 && step < steps) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        } catch (error) {
          failure = error;
        } finally {
          const end = {
            type: failure ? "touchCancel" : "touchEnd",
            touchPoints: [],
            modifiers,
          };
          events.push(end);
          try {
            await session.send("Input.dispatchTouchEvent", end);
          } catch (endError) {
            if (!failure) throw endError;
          }
        }
        if (failure) throw failure;
      });
      return {
        pointerType: type,
        action,
        method: "Input.dispatchTouchEvent",
        steps,
        durationMs,
        events,
      };
    }

    let touchPoints = touchPointsOption(options);
    if (touchPoints === undefined) {
      if (locations.point == null) {
        throw new Error(`Touch ${action} requires a point or --touch-points.`);
      }
      touchPoints = [touchPointFromOptions(locations.point, options)];
    }
    if (touchPoints.length === 0) {
      throw new Error(
        `Touch ${action} requires at least one active touch point.`,
      );
    }
    const clickCount =
      action === "tap" ? integerOption(options, "click-count", 1, 1, 3) : 1;
    const intervalMs = integerOption(options, "interval", 80, 0, 1000);
    const events = [];
    await withCdpSession(webSocketUrl, timeoutMs, async (session) => {
      for (let current = 1; current <= clickCount; current += 1) {
        const start = { type: "touchStart", touchPoints, modifiers };
        const end = {
          type: action === "cancel" ? "touchCancel" : "touchEnd",
          touchPoints: [],
          modifiers,
        };
        events.push(start, end);
        await session.send("Input.dispatchTouchEvent", start);
        await session.send("Input.dispatchTouchEvent", end);
        if (intervalMs > 0 && current < clickCount) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    });
    return {
      pointerType: type,
      action,
      method: "Input.dispatchTouchEvent",
      clickCount,
      intervalMs,
      events,
    };
  }

  if (action === "cancel") {
    throw new Error(
      `Pointer cancel is only supported for touch; CDP has no mouse/pen cancel event.`,
    );
  }
  const button = mouseButton(options);
  const buttonMask = mouseButtonMask(button);
  const geometry = pointerGeometry(options);
  if (action === "drag") {
    if (locations.from == null || locations.to == null) {
      throw new Error(`${type} drag requires from and to points.`);
    }
    const steps = integerOption(options, "steps", 12, 1, 240);
    const durationMs = integerOption(options, "duration", 200, 0, 10000);
    const delayMs = durationMs / steps;
    const events = [];
    await withCdpSession(webSocketUrl, timeoutMs, async (session) => {
      const down = {
        type: "mousePressed",
        x: locations.from.x,
        y: locations.from.y,
        button,
        buttons: buttonMask,
        modifiers,
        pointerType: type,
        ...geometry,
        clickCount: 0,
      };
      events.push(down);
      await session.send("Input.dispatchMouseEvent", down);
      let failure;
      let current = locations.from;
      try {
        for (let step = 1; step <= steps; step += 1) {
          const ratio = step / steps;
          current = {
            x: locations.from.x + (locations.to.x - locations.from.x) * ratio,
            y: locations.from.y + (locations.to.y - locations.from.y) * ratio,
          };
          const move = {
            type: "mouseMoved",
            ...current,
            button,
            buttons: buttonMask,
            modifiers,
            pointerType: type,
            ...geometry,
          };
          events.push(move);
          await session.send("Input.dispatchMouseEvent", move);
          if (delayMs > 0 && step < steps) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        const up = {
          type: "mouseReleased",
          ...current,
          button,
          buttons: 0,
          modifiers,
          pointerType: type,
          ...geometry,
          force: 0,
          clickCount: 0,
        };
        events.push(up);
        try {
          await session.send("Input.dispatchMouseEvent", up);
        } catch (upError) {
          if (!failure) throw upError;
        }
      }
      if (failure) throw failure;
    });
    return {
      pointerType: type,
      action,
      method: "Input.dispatchMouseEvent",
      steps,
      durationMs,
      events,
    };
  }

  if (locations.point == null) {
    throw new Error(`${type} ${action} requires a point.`);
  }
  if (action === "tap") {
    const clickCount = integerOption(options, "click-count", 1, 1, 3);
    const intervalMs = integerOption(options, "interval", 80, 0, 1000);
    const events = [];
    await withCdpSession(webSocketUrl, timeoutMs, async (session) => {
      for (let current = 1; current <= clickCount; current += 1) {
        const down = {
          type: "mousePressed",
          x: locations.point.x,
          y: locations.point.y,
          button,
          buttons: buttonMask,
          modifiers,
          pointerType: type,
          ...geometry,
          clickCount: current,
        };
        const up = {
          ...down,
          type: "mouseReleased",
          buttons: 0,
          force: 0,
        };
        events.push(down, up);
        await session.send("Input.dispatchMouseEvent", down);
        await session.send("Input.dispatchMouseEvent", up);
        if (intervalMs > 0 && current < clickCount) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
      }
    });
    return {
      pointerType: type,
      action,
      method: "Input.dispatchMouseEvent",
      clickCount,
      intervalMs,
      events,
    };
  }

  const pressed = action === "down" || (action === "move" && options.pressed);
  const params = {
    type: {
      down: "mousePressed",
      move: "mouseMoved",
      up: "mouseReleased",
    }[action],
    x: locations.point.x,
    y: locations.point.y,
    buttons: pressed ? buttonMask : 0,
    modifiers,
    pointerType: type,
    ...geometry,
  };
  if (action !== "move" || pressed) {
    params.button = button;
  }
  if (action !== "move") {
    params.clickCount = integerOption(options, "click-count", 1, 1, 3);
  }
  await sendCdp(webSocketUrl, "Input.dispatchMouseEvent", params, timeoutMs);
  return {
    pointerType: type,
    action,
    method: "Input.dispatchMouseEvent",
    params,
  };
}

function viewportReadbackExpression() {
  return `({
      innerWidth,
      innerHeight,
      devicePixelRatio,
      screenWidth: screen.width,
      screenHeight: screen.height,
  })`;
}

function viewportVerificationError(viewport, expected) {
  const mismatches = [
    ["innerWidth", viewport.innerWidth, expected.width],
    ["innerHeight", viewport.innerHeight, expected.height],
    ["devicePixelRatio", viewport.devicePixelRatio, expected.deviceScaleFactor],
    ["screenWidth", viewport.screenWidth, expected.screenWidth],
    ["screenHeight", viewport.screenHeight, expected.screenHeight],
  ].filter(([, actual, expectedValue]) => actual !== expectedValue);
  if (mismatches.length === 0) {
    return null;
  }
  return `Viewport verification failed: ${JSON.stringify({ viewport, expected, mismatches })}`;
}

async function readViewportFromKeepAliveLease(lease, targetId, timeoutMs) {
  const result = await sendKeepAliveBridgeCommand(
    lease.bridge,
    targetId,
    "Runtime.evaluate",
    {
      expression: viewportReadbackExpression(),
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  );
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Viewport readback failed.",
    );
  }
  return result.result?.value;
}

async function setViewportOnKeepAliveLease(
  lease,
  targetId,
  expected,
  timeoutMs,
) {
  await sendKeepAliveBridgeCommand(
    lease.bridge,
    targetId,
    "Emulation.setDeviceMetricsOverride",
    {
      width: expected.width,
      height: expected.height,
      deviceScaleFactor: expected.deviceScaleFactor,
      mobile: false,
      screenWidth: expected.screenWidth,
      screenHeight: expected.screenHeight,
    },
    timeoutMs,
  );
  return readViewportFromKeepAliveLease(lease, targetId, timeoutMs);
}

function assertSelfCheck(condition, message) {
  if (!condition) {
    throw new Error(`Self-check failed: ${message}`);
  }
}

function runSelfCheck() {
  const expectedBridge = {
    host: DEFAULT_HOST,
    port: 49152,
    token: "self-check-token",
  };
  const runningLease = {
    id: "self-check",
    state: "running",
    bridge: expectedBridge,
  };
  assertSelfCheck(
    keepAliveBridgeMetadataIsValid(expectedBridge),
    "valid bridge metadata was rejected",
  );
  assertSelfCheck(
    keepAliveLeaseReadiness(runningLease, {
      workerAlive: true,
      locksHeld: true,
    }).ready,
    "ready lease was rejected",
  );
  assertSelfCheck(
    !keepAliveLeaseReadiness(runningLease, {
      workerAlive: false,
      locksHeld: true,
    }).ready,
    "worker-less lease was accepted",
  );
  assertSelfCheck(
    !keepAliveLeaseReadiness(runningLease, {
      workerAlive: true,
      locksHeld: false,
    }).ready,
    "lease without locks was accepted",
  );
  const backgroundSafeCommandLine = BACKGROUND_SAFE_CHROME_FLAGS.join(" ");
  assertSelfCheck(
    commandLineContainsArguments(
      backgroundSafeCommandLine,
      BACKGROUND_SAFE_CHROME_FLAGS,
    ),
    "background-safe Chrome flags were not recognized",
  );
  assertSelfCheck(
    backgroundSchedulingState({ commandLine: backgroundSafeCommandLine }).safe,
    "background-safe scheduling state was rejected",
  );
  assertSelfCheck(
    !backgroundSchedulingState({ commandLine: "" }).safe,
    "Chrome without background-safe flags was accepted",
  );
  assertSelfCheck(
    resolvedTargetSelectorForHitTest(
      { selector: "#explicit-target" },
      { selector: "#semantic-target" },
    ) === "#explicit-target",
    "explicit selector was not retained for hit testing",
  );
  assertSelfCheck(
    resolvedTargetSelectorForHitTest({}, { selector: "#semantic-target" }) ===
      "#semantic-target",
    "semantic selector was not retained for hit testing",
  );
  assertSelfCheck(
    resolvedTargetSelectorForHitTest({ x: 10, y: 20 }, { x: 10, y: 20 }) ===
      null,
    "coordinate point incorrectly gained a resolved target",
  );
  assertSelfCheck(
    clickHitAllowsDispatch("#target", { topWithinResolvedTarget: true }),
    "selector click with a matching top hit was rejected",
  );
  assertSelfCheck(
    !clickHitAllowsDispatch("#target", { topWithinResolvedTarget: false }),
    "selector click with a mismatched top hit was accepted",
  );
  assertSelfCheck(
    clickHitAllowsDispatch(null, { topWithinResolvedTarget: null }),
    "coordinate click was incorrectly treated as a selector click",
  );
  assertSelfCheck(
    JSON.stringify(
      requestedOuterWindowBounds({
        left: 0,
        top: 80,
        width: 1100,
        height: 850,
        windowState: undefined,
      }),
    ) ===
      JSON.stringify({
        left: 0,
        top: 80,
        width: 1100,
        height: 850,
        windowState: null,
      }),
    "requested outer bounds are ambiguous",
  );
  assertSelfCheck(
    viewportVerificationError(
      {
        innerWidth: 938,
        innerHeight: 599,
        devicePixelRatio: 1,
        screenWidth: 938,
        screenHeight: 599,
      },
      {
        width: 938,
        height: 599,
        deviceScaleFactor: 1,
        screenWidth: 938,
        screenHeight: 599,
      },
    ) === null,
    "matching viewport failed verification",
  );
  const targetWindow = {
    handle: 101,
    ownerHandle: 0,
    visible: true,
    className: "Chrome_WidgetWin_1",
    title: "Example CAD - Google Chrome",
    left: 2553,
    top: 1,
    width: 1454,
    height: 1263,
  };
  const auxiliaryWindow = {
    handle: 102,
    ownerHandle: 0,
    visible: true,
    className: "Chrome_WidgetWin_1",
    title: "Translate this page?",
    left: 3542,
    top: 87,
    width: 298,
    height: 101,
  };
  const resolvedWindow = selectWindowsTargetWindow(
    [auxiliaryWindow, targetWindow],
    { left: 2553, top: 1, width: 1454, height: 1263 },
    { title: "Example CAD" },
  );
  assertSelfCheck(
    resolvedWindow.ok === true &&
      resolvedWindow.candidate.handle === targetWindow.handle,
    "target Chrome window was not resolved from CDP bounds",
  );
  const titleFallbackWindow = selectWindowsTargetWindow(
    [auxiliaryWindow, targetWindow],
    { left: 0, top: 0, width: 1454, height: 1263 },
    { title: "Example CAD" },
  );
  assertSelfCheck(
    titleFallbackWindow.ok === true &&
      titleFallbackWindow.reason === "target-window-unique-title-fallback" &&
      titleFallbackWindow.candidate.handle === targetWindow.handle,
    "target Chrome window was not resolved by its unique full title after CDP bounds drifted",
  );
  assertSelfCheck(
    selectWindowsTargetWindow([], {}, { title: "Example CAD" }).reason ===
      "interactive-desktop-unavailable",
    "missing interactive desktop was not classified",
  );
  print({
    ok: true,
    checks: [
      "lease-readiness",
      "background-scheduling-contract",
      "hit-test-target-classification",
      "outer-window-bounds-shape",
      "viewport-readback-contract",
      "target-window-resolution",
      "target-window-title-fallback",
      "interactive-desktop-classification",
    ],
  });
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(`Usage: node cdp.mjs <command> [options]\n\nCommands:\n  self-check          Validate the local direct-CDP runtime\n  start [url]         Start or reuse the dedicated Chrome instance\n  status              Verify the dedicated Chrome listener and scheduling flags\n  list                List exact page targets\n  new                 Create a page, optionally in a new window\n  close               Close only an exact target returned by list/new\n  keep-alive          Hold exact targets for background-safe operations\n  keep-alive-list     List keep-alive leases\n  keep-alive-status   Read one keep-alive lease\n  keep-alive-stop     Stop one keep-alive lease and wait for cleanup\n  parallel-probe      Probe multiple exact targets without implicit activation\n  focus               Explicitly activate a target when the contract allows it\n  window-place        Move one exact Windows target without activating it\n  viewport            Set a leased target viewport and verify readback\n  viewport-check      Verify a leased target viewport\n  inspect             Inspect page controls and semantic elements\n  hit-test            Resolve a point and report DOM hit evidence\n  eval                Evaluate an expression in an exact page\n  lifecycle           Install, run, or remove a page lifecycle preload\n  heap-sampling       Start or stop V8 heap sampling on an exact page\n  cursor              Show or hide the direct-CDP cursor marker\n  move|hover          Move the pointer to a coordinate or locator\n  click               Dispatch a direct-CDP mouse click\n  drag                Dispatch a direct-CDP mouse drag\n  pointer             Dispatch mouse, pen, or touch input\n  type                Insert text through direct CDP\n  wheel-probe         Dispatch and validate trusted native wheel input\n  scroll              Scroll by evaluating page script (not benchmark input)\n  navigate            Navigate an exact target\n  reload              Reload an exact target\n  wait                Wait for a page condition\n  call                Call an arbitrary CDP method\n  screenshot          Capture an exact target screenshot\n\nGlobal options:\n  --target-exact ID   Bind commands to one exact page target\n  --timeout MS        Override the command timeout\n  --help, -h          Show this help without connecting to Chrome\n\nWindow placement:\n  window-place requires --target-exact, --allow-window-move, and integer\n  --left, --top, --width, and --height values. It validates Win32, CDP,\n  and page readbacks and never activates the target.\n\nPerformance rule: use wheel-probe for strict input evidence and keep\ntrace/CPU/draw-call/GPU captures separate from the final KPI sample.\n`);
}

function summarizeSamplingProfile(profile, limit) {
  const entries = [];
  const visit = (node, stack) => {
    const frame = node.callFrame || {};
    const name = frame.functionName || "(anonymous)";
    const nextStack = [...stack, name];
    if (Number.isFinite(node.selfSize) && node.selfSize > 0) {
      entries.push({
        selfSize: node.selfSize,
        stack: nextStack,
        url: frame.url || "",
        line: Number.isInteger(frame.lineNumber) ? frame.lineNumber : null,
      });
    }
    for (const child of node.children || []) {
      visit(child, nextStack);
    }
  };
  visit(profile.head || {}, []);
  return entries
    .sort((left, right) => right.selfSize - left.selfSize)
    .slice(0, limit)
    .map((entry) => ({
      selfSize: entry.selfSize,
      stack: entry.stack.join(" <- "),
      url: entry.url,
      line: entry.line,
    }));
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  if (
    command === "help" ||
    command === "-h" ||
    options.help === true ||
    options.h === true
  ) {
    printHelp();
    return;
  }
  const { host, port, baseUrl } = endpoint(options);
  const timeoutMs = commandTimeout(options);

  if (command === "self-check") {
    runSelfCheck();
    return;
  }

  if (command === "start") {
    const chrome = findChrome();
    const backgroundSafe =
      optionalBooleanOption(options, "background-safe") ?? true;
    const backgroundStart =
      optionalBooleanOption(options, "background-start") ?? false;
    const backgroundFlags = backgroundSafe
      ? [...BACKGROUND_SAFE_CHROME_FLAGS]
      : [];
    const profile = path.resolve(
      String(
        options.profile ||
          path.join(process.env.LOCALAPPDATA, "CodexChromeCDP"),
      ),
    );
    let current;
    try {
      current = await getJson(`${baseUrl}/json/version`);
    } catch {}
    const existingOwner = inspectWindowsPortOwner(port);
    if (current) {
      const identity = assertDedicatedChromeListener(existingOwner, {
        port,
        chrome,
        profile,
        requireBackgroundSafe: backgroundSafe,
      });
      print({
        ok: true,
        reused: true,
        port,
        profile: identity.profile,
        processId: identity.processId,
        backgroundScheduling: identity.backgroundScheduling,
        browser: current.Browser,
        webSocketDebuggerUrl: current.webSocketDebuggerUrl,
      });
      return;
    }
    if (existingOwner.listenerCount !== 0) {
      throw new Error(
        `Port ${port} already has a listener but no usable CDP endpoint. It will not be replaced or killed automatically.`,
      );
    }
    const url = positional[1] || "about:blank";
    const launchArguments = [
      `--remote-debugging-address=${DEFAULT_HOST}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      ...backgroundFlags,
      ...(backgroundStart ? ["--no-startup-window"] : [url]),
    ];
    const child = spawn(chrome, launchArguments, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const ready = await waitForEndpoint(baseUrl, timeoutMs);
    const identity = assertDedicatedChromeListener(
      inspectWindowsPortOwner(port),
      { port, chrome, profile, requireBackgroundSafe: backgroundSafe },
    );
    print({
      ok: true,
      reused: false,
      port,
      profile: identity.profile,
      backgroundStart,
      processId: identity.processId,
      backgroundScheduling: identity.backgroundScheduling,
      browser: ready.Browser,
      webSocketDebuggerUrl: ready.webSocketDebuggerUrl,
    });
    return;
  }

  if (command === "status") {
    const version = await getJson(`${baseUrl}/json/version`);
    const targets = await listTargets(baseUrl);
    const owner = inspectWindowsPortOwner(port);
    const chrome = findChrome();
    const profile = path.resolve(
      String(
        options.profile ||
          path.join(process.env.LOCALAPPDATA, "CodexChromeCDP"),
      ),
    );
    const identity = assertDedicatedChromeListener(owner, {
      port,
      chrome,
      profile,
      requireBackgroundSafe: false,
    });
    print({
      ok: true,
      port,
      profile: identity.profile,
      processId: identity.processId,
      browser: version.Browser,
      webSocketDebuggerUrl: version.webSocketDebuggerUrl,
      pageCount: targets.length,
      targets: targets.map(({ id, title, url, webSocketDebuggerUrl }) => ({
        id,
        title,
        url,
        webSocketDebuggerUrl,
      })),
      backgroundScheduling: identity.backgroundScheduling,
    });
    return;
  }

  if (command === "list") {
    const targets = await listTargets(baseUrl);
    print(
      targets.map(({ id, title, url, webSocketDebuggerUrl }) => ({
        id,
        title,
        url,
        webSocketDebuggerUrl,
      })),
    );
    return;
  }

  if (command === "new") {
    const url = String(options.url || positional[1] || "");
    if (
      !/^https?:\/\//i.test(url) &&
      !/^file:/i.test(url) &&
      !/^about:/i.test(url)
    ) {
      throw new Error("Provide an absolute --url for the new target");
    }
    const newWindow = Boolean(options["new-window"]);
    const left = optionalIntegerOption(options, "left", -100000, 100000);
    const top = optionalIntegerOption(options, "top", -100000, 100000);
    const width = optionalIntegerOption(options, "width", 1, 100000);
    const height = optionalIntegerOption(options, "height", 1, 100000);
    const windowState = options["window-state"];
    const focus = optionalBooleanOption(options, "focus");
    const allowWindowFocus = Boolean(options["allow-window-focus"]);
    if (focus === true && !allowWindowFocus) {
      throw new Error(
        "--focus true requires --allow-window-focus because it changes Windows foreground state.",
      );
    }
    if (
      !newWindow &&
      [left, top, width, height, windowState].some(
        (value) => value !== undefined,
      )
    ) {
      throw new Error("Window bounds and --window-state require --new-window.");
    }
    if (
      windowState !== undefined &&
      !["normal", "minimized", "maximized", "fullscreen"].includes(
        String(windowState),
      )
    ) {
      throw new Error(
        `Invalid --window-state: ${windowState}. Use normal, minimized, maximized, or fullscreen.`,
      );
    }
    const requestedBackground = optionalBooleanOption(options, "background");
    const background = requestedBackground ?? focus === false;
    if (background && focus === true) {
      throw new Error("--focus true cannot be used with --background.");
    }
    const createTargetParameters = {
      url,
      background,
      ...(newWindow ? { newWindow: true } : {}),
    };
    const browserUrl = await browserWebSocketUrl(baseUrl);
    const created = await sendCdp(
      browserUrl,
      "Target.createTarget",
      createTargetParameters,
      timeoutMs,
    );
    const target = await waitForTarget(
      baseUrl,
      created.targetId,
      timeoutMs,
      true,
    );
    const appliedWindow = newWindow
      ? await applyNewWindowBounds(
          target,
          baseUrl,
          { left, top, width, height, windowState },
          timeoutMs,
        )
      : null;
    const activation =
      focus === true
        ? await activateTarget(target, port, timeoutMs, {
            allowFocusEmulation: false,
            allowWindowFocus,
          })
        : null;
    print({
      created: true,
      target: {
        id: target.id,
        title: target.title,
        url: target.url,
        webSocketDebuggerUrl: target.webSocketDebuggerUrl,
      },
      requestedUrl: url,
      background,
      backgroundRequested: requestedBackground ?? null,
      newWindow,
      focus: {
        requested: focus ?? null,
        explicitActivation: activation,
      },
      window: newWindow
        ? {
            requestedOuterBounds: requestedOuterWindowBounds({
              left,
              top,
              width,
              height,
              windowState,
            }),
            actualOuterBounds: appliedWindow,
            viewport: null,
          }
        : null,
    });
    return;
  }

  if (command === "keep-alive-status") {
    keepAliveStatus(keepAliveLeaseIdOption(options));
    return;
  }

  if (command === "keep-alive-list") {
    listKeepAliveLeases(options);
    return;
  }

  if (command === "keep-alive-stop") {
    const leaseId = keepAliveLeaseIdOption(options);
    const requestedWait = optionalBooleanOption(options, "wait");
    if (requestedWait === false) {
      throw new Error(
        "keep-alive-stop always waits for terminal cleanup; --wait false is not supported.",
      );
    }
    const requested = requestKeepAliveStop(leaseId);
    const completed = await waitForKeepAliveTerminal(leaseId, timeoutMs);
    print({
      stopRequested: requested.stopRequested,
      alreadyFinished: Boolean(requested.alreadyFinished),
      recoveredStaleLease: Boolean(requested.recoveredStaleLease),
      waited: true,
      lease: keepAliveLeaseSnapshot(completed.lease),
      cleanup: completed.cleanup,
    });
    if (completed.lease.state === "failed") {
      throw new Error(
        `Keep-alive lease ${leaseId} stopped with worker failure: ${completed.lease.terminalReason || "no terminal reason"}.`,
      );
    }
    return;
  }

  if (command === "keep-alive-worker") {
    await runKeepAliveWorker(options, { host, port, baseUrl }, timeoutMs);
    return;
  }

  if (command === "keep-alive-launcher") {
    await runKeepAliveLauncher(options, { host, port }, timeoutMs);
    return;
  }

  if (command === "keep-alive") {
    if (!options.detach) {
      throw new Error(
        "Keep-alive must use --detach so the calling analysis can continue.",
      );
    }
    const targetIds = exactTargetIdsOption(options, "Keep alive");
    const durationMs = integerOption(
      options,
      "duration",
      KEEP_ALIVE_DEFAULT_DURATION_MS,
      100,
      KEEP_ALIVE_MAX_DURATION_MS,
    );
    const targets = await listTargets(baseUrl);
    selectTargetsByExactIds(targets, targetIds);
    const lease = createKeepAliveLease(targetIds, durationMs, { host, port });
    try {
      await startKeepAliveWorker(lease, { host, port }, timeoutMs);
    } catch (error) {
      updateKeepAliveLease(lease.id, {
        state: "failed",
        endedAt: new Date().toISOString(),
        terminalReason: error.message,
      });
      releaseKeepAliveTargetLocks(lease.id, targetIds);
      throw error;
    }
    let readyLease;
    try {
      readyLease = await waitForKeepAliveReady(lease.id, timeoutMs);
    } catch (error) {
      try {
        requestKeepAliveStop(lease.id);
        await waitForKeepAliveTerminal(
          lease.id,
          Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(timeoutMs, 5000)),
        );
      } catch {}
      throw error;
    }
    print({
      started: true,
      detached: true,
      lease: keepAliveLeaseSnapshot(readyLease),
      worker: {
        processId: readyLease.workerPid || null,
        alive: keepAliveWorkerIsAlive(readyLease),
      },
    });
    return;
  }

  const targets = await listTargets(baseUrl);
  if (command === "parallel-probe") {
    const targetIds = exactTargetIdsOption(options);
    const probeTargets = selectTargetsByExactIds(targets, targetIds);
    const durationMs = integerOption(options, "duration", 5000, 100, 600000);
    if (timeoutMs <= durationMs) {
      throw new Error(
        `--timeout must exceed --duration for a parallel probe (${durationMs}ms).`,
      );
    }
    const probes = await runParallelProbe(probeTargets, durationMs, timeoutMs);
    print({
      parallel: true,
      durationMs,
      probes,
    });
    return;
  }
  const exactTargetOption = options["target-exact"];
  if (command === "window-place" && typeof exactTargetOption !== "string") {
    throw new Error(
      "Window placement requires --target-exact <target ID>; use the ID returned by list.",
    );
  }
  if (
    options.target &&
    typeof exactTargetOption === "string" &&
    normalize(options.target) !== normalize(exactTargetOption)
  ) {
    throw new Error(
      `Conflicting target selectors: --target ${options.target} and --target-exact ${exactTargetOption}`,
    );
  }
  const targetSelector =
    options.target ??
    (typeof exactTargetOption === "string" ? exactTargetOption : undefined);
  const target = selectTarget(
    targets,
    targetSelector,
    Boolean(exactTargetOption),
  );
  if (command === "close") {
    if (
      typeof exactTargetOption !== "string" ||
      normalize(exactTargetOption) !== normalize(target.id)
    ) {
      throw new Error(
        "Close requires --target-exact <target ID>; use the ID returned by new or list.",
      );
    }
    const browserUrl = await browserWebSocketUrl(baseUrl);
    const closed = await sendCdp(
      browserUrl,
      "Target.closeTarget",
      { targetId: target.id },
      timeoutMs,
    );
    if (closed.success !== true) {
      throw new Error(`Chrome refused to close target ${target.id}`);
    }
    await waitForTarget(baseUrl, target.id, timeoutMs, false);
    print({
      closed: true,
      target: { id: target.id, title: target.title, url: target.url },
    });
    return;
  }
  if (command === "window-place") {
    if (optionalBooleanOption(options, "allow-window-move") !== true) {
      throw new Error(
        "Window placement requires --allow-window-move because it changes the existing Chrome window geometry.",
      );
    }
    const requestedBounds = {
      left: integerOption(options, "left", undefined, -32768, 32767),
      top: integerOption(options, "top", undefined, -32768, 32767),
      width: integerOption(options, "width", undefined, 200, 32768),
      height: integerOption(options, "height", undefined, 200, 32768),
    };
    const placement = await placeWindowsTargetWindow(
      target,
      port,
      timeoutMs,
      requestedBounds,
    );
    print(placement);
    return;
  }
  const pointerCommand = [
    "cursor",
    "move",
    "hover",
    "click",
    "drag",
    "pointer",
    "type",
  ].includes(command);
  let activation;
  const shouldActivateTarget =
    !options["no-activate"] &&
    (Boolean(options.activate) || Boolean(options["allow-window-focus"]));
  if (shouldActivateTarget) {
    activation = await activateTarget(target, port, timeoutMs, {
      allowFocusEmulation: !options["no-focus-emulation"],
      allowWindowFocus: Boolean(options["allow-window-focus"]),
      bringPageToFront: !options["no-page-bring-to-front"],
    });
  }

  if (command === "focus") {
    activation ??= await activateTarget(target, port, timeoutMs, {
      allowFocusEmulation: !options["no-focus-emulation"],
      allowWindowFocus: Boolean(options["allow-window-focus"]),
      bringPageToFront: !options["no-page-bring-to-front"],
    });
    print({
      target: { id: target.id, title: target.title, url: target.url },
      activation,
      page: activation.page,
    });
    return;
  }

  if (command === "heap-sampling") {
    if (
      typeof exactTargetOption !== "string" ||
      normalize(exactTargetOption) !== normalize(target.id)
    ) {
      throw new Error(
        "Heap sampling requires --target-exact <target ID> for a disposable target.",
      );
    }
    const action = String(options.action || "");
    if (action === "start") {
      const samplingInterval = integerOption(
        options,
        "sampling-interval",
        32768,
        1024,
        1 << 30,
      );
      const includeCollected =
        optionalBooleanOption(options, "include-collected") ?? false;
      await sendCdp(
        target.webSocketDebuggerUrl,
        "HeapProfiler.startSampling",
        {
          samplingInterval,
          includeObjectsCollectedByMajorGC: includeCollected,
          includeObjectsCollectedByMinorGC: includeCollected,
        },
        timeoutMs,
      );
      print({
        target: { id: target.id, title: target.title, url: target.url },
        heapSampling: { action, samplingInterval, includeCollected },
      });
      return;
    }
    if (action === "stop") {
      const limit = integerOption(options, "limit", 20, 1, 1000);
      const result = await sendCdp(
        target.webSocketDebuggerUrl,
        "HeapProfiler.stopSampling",
        {},
        timeoutMs,
      );
      const profile = result.profile || {};
      print({
        target: { id: target.id, title: target.title, url: target.url },
        heapSampling: {
          action,
          samples: Array.isArray(profile.samples) ? profile.samples.length : 0,
          top: summarizeSamplingProfile(profile, limit),
        },
      });
      return;
    }
    throw new Error("Heap sampling requires --action start or --action stop.");
  }

  if (command === "viewport" || command === "viewport-check") {
    if (
      typeof exactTargetOption !== "string" ||
      normalize(exactTargetOption) !== normalize(target.id)
    ) {
      throw new Error(
        "Viewport commands require --target-exact <target ID> for a disposable leased target.",
      );
    }
    const lease = activeKeepAliveLeaseForTarget(target.id);
    if (!lease) {
      throw new Error(
        "Viewport emulation requires an active keep-alive lease for the exact target.",
      );
    }
    let expectedViewport = null;
    if (command === "viewport") {
      const width = integerOption(options, "width", undefined, 1, 100000);
      const height = integerOption(options, "height", undefined, 1, 100000);
      const deviceScaleFactor = numberOption(
        options,
        "device-scale-factor",
        1,
        0.1,
        10,
      );
      const screenWidth = integerOption(
        options,
        "screen-width",
        width,
        1,
        100000,
      );
      const screenHeight = integerOption(
        options,
        "screen-height",
        height,
        1,
        100000,
      );
      expectedViewport = {
        width,
        height,
        deviceScaleFactor,
        screenWidth,
        screenHeight,
      };
    }
    const viewport =
      command === "viewport"
        ? await setViewportOnKeepAliveLease(
            lease,
            target.id,
            expectedViewport,
            timeoutMs,
          )
        : await readViewportFromKeepAliveLease(lease, target.id, timeoutMs);
    if (expectedViewport !== null) {
      const verificationError = viewportVerificationError(
        viewport,
        expectedViewport,
      );
      if (verificationError) {
        throw new Error(verificationError);
      }
    }
    print({
      target: { id: target.id, title: target.title, url: target.url },
      lease: { id: lease.id },
      operation: command === "viewport" ? "set-and-readback" : "readback-only",
      viewport,
      persistentSession: true,
    });
    return;
  }

  if (command === "eval") {
    const expression = options.stdin
      ? await readStdin()
      : positional.slice(1).join(" ");
    if (!expression) {
      throw new Error("Provide an expression or use --stdin");
    }
    const result = await sendCdp(
      target.webSocketDebuggerUrl,
      "Runtime.evaluate",
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      timeoutMs,
    );
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text ||
          "Runtime.evaluate failed",
      );
    }
    print({
      target: { id: target.id, title: target.title, url: target.url },
      result: result.result,
      exceptionDetails: result.exceptionDetails || null,
    });
    return;
  }

  if (command === "lifecycle") {
    const result = await runPageLifecycle(
      target.webSocketDebuggerUrl,
      options,
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      lifecycle: result,
    });
    return;
  }

  if (command === "inspect") {
    const elements = await evaluate(
      target.webSocketDebuggerUrl,
      inspectElementsExpression(Number(options.limit || 200)),
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      count: elements.length,
      elements,
    });
    return;
  }

  if (command === "hit-test") {
    const point = await resolvePoint(
      target.webSocketDebuggerUrl,
      options,
      timeoutMs,
    );
    const hitTest = await readHitTest(
      target.webSocketDebuggerUrl,
      point,
      resolvedTargetSelectorForHitTest(options, point),
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      hitTest,
    });
    return;
  }

  if (command === "cursor") {
    if (options.hide) {
      const result = await evaluate(
        target.webSocketDebuggerUrl,
        cursorExpression(0, 0, { hidden: true }),
        timeoutMs,
      );
      print({
        target: { id: target.id, title: target.title, url: target.url },
        cursor: result,
      });
      return;
    }
    const point = await resolvePoint(
      target.webSocketDebuggerUrl,
      options,
      timeoutMs,
    );
    const result = await evaluate(
      target.webSocketDebuggerUrl,
      cursorExpression(point.x, point.y),
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      cursor: { ...result, element: point },
    });
    return;
  }

  if (command === "click") {
    const point = await resolvePoint(
      target.webSocketDebuggerUrl,
      options,
      timeoutMs,
    );
    const resolvedTargetSelector = resolvedTargetSelectorForHitTest(
      options,
      point,
    );
    const hitBefore = await readHitTest(
      target.webSocketDebuggerUrl,
      point,
      resolvedTargetSelector,
      timeoutMs,
    );
    if (!clickHitAllowsDispatch(resolvedTargetSelector, hitBefore)) {
      throw new Error(
        `Selector click was not dispatched because its resolved target was not the top hit element: ${JSON.stringify(hitBefore)}`,
      );
    }
    await dispatchClick(target.webSocketDebuggerUrl, point, options, timeoutMs);
    print({
      target: { id: target.id, title: target.title, url: target.url },
      clicked: point,
      hitBefore,
      input: {
        button: mouseButton(options),
        modifiers: mouseModifiers(options),
        clickCount: integerOption(options, "click-count", 1, 1, 3),
        repeat: integerOption(options, "repeat", 1, 1, 10000),
        intervalMs: integerOption(options, "interval", 0, 0, 10000),
      },
    });
    return;
  }

  if (command === "move" || command === "hover") {
    const point = await resolvePoint(
      target.webSocketDebuggerUrl,
      options,
      timeoutMs,
    );
    await dispatchMouseMove(
      target.webSocketDebuggerUrl,
      point,
      options,
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      [command === "hover" ? "hovered" : "moved"]: point,
      modifiers: mouseModifiers(options),
    });
    return;
  }

  if (command === "drag") {
    const fromOptions = prefixedPointOptions(options, "from");
    const toOptions = prefixedPointOptions(options, "to");
    const from = await resolvePoint(
      target.webSocketDebuggerUrl,
      fromOptions,
      timeoutMs,
    );
    const to = await resolvePoint(
      target.webSocketDebuggerUrl,
      toOptions,
      timeoutMs,
    );
    const input = await dispatchDrag(
      target.webSocketDebuggerUrl,
      from,
      to,
      options,
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      dragged: { from, to },
      input,
    });
    return;
  }

  if (command === "pointer") {
    const type = pointerType(options);
    const action = pointerAction(options);
    let point = null;
    let from = null;
    let to = null;
    if (action === "drag") {
      const hasFromTouchPoints =
        type === "touch" && options["from-touch-points"] !== undefined;
      const hasToTouchPoints =
        type === "touch" && options["to-touch-points"] !== undefined;
      if (!hasFromTouchPoints) {
        from = await resolvePoint(
          target.webSocketDebuggerUrl,
          prefixedPointOptions(options, "from"),
          timeoutMs,
        );
      }
      if (!hasToTouchPoints) {
        to = await resolvePoint(
          target.webSocketDebuggerUrl,
          prefixedPointOptions(options, "to"),
          timeoutMs,
        );
      }
    } else if (type !== "touch" || options["touch-points"] === undefined) {
      point = await resolvePoint(
        target.webSocketDebuggerUrl,
        options,
        timeoutMs,
      );
    }
    const input = await dispatchPointerInput(
      target.webSocketDebuggerUrl,
      { point, from, to },
      options,
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      locations: { point, from, to },
      input,
    });
    return;
  }

  if (command === "type") {
    if (
      !options.selector &&
      !options.role &&
      !options.name &&
      !options.label &&
      !options.text
    ) {
      throw new Error("Provide --selector or a semantic locator for type");
    }
    const text = options.stdin
      ? await readStdin()
      : String(options.text || positional.slice(1).join(" "));
    if (!text) {
      throw new Error("Provide --text or use --stdin");
    }
    const locatorOptions = { ...options };
    delete locatorOptions.text;
    const point = await resolvePoint(
      target.webSocketDebuggerUrl,
      locatorOptions,
      timeoutMs,
    );
    await dispatchClick(target.webSocketDebuggerUrl, point, options, timeoutMs);
    if (options.clear) {
      await sendCdp(
        target.webSocketDebuggerUrl,
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 },
        timeoutMs,
      );
      await sendCdp(
        target.webSocketDebuggerUrl,
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 },
        timeoutMs,
      );
      await sendCdp(
        target.webSocketDebuggerUrl,
        "Input.dispatchKeyEvent",
        { type: "keyDown", key: "Backspace", code: "Backspace" },
        timeoutMs,
      );
      await sendCdp(
        target.webSocketDebuggerUrl,
        "Input.dispatchKeyEvent",
        { type: "keyUp", key: "Backspace", code: "Backspace" },
        timeoutMs,
      );
    }
    await sendCdp(
      target.webSocketDebuggerUrl,
      "Input.insertText",
      { text },
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      typed: {
        ...point,
        characterCount: text.length,
        cleared: Boolean(options.clear),
      },
    });
    return;
  }

  if (command === "wheel-probe") {
    if (
      typeof exactTargetOption !== "string" ||
      normalize(exactTargetOption) !== normalize(target.id)
    ) {
      throw new Error(
        "Wheel probe requires --target-exact <target ID> so the measured page cannot change during the sample.",
      );
    }
    const point = await resolvePoint(
      target.webSocketDebuggerUrl,
      options,
      timeoutMs,
    );
    const result = await runWheelProbe(target, point, options, timeoutMs);
    print({
      target: { id: target.id, title: target.title, url: target.url },
      probe: result,
    });
    if (!result.valid) {
      process.exitCode = 2;
    }
    return;
  }

  if (command === "scroll") {
    const x = Number(options.x || 0);
    const y = Number(options.y || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("Provide numeric --x or --y");
    }
    const result = await evaluate(
      target.webSocketDebuggerUrl,
      `(() => { window.scrollBy({ left: ${x}, top: ${y}, behavior: "instant" }); return { x: window.scrollX, y: window.scrollY }; })()`,
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      scroll: result,
    });
    return;
  }

  if (command === "navigate") {
    const url = String(options.url || positional[1] || "");
    if (
      !/^https?:\/\//i.test(url) &&
      !/^file:/i.test(url) &&
      !/^about:/i.test(url)
    ) {
      throw new Error("Provide an absolute --url");
    }
    const result = await sendCdp(
      target.webSocketDebuggerUrl,
      "Page.navigate",
      { url },
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      navigation: result,
      requestedUrl: url,
    });
    return;
  }

  if (command === "reload") {
    const result = await sendCdp(
      target.webSocketDebuggerUrl,
      "Page.reload",
      {
        ignoreCache: Boolean(options["ignore-cache"]),
      },
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      reload: result,
      ignoreCache: Boolean(options["ignore-cache"]),
    });
    return;
  }

  if (command === "wait") {
    if (
      !options.selector &&
      !options.url &&
      !options.role &&
      !options.name &&
      !options.label &&
      !options.text
    ) {
      throw new Error(
        "Provide --selector, --url, or a semantic locator for wait",
      );
    }
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        if (options.selector) {
          const selector = JSON.stringify(String(options.selector));
          const found = await evaluate(
            target.webSocketDebuggerUrl,
            `Boolean(document.querySelector(${selector}))`,
            Math.min(timeoutMs, 3000),
          );
          if (found) {
            print({
              target: { id: target.id, title: target.title, url: target.url },
              found: { selector: options.selector },
            });
            return;
          }
        } else if (options.url) {
          const currentUrl = await evaluate(
            target.webSocketDebuggerUrl,
            "location.href",
            Math.min(timeoutMs, 3000),
          );
          if (normalize(currentUrl).includes(normalize(options.url))) {
            print({
              target: { id: target.id, title: target.title, url: currentUrl },
              found: { url: options.url },
            });
            return;
          }
        } else {
          const point = await resolveSemanticPoint(
            target.webSocketDebuggerUrl,
            options,
            Math.min(timeoutMs, 3000),
          );
          print({
            target: { id: target.id, title: target.title, url: target.url },
            found: point,
          });
          return;
        }
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      `Wait condition timed out after ${timeoutMs}ms: ${lastError?.message || "not found"}`,
    );
  }

  if (command === "call") {
    const method = options.method;
    if (!method) {
      throw new Error("Provide --method");
    }
    const paramsSource = options.stdin
      ? await readStdin()
      : String(options.params || "{}");
    const params = JSON.parse(paramsSource || "{}");
    const result = await sendCdp(
      target.webSocketDebuggerUrl,
      method,
      params,
      timeoutMs,
    );
    print({
      target: { id: target.id, title: target.title, url: target.url },
      method,
      result,
      params,
    });
    return;
  }

  if (command === "screenshot") {
    const output = path.resolve(
      String(
        options.output || path.join(process.cwd(), "chrome-cdp-screenshot.png"),
      ),
    );
    const params = {
      format: "png",
      fromSurface: true,
      optimizeForSpeed: Boolean(options["optimize-for-speed"]),
    };
    const hasClipOption = ["x", "y", "width", "height", "scale"].some(
      (key) => options[key] !== undefined,
    );
    if (hasClipOption) {
      const x = Number(options.x ?? 0);
      const y = Number(options.y ?? 0);
      const width = Number(options.width);
      const height = Number(options.height);
      const scale = Number(options.scale ?? 1);
      if (
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(width) ||
        !Number.isFinite(height) ||
        !Number.isFinite(scale) ||
        width <= 0 ||
        height <= 0 ||
        scale <= 0
      ) {
        throw new Error(
          "Screenshot clip requires finite --x/--y, positive --width/--height, and positive --scale",
        );
      }
      params.clip = { x, y, width, height, scale };
      params.captureBeyondViewport = Boolean(
        options["capture-beyond-viewport"],
      );
    }
    const result = await sendCdp(
      target.webSocketDebuggerUrl,
      "Page.captureScreenshot",
      params,
      timeoutMs,
    );
    fs.writeFileSync(output, Buffer.from(result.data, "base64"));
    print({
      target: { id: target.id, title: target.title, url: target.url },
      output,
      clip: params.clip ?? null,
    });
    return;
  }

  throw new Error(
    "Unknown command. Run `node cdp.mjs --help` for the complete command list.",
  );
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
