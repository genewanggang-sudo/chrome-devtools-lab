#!/usr/bin/env node
import fs from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

function argumentsOf(argv) {
  if (argv.includes("--help") || argv.includes("-h"))
    return { command: "help", options: {} };
  const command = argv[0] ?? "help",
    options = {};
  for (let i = 1; i < argv.length; i++) {
    if (!argv[i].startsWith("--"))
      throw new Error(`Unexpected argument: ${argv[i]}`);
    const key = argv[i].slice(2);
    options[key] =
      argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return { command, options };
}

function publicState(state) {
  return JSON.stringify(
    state,
    (key, value) => (key === "controlToken" ? undefined : value),
    2,
  );
}

async function configOf(options) {
  const { validateRecording } = await import("./performance-recorder.mjs");
  const config = options.config
    ? JSON.parse(
        await fs.readFile(path.resolve(String(options.config)), "utf8"),
      )
    : {};
  for (const [option, key] of [
    ["target-exact", "targetId"],
    ["output-dir", "outputDir"],
    ["host", "host"],
    ["url", "url"],
    ["cache", "cache"],
    ["until", "stopWhen"],
    ["revision", "applicationRevision"],
  ]) {
    if (options[option] !== undefined) config[key] = String(options[option]);
  }
  for (const [option, key] of [
    ["port", "port"],
    ["duration", "durationMs"],
    ["max-duration", "maxDurationMs"],
    ["stable", "stableMs"],
    ["poll", "pollMs"],
    ["buffer-mb", "bufferMb"],
  ]) {
    if (options[option] !== undefined) config[key] = Number(options[option]);
  }
  if (options.screenshots !== undefined) {
    if (![true, "true", "false"].includes(options.screenshots))
      throw new Error("--screenshots must be true or false.");
    config.screenshots = options.screenshots !== "false";
  }
  if (options.reload) config.action = "reload";
  if (options.navigate) config.action = "navigate";
  return validateRecording(config);
}

async function readState(directory) {
  return JSON.parse(
    await fs.readFile(path.join(directory, "session.json"), "utf8"),
  );
}

async function waitState(directory, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    try {
      state = await readState(directory);
      if (predicate(state)) return state;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Recorder did not reach expected state within ${timeoutMs}ms. Last state: ${publicState(state)}. Check recorder.log.`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = argumentsOf(argv);
  if (command === "help" || options.help) {
    console.log(
      `Chrome Performance\n\nNative Performance panel (preferred):\n  open --target-exact ID [--port 9333]\n  native-start --target-exact ID [--port 9333]\n  native-stop --target-exact ID [--port 9333]\n  native-status --target-exact ID [--port 9333]\n  analyze-current --target-exact ID --output-dir NEW_DIR [--port 9333]\n\nAutomatic recording without opening the panel:\n  start --target-exact ID --output-dir NEW_DIR [--reload] [--port 9333]\n  stop --session DIR\n  status --session DIR\n  record --config scenario.json\n  record --target-exact ID --output-dir NEW_DIR --reload --until "window.appReady === true"\n\nExisting recording query:\n  analyze --input trace.json --output report.json [--capture capture.json] [--start-ms 0 --end-ms 5000]\n\nThe panel commands operate Chrome's own Performance UI; analyze-current reads its current completed recording.\nDo not run a panel and automatic recorder at the same time.\nAutomatic start returns while recording continues; stop flushes trace.json and capture.json.\nrecord stops on a stable condition (default 500ms), duration, or deadline.\nDefault diagnostic tracks include JS sampling, loading and screenshots; GPU events are not hardware GPU time.\n--screenshots false omits automatic filmstrip capture; output directories must be new.\n--cache disable-http affects HTTP caching only; persistent app/upstream caches remain.\n`,
    );
    console.log(
      "Analysis defaults: native tree roots and Bottom-up hotspots only. Add --expand-call-tree for call chains, bounded by --max-nodes 100 --max-depth 10. Read summary.json first; report.json and trace.json retain detailed evidence. Analysis stdout contains paths, coverage and five hotspots only.",
    );
    console.log("One-call native reload diagnosis: native-record --config project-scenario.json. The config supplies targetId, outputDir, stopWhen, optional initScript, observationExpression and analysisQueries. Reuses Chrome's native parsed recording without a second parse, saves and prints the first summary before archiving the full raw trace. Progress goes to stderr; run.json separates firstSummaryMs, native processing, query, export and totalMs. Query boundaries also accept --start-mark NAME --end-mark NAME.");
    return;
  }
  if (command === "native-record") {
    const allowed = new Set(["config", "target-exact", "output-dir", "until", "host", "port", "stable", "poll", "max-duration"]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown native-record option: --${key}`);
    const config = options.config ? JSON.parse(await fs.readFile(path.resolve(String(options.config)), "utf8")) : {};
    for (const [option, key] of [["target-exact", "targetId"], ["output-dir", "outputDir"], ["until", "stopWhen"], ["host", "host"]]) {
      if (options[option] !== undefined) config[key] = String(options[option]);
    }
    for (const [option, key] of [["port", "port"], ["stable", "stableMs"], ["poll", "pollMs"], ["max-duration", "maxDurationMs"]]) {
      if (options[option] !== undefined) config[key] = Number(options[option]);
    }
    const { NativePerformanceRun } = await import("./native-performance-run.mjs");
    const result = await new NativePerformanceRun(config).run();
    console.log(JSON.stringify(result, null, 2));
    if (!result.valid) process.exitCode = 1;
    return result;
  }
  if (
    [
      "open",
      "native-start",
      "native-stop",
      "native-status",
      "analyze-current",
    ].includes(command)
  ) {
    const { main: panel } = await import("./performance-panel.mjs");
    if (command !== "analyze-current")
      return panel([command.replace("native-", ""), ...argv.slice(1)]);
    if (typeof options["output-dir"] !== "string")
      throw new Error("analyze-current requires --output-dir NEW_DIR.");
    const queryKeys = {
      "start-ms": "startMs", "end-ms": "endMs",
      "start-mark": "startMark", "end-mark": "endMark", "frame-id": "frameId",
      pid: "pid", tid: "tid", "max-nodes": "maxNodes", "max-depth": "maxDepth",
    };
    const allowed = new Set(["target-exact", "output-dir", "host", "port", "timeout", "expand-call-tree", ...Object.keys(queryKeys)]);
    for (const key of Object.keys(options)) if (!allowed.has(key)) throw new Error(`Unknown analyze-current option: --${key}`);
    const queryOptions = {};
    if (options["expand-call-tree"] !== undefined) {
      if (![true, "true", "false"].includes(options["expand-call-tree"])) throw new Error("--expand-call-tree must be true or false.");
      queryOptions.expandCallTree = options["expand-call-tree"] !== "false";
    }
    for (const [key, queryKey] of Object.entries(queryKeys)) {
      if (options[key] !== undefined) {
        if (options[key] === true) throw new Error(`--${key} requires a value.`);
        queryOptions[queryKey] = options[key];
      }
    }
    const { NativePerformancePanel } = await import("./performance-panel.mjs");
    const { NativePerformanceTraceSession } = await import("./native-performance-analysis.mjs");
    const { PerformanceSummary } = await import("./performance-analysis.mjs");
    const nativePanel = new NativePerformancePanel({ targetId: options["target-exact"],
      host: options.host, port: options.port, timeoutMs: options.timeout });
    const started = performance.now();
    const directory = path.resolve(options["output-dir"]);
    await fs.mkdir(path.dirname(directory), { recursive: true });
    await fs.mkdir(directory);
    const raw = path.join(directory, "trace.json");
    const resultPath = path.join(directory, "result.json");
    let session, summary, analysisError;
    try {
      await nativePanel.connect();
      const capture = { ...await nativePanel.inspect(), target: nativePanel.target };
      try {
        session = await NativePerformanceTraceSession.open({ panel: nativePanel, capture });
        const report = await session.query({ ...queryOptions, targetId: options["target-exact"], output: path.join(directory, "report.json") });
        const firstPass = new PerformanceSummary(report).reportSummary();
        summary = { status: "analyzed", archiveStatus: "pending", outputDir: directory,
          artifacts: report.artifacts, panelTargetId: nativePanel.panelTargetId,
          window: report.window, scope: report.scope, coverage: report.coverage,
          processing: report.processing, firstSummaryMs: performance.now() - started,
          javascriptHotspots: firstPass.javascriptHotspots.slice(0, 5),
          truncatedNativeTrees: firstPass.truncation.nativeTrees.length };
        await fs.writeFile(resultPath, JSON.stringify(summary, null, 2));
        console.error(`[native-performance] summary ${JSON.stringify(summary)}`);
      } catch (error) {
        analysisError = error;
        throw error;
      } finally {
        try {
          console.error("[native-performance] archive complete raw recording");
          const exported = await nativePanel.exportTrace(raw);
          if (session) await session.archive(exported);
          if (summary) {
            summary.status = "complete";
            summary.archiveStatus = "complete";
            summary.capture = exported;
            summary.analysisTimings = session.timings;
            summary.totalMs = performance.now() - started;
            await fs.writeFile(resultPath, JSON.stringify(summary, null, 2));
          }
        } catch (archiveError) {
          if (analysisError) throw new AggregateError([analysisError, archiveError], `Native analysis failed (${analysisError.message}); raw archive failed (${archiveError.message}).`);
          throw archiveError;
        }
      }
      console.log(JSON.stringify(summary, null, 2));
      return summary;
    } catch (error) {
      if (summary) {
        summary.status = "failed";
        summary.error = error.message;
        summary.totalMs = performance.now() - started;
        await fs.writeFile(resultPath, JSON.stringify(summary, null, 2));
      }
      throw error;
    } finally {
      await session?.close();
      nativePanel.close();
    }
  }
  if (command === "analyze") {
    const { main: analyze } = await import("./devtools-performance.mjs");
    return analyze(["analyze", ...argv.slice(1)]);
  }
  if (command === "__record") {
    const { PerformanceRecorder } = await import("./performance-recorder.mjs");
    const config = JSON.parse(
      await fs.readFile(String(options.config), "utf8"),
    );
    const recorder = new PerformanceRecorder(config);
    process.on("SIGINT", () => recorder.requestStop("manual"));
    process.on("SIGTERM", () => recorder.requestStop("manual"));
    const capture = await recorder.run();
    console.log(
      JSON.stringify({
        valid: capture.valid,
        outputDir: config.outputDir,
        stopReason: capture.stopReason,
      }),
    );
    if (!capture.valid) process.exitCode = 1;
    return capture;
  }
  if (command === "start" || command === "record") {
    const config = await configOf(options);
    await fs.mkdir(path.dirname(config.outputDir), { recursive: true });
    await fs.mkdir(config.outputDir);
    const configPath = path.join(config.outputDir, "recording-config.json");
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), {
      flag: "wx",
    });
    const descriptor = openSync(
      path.join(config.outputDir, "recorder.log"),
      "wx",
    );
    const worker = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "__record", "--config", configPath],
      {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", descriptor, descriptor],
      },
    );
    closeSync(descriptor);
    let spawnError;
    worker.once("error", (error) => {
      spawnError = error;
    });
    worker.unref();
    const state = await waitState(
      config.outputDir,
      (x) => ["recording", "complete", "failed"].includes(x.status),
      60000,
    );
    if (spawnError) throw spawnError;
    console.log(publicState(state));
    if (command === "record") {
      const end = await waitState(
        config.outputDir,
        (x) => ["complete", "failed"].includes(x.status),
        config.maxDurationMs + 180000,
      );
      console.log(JSON.stringify(end, null, 2));
      if (!end.valid) process.exitCode = 1;
      return end;
    }
    if (state.status === "failed") process.exitCode = 1;
    return state;
  }
  if (command === "stop" || command === "status") {
    if (typeof options.session !== "string")
      throw new Error("--session recording-directory is required.");
    const directory = path.resolve(options.session),
      state = await readState(directory);
    if (command === "stop" && state.status === "recording") {
      const response = await fetch(
        `http://127.0.0.1:${state.controlPort}/stop`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${state.controlToken}` },
          signal: AbortSignal.timeout(10000),
        },
      );
      if (!response.ok)
        throw new Error(`Stop request failed: HTTP ${response.status}`);
    }
    const result =
      command === "stop"
        ? await waitState(
            directory,
            (x) => ["complete", "failed"].includes(x.status),
            180000,
          )
        : state;
    console.log(publicState(result));
    if (result.status === "failed") process.exitCode = 1;
    return result;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.stack ?? error);
    process.exitCode = 1;
  });
}
