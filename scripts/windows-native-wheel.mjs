import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  if (request.selfTest === true) {
    return { selfTest: true, timeoutMs: 30000 };
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
$selfTest = [bool]$request.selfTest

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
    public static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr window, out Rect rect);

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
    public static readonly uint GetAncestorParent = 1;
    public static readonly uint GetAncestorRoot = 2;

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
            throw new InvalidOperationException("SendInput returned zero. Win32Error=" + Marshal.GetLastWin32Error() + ".");
        }
    }
}
"@

function Get-WindowClassName([IntPtr]$window) {
    $className = New-Object System.Text.StringBuilder 256
    [void][CodexNativeWheel]::GetClassName($window, $className, $className.Capacity)
    return $className.ToString()
}

function Get-WindowParentChain([IntPtr]$window) {
    $chain = New-Object System.Collections.Generic.List[object]
    $current = $window
    $seen = New-Object 'System.Collections.Generic.HashSet[long]'
    for ($depth = 0; $depth -lt 64 -and $current -ne [IntPtr]::Zero; $depth++) {
        $handle = [long]$current
        if (-not ($seen.Add($handle))) { break }
        $windowProcessId = [uint32]0
        [void][CodexNativeWheel]::GetWindowThreadProcessId($current, [ref]$windowProcessId)
        [void]$chain.Add([pscustomobject]@{
            handle = $handle
            className = Get-WindowClassName $current
            processId = [int]$windowProcessId
            visible = [bool][CodexNativeWheel]::IsWindowVisible($current)
        })
        $current = [CodexNativeWheel]::GetAncestor($current, [CodexNativeWheel]::GetAncestorParent)
    }
    return $chain.ToArray()
}

function Get-PhysicalHitAudit(
    [object]$candidate,
    [IntPtr]$expectedRoot,
    [int]$expectedProcessId,
    [double]$viewportPointX,
    [double]$viewportPointY,
    [double]$dpr
) {
    $candidateWindow = [IntPtr][long]$candidate.handle
    $rejectReasons = New-Object System.Collections.Generic.List[string]
    $clientRect = New-Object CodexNativeWheel+Rect
    $clientRectValid = [CodexNativeWheel]::GetClientRect($candidateWindow, [ref]$clientRect)
    $clientWidth = if ($clientRectValid) { [int]($clientRect.Right - $clientRect.Left) } else { $null }
    $clientHeight = if ($clientRectValid) { [int]($clientRect.Bottom - $clientRect.Top) } else { $null }
    if (-not $clientRectValid) { [void]$rejectReasons.Add("candidate-client-rect-unavailable") }

    $windowRect = New-Object CodexNativeWheel+Rect
    $windowRectValid = [CodexNativeWheel]::GetWindowRect($candidateWindow, [ref]$windowRect)
    $candidateRoot = [CodexNativeWheel]::GetAncestor($candidateWindow, [CodexNativeWheel]::GetAncestorRoot)
    if ($candidateRoot -ne $expectedRoot) { [void]$rejectReasons.Add("candidate-root-mismatch") }
    if (-not [CodexNativeWheel]::IsWindow($candidateWindow)) { [void]$rejectReasons.Add("candidate-invalid") }
    if (-not [CodexNativeWheel]::IsWindowVisible($candidateWindow)) { [void]$rejectReasons.Add("candidate-not-visible") }
    $candidateProcessId = [uint32]0
    [void][CodexNativeWheel]::GetWindowThreadProcessId($candidateWindow, [ref]$candidateProcessId)
    if ($candidateProcessId -ne $expectedProcessId) { [void]$rejectReasons.Add("candidate-process-mismatch") }

    $clientPoint = New-Object CodexNativeWheel+Point
    $clientPoint.X = [int][Math]::Round($viewportPointX * $dpr)
    $clientPoint.Y = [int][Math]::Round($viewportPointY * $dpr)
    if ($clientRectValid -and ($clientPoint.X -lt 0 -or $clientPoint.X -ge $clientWidth -or $clientPoint.Y -lt 0 -or $clientPoint.Y -ge $clientHeight)) {
        [void]$rejectReasons.Add("candidate-client-point-outside")
    }
    $screenPoint = New-Object CodexNativeWheel+Point
    $screenPoint.X = $clientPoint.X
    $screenPoint.Y = $clientPoint.Y
    $screenPointValid = [CodexNativeWheel]::ClientToScreen($candidateWindow, [ref]$screenPoint)
    if (-not $screenPointValid) { [void]$rejectReasons.Add("candidate-client-to-screen-failed") }

    $hitWindow = if ($screenPointValid) { [CodexNativeWheel]::WindowFromPoint($screenPoint) } else { [IntPtr]::Zero }
    if ($hitWindow -eq [IntPtr]::Zero) { [void]$rejectReasons.Add("physical-point-hit-no-window") }
    $hitRoot = if ($hitWindow -ne [IntPtr]::Zero) { [CodexNativeWheel]::GetAncestor($hitWindow, [CodexNativeWheel]::GetAncestorRoot) } else { [IntPtr]::Zero }
    if ($hitRoot -ne $expectedRoot) { [void]$rejectReasons.Add("physical-point-hit-root-mismatch") }
    $parentChain = if ($hitWindow -ne [IntPtr]::Zero) { @(Get-WindowParentChain $hitWindow) } else { @() }
    $nearestRenderWidget = $parentChain | Where-Object { $_.className -eq "Chrome_RenderWidgetHostHWND" } | Select-Object -First 1
    if ($null -eq $nearestRenderWidget) {
        [void]$rejectReasons.Add("physical-point-hit-render-widget-missing")
    } elseif ([long]$nearestRenderWidget.handle -ne [long]$candidate.handle) {
        [void]$rejectReasons.Add("physical-point-hit-different-render-widget")
    }

    return [pscustomobject]@{
        handle = [long]$candidate.handle
        className = $candidate.className
        processId = [int]$candidateProcessId
        visible = [bool][CodexNativeWheel]::IsWindowVisible($candidateWindow)
        clientRect = [pscustomobject]@{
            valid = [bool]$clientRectValid
            left = 0
            top = 0
            width = $clientWidth
            height = $clientHeight
        }
        windowRect = [pscustomobject]@{
            valid = [bool]$windowRectValid
            left = if ($windowRectValid) { [int]$windowRect.Left } else { $null }
            top = if ($windowRectValid) { [int]$windowRect.Top } else { $null }
            right = if ($windowRectValid) { [int]$windowRect.Right } else { $null }
            bottom = if ($windowRectValid) { [int]$windowRect.Bottom } else { $null }
        }
        clientPoint = [pscustomobject]@{ x = [int]$clientPoint.X; y = [int]$clientPoint.Y }
        screenPoint = [pscustomobject]@{
            valid = [bool]$screenPointValid
            x = if ($screenPointValid) { [int]$screenPoint.X } else { $null }
            y = if ($screenPointValid) { [int]$screenPoint.Y } else { $null }
        }
        candidateRoot = [long]$candidateRoot
        hitWindow = [long]$hitWindow
        hitRoot = [long]$hitRoot
        parentChain = $parentChain
        nearestRenderWidget = if ($null -eq $nearestRenderWidget) { $null } else { [long]$nearestRenderWidget.handle }
        rejectReasons = @($rejectReasons)
        physicalHitWinner = $rejectReasons.Count -eq 0
    }
}

