import process from "node:process";
import { spawn } from "node:child_process";

const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

function readStdin() {
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

function validateRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("Native wheel request must be an object.");
  }
  const point = request.viewportPoint;
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("Native wheel request requires viewportPoint.x/y.");
  }
  const viewport = request.viewport;
  if (!viewport || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) || !Number.isFinite(viewport.dpr)) {
    throw new Error("Native wheel request requires viewport width, height, and dpr.");
  }
  if (viewport.width <= 0 || viewport.height <= 0 || viewport.dpr <= 0) {
    throw new Error("Native wheel viewport values must be positive.");
  }
  if (point.x < 0 || point.x >= viewport.width || point.y < 0 || point.y >= viewport.height) {
    throw new Error("Native wheel viewportPoint is outside the viewport.");
  }
  if (!Number.isInteger(request.processId) || request.processId <= 0) {
    throw new Error("Native wheel request requires a positive processId.");
  }
  if (!Number.isSafeInteger(request.foregroundWindowHandle) || request.foregroundWindowHandle <= 0) {
    throw new Error("Native wheel request requires a positive foregroundWindowHandle.");
  }
  const preflightOnly = request.preflightOnly === true;
  if (!Array.isArray(request.events)) {
    throw new Error("Native wheel request requires an events array.");
  }
  if (!preflightOnly && request.events.length === 0) {
    throw new Error("Native wheel request requires at least one event.");
  }
  if (preflightOnly && request.events.length !== 0) {
    throw new Error("Native wheel preflight requires an empty events array.");
  }
  let previousOffset = -1;
  for (const [index, event] of request.events.entries()) {
    if (!Number.isFinite(event?.offsetMilliseconds) || event.offsetMilliseconds < 0) {
      throw new Error(`Native wheel event ${index} has an invalid offset.`);
    }
    if (event.offsetMilliseconds < previousOffset) {
      throw new Error("Native wheel event offsets must be monotonic.");
    }
    if (!Number.isInteger(event.deltaY) || event.deltaY === 0 || Math.abs(event.deltaY) > 10000) {
      throw new Error(`Native wheel event ${index} has an invalid deltaY.`);
    }
    previousOffset = event.offsetMilliseconds;
  }
  const timeoutMs = Number(request.timeoutMs ?? previousOffset + 5000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Native wheel timeout must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS} milliseconds.`);
  }
  return { ...request, preflightOnly, timeoutMs };
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$processId = [int]$request.processId
$expectedForegroundWindow = [IntPtr][long]$request.foregroundWindowHandle
$viewportX = [double]$request.viewportPoint.x
$viewportY = [double]$request.viewportPoint.y
$viewportWidth = [double]$request.viewport.width
$viewportHeight = [double]$request.viewport.height
$devicePixelRatio = [double]$request.viewport.dpr
$events = @($request.events)
$preflightOnly = [bool]$request.preflightOnly

Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class CodexNativeWheel {
    public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);

    [StructLayout(LayoutKind.Sequential)]
    public struct Point {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MouseInput {
        public int Dx;
        public int Dy;
        public uint MouseData;
        public uint Flags;
        public uint Time;
        public UIntPtr ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Input {
        public uint Type;
        public MouseInput Mouse;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct Rect {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MonitorInfo {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool BringWindowToTop(IntPtr window);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr window, System.Text.StringBuilder text, int maximumCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr window, ref Point point);

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetClipCursor(out Rect rect);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ClipCursor(ref Rect rect);

    [DllImport("user32.dll")]
    public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    public static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, Input[] inputs, int size);

    public static readonly uint MouseInputType = 0;
    public static readonly uint MouseWheelFlag = 0x0800;

    public static int ForegroundProcessId() {
        uint processId;
        GetWindowThreadProcessId(GetForegroundWindow(), out processId);
        return (int)processId;
    }

    public static void SendWheel(int deltaY) {
        var input = new Input[1];
        input[0].Type = MouseInputType;
        input[0].Mouse.MouseData = unchecked((uint)deltaY);
        input[0].Mouse.Flags = MouseWheelFlag;
        if (SendInput(1, input, Marshal.SizeOf(typeof(Input))) != 1) {
            throw new InvalidOperationException("SendInput returned zero.");
        }
    }
}
"@

[void][CodexNativeWheel]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not [CodexNativeWheel]::IsWindow($expectedForegroundWindow)) {
    throw "Expected Chrome foreground window is no longer valid."
}
$targetProcessId = [uint32]0
$targetThread = [CodexNativeWheel]::GetWindowThreadProcessId($expectedForegroundWindow, [ref]$targetProcessId)
if ($targetProcessId -ne $processId) {
    throw "Expected Chrome window belongs to PID $targetProcessId instead of $processId."
}
$foregroundWindowBefore = [CodexNativeWheel]::GetForegroundWindow()
$foregroundProcessIdBefore = [uint32]0
$foregroundThread = [CodexNativeWheel]::GetWindowThreadProcessId($foregroundWindowBefore, [ref]$foregroundProcessIdBefore)
$currentThread = [CodexNativeWheel]::GetCurrentThreadId()
$attachedForeground = $false
$attachedTarget = $false
$broughtToTop = $true
$setForeground = $true
try {
    if ($foregroundWindowBefore -ne $expectedForegroundWindow) {
        if ($foregroundThread -ne 0 -and $foregroundThread -ne $currentThread) {
            $attachedForeground = [CodexNativeWheel]::AttachThreadInput($currentThread, $foregroundThread, $true)
        }
        if ($targetThread -ne 0 -and $targetThread -ne $currentThread -and $targetThread -ne $foregroundThread) {
            $attachedTarget = [CodexNativeWheel]::AttachThreadInput($currentThread, $targetThread, $true)
        }
        $broughtToTop = [CodexNativeWheel]::BringWindowToTop($expectedForegroundWindow)
        $setForeground = [CodexNativeWheel]::SetForegroundWindow($expectedForegroundWindow)
        Start-Sleep -Milliseconds 50
    }
} finally {
    if ($attachedTarget) {
        [void][CodexNativeWheel]::AttachThreadInput($currentThread, $targetThread, $false)
    }
    if ($attachedForeground) {
        [void][CodexNativeWheel]::AttachThreadInput($currentThread, $foregroundThread, $false)
    }
}
$foregroundWindow = [CodexNativeWheel]::GetForegroundWindow()
$focusLease = [pscustomobject]@{
    foregroundWindowBefore = [long]$foregroundWindowBefore
    foregroundProcessIdBefore = [int]$foregroundProcessIdBefore
    expectedWindow = [long]$expectedForegroundWindow
    reactivationRequired = $foregroundWindowBefore -ne $expectedForegroundWindow
    attachedForeground = [bool]$attachedForeground
    attachedTarget = [bool]$attachedTarget
    broughtToTop = [bool]$broughtToTop
    setForeground = [bool]$setForeground
    foregroundWindowAfter = [long]$foregroundWindow
    exactWindowAfter = $foregroundWindow -eq $expectedForegroundWindow
}
if ($foregroundWindow -ne $expectedForegroundWindow) {
    throw "Could not establish the exact Chrome foreground window inside the native input process."
}
$foregroundProcessId = [CodexNativeWheel]::ForegroundProcessId()
if ($foregroundProcessId -ne $processId) {
    throw "Foreground process $foregroundProcessId does not match dedicated Chrome process $processId."
}
$expectedWidth = [int][Math]::Round($viewportWidth * $devicePixelRatio)
$expectedHeight = [int][Math]::Round($viewportHeight * $devicePixelRatio)
$candidates = New-Object System.Collections.Generic.List[object]
[void][CodexNativeWheel]::EnumChildWindows($foregroundWindow, {
    param($window, $parameter)
    if (-not [CodexNativeWheel]::IsWindowVisible($window)) { return $true }
    $className = New-Object System.Text.StringBuilder 256
    [void][CodexNativeWheel]::GetClassName($window, $className, $className.Capacity)
    if ($className.ToString() -ne "Chrome_RenderWidgetHostHWND") { return $true }
    $windowProcessId = [uint32]0
    [void][CodexNativeWheel]::GetWindowThreadProcessId($window, [ref]$windowProcessId)
    if ($windowProcessId -ne $processId) { return $true }
    $rect = New-Object CodexNativeWheel+Rect
    if (-not [CodexNativeWheel]::GetClientRect($window, [ref]$rect)) { return $true }
    $origin = New-Object CodexNativeWheel+Point
    $origin.X = 0
    $origin.Y = 0
    if (-not [CodexNativeWheel]::ClientToScreen($window, [ref]$origin)) { return $true }
    $width = [int]($rect.Right - $rect.Left)
    $height = [int]($rect.Bottom - $rect.Top)
    if ([Math]::Abs($width - $expectedWidth) -le 4 -and [Math]::Abs($height - $expectedHeight) -le 4) {
        $candidates.Add([pscustomobject]@{
            handle = [long]$window
            className = $className.ToString()
            left = [int]$origin.X
            top = [int]$origin.Y
            width = $width
            height = $height
        })
    }
    return $true
}, [IntPtr]::Zero)
if ($candidates.Count -ne 1) {
    throw "Expected one visible Chrome_RenderWidgetHostHWND matching the requested viewport, found $($candidates.Count)."
}
$renderWidget = $candidates[0]
$monitorHandle = [CodexNativeWheel]::MonitorFromWindow([IntPtr][long]$renderWidget.handle, 2)
$monitorInfo = New-Object CodexNativeWheel+MonitorInfo
$monitorInfo.Size = [Runtime.InteropServices.Marshal]::SizeOf([type][CodexNativeWheel+MonitorInfo])
if (-not [CodexNativeWheel]::GetMonitorInfo($monitorHandle, [ref]$monitorInfo)) {
    throw "GetMonitorInfo failed."
}
$renderRight = $renderWidget.left + $renderWidget.width
$renderBottom = $renderWidget.top + $renderWidget.height
if ($renderWidget.left -lt $monitorInfo.Monitor.Left -or $renderWidget.top -lt $monitorInfo.Monitor.Top -or $renderRight -gt $monitorInfo.Monitor.Right -or $renderBottom -gt $monitorInfo.Monitor.Bottom) {
    throw "The Chrome render widget crosses monitor boundaries."
}
$screenX = [int][Math]::Round($renderWidget.left + $viewportX * $devicePixelRatio)
$screenY = [int][Math]::Round($renderWidget.top + $viewportY * $devicePixelRatio)
if ($screenX -lt $renderWidget.left -or $screenX -ge $renderRight -or $screenY -lt $renderWidget.top -or $screenY -ge $renderBottom) {
    throw "Resolved native wheel point is outside the Chrome render widget."
}
if ($preflightOnly) {
    [pscustomobject]@{
        preflightOnly = $true
        sentCount = 0
        requestedCount = 0
        elapsedMilliseconds = 0
        maximumScheduleErrorMilliseconds = 0
        foregroundProcessId = $foregroundProcessId
        foregroundWindowHandle = [long]$foregroundWindow
        focusLease = $focusLease
        screenPoint = [pscustomobject]@{ x = $screenX; y = $screenY }
        cursorLockedDuringDispatch = $false
        renderWidget = $renderWidget
        windowDpi = [int][CodexNativeWheel]::GetDpiForWindow([IntPtr][long]$renderWidget.handle)
        monitor = [pscustomobject]@{
            left = [int]$monitorInfo.Monitor.Left
            top = [int]$monitorInfo.Monitor.Top
            right = [int]$monitorInfo.Monitor.Right
            bottom = [int]$monitorInfo.Monitor.Bottom
        }
    } | ConvertTo-Json -Compress
    exit 0
}
$previousCursorClip = New-Object CodexNativeWheel+Rect
if (-not [CodexNativeWheel]::GetClipCursor([ref]$previousCursorClip)) {
    throw "GetClipCursor failed."
}
$measurementCursorClip = New-Object CodexNativeWheel+Rect
$measurementCursorClip.Left = $screenX
$measurementCursorClip.Top = $screenY
$measurementCursorClip.Right = $screenX + 1
$measurementCursorClip.Bottom = $screenY + 1
if (-not [CodexNativeWheel]::ClipCursor([ref]$measurementCursorClip)) {
    throw "ClipCursor failed before native wheel dispatch."
}
$result = $null
try {
    if (-not [CodexNativeWheel]::SetCursorPos($screenX, $screenY)) {
        throw "SetCursorPos failed."
    }
    Start-Sleep -Milliseconds 20
    $cursor = New-Object CodexNativeWheel+Point
    if (-not [CodexNativeWheel]::GetCursorPos([ref]$cursor) -or $cursor.X -ne $screenX -or $cursor.Y -ne $screenY) {
        throw "Cursor position did not match the locked native wheel point: expected ($screenX,$screenY), actual ($($cursor.X),$($cursor.Y))."
    }
    if ([CodexNativeWheel]::GetForegroundWindow() -ne $foregroundWindow) {
        throw "Foreground window changed before native wheel dispatch."
    }

    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    $sentCount = 0
    $maximumScheduleErrorMs = 0.0
    foreach ($event in $events) {
        $dueMs = [double]$event.offsetMilliseconds
        $remainingMs = $dueMs - $stopwatch.Elapsed.TotalMilliseconds
        if ($remainingMs -gt 0) {
            [Threading.Thread]::Sleep([int][Math]::Floor($remainingMs))
            do {
                $remainingMs = $dueMs - $stopwatch.Elapsed.TotalMilliseconds
                if ($remainingMs -gt 0) { [Threading.Thread]::SpinWait(1000) }
            } while ($remainingMs -gt 0)
        }
        $scheduleErrorMs = [Math]::Abs($stopwatch.Elapsed.TotalMilliseconds - $dueMs)
        if ($scheduleErrorMs -gt $maximumScheduleErrorMs) { $maximumScheduleErrorMs = $scheduleErrorMs }
        if ([CodexNativeWheel]::GetForegroundWindow() -ne $expectedForegroundWindow) {
            throw "Foreground window changed during native wheel dispatch at event $sentCount."
        }
        [CodexNativeWheel]::SendWheel([int]$event.deltaY)
        $sentCount++
    }
    $stopwatch.Stop()
    $result = [pscustomobject]@{
        sentCount = $sentCount
        requestedCount = $events.Count
        elapsedMilliseconds = $stopwatch.Elapsed.TotalMilliseconds
        maximumScheduleErrorMilliseconds = $maximumScheduleErrorMs
        foregroundProcessId = $foregroundProcessId
        foregroundWindowHandle = [long]$foregroundWindow
        focusLease = $focusLease
        preflightOnly = $false
        screenPoint = [pscustomobject]@{ x = $screenX; y = $screenY }
        cursorLockedDuringDispatch = $true
        renderWidget = $renderWidget
        windowDpi = [int][CodexNativeWheel]::GetDpiForWindow([IntPtr][long]$renderWidget.handle)
        monitor = [pscustomobject]@{
            left = [int]$monitorInfo.Monitor.Left
            top = [int]$monitorInfo.Monitor.Top
            right = [int]$monitorInfo.Monitor.Right
            bottom = [int]$monitorInfo.Monitor.Bottom
        }
    }
} finally {
    if (-not [CodexNativeWheel]::ClipCursor([ref]$previousCursorClip)) {
        throw "Failed to restore the previous cursor clipping rectangle."
    }
}
$result | ConvertTo-Json -Compress
`;

export function runPowerShellNativeWheel(request) {
  const validated = validateRequest(request);
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => reject(new Error(`PowerShell native wheel failed to start: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`PowerShell native wheel failed with ${signal ? `signal ${signal}` : `code ${code}`}: ${(stderr || stdout).trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (error) {
        reject(new Error(`PowerShell native wheel returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify(validated));
  });
}

async function main() {
  const request = JSON.parse(await readStdin());
  const result = await runPowerShellNativeWheel(request);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && process.argv[1].endsWith("windows-native-wheel.mjs")) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
