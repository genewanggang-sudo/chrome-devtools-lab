#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compareCanvasAnchors } from "./canvas-anchor.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const CDP_SCRIPT = path.join(SCRIPT_DIRECTORY, "cdp.mjs");
const WHEEL_SCRIPT = path.join(SCRIPT_DIRECTORY, "wheel-benchmark.mjs");
const ANALYZE_SCRIPT = path.join(SCRIPT_DIRECTORY, "analyze-trace.mjs");
const FPS_OVERLAY_SCRIPT = path.join(SCRIPT_DIRECTORY, "fps-overlay.mjs");
const CONFIG_SCHEMA_VERSION = 1;
const CAPTURE_SCHEMA_VERSION = 5;
const ANALYSIS_SCHEMA_VERSION = 2;
const DEFAULT_SAMPLE = Object.freeze({
  rounds: 3,
  count: 120,
  durationMs: 4000,
  deltaY: 40,
  settleMs: 500,
  postFrames: 12,
  showFpsCounter: true,
  fpsCounterHoldMs: 1000,
  skipMidpointScreenshot: true,
});

class ConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigurationError";
  }
}

class ContractError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "ContractError";
    this.details = details;
  }
}

class ChildProcessError extends Error {
  constructor(label, exitCode, stderr) {
    super(
      `${label} failed with exit code ${String(exitCode)}${
        stderr ? `: ${stderr}` : "."
      }`,
    );
    this.name = "ChildProcessError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

class ValueChecks {
  static isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  static allowedKeys(value, keys, location) {
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) {
        throw new ConfigurationError(
          `${location} contains unsupported field "${key}".`,
        );
      }
    }
  }

  static string(value, location) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new ConfigurationError(`${location} must be a non-empty string.`);
    }
    return value;
  }

  static boolean(value, location) {
    if (typeof value !== "boolean") {
      throw new ConfigurationError(`${location} must be boolean.`);
    }
    return value;
  }

  static integer(value, location, minimum, maximum) {
    if (
      !Number.isInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw new ConfigurationError(
        `${location} must be an integer from ${minimum} to ${maximum}.`,
      );
    }
    return value;
  }

  static number(value, location, minimum, maximum) {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new ConfigurationError(
        `${location} must be a number from ${minimum} to ${maximum}.`,
      );
    }
    return value;
  }

  static optionalInteger(value, fallback, location, minimum, maximum) {
    return ValueChecks.integer(
      value === undefined ? fallback : value,
      location,
      minimum,
      maximum,
    );
  }

  static optionalNumber(value, fallback, location, minimum, maximum) {
    return ValueChecks.number(
      value === undefined ? fallback : value,
      location,
      minimum,
      maximum,
    );
  }

  static optionalBoolean(value, fallback, location) {
    return value === undefined
      ? fallback
      : ValueChecks.boolean(value, location);
  }
}