function Resolve-PhysicalHitSelection([object[]]$candidateAudits) {
    $physicalHitWinners = @($candidateAudits | Where-Object { $_.physicalHitWinner -eq $true })
    return [pscustomobject]@{
        winnerCount = $physicalHitWinners.Count
        selectedHandle = if ($physicalHitWinners.Count -eq 1) { [long]$physicalHitWinners[0].handle } else { $null }
        selectionReason = if ($physicalHitWinners.Count -eq 1) { "unique-physical-hit-render-widget" } elseif ($physicalHitWinners.Count -eq 0) { "no-physical-hit-render-widget" } else { "ambiguous-physical-hit-render-widgets" }
        winners = $physicalHitWinners
    }
}

function Convert-PhysicalHitAuditForOutput([object]$audit) {
    if ($null -eq $audit) { return $null }
    $parentChain = @(
        foreach ($entry in @($audit.parentChain)) {
            [ordered]@{
                handle = [long]$entry.handle
                className = [string]$entry.className
                processId = [int]$entry.processId
                visible = [bool]$entry.visible
            }
        }
    )
    $output = [ordered]@{
        handle = [long]$audit.handle
        className = [string]$audit.className
        processId = [int]$audit.processId
        visible = [bool]$audit.visible
        clientRect = [ordered]@{
            valid = [bool]$audit.clientRect.valid
            left = if ($null -eq $audit.clientRect.left) { $null } else { [int]$audit.clientRect.left }
            top = if ($null -eq $audit.clientRect.top) { $null } else { [int]$audit.clientRect.top }
            width = if ($null -eq $audit.clientRect.width) { $null } else { [int]$audit.clientRect.width }
            height = if ($null -eq $audit.clientRect.height) { $null } else { [int]$audit.clientRect.height }
        }
        windowRect = [ordered]@{
            valid = [bool]$audit.windowRect.valid
            left = if ($null -eq $audit.windowRect.left) { $null } else { [int]$audit.windowRect.left }
            top = if ($null -eq $audit.windowRect.top) { $null } else { [int]$audit.windowRect.top }
            right = if ($null -eq $audit.windowRect.right) { $null } else { [int]$audit.windowRect.right }
            bottom = if ($null -eq $audit.windowRect.bottom) { $null } else { [int]$audit.windowRect.bottom }
        }
        clientPoint = [ordered]@{ x = [int]$audit.clientPoint.x; y = [int]$audit.clientPoint.y }
        screenPoint = [ordered]@{
            valid = [bool]$audit.screenPoint.valid
            x = if ($null -eq $audit.screenPoint.x) { $null } else { [int]$audit.screenPoint.x }
            y = if ($null -eq $audit.screenPoint.y) { $null } else { [int]$audit.screenPoint.y }
        }
        candidateRoot = [long]$audit.candidateRoot
        hitWindow = [long]$audit.hitWindow
        hitRoot = [long]$audit.hitRoot
        parentChain = $parentChain
        nearestRenderWidget = if ($null -eq $audit.nearestRenderWidget) { $null } else { [long]$audit.nearestRenderWidget }
        rejectReasons = @($audit.rejectReasons | ForEach-Object { [string]$_ })
        physicalHitWinner = [bool]$audit.physicalHitWinner
    }
    return ,$output
}

