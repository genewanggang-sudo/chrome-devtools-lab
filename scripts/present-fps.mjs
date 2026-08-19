#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PRESENTMON_VERSION = "2.5.1";
const PRESENTMON_URL =
  "https://github.com/GameTechDev/PresentMon/releases/download/v2.5.1/PresentMon-2.5.1-x64.exe";
const PRESENTMON_SHA256 =
  "9bec3083069f58f911e6a512f4806db51a27bd096103087bc1d05ef54c80a191";
const DEFAULT_TIMEOUT_MS = 60000;
const DEFAULT_PROBE_SECONDS = 1;
const DEFAULT_CAPTURE_EXTRA_SECONDS = 4;
const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const WHEEL_SCRIPT = path.join(SCRIPT_DIRECTORY, "wheel-benchmark.mjs");

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return { positional, options };
}

function numberOption(options, name, fallback, minimum, maximum) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid --${name}: ${options[name]}. Use a number from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function integerOption(options, name, fallback, minimum, maximum) {
  const value = numberOption(options, name, fallback, minimum, maximum);
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid --${name}: ${options[name]}. Use an integer.`);
  }
  return value;
}

function requiredOption(options, name) {
  const value = options[name];
  if (value === undefined || value === true || String(value).length === 0) {
    throw new Error(`The wheel operation requires --${name}.`);
  }
  return String(value);
}

function defaultToolPath() {
  const localAppData = process.env.LOCALAPPDATA || os.tmpdir();
  return path.join(
    localAppData,
    "CodexChromeDevToolsLab",
    "tools",
    `PresentMon-${PRESENTMON_VERSION}-x64.exe`,
  );
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function resolvePresentMon(options) {
  const explicit = options["presentmon-path"] || process.env.PRESENTMON_PATH;
  const filePath = path.resolve(String(explicit || defaultToolPath()));
  try {
    const hash = await sha256File(filePath);
    if (hash !== PRESENTMON_SHA256) {
      throw new Error(
        `PresentMon hash mismatch at ${filePath}: expected ${PRESENTMON_SHA256}, got ${hash}`,
      );
    }
    return { path: filePath, downloaded: false, sha256: hash };
  } catch (error) {
    if (explicit || options["no-download"] === true) throw error;
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const response = await fetch(PRESENTMON_URL);
  if (!response.ok) {
    throw new Error(`PresentMon download failed with HTTP ${response.status}`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  const hash = createHash("sha256").update(data).digest("hex");
  if (hash !== PRESENTMON_SHA256) {
    throw new Error(
      `Downloaded PresentMon hash mismatch: expected ${PRESENTMON_SHA256}, got ${hash}`,
    );
  }
  await fs.writeFile(filePath, data, { flag: "wx" }).catch(async (error) => {
    if (error.code !== "EEXIST") throw error;
    const existingHash = await sha256File(filePath);
    if (existingHash !== PRESENTMON_SHA256) throw error;
  });
  return { path: filePath, downloaded: true, sha256: hash };
}

function runProcess(command, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ exitCode: null, signal: "timeout", stdout, stderr });
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}${error.message}`,
      });
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}

function presentMonPermissionError(result) {
  const text = `${result.stdout}\n${result.stderr}`;
  return /access denied|failed to start trace session|performance log users|elevated privilege/i.test(
    text,
  );
}