class CliArguments {
  static parse(argv) {
    const result = { selfTest: false, configPath: null, outputDirectory: null };
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === "--self-test") {
        result.selfTest = true;
        continue;
      }
      if (token !== "--config" && token !== "--output-dir") {
        throw new Error(
          `Unknown argument "${token}". Use --config <absolute-json> --output-dir <dir> or --self-test.`,
        );
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${token} requires a value.`);
      }
      if (token === "--config") result.configPath = value;
      else result.outputDirectory = value;
      index += 1;
    }
    if (result.selfTest && (result.configPath || result.outputDirectory)) {
      throw new Error("--self-test cannot be combined with run options.");
    }
    if (!result.selfTest) {
      if (!result.configPath) {
        throw new Error("Missing --config <absolute-json>.");
      }
      if (!result.outputDirectory) {
        throw new Error("Missing --output-dir <dir>.");
      }
      if (!path.isAbsolute(result.configPath)) {
        throw new Error("--config must be an absolute JSON path.");
      }
    }
    return result;
  }
}

class ComparisonConfig {
  constructor(value) {
    this.schemaVersion = value.schemaVersion;
    this.sample = value.sample;
    this.targets = value.targets;
    this.environment = value.environment;
  }

  static async load(filePath) {
    let rawText;
    try {
      rawText = await fs.readFile(filePath, "utf8");
    } catch (error) {
      throw new ConfigurationError(
        `Cannot read config ${filePath}: ${error.message}`,
      );
    }
    let raw;
    try {
      raw = JSON.parse(rawText);
    } catch (error) {
      throw new ConfigurationError(
        `Config ${filePath} is not valid JSON: ${error.message}`,
      );
    }
    return new ComparisonConfig(ComparisonConfig.normalize(raw));
  }

  static fromObject(raw) {
    return new ComparisonConfig(ComparisonConfig.normalize(raw));
  }

  static normalize(raw) {
    if (!ValueChecks.isObject(raw)) {
      throw new ConfigurationError("Config root must be an object.");
    }
    ValueChecks.allowedKeys(
      raw,
      ["schemaVersion", "sample", "targets", "environment"],
      "Config",
    );
    if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
      throw new ConfigurationError(
        `Config schemaVersion must be ${CONFIG_SCHEMA_VERSION}.`,
      );
    }
    if (!Array.isArray(raw.targets) || raw.targets.length !== 2) {
      throw new ConfigurationError("Config targets must contain exactly two targets.");
    }
    const sample = ComparisonConfig.normalizeSample(raw.sample);
    const targets = raw.targets.map((target, index) =>
      ComparisonConfig.normalizeTarget(target, index),
    );
    const environment = ComparisonConfig.normalizeEnvironment(raw.environment);
    const names = new Set();
    const urls = new Set();
    for (const target of targets) {
      if (names.has(target.name)) {
        throw new ConfigurationError(`Duplicate target name: ${target.name}.`);
      }
      if (urls.has(target.match.urlExact)) {
        throw new ConfigurationError(
          `Target match.urlExact values must be distinct: ${target.match.urlExact}.`,
        );
      }
      names.add(target.name);
      urls.add(target.match.urlExact);
    }
    return { schemaVersion: CONFIG_SCHEMA_VERSION, sample, targets, environment };
  }

  static normalizeSample(rawSample) {
    if (rawSample !== undefined && !ValueChecks.isObject(rawSample)) {
      throw new ConfigurationError("sample must be an object.");
    }
    const raw = rawSample || {};
    ValueChecks.allowedKeys(
      raw,
      Object.keys(DEFAULT_SAMPLE),
      "sample",
    );
    const sample = {
      rounds: ValueChecks.optionalInteger(
        raw.rounds,
        DEFAULT_SAMPLE.rounds,
        "sample.rounds",
        1,
        100,
      ),
      count: ValueChecks.optionalInteger(
        raw.count,
        DEFAULT_SAMPLE.count,
        "sample.count",
        2,
        10000,
      ),
      durationMs: ValueChecks.optionalInteger(
        raw.durationMs,
        DEFAULT_SAMPLE.durationMs,
        "sample.durationMs",
        100,
        600000,
      ),
      deltaY: ValueChecks.optionalNumber(
        raw.deltaY,
        DEFAULT_SAMPLE.deltaY,
        "sample.deltaY",
        0.01,
        10000,
      ),
      settleMs: ValueChecks.optionalInteger(
        raw.settleMs,
        DEFAULT_SAMPLE.settleMs,
        "sample.settleMs",
        0,
        60000,
      ),
      postFrames: ValueChecks.optionalInteger(
        raw.postFrames,
        DEFAULT_SAMPLE.postFrames,
        "sample.postFrames",
        1,
        240,
      ),
      showFpsCounter: ValueChecks.optionalBoolean(
        raw.showFpsCounter,
        DEFAULT_SAMPLE.showFpsCounter,
        "sample.showFpsCounter",
      ),
      fpsCounterHoldMs: ValueChecks.optionalInteger(
        raw.fpsCounterHoldMs,
        DEFAULT_SAMPLE.fpsCounterHoldMs,
        "sample.fpsCounterHoldMs",
        0,
        600000,
      ),
      skipMidpointScreenshot: ValueChecks.optionalBoolean(
        raw.skipMidpointScreenshot,
        DEFAULT_SAMPLE.skipMidpointScreenshot,
        "sample.skipMidpointScreenshot",
      ),
    };
    if (sample.count % 2 !== 0) {
      throw new ConfigurationError("sample.count must be even.");
    }
    return sample;
  }

  static normalizeTarget(raw, index) {
    const location = `targets[${index}]`;
    if (!ValueChecks.isObject(raw)) {
      throw new ConfigurationError(`${location} must be an object.`);
    }
    ValueChecks.allowedKeys(
      raw,
      ["name", "match", "legacyMousewheelBridge", "setup"],
      location,
    );
    const name = ValueChecks.string(raw.name, `${location}.name`).trim();
    if (!ValueChecks.isObject(raw.match)) {
      throw new ConfigurationError(`${location}.match must be an object.`);
    }
    ValueChecks.allowedKeys(raw.match, ["urlExact"], `${location}.match`);
    const urlExact = ValueChecks.string(
      raw.match.urlExact,
      `${location}.match.urlExact`,
    );
    try {
      new URL(urlExact);
    } catch (error) {
      throw new ConfigurationError(
        `${location}.match.urlExact must be an absolute URL: ${error.message}`,
      );
    }
    const legacyMousewheelBridge = ValueChecks.boolean(
      raw.legacyMousewheelBridge,
      `${location}.legacyMousewheelBridge`,
    );
    const setup = ComparisonConfig.normalizeSetup(raw.setup, location);
    return {
      name,
      match: { urlExact },
      legacyMousewheelBridge,
      setup,
    };
  }

  static normalizeSetup(rawSetup, location) {
    if (rawSetup !== undefined && !ValueChecks.isObject(rawSetup)) {
      throw new ConfigurationError(`${location}.setup must be an object.`);
    }
    const raw = rawSetup || {};
    ValueChecks.allowedKeys(
      raw,
      ["waitSelector", "settleMs", "actions"],
      `${location}.setup`,
    );
    const waitSelector = ValueChecks.string(
      raw.waitSelector === undefined ? "canvas" : raw.waitSelector,
      `${location}.setup.waitSelector`,
    );
    const settleMs = ValueChecks.optionalInteger(
      raw.settleMs,
      1000,
      `${location}.setup.settleMs`,
      0,
      60000,
    );
    const actions = raw.actions === undefined ? [] : raw.actions;
    if (!Array.isArray(actions)) {
      throw new ConfigurationError(`${location}.setup.actions must be an array.`);
    }
    return {
      waitSelector,
      settleMs,
      actions: actions.map((action, actionIndex) =>
        ComparisonConfig.normalizeAction(
          action,
          `${location}.setup.actions[${actionIndex}]`,
        ),
      ),
    };
  }

  static normalizeEnvironment(rawEnvironment) {
    if (rawEnvironment !== undefined && !ValueChecks.isObject(rawEnvironment)) {
      throw new ConfigurationError("environment must be an object.");
    }
    if (rawEnvironment === undefined) {
      return {
        canvasCssSize: null,
        maxResizeAttempts: 0,
        settleMs: 0,
      };
    }
    ValueChecks.allowedKeys(
      rawEnvironment,
      ["canvasCssSize", "maxResizeAttempts", "settleMs"],
      "environment",
    );
    if (!ValueChecks.isObject(rawEnvironment.canvasCssSize)) {
      throw new ConfigurationError(
        "environment.canvasCssSize must be an object when environment is provided.",
      );
    }
    ValueChecks.allowedKeys(
      rawEnvironment.canvasCssSize,
      ["width", "height"],
      "environment.canvasCssSize",
    );
    return {
      canvasCssSize: {
        width: ValueChecks.integer(
          rawEnvironment.canvasCssSize.width,
          "environment.canvasCssSize.width",
          1,
          100000,
        ),
        height: ValueChecks.integer(
          rawEnvironment.canvasCssSize.height,
          "environment.canvasCssSize.height",
          1,
          100000,
        ),
      },
      maxResizeAttempts: ValueChecks.optionalInteger(
        rawEnvironment.maxResizeAttempts,
        3,
        "environment.maxResizeAttempts",
        1,
        10,
      ),
      settleMs: ValueChecks.optionalInteger(
        rawEnvironment.settleMs,
        350,
        "environment.settleMs",
        0,
        10000,
      ),
    };
  }

  static normalizeAction(raw, location) {
    if (!ValueChecks.isObject(raw)) {
      throw new ConfigurationError(`${location} must be an object.`);
    }
    ValueChecks.allowedKeys(
      raw,
      ["type", "selector", "x", "y", "whenExpression"],
      location,
    );
    if (raw.type !== "click") {
      throw new ConfigurationError(`${location}.type must be "click".`);
    }
    const hasSelector = raw.selector !== undefined;
    const hasX = raw.x !== undefined;
    const hasY = raw.y !== undefined;
    if (hasSelector === (hasX || hasY) || (hasX !== hasY)) {
      throw new ConfigurationError(
        `${location} must provide exactly selector or both x and y.`,
      );
    }
    const result = { type: "click" };
    if (hasSelector) {
      result.selector = ValueChecks.string(raw.selector, `${location}.selector`);
    } else {
      result.x = ValueChecks.number(raw.x, `${location}.x`, -100000, 100000);
      result.y = ValueChecks.number(raw.y, `${location}.y`, -100000, 100000);
    }
    if (raw.whenExpression !== undefined) {
      result.whenExpression = ValueChecks.string(
        raw.whenExpression,
        `${location}.whenExpression`,
      );
    }
    return result;
  }
}

class NodeProcessRunner {
  constructor(scriptDirectory) {
    this.scriptDirectory = scriptDirectory;
  }

  run(scriptPath, args, options = {}) {
    const {
      input,
      label = path.basename(scriptPath),
      acceptedExitCodes = [0],
      captureStdout = false,
    } = options;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        cwd: this.scriptDirectory,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const stderrLimit = 16000;
      child.stdout.on("data", (chunk) => {
        if (captureStdout) stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < stderrLimit) {
          stderr += chunk.toString().slice(0, stderrLimit - stderr.length);
        }
      });
      child.on("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
      child.on("close", (exitCode) => {
        if (!acceptedExitCodes.includes(exitCode)) {
          reject(new ChildProcessError(label, exitCode, stderr.trim()));
          return;
        }
        resolve({ exitCode, stdout, stderr: stderr.trim() });
      });
      if (input === undefined) child.stdin.end();
      else child.stdin.end(input);
    });
  }

  async runJson(scriptPath, args, options = {}) {
    const result = await this.run(scriptPath, args, {
      ...options,
      captureStdout: true,
    });
    try {
      return { ...result, value: JSON.parse(result.stdout) };
    } catch (error) {
      throw new Error(
        `${options.label || path.basename(scriptPath)} returned invalid JSON: ${error.message}`,
      );
    }
  }
}

class NativeFpsOverlaySession {
  constructor(child, ready, closePromise) {
    this.child = child;
    this.ready = ready;
    this.closePromise = closePromise;
    this.stopPromise = null;
  }

  static async start(target, timeoutMs) {
    const child = spawn(
      process.execPath,
      [
        FPS_OVERLAY_SCRIPT,
        "--target-exact",
        target.id,
        "--until-stop",
        "--timeout",
        String(timeoutMs),
      ],
      {
        cwd: SCRIPT_DIRECTORY,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    let launchError = null;
    let closeResolve;
    const closePromise = new Promise((resolve) => {
      closeResolve = resolve;
    });
    child.on("error", (error) => {
      launchError = error;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 16000) {
        stderr += chunk.toString().slice(0, 16000 - stderr.length);
      }
    });
    child.on("close", (exitCode, signal) => {
      closeResolve({ exitCode, signal, stderr: stderr.trim() });
    });

    const ready = await new Promise((resolve, reject) => {
      let pending = "";
      let settled = false;
      let timer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        callback(value);
      };
      timer = setTimeout(() => {
        finish(
          reject,
          new Error(`Timed out after ${timeoutMs}ms waiting for the native FPS overlay on ${target.id}.`),
        );
      }, timeoutMs);
      child.stdout.on("data", (chunk) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          try {
            const value = JSON.parse(line);
            if (value.event === "ready") {
              finish(resolve, value);
              return;
            }
          } catch (error) {
            finish(
              reject,
              new Error(`Native FPS overlay returned invalid readiness JSON: ${error.message}`),
            );
            return;
          }
        }
      });
      child.on("close", (exitCode, signal) => {
        finish(
          reject,
          new Error(
            `Native FPS overlay exited before readiness for ${target.id}: exit=${String(exitCode)} signal=${String(signal)} ${stderr.trim()}`,
          ),
        );
      });
      child.on("error", (error) => {
        finish(reject, new Error(`Native FPS overlay could not start: ${error.message}`));
      });
    }).catch(async (error) => {
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
      await closePromise;
      throw launchError ? new Error(`Native FPS overlay could not start: ${launchError.message}`) : error;
    });
    if (
      ready.target?.id !== target.id ||
      ready.overlay?.enabled !== true ||
      ready.overlay?.untilStop !== true
    ) {
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM");
      await closePromise;
      throw new Error(`Native FPS overlay readiness did not match target ${target.id}.`);
    }
    return new NativeFpsOverlaySession(child, ready, closePromise);
  }

  describe() {
    return {
      target: this.ready.target,
      source: this.ready.overlay?.source ?? null,
      enabled: this.ready.overlay?.enabled === true,
      sessionHeld: this.ready.overlay?.sessionHeld === true,
      numericValueReturnedByCdp: this.ready.overlay?.numericValueReturnedByCdp === true,
    };
  }

  async stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      if (!this.child.killed && this.child.exitCode === null) {
        try {
          this.child.stdin.write("stop\n");
          this.child.stdin.end();
        } catch {}
      }
      const timeout = Timer.sleep(5000).then(() => null);
      let closed = await Promise.race([this.closePromise, timeout]);
      if (closed === null && !this.child.killed && this.child.exitCode === null) {
        this.child.kill("SIGTERM");
        closed = await this.closePromise;
      }
      return closed;
    })();
    return this.stopPromise;
  }
}

class Timer {
  static sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

class OutputDirectoryAllocator {
  async create(baseDirectory) {
    const root = path.resolve(baseDirectory);
    try {
      await fs.mkdir(root, { recursive: true });
    } catch (error) {
      throw new Error(`Cannot create output directory ${root}: ${error.message}`);
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const runName = `run-${Date.now()}-${process.pid}-${randomUUID()}`;
      const runDirectory = path.join(root, runName);
      try {
        await fs.mkdir(runDirectory, { recursive: false });
        return runDirectory;
      } catch (error) {
        if (error.code !== "EEXIST") {
          throw new Error(`Cannot create unique run directory: ${error.message}`);
        }
      }
    }
    throw new Error(`Could not allocate a unique run directory under ${root}.`);
  }
}

class CanvasEnvironment {
  static expression() {
    return `(() => {
      const canvases = [...document.querySelectorAll("canvas")]
        .map((canvas, index) => ({ canvas, index, rect: canvas.getBoundingClientRect(), style: getComputedStyle(canvas) }))
        .filter(({ rect, style }) =>
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          Number(style.opacity) !== 0
        )
        .sort((left, right) =>
          right.rect.width * right.rect.height - left.rect.width * left.rect.height ||
          left.index - right.index
        );
      const candidate = canvases[0];
      if (!candidate) throw new Error("No visible canvas is available");
      const { canvas, rect, style } = candidate;
      return {
        url: location.href,
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        drawingBuffer: { width: canvas.width, height: canvas.height },
        dpr: devicePixelRatio,
        viewport: { width: innerWidth, height: innerHeight },
        visibility: document.visibilityState,
        visibilityState: document.visibilityState,
        canvasStyle: { display: style.display, visibility: style.visibility, opacity: Number(style.opacity) }
      };
    })()`;
  }

  static validate(value, targetName) {
    const prefix = `Target ${targetName} canvas environment`;
    if (!ValueChecks.isObject(value)) {
      throw new ContractError(`${prefix} is not an object.`);
    }
    const fields = [
      ["dpr", value.dpr],
      ["rect.x", value.rect?.x],
      ["rect.y", value.rect?.y],
      ["rect.width", value.rect?.width],
      ["rect.height", value.rect?.height],
      ["drawingBuffer.width", value.drawingBuffer?.width],
      ["drawingBuffer.height", value.drawingBuffer?.height],
      ["viewport.width", value.viewport?.width],
      ["viewport.height", value.viewport?.height],
    ];
    for (const [field, fieldValue] of fields) {
      if (!Number.isFinite(fieldValue)) {
        throw new ContractError(`${prefix}.${field} is missing or non-finite.`);
      }
    }
    if (typeof value.url !== "string" || typeof value.visibility !== "string") {
      throw new ContractError(`${prefix} is missing url or visibility.`);
    }
    const expectedWidth = Math.round(value.rect.width * value.dpr);
    const expectedHeight = Math.round(value.rect.height * value.dpr);
    const drawingBufferMatchesCssDpr =
      value.drawingBuffer.width === expectedWidth &&
      value.drawingBuffer.height === expectedHeight;
    return {
      ...value,
      expectedDrawingBuffer: { width: expectedWidth, height: expectedHeight },
      drawingBufferMatchesCssDpr,
    };
  }

  static compare(left, right, targetNames, targetCanvasCssSize = null) {
    const leftEnvironment = CanvasEnvironment.validate(left, targetNames[0]);
    const rightEnvironment = CanvasEnvironment.validate(right, targetNames[1]);
    const invalidReasons = [];
    if (leftEnvironment.visibility !== "visible") {
      invalidReasons.push(`${targetNames[0]} visibility is ${leftEnvironment.visibility}, expected visible.`);
    }
    if (rightEnvironment.visibility !== "visible") {
      invalidReasons.push(`${targetNames[1]} visibility is ${rightEnvironment.visibility}, expected visible.`);
    }
    if (leftEnvironment.url !== undefined && rightEnvironment.url !== undefined) {
      if (leftEnvironment.url === rightEnvironment.url) {
        invalidReasons.push("Both targets resolved to the same URL.");
      }
    }
    if (leftEnvironment.dpr !== rightEnvironment.dpr) {
      invalidReasons.push(`DPR mismatch: ${leftEnvironment.dpr} != ${rightEnvironment.dpr}.`);
    }
    if (leftEnvironment.rect.width !== rightEnvironment.rect.width) {
      invalidReasons.push(`Canvas CSS width mismatch: ${leftEnvironment.rect.width} != ${rightEnvironment.rect.width}.`);
    }
    if (leftEnvironment.rect.height !== rightEnvironment.rect.height) {
      invalidReasons.push(`Canvas CSS height mismatch: ${leftEnvironment.rect.height} != ${rightEnvironment.rect.height}.`);
    }
    if (targetCanvasCssSize !== null) {
      if (
        leftEnvironment.rect.width !== targetCanvasCssSize.width ||
        leftEnvironment.rect.height !== targetCanvasCssSize.height
      ) {
        invalidReasons.push(
          `${targetNames[0]} canvas CSS size ${leftEnvironment.rect.width}x${leftEnvironment.rect.height} does not match configured ${targetCanvasCssSize.width}x${targetCanvasCssSize.height}.`,
        );
      }
      if (
        rightEnvironment.rect.width !== targetCanvasCssSize.width ||
        rightEnvironment.rect.height !== targetCanvasCssSize.height
      ) {
        invalidReasons.push(
          `${targetNames[1]} canvas CSS size ${rightEnvironment.rect.width}x${rightEnvironment.rect.height} does not match configured ${targetCanvasCssSize.width}x${targetCanvasCssSize.height}.`,
        );
      }
    }
    if (!leftEnvironment.drawingBufferMatchesCssDpr) {
      invalidReasons.push(`${targetNames[0]} drawingBuffer does not match CSS size * DPR.`);
    }
    if (!rightEnvironment.drawingBufferMatchesCssDpr) {
      invalidReasons.push(`${targetNames[1]} drawingBuffer does not match CSS size * DPR.`);
    }
    return {
      valid: invalidReasons.length === 0,
      invalidReasons,
      targets: {
        [targetNames[0]]: leftEnvironment,
        [targetNames[1]]: rightEnvironment,
      },
      checks: {
        visibility: leftEnvironment.visibility === "visible" && rightEnvironment.visibility === "visible",
        dprEqual: leftEnvironment.dpr === rightEnvironment.dpr,
        canvasCssSizeEqual:
          leftEnvironment.rect.width === rightEnvironment.rect.width &&
          leftEnvironment.rect.height === rightEnvironment.rect.height,
        drawingBufferMatchesCssDpr:
          leftEnvironment.drawingBufferMatchesCssDpr &&
          rightEnvironment.drawingBufferMatchesCssDpr,
        configuredCanvasCssSize:
          targetCanvasCssSize === null ||
          (leftEnvironment.rect.width === targetCanvasCssSize.width &&
            leftEnvironment.rect.height === targetCanvasCssSize.height &&
            rightEnvironment.rect.width === targetCanvasCssSize.width &&
            rightEnvironment.rect.height === targetCanvasCssSize.height),
      },
    };
  }
}

class RoundPlan {
  static order(roundNumber) {
    return roundNumber % 2 === 1 ? [0, 1] : [1, 0];
  }
}

class SummaryStore {
  constructor(config) {
    this.config = config;
    this.rounds = [];
    this.samples = [];
    this.failure = null;
  }

  addRound(round) {
    this.rounds.push(round);
  }

  addSample(sample) {
    this.samples.push(sample);
  }

  setFailure(error) {
    this.failure = {
      name: error.name || "Error",
      message: error.message || String(error),
      details: Array.isArray(error.details) ? error.details : [],
    };
  }

  static numeric(values) {
    const finite = values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) {
      return { count: 0, mean: null, min: null, max: null, range: null };
    }
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    return {
      count: finite.length,
      mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
      min,
      max,
      range: { min, max },
    };
  }

  static aggregateForTarget(samples, targetIndex) {
    const targetSamples = samples.filter((sample) => sample.targetIndex === targetIndex);
    const metric = (name) => SummaryStore.numeric(targetSamples.map((sample) => sample.metrics[name]));
    const gapCandidates = [];
    for (const sample of targetSamples) {
      for (const [metricName, value] of Object.entries({
        presentationMaxFrameGapMs: sample.metrics.presentationMaxFrameGapMs,
        compositorMaxFrameGapMs: sample.metrics.compositorMaxFrameGapMs,
        rafMaxFrameGapMs: sample.metrics.rafMaxFrameGapMs,
      })) {
        if (Number.isFinite(value)) gapCandidates.push({ metric: metricName, value });
      }
    }
    gapCandidates.sort((left, right) => right.value - left.value);
    return {
      sampleCount: targetSamples.length,
      validSampleCount: targetSamples.filter((sample) => sample.valid).length,
      invalidSampleCount: targetSamples.filter((sample) => !sample.valid).length,
      metrics: {
        inputAckCount: metric("inputAckCount"),
        inputReceivedCount: metric("inputReceivedCount"),
        coalescedEventCount: metric("coalescedEventCount"),
        rafAverageFps: metric("rafAverageFps"),
        compositorAverageFps: metric("compositorAverageFps"),
        presentationAverageFps: metric("presentationAverageFps"),
        rafMaxFrameGapMs: metric("rafMaxFrameGapMs"),
        compositorMaxFrameGapMs: metric("compositorMaxFrameGapMs"),
        presentationMaxFrameGapMs: metric("presentationMaxFrameGapMs"),
      },
      worstMaxGap: gapCandidates[0] || { metric: null, value: null },
    };
  }

  toObject() {
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      status: this.failure ? "failed" : "completed",
      contract: {
        schemaVersion: this.config.schemaVersion,
        sample: this.config.sample,
        environment: this.config.environment,
        targets: this.config.targets,
        rules: {
          targetDiscovery: "Each round runs cdp.mjs status and list, then requires one exact URL match per target.",
          noForegroundActivation: true,
          surfacePreparation: "No Page.bringToFront, Target.activateTarget, or Windows foreground activation is used. Existing visible targets are validated in place.",
          canvas: "Largest visible canvas; CSS size and drawingBuffer/DPR are read back before sampling.",
          windowNormalization:
            this.config.environment.canvasCssSize === null
              ? "Disabled unless environment.canvasCssSize is configured."
              : "Existing target windows are resized without foreground activation until their canvases match environment.canvasCssSize or the retry limit is reached.",
          parity: "Both pages must be visible, have equal DPR and equal canvas CSS width/height, and each drawingBuffer must equal round(CSS size * DPR).",
          order: "Odd rounds target0->target1; even rounds target1->target0.",
        },
      },
      roundOrder: this.rounds.map((round) => round.order),
      rounds: this.rounds,
      samples: this.samples,
      targetAggregates: this.config.targets.map((target, targetIndex) => ({
        targetIndex,
        name: target.name,
        ...SummaryStore.aggregateForTarget(this.samples, targetIndex),
      })),
      failure: this.failure,
    };
  }
}

class ComparisonRunner {
  constructor(config, outputDirectory) {
    this.config = config;
    this.outputDirectory = outputDirectory;
    this.processes = new NodeProcessRunner(SCRIPT_DIRECTORY);
    this.outputAllocator = new OutputDirectoryAllocator();
    this.summary = new SummaryStore(config);
    this.runDirectory = null;
    this.summaryPath = null;
    this.cdpTimeoutMs = Math.min(
      600000,
      Math.max(10000, config.sample.durationMs + config.sample.settleMs + 30000),
    );
  }

  progress(message) {
    process.stdout.write(`${message}\n`);
  }

  async run() {
    this.runDirectory = await this.outputAllocator.create(this.outputDirectory);
    this.summaryPath = path.join(this.runDirectory, "comparison-summary.json");
    try {
      for (let roundNumber = 1; roundNumber <= this.config.sample.rounds; roundNumber += 1) {
        await this.runRound(roundNumber);
      }
      await this.writeSummary();
      this.progress(`comparison-summary: ${this.summaryPath}`);
      return this.summaryPath;
    } catch (error) {
      this.summary.setFailure(error);
      await this.writeSummary();
      this.progress(`comparison-summary: ${this.summaryPath}`);
      throw error;
    }
  }

  async writeSummary() {
    await fs.writeFile(
      this.summaryPath,
      `${JSON.stringify(this.summary.toObject(), null, 2)}\n`,
      "utf8",
    );
  }

  async runRound(roundNumber) {
    const order = RoundPlan.order(roundNumber);
    const discovered = await this.discoverTargets(roundNumber);
    const round = {
      round: roundNumber,
      order,
      targets: discovered.map((entry, targetIndex) => ({
        targetIndex,
        name: this.config.targets[targetIndex].name,
        id: entry.id,
        title: entry.title,
        url: entry.url,
      })),
      setup: [],
      environment: null,
      windowNormalization: null,
      sampleIds: [],
    };
    this.summary.addRound(round);
    let overlaySessions = [];
    try {
      this.progress(`round ${roundNumber}/${this.config.sample.rounds}: reload and wait`);
      await this.reloadAndWait(discovered);
      round.setup = await this.runSetup(discovered);
      let environments = await Promise.all(
        discovered.map((target, targetIndex) =>
          this.readEnvironment(target, targetIndex),
        ),
      );
      if (this.config.environment.canvasCssSize !== null) {
        round.windowNormalization = await this.normalizeCanvasWindows(
          discovered,
          environments,
        );
        environments = await Promise.all(
          discovered.map((target, targetIndex) =>
            this.readEnvironment(target, targetIndex),
          ),
        );
      }
      for (let targetIndex = 0; targetIndex < environments.length; targetIndex += 1) {
        const expectedUrl = this.config.targets[targetIndex].match.urlExact;
        if (environments[targetIndex].url !== expectedUrl) {
          throw new ContractError(
            `Target ${this.config.targets[targetIndex].name} URL changed after setup: expected ${expectedUrl}, actual ${environments[targetIndex].url}.`,
          );
        }
      }
      const environmentContract = CanvasEnvironment.compare(
        environments[0],
        environments[1],
        this.config.targets.map((target) => target.name),
        this.config.environment.canvasCssSize,
      );
      round.environment = environmentContract;
      if (!environmentContract.valid) {
        throw new ContractError(
          `Round ${roundNumber} environment contract failed: ${environmentContract.invalidReasons.join(" ")}`,
          environmentContract.invalidReasons,
        );
      }
      const anchorContract = await this.compareCanvasAnchors(
        discovered,
        environments,
        roundNumber,
      );
      round.anchor = anchorContract;
      if (!anchorContract.valid) {
        throw new ContractError(
          `Round ${roundNumber} camera/model anchor contract failed: ${anchorContract.reasons.join(" ")}`,
          anchorContract.reasons,
        );
      }
      if (this.config.sample.showFpsCounter) {
        this.progress(`round ${roundNumber}/${this.config.sample.rounds}: enable native FPS overlays`);
        overlaySessions = await this.startNativeFpsOverlays(discovered);
        round.fpsOverlay = {
          requested: true,
          targets: overlaySessions.map((session) => session.describe()),
        };
      } else {
        round.fpsOverlay = { requested: false, targets: [] };
      }
      this.progress(`round ${roundNumber}/${this.config.sample.rounds}: sample ${order[0]} then ${order[1]}`);
      for (const targetIndex of order) {
        const sample = await this.runSample(
          roundNumber,
          targetIndex,
          discovered[targetIndex],
          environments[targetIndex],
          environmentContract,
          anchorContract,
          overlaySessions[targetIndex] ?? null,
        );
        this.summary.addSample(sample);
        round.sampleIds.push(sample.sampleId);
      }
    } finally {
      if (overlaySessions.length > 0) {
        round.fpsOverlayCleanup = await Promise.all(
          overlaySessions.map((session) => session.stop()),
        );
      }
    }
  }

  async discoverTargets(roundNumber) {
    const status = await this.processes.runJson(
      CDP_SCRIPT,
      ["status", "--timeout", String(this.cdpTimeoutMs)],
      { label: `cdp status for round ${roundNumber}` },
    );
    if (status.value?.ok !== true) {
      throw new ContractError(`cdp status did not confirm a usable Chrome target.`);
    }
    const listed = await this.processes.runJson(
      CDP_SCRIPT,
      ["list", "--timeout", String(this.cdpTimeoutMs)],
      { label: `cdp list for round ${roundNumber}` },
    );
    if (!Array.isArray(listed.value)) {
      throw new ContractError("cdp list did not return a target array.");
    }
    const targets = this.config.targets.map((targetConfig) => {
      const matches = listed.value.filter(
        (target) => target.url === targetConfig.match.urlExact,
      );
      if (matches.length !== 1) {
        throw new ContractError(
          `Exact URL ${targetConfig.match.urlExact} matched ${matches.length} page targets in round ${roundNumber}; expected exactly one.`,
        );
      }
      const target = matches[0];
      if (typeof target.id !== "string" || typeof target.webSocketDebuggerUrl !== "string") {
        throw new ContractError(
          `Exact URL ${targetConfig.match.urlExact} returned an incomplete CDP target record.`,
        );
      }
      return target;
    });
    return targets;
  }

  cdpArgs(command, targetId, extra = []) {
    const args = [command];
    if (targetId) args.push("--target-exact", targetId);
    args.push("--no-activate", "--timeout", String(this.cdpTimeoutMs), ...extra);
    return args;
  }

  async reloadAndWait(targets) {
    await Promise.all(
      targets.map(async (target, targetIndex) => {
        await this.processes.run(
          CDP_SCRIPT,
          this.cdpArgs("reload", target.id),
          { label: `reload target ${targetIndex}` },
        );
        await this.waitForReadySurface(target, targetIndex);
      }),
    );
  }

  async waitForReadySurface(target, targetIndex) {
    const selector = this.config.targets[targetIndex].setup.waitSelector;
    const expression = `(() => {
      if (document.visibilityState !== "visible") return false;
      return [...document.querySelectorAll(${JSON.stringify(selector)})].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          Number(style.opacity) !== 0;
      });
    })()`;
    const deadline = Date.now() + this.cdpTimeoutMs;
    let lastValue = null;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        lastValue = await this.evaluate(
          target.id,
          expression,
          `wait ready surface target ${targetIndex}`,
        );
        if (lastValue === true) return;
      } catch (error) {
        lastError = error;
      }
      await Timer.sleep(250);
    }
    throw new ContractError(
      `Target ${this.config.targets[targetIndex].name} did not expose a visible, non-zero surface for ${selector}; lastValue=${String(lastValue)}; lastError=${lastError?.message || "none"}.`,
    );
  }

  async runSetup(targets) {
    const setupRecords = await Promise.all(
      targets.map(async (target, targetIndex) => {
        const actions = [];
        for (let actionIndex = 0; actionIndex < this.config.targets[targetIndex].setup.actions.length; actionIndex += 1) {
          const action = this.config.targets[targetIndex].setup.actions[actionIndex];
          if (action.whenExpression !== undefined) {
            const condition = await this.evaluate(
              target.id,
              action.whenExpression,
              `whenExpression target ${targetIndex} action ${actionIndex}`,
            );
            if (typeof condition !== "boolean") {
              throw new ContractError(
                `whenExpression for target ${targetIndex} action ${actionIndex} must return boolean.`,
              );
            }
            if (!condition) {
              actions.push({ actionIndex, skipped: true, condition: false });
              continue;
            }
            actions.push({ actionIndex, skipped: false, condition: true });
          } else {
            actions.push({ actionIndex, skipped: false, condition: null });
          }
          const clickArgs = [];
          if (action.selector !== undefined) {
            clickArgs.push("--selector", action.selector);
          } else {
            clickArgs.push("--x", String(action.x), "--y", String(action.y));
          }
          await this.processes.run(
            CDP_SCRIPT,
            this.cdpArgs("click", target.id, clickArgs),
            { label: `click target ${targetIndex} action ${actionIndex}` },
          );
        }
        await Timer.sleep(this.config.targets[targetIndex].setup.settleMs);
        return {
          targetIndex,
          settleMs: this.config.targets[targetIndex].setup.settleMs,
          actions,
        };
      }),
    );
    return setupRecords;
  }

  async evaluate(targetId, expression, label) {
    const result = await this.processes.runJson(
      CDP_SCRIPT,
      this.cdpArgs("eval", targetId, ["--stdin"]),
      { input: expression, label },
    );
    if (result.value?.exceptionDetails) {
      throw new ContractError(
        `${label} failed in the page: ${result.value.exceptionDetails.text || "Runtime.evaluate exception"}.`,
      );
    }
    const value = result.value?.result?.value;
    if (value === undefined && result.value?.result?.type !== "undefined") {
      throw new ContractError(`${label} returned no value.`);
    }
    return value;
  }

  async readEnvironment(target, targetIndex) {
    const value = await this.evaluate(
      target.id,
      CanvasEnvironment.expression(),
      `canvas environment target ${targetIndex}`,
    );
    return CanvasEnvironment.validate(
      value,
      this.config.targets[targetIndex].name,
    );
  }

  async compareCanvasAnchors(targets, environments, roundNumber) {
    const canvasWidth = environments[0].rect.width;
    const canvasHeight = environments[0].rect.height;
    const roi = {
      x: Math.min(100, Math.max(0, canvasWidth - 1)),
      y: Math.min(100, Math.max(0, canvasHeight - 1)),
      width: Math.max(1, canvasWidth - 200),
      height: Math.max(1, canvasHeight - 150),
    };
    const screenshots = await Promise.all(
      targets.map((target, targetIndex) =>
        this.browserCall(
          target.id,
          "Page.captureScreenshot",
          {
            format: "png",
            fromSurface: true,
            optimizeForSpeed: true,
            clip: {
              x: environments[targetIndex].rect.x,
              y: environments[targetIndex].rect.y,
              width: environments[targetIndex].rect.width,
              height: environments[targetIndex].rect.height,
              scale: 1,
            },
          },
          `capture anchor screenshot target ${targetIndex} round ${roundNumber}`,
        ),
      ),
    );
    const comparison = compareCanvasAnchors(
      { data: screenshots[0]?.data },
      { data: screenshots[1]?.data },
      { roi },
    );
    return {
      valid: comparison.valid,
      reasons: comparison.reasons,
      comparison: comparison.comparison,
      targets: {
        [this.config.targets[0].name]: ComparisonRunner.anchorSummary(comparison.left),
        [this.config.targets[1].name]: ComparisonRunner.anchorSummary(comparison.right),
      },
      screenshot: {
        source: "Page.captureScreenshot canvas clip",
        round: roundNumber,
        roi,
        canvasRects: environments.map((environment) => environment.rect),
      },
    };
  }

  async startNativeFpsOverlays(targets) {
    const started = [];
    try {
      const sessions = await Promise.all(
        targets.map(async (target) => {
          const session = await NativeFpsOverlaySession.start(target, this.cdpTimeoutMs);
          started.push(session);
          return session;
        }),
      );
      return sessions;
    } catch (error) {
      await Promise.all(started.map((session) => session.stop()));
      throw error;
    }
  }

  async normalizeCanvasWindows(targets, initialEnvironments) {
    return Promise.all(
      targets.map((target, targetIndex) =>
        this.normalizeCanvasWindow(
          target,
          targetIndex,
          initialEnvironments[targetIndex],
        ),
      ),
    );
  }

  async normalizeCanvasWindow(target, targetIndex, initialEnvironment) {
    const targetSize = this.config.environment.canvasCssSize;
    const attempts = [];
    let environment = initialEnvironment;
    for (
      let attempt = 1;
      attempt <= this.config.environment.maxResizeAttempts;
      attempt += 1
    ) {
      if (
        environment.rect.width === targetSize.width &&
        environment.rect.height === targetSize.height
      ) {
        return {
          targetIndex,
          targetSize,
          matched: true,
          initialEnvironment,
          finalEnvironment: environment,
          attempts,
        };
      }
      const browserWindow = await this.browserCall(
        target.id,
        "Browser.getWindowForTarget",
        {},
        `read window bounds target ${targetIndex}`,
      );
      const windowId = browserWindow?.windowId;
      const bounds = browserWindow?.bounds;
      if (!Number.isInteger(windowId) || !ValueChecks.isObject(bounds)) {
        throw new ContractError(
          `Target ${this.config.targets[targetIndex].name} did not return a usable Chrome window boundary.`,
        );
      }
      if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
        throw new ContractError(
          `Target ${this.config.targets[targetIndex].name} Chrome window bounds are incomplete.`,
        );
      }
      if (bounds.windowState !== undefined && bounds.windowState !== "normal") {
        await this.browserCall(
          target.id,
          "Browser.setWindowBounds",
          { windowId, bounds: { windowState: "normal" } },
          `restore normal window state target ${targetIndex}`,
        );
        await Timer.sleep(this.config.environment.settleMs);
      }
      const requestedBounds = {
        width: Math.max(
          200,
          Math.round(bounds.width + targetSize.width - environment.rect.width),
        ),
        height: Math.max(
          200,
          Math.round(bounds.height + targetSize.height - environment.rect.height),
        ),
      };
      await this.browserCall(
        target.id,
        "Browser.setWindowBounds",
        { windowId, bounds: requestedBounds },
        `resize window target ${targetIndex} attempt ${attempt}`,
      );
      await Timer.sleep(this.config.environment.settleMs);
      environment = await this.readEnvironment(target, targetIndex);
      attempts.push({
        attempt,
        requestedBounds,
        environment,
      });
    }
    return {
      targetIndex,
      targetSize,
      matched:
        environment.rect.width === targetSize.width &&
        environment.rect.height === targetSize.height,
      initialEnvironment,
      finalEnvironment: environment,
      attempts,
    };
  }

  async browserCall(targetId, method, params, label) {
    const result = await this.processes.runJson(
      CDP_SCRIPT,
      this.cdpArgs("call", targetId, [
        "--method",
        method,
        "--params",
        JSON.stringify(params),
      ]),
      { label },
    );
    return result.value?.result;
  }

  async runSample(roundNumber, targetIndex, target, environment, environmentContract, anchorContract, fpsOverlay) {
    const sampleId = `round-${String(roundNumber).padStart(2, "0")}-target-${targetIndex}`;
    const basePath = path.join(this.runDirectory, sampleId);
    const capturePath = `${basePath}.json`;
    const tracePath = `${basePath}.trace.json`;
    const analyzedPath = `${basePath}.analyzed.json`;
    const sample = this.config.sample;
    const args = [
      "--target-exact",
      target.id,
      "--count",
      String(sample.count),
      "--duration",
      String(sample.durationMs),
      "--settle",
      String(sample.settleMs),
      "--post-frames",
      String(sample.postFrames),
      "--delta-y",
      String(sample.deltaY),
      "--x",
      String(Math.floor(environment.rect.x + environment.rect.width / 2)),
      "--y",
      String(Math.floor(environment.rect.y + environment.rect.height / 2)),
      "--expected-dpr",
      String(environment.dpr),
      "--expected-viewport-width",
      String(environment.viewport.width),
      "--expected-viewport-height",
      String(environment.viewport.height),
      "--expected-canvas-x",
      String(environment.rect.x),
      "--expected-canvas-y",
      String(environment.rect.y),
      "--expected-canvas-width",
      String(environment.rect.width),
      "--expected-canvas-height",
      String(environment.rect.height),
      "--output",
      capturePath,
      "--trace-output",
      tracePath,
    ];
    if (sample.skipMidpointScreenshot) args.push("--skip-midpoint-screenshot");
    if (this.config.targets[targetIndex].legacyMousewheelBridge) {
      args.push("--legacy-mousewheel-bridge");
    }
    const captureProcess = await this.processes.run(WHEEL_SCRIPT, args, {
      label: `${sampleId} wheel benchmark`,
      acceptedExitCodes: [0, 2],
    });
    const capture = await ComparisonRunner.readJsonFile(capturePath, `${sampleId} capture result`);
    if (capture.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
      throw new ContractError(`${sampleId} capture schemaVersion is not ${CAPTURE_SCHEMA_VERSION}.`);
    }
    if (capture.target?.id !== target.id || capture.target?.url !== this.config.targets[targetIndex].match.urlExact) {
      throw new ContractError(`${sampleId} capture target identity changed during sampling.`);
    }
    const analysisArgs = [
      "--input",
      tracePath,
      "--capture-result",
      capturePath,
      "--target-id",
      target.id,
      "--output",
      analyzedPath,
    ];
    const analysisProcess = await this.processes.run(ANALYZE_SCRIPT, analysisArgs, {
      label: `${sampleId} trace analysis`,
    });
    const analyzed = await ComparisonRunner.readJsonFile(analyzedPath, `${sampleId} analyzed result`);
    if (analyzed.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
      throw new ContractError(`${sampleId} analyzed schemaVersion is not ${ANALYSIS_SCHEMA_VERSION}.`);
    }
    return ComparisonRunner.projectSample({
      sampleId,
      roundNumber,
      targetIndex,
      targetName: this.config.targets[targetIndex].name,
      targetId: target.id,
      targetUrl: target.url,
      environment,
      environmentContract,
      anchorContract,
      fpsOverlay: fpsOverlay?.describe() ?? null,
      capture,
      analyzed,
      captureExitCode: captureProcess.exitCode,
      analysisExitCode: analysisProcess.exitCode,
      paths: {
        capture: capturePath,
        trace: tracePath,
        analyzed: analyzedPath,
      },
    });
  }

  static async readJsonFile(filePath, label) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      throw new ContractError(`Cannot read ${label} at ${filePath}: ${error.message}`);
    }
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new ContractError(`${label} at ${filePath} is invalid JSON: ${error.message}`);
    }
  }

  static value(object, ...keys) {
    let current = object;
    for (const key of keys) current = current?.[key];
    return current;
  }

  static projectSample(input) {
    const { capture, analyzed } = input;
    const wheelContract = ComparisonRunner.value(capture, "diagnostics", "wheelContract") || {};
    const invalidReasons = [];
      if (capture.valid !== true) {
      invalidReasons.push(...(capture.invalidReasons || []).map((reason) => `capture: ${reason}`));
    }
    if (analyzed.performanceKpi?.valid !== true) {
      invalidReasons.push(...(analyzed.performanceKpi?.invalidReasons || []).map((reason) => `analysis: ${reason}`));
    }
    if (capture.trace?.completeness?.valid !== true) invalidReasons.push("capture: trace completeness is invalid.");
    if (analyzed.traceIntegrity?.valid !== true) invalidReasons.push("analysis: trace integrity is invalid.");
    const captureReceivedEventCount = capture.diagnostics?.receivedEventCount ?? null;
    const captureExpectedEventCount = capture.diagnostics?.expectedEventCount ?? capture.input?.count ?? null;
    if (captureReceivedEventCount !== null && captureExpectedEventCount !== null && captureReceivedEventCount !== captureExpectedEventCount) {
      invalidReasons.push(`capture: DOM wheel event count mismatch expected=${captureExpectedEventCount} actual=${captureReceivedEventCount}.`);
    }
    const inputAckCount = capture.input?.dispatchAcks ?? null;
    const inputReceivedCount = capture.diagnostics?.receivedEventCount ?? null;
    const coalescedEventCount = wheelContract.coalescedEventCount ?? null;
    const raf = capture.diagnostics?.rafDiagnostic || null;
    const compositor = analyzed.frameRate?.compositor || capture.trace?.compositorFrameRate || null;
    const presentation = analyzed.frameRate?.presentation || null;
    const metrics = {
      inputAckCount,
      inputReceivedCount,
      coalescedEventCount,
      rafAverageFps: raf?.averageFps ?? null,
      compositorAverageFps: compositor?.averageFps ?? null,
      presentationAverageFps: presentation?.fps ?? null,
      rafMaxFrameGapMs: raf?.maximumFrameIntervalMilliseconds ?? null,
      compositorMaxFrameGapMs: compositor?.maxFrameIntervalMs ?? null,
      presentationMaxFrameGapMs: presentation?.maxFrameIntervalMs ?? null,
    };
    return {
      sampleId: input.sampleId,
      round: input.roundNumber,
      targetIndex: input.targetIndex,
      targetName: input.targetName,
      target: { id: input.targetId, url: input.targetUrl },
      valid: invalidReasons.length === 0,
      invalidReasons,
      files: input.paths,
      process: {
        wheelBenchmarkExitCode: input.captureExitCode,
        analyzeTraceExitCode: input.analysisExitCode,
      },
      environment: {
        actual: input.environment,
        comparisonContract: input.environmentContract,
        anchorContract: input.anchorContract,
      },
      fpsOverlay: input.fpsOverlay,
      input: {
        ack: {
          expected: capture.input?.count ?? null,
          received: inputAckCount,
          matches: capture.input?.dispatchAckCountMatches ?? false,
          maximumLatencyMs: capture.input?.maximumDispatchAckLatencyMilliseconds ?? null,
        },
        received: {
          expected: capture.input?.count ?? null,
          count: inputReceivedCount,
          types: capture.diagnostics?.receivedEventTypes || [],
        },
        coalescing: {
          mode: wheelContract.deliveryMode ?? null,
          coalescedEventCount,
          exactSequenceMatches: wheelContract.exactSequenceMatches ?? false,
          sequenceMatchesAllowingCoalescing: wheelContract.sequenceMatchesAllowingCoalescing ?? false,
        },
      },
      visual: capture.visualChange || null,
      raf,
      compositor,
      presentation: {
        source: "Display::FrameDisplayed",
        frameDisplayed: presentation,
        evidence: analyzed.evidence?.presentation || null,
      },
      traceIntegrity: {
        capture: capture.trace?.completeness || null,
        analyzed: analyzed.traceIntegrity || null,
      },
      pageErrors: capture.diagnostics?.pageErrors || [],
      metrics,
    };
  }

  static anchorSummary(anchor) {
    return {
      canvasSize: anchor.canvasSize,
      roi: anchor.roi,
      maskCount: anchor.maskCount,
      bbox: anchor.bbox,
      centroid: anchor.centroid,
    };
  }
}

class SelfTest {
  static async run() {
    const config = ComparisonConfig.fromObject({
      schemaVersion: 1,
      targets: [
        { name: "a", match: { urlExact: "http://a.test/" }, legacyMousewheelBridge: false },
        { name: "b", match: { urlExact: "http://b.test/" }, legacyMousewheelBridge: true },
      ],
    });
    assert.deepEqual(config.sample, DEFAULT_SAMPLE);
    assert.deepEqual(config.environment, {
      canvasCssSize: null,
      maxResizeAttempts: 0,
      settleMs: 0,
    });
    const configuredEnvironment = ComparisonConfig.fromObject({
      schemaVersion: 1,
      environment: {
        canvasCssSize: { width: 1115, height: 804 },
        maxResizeAttempts: 4,
        settleMs: 500,
      },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.deepEqual(configuredEnvironment.environment, {
      canvasCssSize: { width: 1115, height: 804 },
      maxResizeAttempts: 4,
      settleMs: 500,
    });
    assert.equal(Math.floor(1115 / 2), 557);
    assert.equal(Math.floor(246 + 1115 / 2), 803);
    assert.throws(
      () =>
        ComparisonConfig.fromObject({
          schemaVersion: 1,
          targets: [config.targets[0]],
        }),
      /exactly two targets/,
    );
    assert.deepEqual(RoundPlan.order(1), [0, 1]);
    assert.deepEqual(RoundPlan.order(2), [1, 0]);
    assert.deepEqual(RoundPlan.order(3), [0, 1]);
    const aggregateSamples = [
      { targetIndex: 0, valid: true, metrics: { inputAckCount: 120, inputReceivedCount: 120, coalescedEventCount: 0, rafAverageFps: 60, compositorAverageFps: 59, presentationAverageFps: 58, rafMaxFrameGapMs: 20, compositorMaxFrameGapMs: 22, presentationMaxFrameGapMs: 24 } },
      { targetIndex: 0, valid: false, metrics: { inputAckCount: 120, inputReceivedCount: 118, coalescedEventCount: 2, rafAverageFps: 55, compositorAverageFps: 54, presentationAverageFps: null, rafMaxFrameGapMs: 40, compositorMaxFrameGapMs: 44, presentationMaxFrameGapMs: 48 } },
    ];
    const aggregate = SummaryStore.aggregateForTarget(aggregateSamples, 0);
    assert.equal(aggregate.sampleCount, 2);
    assert.equal(aggregate.validSampleCount, 1);
    assert.equal(aggregate.metrics.inputReceivedCount.mean, 119);
    assert.deepEqual(aggregate.metrics.inputReceivedCount.range, { min: 118, max: 120 });
    assert.deepEqual(aggregate.worstMaxGap, { metric: "presentationMaxFrameGapMs", value: 48 });
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "compare-wheel-self-test-"));
    try {
      const allocator = new OutputDirectoryAllocator();
      const first = await allocator.create(temporaryRoot);
      const sentinelPath = path.join(first, "comparison-summary.json");
      await fs.writeFile(sentinelPath, "sentinel\n", "utf8");
      const second = await allocator.create(temporaryRoot);
      assert.notEqual(first, second);
      assert.equal(await fs.readFile(sentinelPath, "utf8"), "sentinel\n");
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
    process.stdout.write("self-test: ok (config, alternating order, aggregation, no-overwrite)\n");
  }
}

async function main() {
  const cli = CliArguments.parse(process.argv.slice(2));
  if (cli.selfTest) {
    await SelfTest.run();
    return;
  }
  const config = await ComparisonConfig.load(cli.configPath);
  const runner = new ComparisonRunner(config, cli.outputDirectory);
  await runner.run();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