function Compare-DispatchAudit(
    [object]$initialAudit,
    [object]$currentAudit,
    [long]$expectedForegroundWindow,
    [long]$currentForegroundWindow,
    [long]$expectedForegroundRoot,
    [long]$currentForegroundRoot
) {
    $rejectReasons = New-Object System.Collections.Generic.List[string]
    foreach ($reason in @($currentAudit.rejectReasons)) { [void]$rejectReasons.Add([string]$reason) }
    if ($currentForegroundWindow -ne $expectedForegroundWindow) { [void]$rejectReasons.Add("dispatch-foreground-window-changed") }
    if ($currentForegroundRoot -ne $expectedForegroundRoot) { [void]$rejectReasons.Add("dispatch-foreground-root-changed") }
    if ([long]$currentAudit.handle -ne [long]$initialAudit.handle) { [void]$rejectReasons.Add("dispatch-selected-handle-changed") }
    if ([int]$currentAudit.clientRect.width -ne [int]$initialAudit.clientRect.width -or [int]$currentAudit.clientRect.height -ne [int]$initialAudit.clientRect.height) {
        [void]$rejectReasons.Add("dispatch-client-size-changed")
    }
    if ([bool]$currentAudit.screenPoint.valid -ne [bool]$initialAudit.screenPoint.valid -or [int]$currentAudit.screenPoint.x -ne [int]$initialAudit.screenPoint.x -or [int]$currentAudit.screenPoint.y -ne [int]$initialAudit.screenPoint.y) {
        [void]$rejectReasons.Add("dispatch-screen-point-changed")
    }
    if ([bool]$currentAudit.windowRect.valid -ne [bool]$initialAudit.windowRect.valid -or
        [int]$currentAudit.windowRect.left -ne [int]$initialAudit.windowRect.left -or
        [int]$currentAudit.windowRect.top -ne [int]$initialAudit.windowRect.top -or
        [int]$currentAudit.windowRect.right -ne [int]$initialAudit.windowRect.right -or
        [int]$currentAudit.windowRect.bottom -ne [int]$initialAudit.windowRect.bottom) {
        [void]$rejectReasons.Add("dispatch-window-rect-changed")
    }
    return [pscustomobject]@{
        passed = $rejectReasons.Count -eq 0
        sentCountBeforeRecheck = 0
        expectedForegroundWindow = $expectedForegroundWindow
        actualForegroundWindow = $currentForegroundWindow
        expectedForegroundRoot = $expectedForegroundRoot
        actualForegroundRoot = $currentForegroundRoot
        rejectReasons = @($rejectReasons)
        audit = $currentAudit
    }
}

function Get-DispatchRecheck(
    [object]$initialAudit,
    [object]$candidate,
    [IntPtr]$expectedWindow,
    [IntPtr]$expectedRoot,
    [int]$expectedProcessId,
    [double]$viewportPointX,
    [double]$viewportPointY,
    [double]$dpr
) {
    $currentForegroundWindow = [CodexNativeWheel]::GetForegroundWindow()
    $currentForegroundRoot = if ($currentForegroundWindow -ne [IntPtr]::Zero) { [CodexNativeWheel]::GetAncestor($currentForegroundWindow, [CodexNativeWheel]::GetAncestorRoot) } else { [IntPtr]::Zero }
    $currentAudit = Get-PhysicalHitAudit $candidate $expectedRoot $expectedProcessId $viewportPointX $viewportPointY $dpr
    return Compare-DispatchAudit $initialAudit $currentAudit ([long]$expectedWindow) ([long]$currentForegroundWindow) ([long]$expectedRoot) ([long]$currentForegroundRoot)
}