function inspectPresentMonVersion(executable) {
  const result = spawnSync(executable, ["--help"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  const version = text.match(/PresentMon\s+([0-9.]+)/i)?.[1] || null;
  return {
    version,
    executableExitCode: result.status,
    helpAvailable: version !== null,
    output: text.trim().slice(0, 2000),
  };
}

async function probe(options) {
  const tool = await resolvePresentMon(options);
  const version = inspectPresentMonVersion(tool.path);
  const sessionName = `CodexChromeDevToolsLabProbe-${randomUUID()}`;
  const seconds = numberOption(
    options,
    "probe-seconds",
    DEFAULT_PROBE_SECONDS,
    0.5,
    30,
  );
  const capture = await runProcess(
    tool.path,
    [
      "--timed",
      String(seconds),
      "--terminate_after_timed",
      "--no_csv",
      "--no_console_stats",
      "--session_name",
      sessionName,
    ],
    Math.max(DEFAULT_TIMEOUT_MS, (seconds + 5) * 1000),
  );
  const permissionDenied = presentMonPermissionError(capture);
  return {
    backend: "PresentMon",
    executable: tool,
    version,
    permission: {
      available: !permissionDenied && capture.exitCode === 0,
      exitCode: capture.exitCode,
      permissionDenied,
      stdout: capture.stdout.trim().slice(-2000),
      stderr: capture.stderr.trim().slice(-4000),
    },
    repair: permissionDenied
      ? {
          required: true,
          action:
            "加入 Performance Log Users 组后重新登录，或以管理员权限运行该采集命令；插件不会自动提权。",
          command:
            "net localgroup \"Performance Log Users\" <your-user> /add",
        }
      : null,
  };
}

function powershellJson(script) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "PowerShell failed").trim());
  }
  return JSON.parse(result.stdout.trim());
}

function discoverChromeGpuProcess(options) {
  const marker = String(
    options["user-data-dir-marker"] ||
      process.env.CODEX_CDP_USER_DATA_DIR_MARKER ||
      "CodexChromeCDP",
  );
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const script = String.raw`
$ErrorActionPreference = "Stop"
$marker = '${escapedMarker}'
$process = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
  Where-Object { $_.CommandLine -match '--type=gpu-process' -and $_.CommandLine -match $marker } |
  Sort-Object ProcessId | Select-Object -First 1)
if ($process.Count -eq 0) { throw "Dedicated Chrome GPU process was not found for marker $marker" }
[pscustomobject]@{ processId = [int]$process[0].ProcessId; commandLine = [string]$process[0].CommandLine } | ConvertTo-Json -Compress
`;
  return powershellJson(script);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (character === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else cell += character;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell.replace(/\r$/, ""));
    rows.push(row);
  }
  if (rows.length === 0) return [];
  const headers = rows[0].map((header) => header.replace(/^\uFEFF/, "").trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
}

function cell(row, names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  const wanted = names.map((name) => name.toLowerCase());
  const key = Object.keys(row).find((candidate) =>
    wanted.includes(candidate.toLowerCase()),
  );
  return key ? row[key] : "";
}

