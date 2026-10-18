# Start the dedicated CDP Chrome so it survives the teardown of the calling shell.
#
# `cdp.mjs start` launches Chrome as a child of the current shell. When a host
# tears that shell down (task runner, agent step, CI job), Windows can take the
# browser with it. Win32_Process.Create parents the browser to WmiPrvSE instead,
# so the dedicated instance keeps running for the next command.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/start-chrome-detached.ps1
#
# Reuses an existing listener on the same port and never touches the user's
# normal Chrome profile.

param(
  [int]$Port = 9333,
  [string]$UserDataDir = (Join-Path $env:LOCALAPPDATA 'CodexChromeCDP'),
  [string]$ChromePath = 'C:\Program Files\Google\Chrome\Application\chrome.exe',
  [string]$StartUrl = 'about:blank',
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

function Write-Result($message) {
  if (-not $Quiet) { Write-Output $message }
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($listener) {
  Write-Result "already listening on $Port (pid $($listener[0].OwningProcess))"
  return
}

if (-not (Test-Path $ChromePath)) {
  throw "Chrome not found at $ChromePath; pass -ChromePath"
}

$arguments = @(
  '--remote-debugging-address=127.0.0.1'
  "--remote-debugging-port=$Port"
  "--user-data-dir=`"$UserDataDir`""
  '--no-first-run'
  '--no-default-browser-check'
  '--disable-background-timer-throttling'
  '--disable-renderer-backgrounding'
  '--disable-backgrounding-occluded-windows'
  '--disable-features=CalculateNativeWinOcclusion'
  $StartUrl
) -join ' '

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = "`"$ChromePath`" $arguments"
}
if ($result.ReturnValue -ne 0) {
  throw "Win32_Process.Create failed with $($result.ReturnValue)"
}

for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $version = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    Write-Result "started pid=$($result.ProcessId) browser=$($version.Browser) ws=$($version.webSocketDebuggerUrl)"
    return
  }
  catch { }
}

throw "chrome started as pid $($result.ProcessId) but the CDP endpoint never answered on $Port"