function Assert-SelfTest([bool]$condition, [string]$message) {
    if (-not $condition) { throw "Native wheel self-test failed: $message" }
}

if ($selfTest) {
    $winner = [pscustomobject]@{ handle = 101; physicalHitWinner = $true; rejectReasons = @() }
    $loser = [pscustomobject]@{ handle = 102; physicalHitWinner = $false; rejectReasons = @("physical-point-hit-root-mismatch") }
    $unique = Resolve-PhysicalHitSelection @($winner, $loser)
    Assert-SelfTest ($unique.winnerCount -eq 1 -and $unique.selectedHandle -eq 101 -and $unique.selectionReason -eq "unique-physical-hit-render-widget") "unique physical hit selection"
    $none = Resolve-PhysicalHitSelection @($loser)
    Assert-SelfTest ($none.winnerCount -eq 0 -and $null -eq $none.selectedHandle -and $none.selectionReason -eq "no-physical-hit-render-widget") "no physical hit rejection"
    $ambiguous = Resolve-PhysicalHitSelection @($winner, [pscustomobject]@{ handle = 103; physicalHitWinner = $true; rejectReasons = @() })
    Assert-SelfTest ($ambiguous.winnerCount -eq 2 -and $null -eq $ambiguous.selectedHandle -and $ambiguous.selectionReason -eq "ambiguous-physical-hit-render-widgets") "ambiguous physical hit rejection"

    $initialAudit = [pscustomobject]@{
        handle = 101
        rejectReasons = @()
        clientRect = [pscustomobject]@{ width = 1200; height = 800 }
        screenPoint = [pscustomobject]@{ valid = $true; x = 640; y = 480 }
        windowRect = [pscustomobject]@{ valid = $true; left = 0; top = 0; right = 1216; bottom = 839 }
    }
    $sameAudit = $initialAudit | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    $stable = Compare-DispatchAudit $initialAudit $sameAudit 500 500 500 500
    Assert-SelfTest ($stable.passed -eq $true -and $stable.sentCountBeforeRecheck -eq 0) "stable dispatch audit"
    $movedAudit = $initialAudit | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    $movedAudit.screenPoint.x = 650
    $moved = Compare-DispatchAudit $initialAudit $movedAudit 500 500 500 500
    Assert-SelfTest ($moved.passed -eq $false -and $moved.rejectReasons -contains "dispatch-screen-point-changed") "screen point drift rejection"
    $switched = Compare-DispatchAudit $initialAudit $sameAudit 500 501 500 501
    Assert-SelfTest ($switched.passed -eq $false -and $switched.rejectReasons -contains "dispatch-foreground-window-changed" -and $switched.rejectReasons -contains "dispatch-foreground-root-changed") "foreground drift rejection"
    [pscustomobject]@{
        selfTest = $true
        passed = $true
        cases = @("unique-winner", "no-winner", "ambiguous-winners", "stable-dispatch", "screen-point-drift", "foreground-drift")
    } | ConvertTo-Json -Compress
    exit 0
}

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
$expectedForegroundRoot = [CodexNativeWheel]::GetAncestor($expectedForegroundWindow, [CodexNativeWheel]::GetAncestorRoot)
if ($expectedForegroundRoot -ne $expectedForegroundWindow) {
    throw "Expected Chrome foreground window is not its own root window."
}
$candidates = New-Object System.Collections.Generic.List[object]
[void][CodexNativeWheel]::EnumChildWindows($foregroundWindow, {
    param($window, $parameter)
    if (-not [CodexNativeWheel]::IsWindowVisible($window)) { return $true }
    $className = Get-WindowClassName $window
    if ($className -ne "Chrome_RenderWidgetHostHWND") { return $true }
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
        [void]$candidates.Add([pscustomobject]@{
            handle = [long]$window
            className = $className
            left = [int]$origin.X
            top = [int]$origin.Y
            width = $width
            height = $height
        })
    }
    return $true
}, [IntPtr]::Zero)
$candidateAudits = @(
    foreach ($candidate in $candidates) {
        Get-PhysicalHitAudit $candidate $expectedForegroundRoot $processId $viewportX $viewportY $devicePixelRatio
    }
)
$selection = Resolve-PhysicalHitSelection $candidateAudits
$physicalHitWinners = @($selection.winners)
$targetingCandidates = @($candidateAudits | ForEach-Object {
    [pscustomobject]@{
        handle = [long]$_.handle
        className = [string]$_.className
        processId = [int]$_.processId
        visible = [bool]$_.visible
        candidateRoot = [long]$_.candidateRoot
        hitWindow = [long]$_.hitWindow
        hitRoot = [long]$_.hitRoot
        nearestRenderWidget = if ($null -eq $_.nearestRenderWidget) { $null } else { [long]$_.nearestRenderWidget }
        rejectReasons = @($_.rejectReasons | ForEach-Object { [string]$_ })
        physicalHitWinner = [bool]$_.physicalHitWinner
    }
})
$targeting = [ordered]@{
    expectedForegroundRoot = [long]$expectedForegroundRoot
    expectedProcessId = $processId
    expectedPhysicalViewport = [pscustomobject]@{ width = $expectedWidth; height = $expectedHeight }
    viewportPoint = [pscustomobject]@{ x = $viewportX; y = $viewportY; dpr = $devicePixelRatio }
    candidates = $targetingCandidates
    winnerCount = $selection.winnerCount
    selectedHandle = $selection.selectedHandle
    selectionReason = $selection.selectionReason
    dispatchRecheck = $null
}
if ($physicalHitWinners.Count -ne 1) {
    $targetingJson = $targeting | ConvertTo-Json -Compress -Depth 12
    throw "Expected one physical-hit Chrome_RenderWidgetHostHWND matching the requested viewport, found $($physicalHitWinners.Count) winners from $($candidates.Count) size candidates. Targeting=$targetingJson"
}
$selectedAudit = $physicalHitWinners[0]
$renderWidget = $candidates | Where-Object { [long]$_.handle -eq [long]$selectedAudit.handle } | Select-Object -First 1
if ($null -eq $renderWidget) {
    throw "Selected render widget was not present in the size-matched candidate set."
}
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
$screenX = [int]$selectedAudit.screenPoint.x
$screenY = [int]$selectedAudit.screenPoint.y
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
        targeting = $targeting
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
    $targeting.dispatchRecheck = Get-DispatchRecheck $selectedAudit $renderWidget $expectedForegroundWindow $expectedForegroundRoot $processId $viewportX $viewportY $devicePixelRatio
    if (-not $targeting.dispatchRecheck.passed) {
        $targetingJson = $targeting | ConvertTo-Json -Compress -Depth 14
        throw "Native wheel dispatch recheck failed before sending input. Targeting=$targetingJson"
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
        targeting = $targeting
        windowDpi = [int][CodexNativeWheel]::GetDpiForWindow([IntPtr][long]$renderWidget.handle)
        monitor = [pscustomobject]@{
            left = [int]$monitorInfo.Monitor.Left
            top = [int]$monitorInfo.Monitor.Top
            right = [int]$monitorInfo.Monitor.Right
            bottom = [int]$monitorInfo.Monitor.Bottom
        }
    }
} catch {
    $dispatchError = $_
} finally {
    if (-not [CodexNativeWheel]::ClipCursor([ref]$previousCursorClip)) {
        $restoreError = "Failed to restore the previous cursor clipping rectangle. Win32Error=$([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }
}
if ($null -ne $dispatchError) {
    if ($null -ne $restoreError) { throw "$($dispatchError.Exception.Message) CleanupError=$restoreError" }
    throw $dispatchError
}
if ($null -ne $restoreError) {
    throw $restoreError
}
$result | ConvertTo-Json -Compress
`;

export async function runPowerShellNativeWheel(request) {
  const validated = validateRequest(request);
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "chrome-devtools-lab-native-wheel-"),
  );
  const scriptPath = path.join(temporaryDirectory, "native-wheel.ps1");

  try {
    // Windows PowerShell 5.1 reliably detects generated UTF-8 scripts with a BOM.
    await writeFile(scriptPath, `\uFEFF${POWERSHELL_SCRIPT}`, {
      encoding: "utf8",
      flag: "wx",
    });

    return await new Promise((resolve, reject) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ],
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      let startError = null;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        // Wait for close before resolving the outer promise so finally can safely remove the script.
        startError = error;
      });
      child.once("close", (code, signal) => {
        if (startError) {
          reject(new Error(`PowerShell native wheel failed to start: ${startError.message}`));
          return;
        }
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
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (process.argv.includes("--self-test")) {
    const result = await runPowerShellNativeWheel({ selfTest: true });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
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