function numericCell(row, names) {
  const raw = String(cell(row, names)).trim();
  if (!raw || /^na$/i.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function dateCell(row) {
  const raw = String(cell(row, ["CPUStartDateTime"])).trim();
  if (!raw || /^na$/i.test(raw)) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function analyzePresentCsv(csv, { processId, wheel }) {
  const rows = parseCsv(csv);
  const allProcessRows = rows.filter(
    (row) => String(cell(row, ["ProcessID", "ProcessId"])).trim() === String(processId),
  );
  const displayedRows = allProcessRows.filter(
    (row) => numericCell(row, ["DisplayedTime"]) !== null,
  );
  const wallClock = wheel?.input?.wallClock;
  const startEpochMs = Number(wallClock?.dispatchStartEpochMs);
  const endEpochMs = Number(wallClock?.dispatchEndEpochMs);
  const hasWindow =
    Number.isFinite(startEpochMs) &&
    Number.isFinite(endEpochMs) &&
    endEpochMs > startEpochMs;
  const frameRecords = displayedRows
    .map((row) => {
      const cpuTime = dateCell(row);
      const untilDisplayed = numericCell(row, ["MsUntilDisplayed"]);
      const displayedAt =
        cpuTime === null
          ? null
          : cpuTime + (untilDisplayed === null ? 0 : untilDisplayed);
      return {
        row,
        displayedAt,
        intervalMs: numericCell(row, ["MsBetweenDisplayChange"]),
      };
    })
    .filter(
      (record) =>
        record.displayedAt !== null &&
        (!hasWindow ||
          (record.displayedAt >= startEpochMs && record.displayedAt <= endEpochMs)),
    )
    .sort((left, right) => left.displayedAt - right.displayedAt);
  const timestamps = frameRecords.map((record) => record.displayedAt);
  const intervals = frameRecords
    .map((record) => record.intervalMs)
    .filter((value) => value !== null && value > 0);
  const derivedIntervals = [];
  for (let index = 1; index < timestamps.length; index += 1) {
    derivedIntervals.push(timestamps[index] - timestamps[index - 1]);
  }
  const intervalValues = intervals.length > 0 ? intervals : derivedIntervals;
  const durationMs = hasWindow
    ? endEpochMs - startEpochMs
    : timestamps.length > 1
      ? timestamps.at(-1) - timestamps[0]
      : null;
  const averageFps =
    durationMs !== null && durationMs > 0
      ? (frameRecords.length * 1000) / durationMs
      : null;
  return {
    valid: hasWindow && frameRecords.length > 0,
    source: "PresentMon ETW DisplayTime/MsBetweenDisplayChange",
    isFinalDisplayPresentFps: true,
    processId,
    totalProcessRows: allProcessRows.length,
    displayedFrameCount: frameRecords.length,
    submittedFrameCount: allProcessRows.length,
    droppedFrameCount: Math.max(0, allProcessRows.length - displayedRows.length),
    window: {
      applied: hasWindow,
      startEpochMs: hasWindow ? startEpochMs : null,
      endEpochMs: hasWindow ? endEpochMs : null,
      durationMs,
    },
    averageFps,
    meanInterFrameFps:
      intervalValues.length > 0
        ? 1000 / (intervalValues.reduce((sum, value) => sum + value, 0) / intervalValues.length)
        : null,
    p50FrameIntervalMs: percentile(intervalValues, 0.5),
    p95FrameIntervalMs: percentile(intervalValues, 0.95),
    maxFrameIntervalMs:
      intervalValues.length > 0 ? Math.max(...intervalValues) : null,
    longFrameCount: intervalValues.filter((value) => value > 16.667).length,
    invalidReasons: [
      ...(hasWindow ? [] : ["wheel-wall-clock-window-missing"]),
      ...(frameRecords.length > 0 ? [] : ["presentmon-no-displayed-frames-for-target"]),
    ],
  };
}

function pushOption(args, name, value) {
  if (value !== undefined && value !== true && value !== null) {
    args.push(`--${name}`, String(value));
  }
}

function wheelArguments(options, output, traceOutput) {
  const args = [WHEEL_SCRIPT];
  for (const name of [
    "target-exact",
    "x",
    "y",
    "count",
    "duration",
    "delta-y",
    "settle",
    "timeout",
    "max-dispatch-error",
    "expected-dpr",
    "expected-viewport-width",
    "expected-viewport-height",
    "expected-canvas-x",
    "expected-canvas-y",
    "expected-canvas-width",
    "expected-canvas-height",
  ]) {
    pushOption(args, name, options[name]);
  }
  pushOption(args, "output", output);
  pushOption(args, "trace-output", traceOutput);
  return args;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function wheel(options) {
  const targetId = requiredOption(options, "target-exact");
  const durationMs = integerOption(options, "duration", 2000, 100, 600000);
  const extraSeconds = numberOption(
    options,
    "capture-extra-seconds",
    DEFAULT_CAPTURE_EXTRA_SECONDS,
    1,
    60,
  );
  const tool = await resolvePresentMon(options);
  const permissionProbe = await probe({
    ...options,
    "presentmon-path": tool.path,
    "probe-seconds": options["probe-seconds"] ?? 1,
  });
  if (!permissionProbe.permission.available) {
    return {
      schemaVersion: 1,
      valid: false,
      blocked: true,
      blockedReason: "presentmon-permission-unavailable",
      target: { id: targetId },
      realFps: {
        valid: false,
        source: "PresentMon ETW",
        isFinalDisplayPresentFps: true,
        averageFps: null,
        invalidReasons: ["presentmon-permission-unavailable"],
      },
      presentMon: permissionProbe,
    };
  }

  const gpuProcess = options["process-id"]
    ? { processId: integerOption(options, "process-id", undefined, 1, 1000000) }
    : discoverChromeGpuProcess(options);
  const workDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "chrome-devtools-lab-present-fps-"),
  );
  const wheelOutput = path.join(workDirectory, "wheel.json");
  const wheelTrace = path.join(workDirectory, "wheel.trace.json");
  const csvOutput = path.join(workDirectory, "presentmon.csv");
  const captureSeconds = Math.max(
    5,
    Math.ceil(durationMs / 1000 + extraSeconds),
  );
  const sessionName = `CodexChromeDevToolsLab-${randomUUID()}`;
  const presentMonArgs = [
    "--process_id",
    String(gpuProcess.processId),
    "--output_file",
    csvOutput,
    "--date_time",
    "--write_display_metadata",
    "--timed",
    String(captureSeconds),
    "--terminate_after_timed",
    "--no_console_stats",
    "--session_name",
    sessionName,
  ];
  const presentMonPromise = runProcess(
    tool.path,
    presentMonArgs,
    (captureSeconds + 15) * 1000,
  );
  const wheelPromise = runProcess(
    process.execPath,
    wheelArguments(options, wheelOutput, wheelTrace),
    integerOption(options, "timeout", DEFAULT_TIMEOUT_MS, 1000, 600000) +
      30000,
  );
  const [wheelProcess, presentMonProcess] = await Promise.all([
    wheelPromise,
    presentMonPromise,
  ]);
  const wheelResult = await readJson(wheelOutput).catch(() => null);
  const csv = await fs.readFile(csvOutput, "utf8").catch(() => "");
  const realFps = analyzePresentCsv(csv, {
    processId: gpuProcess.processId,
    wheel: wheelResult,
  });
  const valid =
    wheelProcess.exitCode === 0 &&
    presentMonProcess.exitCode === 0 &&
    wheelResult?.valid === true &&
    realFps.valid;
  return {
    schemaVersion: 1,
    valid,
    blocked: false,
    target: wheelResult?.target || { id: targetId },
    realFps: {
      ...realFps,
      valid,
      evidenceValid: realFps.valid,
      sampleContractValid: wheelResult?.valid === true,
    },
    presentMon: {
      ...permissionProbe,
      capture: {
        executable: tool.path,
        processId: gpuProcess.processId,
        processCommandLine: gpuProcess.commandLine || null,
        csvPath: csvOutput,
        captureSeconds,
        exitCode: presentMonProcess.exitCode,
        stderr: presentMonProcess.stderr.trim().slice(-4000),
      },
    },
    wheel: wheelResult,
    artifacts: {
      directory: workDirectory,
      wheelResult: wheelOutput,
      wheelTrace,
      presentMonCsv: csvOutput,
    },
  };
}

function print(value, outputPath) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (outputPath) {
    return fs
      .mkdir(path.dirname(path.resolve(outputPath)), { recursive: true })
      .then(() => fs.writeFile(path.resolve(outputPath), text, "utf8"))
      .then(() => process.stdout.write(text));
  }
  process.stdout.write(text);
  return Promise.resolve();
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const operation = positional[0] || "probe";
  const result =
    operation === "probe"
      ? await probe(options)
      : operation === "wheel"
        ? await wheel(options)
        : (() => {
            throw new Error(`Unknown operation ${operation}; use probe or wheel.`);
          })();
  await print(result, typeof options.output === "string" ? options.output : null);
  if (result.valid === false && result.blocked !== true) process.exitCode = 2;
  if (result.blocked === true) process.exitCode = 3;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
