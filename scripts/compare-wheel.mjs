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
const FPS_OVERLAY_SCRIPT = path.join(SCRIPT_DIRECTORY, "fps-overlay.mjs");
const PLUGIN_ROOT_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, "..");
const PLUGIN_MANIFEST_PATH = path.join(
  PLUGIN_ROOT_DIRECTORY,
  ".codex-plugin",
  "plugin.json",
);
const CONFIG_SCHEMA_VERSION = 1;
const CAPTURE_SCHEMA_VERSION = 5;
const ANALYSIS_SCHEMA_VERSION = 2;
const DEFAULT_CANVAS_POINT = Object.freeze({ xRatio: 0.5, yRatio: 0.5 });
const PRIMARY_SCREEN_WINDOW_PLACEMENT = Object.freeze({
  left: 0,
  top: 0,
  minimumRightMargin: 64,
  minimumBottomMargin: 64,
});
const WINDOW_POSITION_TOLERANCE_PX = 2;
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
  traceProfile: "full",
  inputDeliveryPolicy: "strict",
  inputBackend: "cdp",
  canvasPoint: DEFAULT_CANVAS_POINT,
});
const DEFAULT_RETRY_POLICY = Object.freeze({
  maxInputRetries: 2,
  durationBackoffMultiplier: 2,
});
const FPS_TRACE_PROFILE = "fps";
const FPS_MINIMAL_TRACE_PROFILE = "fps-minimal";
const NO_TRACE_PROFILE = "none";
const INPUT_DELIVERY_POLICIES = new Set(["strict", "diagnostic"]);

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
    const result = {
      selfTest: false,
      help: false,
      configPath: null,
      outputDirectory: null,
      rounds: null,
      maxInputRetries: null,
      reuseReadyState: null,
      prepareOnly: null,
    };
    const valueOptions = new Set([
      "--config",
      "--output-dir",
      "--rounds",
      "--max-input-retries",
    ]);
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index];
      if (token === "--self-test") {
        result.selfTest = true;
        continue;
      }
      if (token === "--reuse-ready-state") {
        result.reuseReadyState = true;
        continue;
      }
      if (token === "--prepare-only") {
        result.prepareOnly = true;
        continue;
      }
      if (token === "--help") {
        result.help = true;
        continue;
      }
      if (!valueOptions.has(token)) {
        throw new Error(`Unknown argument "${token}". ${CliArguments.usage()}`);
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${token} requires a value.`);
      }
      if (token === "--config") result.configPath = value;
      else if (token === "--output-dir") result.outputDirectory = value;
      else if (token === "--rounds") result.rounds = CliArguments.integer(value, token, 1, 100);
      else if (token === "--max-input-retries") {
        result.maxInputRetries = CliArguments.integer(value, token, 0, 10);
      }
      index += 1;
    }
    if (result.help) {
      if (argv.length !== 1) throw new Error("--help cannot be combined with other options.");
      return result;
    }
    if (
      result.selfTest &&
      (result.configPath ||
        result.outputDirectory ||
        result.rounds !== null ||
        result.maxInputRetries !== null ||
        result.reuseReadyState !== null ||
        result.prepareOnly !== null)
    ) {
      throw new Error("--self-test cannot be combined with run options.");
    }
    if (result.selfTest) return result;
    if (!result.configPath) {
      throw new Error("Missing --config <absolute-json>.");
    }
    if (result.prepareOnly && result.reuseReadyState) {
      throw new Error("--prepare-only cannot be combined with --reuse-ready-state.");
    }
    if (result.prepareOnly && result.rounds !== null && result.rounds !== 1) {
      throw new Error("--prepare-only requires --rounds 1.");
    }
    if (!result.outputDirectory) {
      throw new Error("Missing --output-dir <dir>.");
    }
    if (result.configPath && !path.isAbsolute(result.configPath)) {
      throw new Error("--config must be an absolute JSON path.");
    }
    return result;
  }

  static integer(value, option, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new Error(`${option} must be an integer from ${minimum} to ${maximum}.`);
    }
    return parsed;
  }

  static usage() {
    return "Use --config <absolute-json> --output-dir <dir>, or --self-test.";
  }
}

class ComparisonConfig {
  constructor(value) {
    this.schemaVersion = value.schemaVersion;
    this.sample = value.sample;
    this.retry = value.retry;
    this.targets = value.targets;
    this.environment = value.environment;
    this.execution = value.execution;
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

  static withCliOverrides(config, cli) {
    return ComparisonConfig.fromObject({
      schemaVersion: config.schemaVersion,
      sample: {
        ...config.sample,
        rounds: cli.rounds ?? config.sample.rounds,
      },
      retry: {
        ...config.retry,
        maxInputRetries:
          cli.maxInputRetries ?? config.retry.maxInputRetries,
      },
      environment:
        config.environment.normalizeToFirstTarget === true
          ? {
              normalizeToFirstTarget: true,
              maxResizeAttempts: config.environment.maxResizeAttempts,
              settleMs: config.environment.settleMs,
              windowPlacement: config.environment.windowPlacement,
            }
          : config.environment.canvasCssSize === null
          ? undefined
          : config.environment,
      execution: {
        reuseReadyState:
          cli.reuseReadyState ?? config.execution.reuseReadyState,
        prepareOnly: cli.prepareOnly ?? config.execution.prepareOnly,
      },
      targets: config.targets,
    });
  }

  static normalize(raw) {
    if (!ValueChecks.isObject(raw)) {
      throw new ConfigurationError("Config root must be an object.");
    }
    ValueChecks.allowedKeys(
      raw,
      ["schemaVersion", "sample", "retry", "targets", "environment", "execution"],
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
    const retry = ComparisonConfig.normalizeRetry(raw.retry);
    const targets = raw.targets.map((target, index) =>
      ComparisonConfig.normalizeTarget(target, index),
    );
    const environment = ComparisonConfig.normalizeEnvironment(raw.environment);
    const execution = ComparisonConfig.normalizeExecution(raw.execution);
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
    return {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      sample,
      retry,
      targets,
      environment,
      execution,
    };
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
      traceProfile: ValueChecks.string(
        raw.traceProfile === undefined ? DEFAULT_SAMPLE.traceProfile : raw.traceProfile,
        "sample.traceProfile",
      ),
      inputDeliveryPolicy: ValueChecks.string(
        raw.inputDeliveryPolicy === undefined
          ? DEFAULT_SAMPLE.inputDeliveryPolicy
          : raw.inputDeliveryPolicy,
        "sample.inputDeliveryPolicy",
      ),
      inputBackend: ValueChecks.string(
        raw.inputBackend === undefined
          ? DEFAULT_SAMPLE.inputBackend
          : raw.inputBackend,
        "sample.inputBackend",
      ),
      canvasPoint: ComparisonConfig.normalizeCanvasPoint(raw.canvasPoint),
    };
    if (!new Set([NO_TRACE_PROFILE, FPS_TRACE_PROFILE, FPS_MINIMAL_TRACE_PROFILE, "quick", "full"]).has(sample.traceProfile)) {
      throw new ConfigurationError(
        "sample.traceProfile must be \"none\", \"fps-minimal\", \"fps\", \"quick\", or \"full\".",
      );
    }
    if (!INPUT_DELIVERY_POLICIES.has(sample.inputDeliveryPolicy)) {
      throw new ConfigurationError(
        'sample.inputDeliveryPolicy must be "strict" or "diagnostic".',
      );
    }
    if (!new Set(["cdp", "windows-native"]).has(sample.inputBackend)) {
      throw new ConfigurationError(
        'sample.inputBackend must be "cdp" or "windows-native".',
      );
    }
    if (sample.count % 2 !== 0) {
      throw new ConfigurationError("sample.count must be even.");
    }
    return sample;
  }

  static normalizeCanvasPoint(rawCanvasPoint) {
    if (rawCanvasPoint === undefined) return { ...DEFAULT_CANVAS_POINT };
    if (!ValueChecks.isObject(rawCanvasPoint)) {
      throw new ConfigurationError("sample.canvasPoint must be an object.");
    }
    ValueChecks.allowedKeys(
      rawCanvasPoint,
      ["xRatio", "yRatio"],
      "sample.canvasPoint",
    );
    return {
      xRatio: ValueChecks.number(
        rawCanvasPoint.xRatio,
        "sample.canvasPoint.xRatio",
        0.05,
        0.95,
      ),
      yRatio: ValueChecks.number(
        rawCanvasPoint.yRatio,
        "sample.canvasPoint.yRatio",
        0.05,
        0.95,
      ),
    };
  }

  static normalizeRetry(rawRetry) {
    if (rawRetry !== undefined && !ValueChecks.isObject(rawRetry)) {
      throw new ConfigurationError("retry must be an object.");
    }
    const raw = rawRetry || {};
    ValueChecks.allowedKeys(
      raw,
      Object.keys(DEFAULT_RETRY_POLICY),
      "retry",
    );
    return {
      maxInputRetries: ValueChecks.optionalInteger(
        raw.maxInputRetries,
        DEFAULT_RETRY_POLICY.maxInputRetries,
        "retry.maxInputRetries",
        0,
        10,
      ),
      durationBackoffMultiplier: ValueChecks.optionalNumber(
        raw.durationBackoffMultiplier,
        DEFAULT_RETRY_POLICY.durationBackoffMultiplier,
        "retry.durationBackoffMultiplier",
        1,
        10,
      ),
    };
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
      ["waitSelector", "readyExpression", "settleMs", "actions"],
      `${location}.setup`,
    );
    const waitSelector = ValueChecks.string(
      raw.waitSelector === undefined ? "canvas" : raw.waitSelector,
      `${location}.setup.waitSelector`,
    );
    const readyExpression =
      raw.readyExpression === undefined || raw.readyExpression === null
        ? null
        : ValueChecks.string(
            raw.readyExpression,
            `${location}.setup.readyExpression`,
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
      readyExpression,
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
        normalizeToFirstTarget: false,
        maxResizeAttempts: 0,
        settleMs: 0,
        windowPlacement: null,
      };
    }
    ValueChecks.allowedKeys(
      rawEnvironment,
      [
        "canvasCssSize",
        "normalizeToFirstTarget",
        "maxResizeAttempts",
        "settleMs",
        "windowPlacement",
      ],
      "environment",
    );
    const normalizeToFirstTarget = ValueChecks.optionalBoolean(
      rawEnvironment.normalizeToFirstTarget,
      false,
      "environment.normalizeToFirstTarget",
    );
    if (
      normalizeToFirstTarget &&
      rawEnvironment.canvasCssSize !== undefined
    ) {
      throw new ConfigurationError(
        "environment.canvasCssSize and environment.normalizeToFirstTarget cannot be combined.",
      );
    }
    if (!normalizeToFirstTarget && !ValueChecks.isObject(rawEnvironment.canvasCssSize)) {
      throw new ConfigurationError(
        "environment.canvasCssSize must be an object unless environment.normalizeToFirstTarget is true.",
      );
    }
    if (rawEnvironment.canvasCssSize !== undefined) {
      ValueChecks.allowedKeys(
        rawEnvironment.canvasCssSize,
        ["width", "height"],
        "environment.canvasCssSize",
      );
    }
    const windowPlacement = ComparisonConfig.normalizeWindowPlacement(
      rawEnvironment.windowPlacement,
    );
    return {
      canvasCssSize:
        rawEnvironment.canvasCssSize === undefined
          ? null
          : {
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
      normalizeToFirstTarget,
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
      windowPlacement,
    };
  }

  static normalizeWindowPlacement(rawWindowPlacement) {
    if (rawWindowPlacement === undefined || rawWindowPlacement === null) {
      return null;
    }
    if (!ValueChecks.isObject(rawWindowPlacement)) {
      throw new ConfigurationError("environment.windowPlacement must be an object.");
    }
    ValueChecks.allowedKeys(
      rawWindowPlacement,
      ["left", "top", "minimumRightMargin", "minimumBottomMargin"],
      "environment.windowPlacement",
    );
    return {
      left: ValueChecks.integer(
        rawWindowPlacement.left,
        "environment.windowPlacement.left",
        -100000,
        100000,
      ),
      top: ValueChecks.integer(
        rawWindowPlacement.top,
        "environment.windowPlacement.top",
        -100000,
        100000,
      ),
      minimumRightMargin: ValueChecks.integer(
        rawWindowPlacement.minimumRightMargin,
        "environment.windowPlacement.minimumRightMargin",
        0,
        10000,
      ),
      minimumBottomMargin: ValueChecks.integer(
        rawWindowPlacement.minimumBottomMargin,
        "environment.windowPlacement.minimumBottomMargin",
        0,
        10000,
      ),
    };
  }

  static normalizeExecution(rawExecution) {
    if (rawExecution !== undefined && !ValueChecks.isObject(rawExecution)) {
      throw new ConfigurationError("execution must be an object.");
    }
    const raw = rawExecution || {};
    ValueChecks.allowedKeys(raw, ["reuseReadyState", "prepareOnly"], "execution");
    return {
      reuseReadyState: ValueChecks.optionalBoolean(
        raw.reuseReadyState,
        false,
        "execution.reuseReadyState",
      ),
      prepareOnly: ValueChecks.optionalBoolean(
        raw.prepareOnly,
        false,
        "execution.prepareOnly",
      ),
    };
  }

  static normalizeActionPostcondition(rawPostcondition, location) {
    if (!ValueChecks.isObject(rawPostcondition)) {
      throw new ConfigurationError(`${location}.postcondition must be an object.`);
    }
    ValueChecks.allowedKeys(
      rawPostcondition,
      ["selector", "visible"],
      `${location}.postcondition`,
    );
    return {
      selector: ValueChecks.string(
        rawPostcondition.selector,
        `${location}.postcondition.selector`,
      ),
      visible: ValueChecks.boolean(
        rawPostcondition.visible,
        `${location}.postcondition.visible`,
      ),
    };
  }

  static normalizeAction(raw, location) {
    if (!ValueChecks.isObject(raw)) {
      throw new ConfigurationError(`${location} must be an object.`);
    }
    ValueChecks.allowedKeys(
      raw,
      [
        "type",
        "selector",
        "x",
        "y",
        "containerSelector",
        "itemSelector",
        "text",
        "postcondition",
        "whenExpression",
      ],
      location,
    );
    const type = ValueChecks.string(raw.type, `${location}.type`);
    const result = { type };
    if (type === "click") {
      const hasSelector = raw.selector !== undefined;
      const hasX = raw.x !== undefined;
      const hasY = raw.y !== undefined;
      if (hasSelector === (hasX || hasY) || (hasX !== hasY)) {
        throw new ConfigurationError(
          `${location} must provide exactly selector or both x and y.`,
        );
      }
      if (hasSelector) {
        result.selector = ValueChecks.string(raw.selector, `${location}.selector`);
      } else {
        result.x = ValueChecks.number(raw.x, `${location}.x`, -100000, 100000);
        result.y = ValueChecks.number(raw.y, `${location}.y`, -100000, 100000);
      }
    } else if (type === "click-text") {
      if (raw.selector !== undefined || raw.x !== undefined || raw.y !== undefined) {
        throw new ConfigurationError(
          `${location} click-text action cannot provide selector, x, or y.`,
        );
      }
      result.containerSelector = ValueChecks.string(
        raw.containerSelector,
        `${location}.containerSelector`,
      );
      result.itemSelector = ValueChecks.string(
        raw.itemSelector,
        `${location}.itemSelector`,
      );
      const rawTexts = Array.isArray(raw.text) ? raw.text : [raw.text];
      if (rawTexts.length === 0) {
        throw new ConfigurationError(`${location}.text must contain at least one string.`);
      }
      result.text = rawTexts.map((text, textIndex) =>
        ValueChecks.string(text, `${location}.text[${textIndex}]`),
      );
      if (new Set(result.text).size !== result.text.length) {
        throw new ConfigurationError(`${location}.text must not repeat a candidate.`);
      }
      if (raw.postcondition === undefined) {
        throw new ConfigurationError(
          `${location} click-text action requires a postcondition.`,
        );
      }
    } else {
      throw new ConfigurationError(
        `${location}.type must be "click" or "click-text".`,
      );
    }
    if (raw.postcondition !== undefined) {
      result.postcondition = ComparisonConfig.normalizeActionPostcondition(
        raw.postcondition,
        location,
      );
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
    this.queue = Promise.resolve();
  }

  run(scriptPath, args, options = {}) {
    const execute = () => this.runProcess(scriptPath, args, options);
    const result = this.queue.then(execute, execute);
    this.queue = result.catch(() => undefined);
    return result;
  }

  runProcess(scriptPath, args, options = {}) {
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
        displaySurface: {
          screen: {
            availLeft: screen.availLeft,
            availTop: screen.availTop,
            availWidth: screen.availWidth,
            availHeight: screen.availHeight
          },
          window: {
            screenX,
            screenY,
            outerWidth,
            outerHeight,
            innerWidth,
            innerHeight
          }
        },
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
      ["displaySurface.screen.availLeft", value.displaySurface?.screen?.availLeft],
      ["displaySurface.screen.availTop", value.displaySurface?.screen?.availTop],
      ["displaySurface.screen.availWidth", value.displaySurface?.screen?.availWidth],
      ["displaySurface.screen.availHeight", value.displaySurface?.screen?.availHeight],
      ["displaySurface.window.screenX", value.displaySurface?.window?.screenX],
      ["displaySurface.window.screenY", value.displaySurface?.window?.screenY],
      ["displaySurface.window.outerWidth", value.displaySurface?.window?.outerWidth],
      ["displaySurface.window.outerHeight", value.displaySurface?.window?.outerHeight],
      ["displaySurface.window.innerWidth", value.displaySurface?.window?.innerWidth],
      ["displaySurface.window.innerHeight", value.displaySurface?.window?.innerHeight],
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

class WindowSurfacePlacement {
  static compare(environments, placement, targetNames) {
    if (placement === null) {
      return {
        enabled: false,
        valid: true,
        placement: null,
        invalidReasons: [],
        targets: [],
      };
    }
    const targets = environments.map((environment, targetIndex) =>
      WindowSurfacePlacement.evaluate(
        environment,
        placement,
        targetNames[targetIndex],
      ),
    );
    const firstScreen = targets[0].observed.screen;
    const secondScreen = targets[1].observed.screen;
    const sameScreen = ["availLeft", "availTop", "availWidth", "availHeight"].every(
      (field) => firstScreen[field] === secondScreen[field],
    );
    const invalidReasons = targets.flatMap((target) => target.invalidReasons);
    if (!sameScreen) {
      invalidReasons.push(
        `window-placement-screen-mismatch: ${targetNames[0]}=${JSON.stringify(firstScreen)} ${targetNames[1]}=${JSON.stringify(secondScreen)}`,
      );
    }
    return {
      enabled: true,
      valid: invalidReasons.length === 0,
      placement,
      sameScreen,
      invalidReasons,
      targets,
    };
  }

  static evaluate(environment, placement, targetName) {
    const observed = environment.displaySurface;
    const { screen, window } = observed;
    const invalidReasons = [];
    const addMismatch = (field, expected, actual) => {
      invalidReasons.push(
        `window-placement-${field}-mismatch:${targetName}:expected=${expected}:actual=${actual}`,
      );
    };
    if (screen.availLeft !== placement.left) {
      addMismatch("screen-left", placement.left, screen.availLeft);
    }
    if (screen.availTop !== placement.top) {
      addMismatch("screen-top", placement.top, screen.availTop);
    }
    if (Math.abs(window.screenX - placement.left) > WINDOW_POSITION_TOLERANCE_PX) {
      addMismatch("window-left", placement.left, window.screenX);
    }
    if (Math.abs(window.screenY - placement.top) > WINDOW_POSITION_TOLERANCE_PX) {
      addMismatch("window-top", placement.top, window.screenY);
    }
    const requiredWidth =
      Math.max(window.outerWidth, window.innerWidth) +
      placement.minimumRightMargin;
    const requiredHeight =
      Math.max(window.outerHeight, window.innerHeight) +
      placement.minimumBottomMargin;
    if (requiredWidth > screen.availWidth) {
      invalidReasons.push(
        `window-placement-horizontal-capacity:${targetName}:required=${requiredWidth}:available=${screen.availWidth}`,
      );
    }
    if (requiredHeight > screen.availHeight) {
      invalidReasons.push(
        `window-placement-vertical-capacity:${targetName}:required=${requiredHeight}:available=${screen.availHeight}`,
      );
    }
    return {
      targetName,
      valid: invalidReasons.length === 0,
      invalidReasons,
      requiredSize: { width: requiredWidth, height: requiredHeight },
      observed,
    };
  }
}

class RoundPlan {
  static order(roundNumber) {
    return roundNumber % 2 === 1 ? [0, 1] : [1, 0];
  }
}

class CanvasInputPoint {
  static resolve(canvasPoint, canvasRect) {
    const page = {
      x: Math.floor(canvasRect.x + canvasRect.width * canvasPoint.xRatio),
      y: Math.floor(canvasRect.y + canvasRect.height * canvasPoint.yRatio),
    };
    return {
      source: "normalized-canvas-coordinate",
      normalized: { ...canvasPoint },
      page,
      canvasRect: {
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height,
      },
    };
  }
}

class NativeWindowPlacement {
  static resolve(placement, environment, inputBackend) {
    if (placement === null || inputBackend !== "windows-native") return null;
    const surfaceWindow = environment?.displaySurface?.window;
    const bounds = {
      left: placement.left,
      top: placement.top,
      width: surfaceWindow?.outerWidth,
      height: surfaceWindow?.outerHeight,
    };
    for (const [field, value] of Object.entries(bounds)) {
      if (!Number.isInteger(value)) {
        throw new ContractError(
          `Native post-focus window placement requires integer ${field}; actual=${value}.`,
        );
      }
    }
    if (bounds.width < 200 || bounds.height < 200) {
      throw new ContractError(
        `Native post-focus window placement requires a window of at least 200x200; actual=${bounds.width}x${bounds.height}.`,
      );
    }
    return bounds;
  }

  static appendArguments(args, bounds) {
    if (bounds === null) return;
    args.push(
      "--post-focus-window-left",
      String(bounds.left),
      "--post-focus-window-top",
      String(bounds.top),
      "--post-focus-window-width",
      String(bounds.width),
      "--post-focus-window-height",
      String(bounds.height),
    );
  }
}

class RoundAttemptPlan {
  static sample(baseSample) {
    return {
      ...baseSample,
      inputIntervalMs: baseSample.durationMs / (baseSample.count - 1),
    };
  }

  static inputRetryReason(samples) {
    const invalidInput = samples.filter(
      (sample) => sample.input?.delivery?.valid !== true,
    );
    if (invalidInput.length === 0) return null;
    return invalidInput.map((sample) => ({
      sampleId: sample.sampleId,
      targetName: sample.targetName,
      reasons: sample.input.delivery.reasons,
    }));
  }

  static traceEvidenceFailureReason(samples) {
    const invalidTraceEvidence = samples.filter(
      (sample) =>
        sample.sample?.traceProfile !== NO_TRACE_PROFILE &&
        sample.input?.delivery?.valid === true &&
        (sample.presentation?.evidence?.valid !== true ||
          sample.traceIntegrity?.analyzed?.valid !== true),
    );
    if (invalidTraceEvidence.length === 0) return null;
    return invalidTraceEvidence.map((sample) => ({
      sampleId: sample.sampleId,
      targetName: sample.targetName,
      presentationValid: sample.presentation?.evidence?.valid === true,
      traceIntegrityValid: sample.traceIntegrity?.analyzed?.valid === true,
      invalidReasons: sample.invalidReasons.filter((reason) =>
        reason.startsWith("analysis:"),
      ),
    }));
  }
}

class AttemptTiming {
  constructor() {
    this.startedAt = Date.now();
    this.phases = {};
  }

  async run(name, operation) {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      this.add(name, Date.now() - startedAt);
    }
  }

  add(name, elapsedMilliseconds) {
    const elapsed = Math.max(0, Math.round(elapsedMilliseconds));
    this.phases[name] = (this.phases[name] || 0) + elapsed;
  }

  toObject() {
    return {
      totalMilliseconds: Math.max(0, Date.now() - this.startedAt),
      phases: { ...this.phases },
    };
  }
}

class SummaryStore {
  constructor(config, runMetadata) {
    this.config = config;
    this.runMetadata = runMetadata;
    this.runDirectory = null;
    this.runContractPath = null;
    this.rounds = [];
    this.samples = [];
    this.failure = null;
  }

  setRunFiles(runDirectory, runContractPath) {
    this.runDirectory = runDirectory;
    this.runContractPath = runContractPath;
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
    const acceptedSamples = targetSamples.filter((sample) => sample.accepted === true);
    const metric = (name) => SummaryStore.numeric(acceptedSamples.map((sample) => sample.metrics[name]));
    const gapCandidates = [];
    for (const sample of acceptedSamples) {
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
      attemptSampleCount: targetSamples.length,
      sampleCount: acceptedSamples.length,
      acceptedSampleCount: acceptedSamples.length,
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
      run: {
        directory: this.runDirectory,
        contractFile: this.runContractPath,
        source: this.runMetadata?.source || "external-config",
        configPath: this.runMetadata?.configPath || null,
        cliOverrides: this.runMetadata?.cliOverrides || null,
      },
      contract: {
        schemaVersion: this.config.schemaVersion,
        sample: this.config.sample,
        retry: this.config.retry,
        environment: this.config.environment,
        execution: this.config.execution,
        targets: this.config.targets,
        rules: {
          targetDiscovery: "Each round runs cdp.mjs status and list, then requires one exact URL match per target.",
          foregroundActivation:
            this.config.sample.inputBackend === "windows-native"
              ? "Native Windows wheel mode explicitly activates one exact target window immediately before its sample; the two targets are sampled sequentially because SendInput targets the foreground render widget."
              : "CDP mode does not require Windows foreground activation; exact targets are bound through their WebSocket URLs.",
          surfacePreparation: "Existing targets are reused. Native wheel mode resolves the foreground Chrome_RenderWidgetHostHWND by the verified viewport size and fails closed when it is not unique.",
          windowPlacement:
            this.config.environment.windowPlacement === null
              ? "Disabled unless environment.windowPlacement is configured."
              : this.config.execution.reuseReadyState
                ? "Prepared-state mode does not move windows; both targets must already pass the configured same-screen origin and capacity readback gate before input."
                : "After reload and readiness, both existing windows are restored to normal and moved to the configured screen origin. Canvas resizing preserves that origin, and both targets must pass the same-screen capacity readback gate before input.",
          canvas: "Largest visible canvas; CSS size and drawingBuffer/DPR are read back before sampling.",
          statePreparation: this.config.execution.prepareOnly
            ? "Preparation-only mode reloads, reads initial environments, normalizes windows, proves camera setup actions, rereads environments, and runs the paired anchor gate without starting an overlay, trace, or wheel sample."
            : this.config.execution.reuseReadyState
              ? "Prepared-state mode performs no reload, setup action, or window resize. It reruns exact-target discovery, visible-canvas checks, canvas/DPR parity, and the paired anchor gate before the one allowed sample pair."
              : "Fresh-state mode reloads both targets, reads their initial environments, normalizes windows, proves camera setup actions, rereads environments, and then runs parity and paired-anchor gates before sampling.",
          windowNormalization: this.config.execution.reuseReadyState
            ? "Disabled in prepared-state mode; pre-existing canvas CSS dimensions must already match."
            : this.config.environment.canvasCssSize === null &&
                this.config.environment.normalizeToFirstTarget !== true
              ? "Disabled unless environment.canvasCssSize is configured or normalizeToFirstTarget is enabled."
              : this.config.environment.normalizeToFirstTarget === true
                ? "Each attempt uses target 0's post-reload canvas CSS size, then normalizes both existing target windows to that size without foreground activation."
                : "Existing target windows are resized without foreground activation until their canvases match environment.canvasCssSize or the retry limit is reached.",
          parity: "Both pages must be visible, have equal DPR and equal canvas CSS width/height, and each drawingBuffer must equal round(CSS size * DPR).",
          anchor: "Each attempt saves paired canvas screenshots and rejects a camera/model anchor mismatch before wheel input.",
          ready: "Each target may provide setup.readyExpression so application-specific readiness can be proven instead of treating canvas existence as sufficient.",
          retry: this.config.execution.prepareOnly || this.config.execution.reuseReadyState
            ? "Preparation-only and prepared-state modes do not retry because they intentionally emit one auditable gate result instead of changing the established browser state."
            : "A hard trusted-input, direction/accumulation, timing, visual, or trace failure discards the entire pair, reloads both targets, re-runs setup and anchor gates, and retries only up to the configured limit with the recorded cadence backoff. Valid same-direction browser coalescing is accepted and recorded.",
          aggregation: this.config.execution.prepareOnly
            ? "Preparation-only mode emits no wheel samples and therefore no numeric performance aggregate."
            : "Only accepted paired samples contribute to aggregate numeric metrics; valid coalescing remains visible in input.coalescing and invalid attempts remain in samples for audit.",
          order: "Odd rounds target0->target1; even rounds target1->target0. Native Windows input never injects both targets simultaneously.",
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
  constructor(config, outputDirectory, runMetadata = null) {
    this.config = config;
    this.outputDirectory = outputDirectory;
    this.runMetadata = runMetadata;
    this.processes = new NodeProcessRunner(SCRIPT_DIRECTORY);
    this.outputAllocator = new OutputDirectoryAllocator();
    this.summary = new SummaryStore(config, runMetadata);
    this.runDirectory = null;
    this.summaryPath = null;
    this.runContractPath = null;
    this.reuseReadyState = config.execution.reuseReadyState;
    this.prepareOnly = config.execution.prepareOnly;
    const maximumAttemptDuration =
      config.sample.durationMs *
      config.retry.durationBackoffMultiplier ** config.retry.maxInputRetries;
    this.cdpTimeoutMs = Math.min(
      600000,
      Math.max(10000, maximumAttemptDuration + config.sample.settleMs + 30000),
    );
  }

  progress(message) {
    process.stdout.write(`${message}\n`);
  }

  async run() {
    this.validateExecutionMode();
    this.runDirectory = await this.outputAllocator.create(this.outputDirectory);
    this.summaryPath = path.join(this.runDirectory, "comparison-summary.json");
    this.runContractPath = path.join(this.runDirectory, "run-contract.json");
    this.summary.setRunFiles(this.runDirectory, this.runContractPath);
    try {
      await this.writeRunContract();
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

  validateExecutionMode() {
    if (this.prepareOnly && this.reuseReadyState) {
      throw new ConfigurationError(
        "execution.prepareOnly cannot be combined with execution.reuseReadyState.",
      );
    }
    if (this.prepareOnly && this.config.sample.rounds !== 1) {
      throw new ConfigurationError(
        "execution.prepareOnly requires exactly one round because it is a single fresh-state preparation gate.",
      );
    }
    if (!this.reuseReadyState) return;
    if (this.config.sample.rounds !== 1) {
      throw new ConfigurationError(
        "execution.reuseReadyState requires exactly one round because a wheel sample can change the camera/model state.",
      );
    }
    for (const target of this.config.targets) {
      if (target.setup.actions.length !== 0) {
        throw new ConfigurationError(
          `execution.reuseReadyState requires targets.${target.name}.setup.actions to be empty so the verified prepared state is not changed before sampling.`,
        );
      }
    }
  }

  async writeSummary() {
    await fs.writeFile(
      this.summaryPath,
      `${JSON.stringify(this.summary.toObject(), null, 2)}\n`,
      "utf8",
    );
  }

  async writeRunContract() {
    let pluginManifest = null;
    try {
      pluginManifest = JSON.parse(await fs.readFile(PLUGIN_MANIFEST_PATH, "utf8"));
    } catch (error) {
      pluginManifest = { readError: error.message };
    }
    await fs.writeFile(
      this.runContractPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          plugin: {
            manifestPath: PLUGIN_MANIFEST_PATH,
            name: pluginManifest?.name || null,
            version: pluginManifest?.version || null,
          },
          metadata: this.runMetadata,
          config: this.summary.toObject().contract,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  async runRound(roundNumber) {
    const order = RoundPlan.order(roundNumber);
    const round = {
      round: roundNumber,
      order,
      attempts: [],
      sampleIds: [],
      accepted: false,
    };
    this.summary.addRound(round);
    const maximumInputAttempts = this.reuseReadyState || this.prepareOnly
      ? 1
      : this.config.retry.maxInputRetries + 1;
    const maximumAttempts = maximumInputAttempts;
    let inputAttemptNumber = 1;
    for (let attemptNumber = 1; attemptNumber <= maximumAttempts; attemptNumber += 1) {
      const timing = new AttemptTiming();
      const attemptSample = RoundAttemptPlan.sample(
        this.config.sample,
      );
      const attempt = {
        attempt: attemptNumber,
        retryIndex: inputAttemptNumber - 1,
        sample: attemptSample,
        targets: [],
        sampleIds: [],
        accepted: false,
      };
      round.attempts.push(attempt);
      let overlaySessions = [];
      try {
        const discovery = await timing.run(
          "targetDiscovery",
          () => this.discoverTargets(roundNumber, attemptNumber),
        );
        const discovered = discovery.targets;
        attempt.cdp = {
          status: discovery.status,
          targetList: discovery.targetList,
        };
        attempt.targets = discovered.map((entry, targetIndex) => ({
          targetIndex,
          name: this.config.targets[targetIndex].name,
          id: entry.id,
          title: entry.title,
          url: entry.url,
        }));
        let environments;
        if (this.reuseReadyState) {
          if (this.config.environment.windowPlacement !== null) {
            attempt.windowPlacementApplication = {
              mode: "not-applied-reuse-ready-state",
              reason:
                "Prepared-state mode does not move existing Chrome windows; the placement readback gate must already pass.",
              placement: this.config.environment.windowPlacement,
            };
          }
          if (attemptSample.inputBackend === "windows-native") {
            attempt.nativeWindowPreparation = {
              mode: "deferred-to-sample-dispatch",
              activationDuringPreparation: false,
              reason:
                "Windows native input activates one exact target immediately before its sample; setup does not change the foreground window.",
            };
          }
          this.progress(
            `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}/${maximumAttempts}: verify prepared surfaces without reload`,
          );
          attempt.preparation = await timing.run(
            "readyStateVerification",
            () => this.verifyReadyState(discovered),
          );
          attempt.setup = {
            mode: "skipped-reuse-ready-state",
            reason: "prepared-state mode requires empty setup actions",
            targets: this.config.targets.map((target, targetIndex) => ({
              targetIndex,
              name: target.name,
              actions: [],
              settleMs: 0,
            })),
          };
          environments = attempt.preparation.environments;
        } else {
          this.progress(
            `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}/${maximumAttempts}: reload and wait`,
          );
          if (attemptSample.inputBackend === "windows-native") {
            attempt.nativeWindowStatePreparation = await timing.run(
              "nativeWindowStatePreparation",
              () => this.restoreNativeWindowStates(discovered),
            );
          }
          await timing.run(
            "reloadAndReady",
            () => this.reloadAndWait(discovered),
          );
          if (this.config.environment.windowPlacement !== null) {
            attempt.windowPlacementApplication = await timing.run(
              "windowPlacementApplication",
              () => this.placeWindows(discovered),
            );
          }
          if (attemptSample.inputBackend === "windows-native") {
            attempt.nativeWindowPreparation = {
              mode: "deferred-to-sample-dispatch",
              activationDuringPreparation: false,
              reason:
                "Windows native input activates one exact target immediately before its sample; setup does not change the foreground window.",
            };
          }
          environments = await timing.run(
            "initialEnvironment",
            () =>
              Promise.all(
                discovered.map((target, targetIndex) =>
                  this.readEnvironment(target, targetIndex),
                ),
              ),
          );
          attempt.initialEnvironment = environments;
        }
        const targetCanvasCssSize = this.config.environment.normalizeToFirstTarget
          ? {
              width: environments[0].rect.width,
              height: environments[0].rect.height,
            }
          : this.config.environment.canvasCssSize;
        if (targetCanvasCssSize !== null && !this.reuseReadyState) {
          attempt.windowNormalization = await timing.run(
            "windowNormalization",
            () =>
              this.normalizeCanvasWindows(
                discovered,
                environments,
                targetCanvasCssSize,
              ),
          );
          environments = attempt.windowNormalization.map(
            (normalization) => normalization.finalEnvironment,
          );
        } else if (targetCanvasCssSize !== null) {
          attempt.windowNormalization = {
            mode: "not-applied-reuse-ready-state",
            reason:
              "Prepared-state mode does not resize existing Chrome windows; canvas/DPR parity must already pass.",
            targetSize: targetCanvasCssSize,
            targets: environments.map((environment, targetIndex) => ({
              targetIndex,
              name: this.config.targets[targetIndex].name,
              matched:
                environment.rect.width === targetCanvasCssSize.width &&
                environment.rect.height === targetCanvasCssSize.height,
              environment,
            })),
          };
        }
        if (!this.reuseReadyState) {
          attempt.setup = await timing.run("setup", () => this.runSetup(discovered));
          environments = await timing.run(
            "preparedEnvironment",
            () =>
              Promise.all(
                discovered.map((target, targetIndex) =>
                  this.readEnvironment(target, targetIndex),
                ),
              ),
          );
          attempt.preparedEnvironment = environments;
        }
        const windowPlacementContract = WindowSurfacePlacement.compare(
          environments,
          this.config.environment.windowPlacement,
          this.config.targets.map((target) => target.name),
        );
        attempt.windowPlacement = windowPlacementContract;
        if (!windowPlacementContract.valid) {
          throw new ContractError(
            `Round ${roundNumber} attempt ${attemptNumber} window placement contract failed: ${windowPlacementContract.invalidReasons.join(" ")}`,
            windowPlacementContract.invalidReasons,
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
          targetCanvasCssSize,
        );
        attempt.environment = environmentContract;
        if (!environmentContract.valid) {
          throw new ContractError(
            `Round ${roundNumber} attempt ${attemptNumber} environment contract failed: ${environmentContract.invalidReasons.join(" ")}`,
            environmentContract.invalidReasons,
          );
        }
        const anchorContract = await timing.run(
          "anchorGate",
          () =>
            this.compareCanvasAnchors(
              discovered,
              environments,
              roundNumber,
              attemptNumber,
            ),
        );
        attempt.anchor = anchorContract;
        if (!anchorContract.valid) {
          throw new ContractError(
            `Round ${roundNumber} attempt ${attemptNumber} camera/model anchor contract failed: ${anchorContract.reasons.join(" ")}`,
            anchorContract.reasons,
          );
        }
        if (this.prepareOnly) {
          attempt.preparationOnly = {
            valid: true,
            wheelInputDispatched: false,
            fpsOverlayStarted: false,
            traceStarted: false,
            reason:
              "Preparation-only mode completed exact-target, window-placement, environment, semantic-camera, and paired-anchor gates before any performance instrumentation or wheel input.",
          };
          attempt.accepted = true;
          round.accepted = true;
          round.prepared = true;
          this.progress(
            `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}: preparation gates passed; no FPS overlay, trace, or wheel input was started`,
          );
          return;
        }
        if (this.config.sample.showFpsCounter) {
          this.progress(
            `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}: enable native FPS overlays`,
          );
          overlaySessions = await timing.run(
            "fpsOverlayStart",
            () => this.startNativeFpsOverlays(discovered),
          );
          attempt.fpsOverlay = {
            requested: true,
            targets: overlaySessions.map((session) => session.describe()),
          };
        } else {
          attempt.fpsOverlay = { requested: false, targets: [] };
        }
        const samples = [];
        this.progress(
          `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}: sample ${order[0]} then ${order[1]}`,
        );
        for (const targetIndex of order) {
          const sample = await timing.run(
            `sample:${this.config.targets[targetIndex].name}`,
            () =>
              this.runSample(
                roundNumber,
                attemptNumber,
                targetIndex,
                discovered[targetIndex],
                environments[targetIndex],
                environmentContract,
                anchorContract,
                overlaySessions[targetIndex] ?? null,
                attemptSample,
              ),
          );
          samples.push(sample);
          this.summary.addSample(sample);
          attempt.sampleIds.push(sample.sampleId);
        }
        const retryReasons = RoundAttemptPlan.inputRetryReason(samples);
        attempt.inputDelivery = {
          valid: retryReasons === null,
          reasons: retryReasons || [],
        };
        const diagnosticInput = this.config.sample.inputDeliveryPolicy === "diagnostic";
        if (retryReasons !== null) {
          attempt.retry = {
            requested: inputAttemptNumber < maximumInputAttempts,
            reason: "input-delivery-mismatch",
            details: retryReasons,
          };
          this.progress(
            diagnosticInput
              ? `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}: keeping pair with diagnostic wheel coalescing evidence`
              : `round ${roundNumber}/${this.config.sample.rounds} attempt ${attemptNumber}: discarded pair because input delivery was not exact`,
          );
          if (diagnosticInput) {
            throw new ContractError(
              `Round ${roundNumber} diagnostic wheel sample failed a hard input or rendering contract.`,
              retryReasons.flatMap((entry) => entry.reasons),
            );
          }
          if (inputAttemptNumber < maximumInputAttempts) {
            inputAttemptNumber += 1;
            continue;
          }
          throw new ContractError(
            `Round ${roundNumber} exhausted ${maximumInputAttempts} paired attempts without exact wheel delivery.`,
            retryReasons.flatMap((entry) => entry.reasons),
          );
        }
        const traceEvidenceReasons =
          RoundAttemptPlan.traceEvidenceFailureReason(samples);
        attempt.traceEvidence = {
          valid: traceEvidenceReasons === null,
          retryRequested: false,
          reason:
            traceEvidenceReasons === null
              ? null
              : "Trace evidence is reported without an implicit full-trace rerun. Run an explicit full-trace profile only after fixing or accepting the recorded cause.",
          details: traceEvidenceReasons || [],
        };
        const pairAccepted = samples.length === 2 && samples.every(
          (sample) => sample.valid && sample.input.delivery.valid,
        );
        for (const sample of samples) sample.accepted = pairAccepted;
        attempt.accepted = pairAccepted;
        round.accepted = pairAccepted;
        if (!pairAccepted) {
          throw new ContractError(
            `Round ${roundNumber} produced no accepted pair because trace or capture validity failed.`,
            samples.flatMap((sample) => sample.invalidReasons),
          );
        }
        round.sampleIds = [...attempt.sampleIds];
        return;
      } finally {
        if (overlaySessions.length > 0) {
          attempt.fpsOverlayCleanup = await timing.run(
            "fpsOverlayCleanup",
            () => Promise.all(overlaySessions.map((session) => session.stop())),
          );
        }
        attempt.timing = timing.toObject();
      }
    }
  }

  async discoverTargets(roundNumber, attemptNumber = 1) {
    const status = await this.processes.runJson(
      CDP_SCRIPT,
      ["status", "--timeout", String(this.cdpTimeoutMs)],
      { label: `cdp status for round ${roundNumber} attempt ${attemptNumber}` },
    );
    if (status.value?.ok !== true) {
      throw new ContractError(`cdp status did not confirm a usable Chrome target.`);
    }
    const targetList = (
      await this.processes.runJson(
        CDP_SCRIPT,
        ["list", "--timeout", String(this.cdpTimeoutMs)],
        { label: `cdp list for round ${roundNumber} attempt ${attemptNumber}` },
      )
    ).value;
    if (!Array.isArray(targetList)) {
      throw new ContractError("cdp status/list did not return a target array.");
    }
    const targets = this.config.targets.map((targetConfig) => {
      const matches = targetList.filter(
        (target) => target.url === targetConfig.match.urlExact,
      );
      if (matches.length !== 1) {
        throw new ContractError(
          `Exact URL ${targetConfig.match.urlExact} matched ${matches.length} page targets in round ${roundNumber} attempt ${attemptNumber}; expected exactly one.`,
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
    return {
      status: status.value,
      targetList,
      targets,
    };
  }

  cdpArgs(command, targetId, extra = []) {
    const args = [command];
    if (targetId) args.push("--target-exact", targetId);
    args.push("--no-activate", "--timeout", String(this.cdpTimeoutMs), ...extra);
    return args;
  }

  async placeExactTargetWindow(target, requestedBounds, label) {
    const result = await this.processes.runJson(
      CDP_SCRIPT,
      this.cdpArgs("window-place", target.id, [
        "--allow-window-move",
        "--left",
        String(requestedBounds.left),
        "--top",
        String(requestedBounds.top),
        "--width",
        String(requestedBounds.width),
        "--height",
        String(requestedBounds.height),
      ]),
      { label },
    );
    if (result.value?.valid !== true) {
      throw new ContractError(`${label} did not return valid placement evidence.`);
    }
    return result.value;
  }

  async restoreNativeWindowStates(targets) {
    const restored = [];
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      const browserWindow = await this.browserCall(
        target.id,
        "Browser.getWindowForTarget",
        {},
        `read native window state target ${targetIndex}`,
      );
      if (
        !Number.isInteger(browserWindow?.windowId) ||
        !ValueChecks.isObject(browserWindow?.bounds)
      ) {
        throw new ContractError(
          `Target ${this.config.targets[targetIndex].name} did not return a usable Chrome window state.`,
        );
      }
      const previousState = browserWindow.bounds.windowState || "normal";
      if (previousState !== "normal") {
        await this.browserCall(
          target.id,
          "Browser.setWindowBounds",
          {
            windowId: browserWindow.windowId,
            bounds: { windowState: "normal" },
          },
          `restore native window state target ${targetIndex}`,
        );
        await Timer.sleep(this.config.environment.settleMs);
      }
      restored.push({
        targetIndex,
        name: this.config.targets[targetIndex].name,
        windowId: browserWindow.windowId,
        previousState,
        restored: previousState !== "normal",
      });
    }
    return {
      mode: "restored-before-reload",
      targets: restored,
    };
  }

  async placeWindows(targets) {
    const placement = this.config.environment.windowPlacement;
    if (placement === null) return [];
    const applied = [];
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      let browserWindow = await this.browserCall(
        target.id,
        "Browser.getWindowForTarget",
        {},
        `read window before placement target ${targetIndex}`,
      );
      if (
        !Number.isInteger(browserWindow?.windowId) ||
        !ValueChecks.isObject(browserWindow?.bounds)
      ) {
        throw new ContractError(
          `Target ${this.config.targets[targetIndex].name} did not return a usable Chrome window before placement.`,
        );
      }
      if (browserWindow.bounds.windowState !== "normal") {
        await this.browserCall(
          target.id,
          "Browser.setWindowBounds",
          {
            windowId: browserWindow.windowId,
            bounds: { windowState: "normal" },
          },
          `restore normal window state before placement target ${targetIndex}`,
        );
        await Timer.sleep(this.config.environment.settleMs);
        browserWindow = await this.browserCall(
          target.id,
          "Browser.getWindowForTarget",
          {},
          `reread restored window target ${targetIndex}`,
        );
      }
      const width = browserWindow?.bounds?.width;
      const height = browserWindow?.bounds?.height;
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        throw new ContractError(
          `Target ${this.config.targets[targetIndex].name} Chrome window bounds are incomplete before placement.`,
        );
      }
      const requestedBounds = {
        left: placement.left,
        top: placement.top,
        width,
        height,
      };
      const placementEvidence = await this.placeExactTargetWindow(
        target,
        requestedBounds,
        `place native window target ${targetIndex}`,
      );
      await Timer.sleep(this.config.environment.settleMs);
      applied.push({
        targetIndex,
        name: this.config.targets[targetIndex].name,
        windowId: browserWindow.windowId,
        requestedBounds,
        resolution: placementEvidence.resolution,
        browserPlacement: placementEvidence.browserPlacement,
        nativePlacement: placementEvidence.nativePlacement,
        readback: placementEvidence.readback,
        valid: placementEvidence.valid,
      });
    }
    return {
      mode: "applied-after-reload",
      placement,
      targets: applied,
    };
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

  async verifyReadyState(targets) {
    const environments = await Promise.all(
      targets.map((target, targetIndex) =>
        this.readEnvironment(target, targetIndex),
      ),
    );
    return {
      mode: "reuse-ready-state",
      reloaded: false,
      surfacesVerified: environments.every(
        (environment) => environment.visibility === "visible",
      ),
      environments,
      targets: targets.map((target, targetIndex) => ({
        targetIndex,
        id: target.id,
        url: target.url,
      })),
    };
  }

  async waitForReadySurface(target, targetIndex) {
    const setup = this.config.targets[targetIndex].setup;
    const selector = setup.waitSelector;
    const readyExpression = setup.readyExpression;
    const expression = `(() => {
      if (document.visibilityState !== "visible") return false;
      const surfaceReady = [...document.querySelectorAll(${JSON.stringify(selector)})].some((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          Number(style.opacity) !== 0;
      });
      if (!surfaceReady) return false;
      return ${readyExpression === null ? "true" : `Boolean(${readyExpression})`};
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
      `Target ${this.config.targets[targetIndex].name} did not satisfy ready surface ${selector}${readyExpression === null ? "" : " and readyExpression"}; lastValue=${String(lastValue)}; lastError=${lastError?.message || "none"}.`,
    );
  }

  async runSetup(targets) {
    const setupRecords = [];
    for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
      const target = targets[targetIndex];
      const actions = [];
      for (let actionIndex = 0; actionIndex < this.config.targets[targetIndex].setup.actions.length; actionIndex += 1) {
        const action = this.config.targets[targetIndex].setup.actions[actionIndex];
        const actionRecord = {
          actionIndex,
          type: action.type,
          skipped: false,
          condition: null,
        };
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
          actionRecord.condition = condition;
          if (!condition) {
            actionRecord.skipped = true;
            actions.push(actionRecord);
            continue;
          }
        }
        const resolved = await this.resolveSetupAction(
          target,
          targetIndex,
          actionIndex,
          action,
        );
        actionRecord.resolved = resolved;
        const clickArgs = [];
        if (resolved.selector !== undefined) {
          clickArgs.push("--selector", resolved.selector);
        } else {
          clickArgs.push("--x", String(resolved.x), "--y", String(resolved.y));
        }
        const click = (
          await this.processes.runJson(
            CDP_SCRIPT,
            this.cdpArgs("click", target.id, clickArgs),
            { label: `click target ${targetIndex} action ${actionIndex}` },
          )
        ).value;
        if (!click?.clicked) {
          throw new ContractError(
            `Setup action target ${targetIndex} action ${actionIndex} did not return click evidence.`,
          );
        }
        if (
          resolved.selector !== undefined &&
          click.hitBefore?.topWithinResolvedTarget !== true
        ) {
          throw new ContractError(
            `Setup action target ${targetIndex} action ${actionIndex} was not hit-testable as its resolved target.`,
            [JSON.stringify(click.hitBefore || null)],
          );
        }
        actionRecord.click = {
          clicked: click.clicked,
          hitBefore: click.hitBefore || null,
          input: click.input || null,
        };
        if (action.postcondition !== undefined) {
          actionRecord.postcondition = await this.waitForActionPostcondition(
            target,
            targetIndex,
            actionIndex,
            action.postcondition,
          );
        }
        actions.push(actionRecord);
      }
      await Timer.sleep(this.config.targets[targetIndex].setup.settleMs);
      setupRecords.push({
        targetIndex,
        readyExpression: this.config.targets[targetIndex].setup.readyExpression,
        settleMs: this.config.targets[targetIndex].setup.settleMs,
        actions,
      });
    }
    return setupRecords;
  }

  async resolveSetupAction(target, targetIndex, actionIndex, action) {
    if (action.type === "click-text") {
      return this.resolveClickTextAction(target, targetIndex, actionIndex, action);
    }
    if (action.selector !== undefined) {
      return { type: action.type, selector: action.selector };
    }
    return { type: action.type, x: action.x, y: action.y };
  }

  async resolveClickTextAction(target, targetIndex, actionIndex, action) {
    const expression = `(() => {
      const containerSelector = ${JSON.stringify(action.containerSelector)};
      const itemSelector = ${JSON.stringify(action.itemSelector)};
      const expectedTexts = ${JSON.stringify(action.text)};
      const normalizeText = (value) => String(value || "").trim().replace(/\\s+/g, " ");
      const isVisible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          Number(style.opacity) !== 0;
      };
      const containers = [...document.querySelectorAll(containerSelector)];
      if (containers.length !== 1) {
        throw new Error("Container selector matched " + containers.length + " elements: " + containerSelector);
      }
      const items = [...containers[0].querySelectorAll(itemSelector)].filter(isVisible);
      const matches = items.filter((element) =>
        expectedTexts.includes(normalizeText(element.innerText || element.textContent)),
      );
      if (matches.length !== 1) {
        throw new Error(
          "Exact menu text matched " + matches.length + " visible elements for " + JSON.stringify(expectedTexts) +
          ". Visible candidates: " + JSON.stringify(items.map((element) => normalizeText(element.innerText || element.textContent))),
        );
      }
      const selectorFor = (element) => {
        const partFor = (node) => {
          if (node.id) return "#" + CSS.escape(node.id);
          const tagName = node.tagName.toLowerCase();
          const siblings = [...node.parentElement.children].filter((sibling) => sibling.tagName === node.tagName);
          const index = siblings.indexOf(node) + 1;
          return tagName + ":nth-of-type(" + index + ")";
        };
        const parts = [];
        let current = element;
        while (current && current.nodeType === Node.ELEMENT_NODE) {
          parts.unshift(partFor(current));
          const selector = parts.join(" > ");
          if (document.querySelectorAll(selector).length === 1) return selector;
          current = current.parentElement;
        }
        throw new Error("Could not create a unique selector for the exact menu text match.");
      };
      const element = matches[0];
      const rect = element.getBoundingClientRect();
      return {
        type: "click-text",
        containerSelector,
        itemSelector,
        matchedText: normalizeText(element.innerText || element.textContent),
        selector: selectorFor(element),
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        element: {
          tagName: element.tagName,
          text: normalizeText(element.innerText || element.textContent),
          ariaLabel: element.getAttribute("aria-label"),
          className: element.getAttribute("class"),
        },
      };
    })()`;
    const resolved = await this.evaluate(
      target.id,
      expression,
      `resolve exact menu text target ${targetIndex} action ${actionIndex}`,
    );
    if (!ValueChecks.isObject(resolved) || typeof resolved.selector !== "string") {
      throw new ContractError(
        `Exact menu text resolution target ${targetIndex} action ${actionIndex} returned an invalid target.`,
      );
    }
    return resolved;
  }

  async waitForActionPostcondition(
    target,
    targetIndex,
    actionIndex,
    postcondition,
  ) {
    const selector = JSON.stringify(postcondition.selector);
    const expression = `(() => {
      const elements = [...document.querySelectorAll(${selector})];
      const visibleCount = elements.filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.visibility !== "collapse" &&
          Number(style.opacity) !== 0;
      }).length;
      return {
        selector: ${selector},
        matchCount: elements.length,
        visibleCount,
        visible: visibleCount > 0,
      };
    })()`;
    const deadline = Date.now() + 5000;
    let lastValue = null;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        lastValue = await this.evaluate(
          target.id,
          expression,
          `postcondition target ${targetIndex} action ${actionIndex}`,
        );
        if (lastValue?.visible === postcondition.visible) {
          return { expected: postcondition, observed: lastValue };
        }
      } catch (error) {
        lastError = error;
      }
      await Timer.sleep(100);
    }
    throw new ContractError(
      `Setup action target ${targetIndex} action ${actionIndex} did not satisfy postcondition selector=${postcondition.selector} visible=${String(postcondition.visible)}; lastValue=${JSON.stringify(lastValue)}; lastError=${lastError?.message || "none"}.`,
    );
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

  async compareCanvasAnchors(targets, environments, roundNumber, attemptNumber) {
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
    const files = await Promise.all(
      screenshots.map((screenshot, targetIndex) =>
        this.writeAnchorScreenshot(
          screenshot?.data,
          roundNumber,
          attemptNumber,
          this.config.targets[targetIndex].name,
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
        attempt: attemptNumber,
        roi,
        canvasRects: environments.map((environment) => environment.rect),
        files,
      },
    };
  }

  async writeAnchorScreenshot(data, roundNumber, attemptNumber, targetName) {
    if (typeof data !== "string" || data.length === 0) {
      throw new ContractError(
        `Round ${roundNumber} attempt ${attemptNumber} ${targetName} anchor screenshot did not contain PNG data.`,
      );
    }
    const bytes = Buffer.from(data, "base64");
    if (
      bytes.length < 8 ||
      !bytes.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      )
    ) {
      throw new ContractError(
        `Round ${roundNumber} attempt ${attemptNumber} ${targetName} anchor screenshot was not a PNG.`,
      );
    }
    const filename = [
      `round-${String(roundNumber).padStart(2, "0")}`,
      `attempt-${String(attemptNumber).padStart(2, "0")}`,
      "anchor",
      `${targetName}.png`,
    ].join("-");
    const outputPath = path.join(this.runDirectory, filename);
    await fs.writeFile(outputPath, bytes);
    return outputPath;
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

  async normalizeCanvasWindows(targets, initialEnvironments, targetSize) {
    return Promise.all(
      targets.map((target, targetIndex) =>
        this.normalizeCanvasWindow(
          target,
          targetIndex,
          initialEnvironments[targetIndex],
          targetSize,
        ),
      ),
    );
  }

  async normalizeCanvasWindow(target, targetIndex, initialEnvironment, targetSize) {
    const attempts = [];
    let environment = initialEnvironment;
    for (
      let attempt = 1;
      attempt <= this.config.environment.maxResizeAttempts;
      attempt += 1
    ) {
      const placementValid =
        this.config.environment.windowPlacement === null ||
        WindowSurfacePlacement.evaluate(
          environment,
          this.config.environment.windowPlacement,
          this.config.targets[targetIndex].name,
        ).valid;
      if (
        environment.rect.width === targetSize.width &&
        environment.rect.height === targetSize.height &&
        placementValid
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
        ...(this.config.environment.windowPlacement === null
          ? {}
          : {
              left: this.config.environment.windowPlacement.left,
              top: this.config.environment.windowPlacement.top,
            }),
        width: Math.max(
          200,
          Math.round(bounds.width + targetSize.width - environment.rect.width),
        ),
        height: Math.max(
          200,
          Math.round(bounds.height + targetSize.height - environment.rect.height),
        ),
      };
      let placementEvidence = null;
      if (this.config.environment.windowPlacement === null) {
        await this.browserCall(
          target.id,
          "Browser.setWindowBounds",
          { windowId, bounds: requestedBounds },
          `resize window target ${targetIndex} attempt ${attempt}`,
        );
      } else {
        placementEvidence = await this.placeExactTargetWindow(
          target,
          requestedBounds,
          `resize native window target ${targetIndex} attempt ${attempt}`,
        );
      }
      await Timer.sleep(this.config.environment.settleMs);
      environment = await this.readEnvironment(target, targetIndex);
      attempts.push({
        attempt,
        requestedBounds,
        placementEvidence,
        environment,
      });
    }
    return {
      targetIndex,
      targetSize,
      matched:
        environment.rect.width === targetSize.width &&
        environment.rect.height === targetSize.height &&
        (this.config.environment.windowPlacement === null ||
          WindowSurfacePlacement.evaluate(
            environment,
            this.config.environment.windowPlacement,
            this.config.targets[targetIndex].name,
          ).valid),
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

  async runSample(
    roundNumber,
    attemptNumber,
    targetIndex,
    target,
    environment,
    environmentContract,
    anchorContract,
    fpsOverlay,
    sample,
  ) {
    const sampleId = [
      `round-${String(roundNumber).padStart(2, "0")}`,
      `attempt-${String(attemptNumber).padStart(2, "0")}`,
      `target-${targetIndex}`,
    ].join("-");
    const basePath = path.join(this.runDirectory, sampleId);
    const capturePath = `${basePath}.json`;
    const traceEnabled = sample.traceProfile !== NO_TRACE_PROFILE;
    const tracePath = traceEnabled ? `${basePath}.trace.json` : null;
    const analyzedPath = traceEnabled ? `${basePath}.analyzed.json` : null;
    const inputPoint = CanvasInputPoint.resolve(
      sample.canvasPoint,
      environment.rect,
    );
    const postFocusWindowBounds = NativeWindowPlacement.resolve(
      this.config.environment.windowPlacement,
      environment,
      sample.inputBackend,
    );
    const args = [
      "--target-exact",
      target.id,
      "--target-websocket-url",
      target.webSocketDebuggerUrl,
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
      String(inputPoint.page.x),
      "--y",
      String(inputPoint.page.y),
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
    ];
    if (traceEnabled) {
      args.push(
        "--trace-output",
        tracePath,
        "--analyzed-output",
        analyzedPath,
      );
    }
    if (sample.skipMidpointScreenshot) args.push("--skip-midpoint-screenshot");
    args.push("--trace-profile", sample.traceProfile);
    args.push("--input-backend", sample.inputBackend);
    args.push("--input-delivery-policy", sample.inputDeliveryPolicy);
    NativeWindowPlacement.appendArguments(args, postFocusWindowBounds);
    if (this.config.targets[targetIndex].legacyMousewheelBridge) {
      args.push("--legacy-mousewheel-bridge");
    }
    const sampleStartedAt = Date.now();
    const targetName = this.config.targets[targetIndex].name;
    this.progress(
      `${sampleId} ${targetName}: wheel window 0/${Math.ceil(sample.durationMs / 1000)}s, trace=${sample.traceProfile}`,
    );
    const progressTimer = setInterval(() => {
      const elapsedMs = Date.now() - sampleStartedAt;
      if (elapsedMs <= sample.durationMs) {
        this.progress(
          `${sampleId} ${targetName}: wheel window ${Math.min(Math.floor(elapsedMs / 1000), Math.ceil(sample.durationMs / 1000))}/${Math.ceil(sample.durationMs / 1000)}s`,
        );
      } else {
        this.progress(
          `${sampleId} ${targetName}: wheel complete; finalizing ${traceEnabled ? "trace" : "input evidence"} (${Math.ceil((elapsedMs - sample.durationMs) / 1000)}s)`,
        );
      }
    }, 1000);
    let captureProcess;
    try {
      captureProcess = await this.processes.run(WHEEL_SCRIPT, args, {
        label: `${sampleId} wheel benchmark`,
        acceptedExitCodes: [0, 2],
      });
    } finally {
      clearInterval(progressTimer);
    }
    this.progress(
      `${sampleId} ${targetName}: complete in ${((Date.now() - sampleStartedAt) / 1000).toFixed(1)}s`,
    );
    const capture = await ComparisonRunner.readJsonFile(capturePath, `${sampleId} capture result`);
    if (capture.schemaVersion !== CAPTURE_SCHEMA_VERSION) {
      throw new ContractError(`${sampleId} capture schemaVersion is not ${CAPTURE_SCHEMA_VERSION}.`);
    }
    if (capture.target?.id !== target.id || capture.target?.url !== this.config.targets[targetIndex].match.urlExact) {
      throw new ContractError(`${sampleId} capture target identity changed during sampling.`);
    }
    if (
      capture.point?.x !== inputPoint.page.x ||
      capture.point?.y !== inputPoint.page.y
    ) {
      throw new ContractError(
        `${sampleId} capture point does not match the normalized Canvas contract: expected ${inputPoint.page.x},${inputPoint.page.y}; actual ${capture.point?.x ?? "missing"},${capture.point?.y ?? "missing"}.`,
      );
    }
    const analyzed = traceEnabled
      ? await ComparisonRunner.readJsonFile(analyzedPath, `${sampleId} analyzed result`)
      : null;
    if (traceEnabled && analyzed.schemaVersion !== ANALYSIS_SCHEMA_VERSION) {
      throw new ContractError(`${sampleId} analyzed schemaVersion is not ${ANALYSIS_SCHEMA_VERSION}.`);
    }
    return ComparisonRunner.projectSample({
      sampleId,
      roundNumber,
      attemptNumber,
      targetIndex,
      targetName: this.config.targets[targetIndex].name,
      targetId: target.id,
      targetUrl: target.url,
      environment,
      environmentContract,
      anchorContract,
      fpsOverlay: fpsOverlay?.describe() ?? null,
      inputPoint,
      capture,
      analyzed,
      captureExitCode: captureProcess.exitCode,
      analysisExitCode: traceEnabled ? 0 : null,
      analysisMode: traceEnabled ? "inline-wheel-benchmark" : "disabled",
      paths: {
        capture: capturePath,
        trace: tracePath,
        analyzed: analyzedPath,
      },
      sample,
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

  static isSoftInputCaptureReason(reason) {
    return /^(dom-wheel-event-count-mismatch|dom-wheel-delta-y-sequence-mismatch|legacy-wheel-handler-count-mismatch|dom-wheel-timing-out-of-contract):/.test(
      reason,
    );
  }

  static buildInputDelivery(capture, wheelContract, policy) {
    const diagnostics = capture.diagnostics || {};
    const expectedCount = capture.input?.count ?? wheelContract.expectedEventCount ?? null;
    const receivedCount = diagnostics.receivedEventCount ?? wheelContract.receivedEventCount ?? null;
    const receivedCountRatio =
      Number.isFinite(expectedCount) && expectedCount > 0 && Number.isFinite(receivedCount)
        ? receivedCount / expectedCount
        : null;
    const expectedNegative = diagnostics.expectedDeltaMagnitudePerDirection;
    const negativeRatio =
      Number.isFinite(expectedNegative) && expectedNegative > 0
        ? diagnostics.receivedNegativeDeltaMagnitude / expectedNegative
        : null;
    const positiveRatio =
      Number.isFinite(expectedNegative) && expectedNegative > 0
        ? diagnostics.receivedPositiveDeltaMagnitude / expectedNegative
        : null;
    const strictReasons = [];
    if (capture.input?.dispatchAckCountMatches !== true) {
      strictReasons.push(
        `dispatch acknowledgements mismatch expected=${expectedCount ?? "unknown"} actual=${capture.input?.dispatchAcks ?? "unknown"}`,
      );
    }
    if (wheelContract.sequenceMatchesAllowingCoalescing !== true) {
      strictReasons.push(
        `DOM wheel delta sequence was not delivered exactly or as valid same-direction coalescing; mode=${wheelContract.deliveryMode || "unknown"}.`,
      );
    }
    if (diagnostics.receivedTimingWithinContract === false) {
      strictReasons.push(
        `DOM wheel timing exceeded the input contract: maximumScheduleErrorMs=${diagnostics.maximumReceivedScheduleErrorMilliseconds ?? "unknown"}.`,
      );
    }
    const mismatch = wheelContract.mismatch || {};
    const hardMismatchFields = ["isTrusted", "coordinates", "deltaMode", "deltaX"];
    const hardMismatch = hardMismatchFields.filter(
      (field) => Array.isArray(mismatch[field]) && mismatch[field].length > 0,
    );
    const relay = capture.input?.legacyMousewheelBridge;
    const relayConsistent =
      !relay?.requested ||
      ((relay.browserLegacyCount || 0) + (relay.relayedCount || 0) >= receivedCount &&
        relay.pluginRelayObservedCount === relay.relayedCount &&
        relay.preventedCount === relay.relayedCount &&
        relay.relayedEventsAreUntrusted === true);
    const varianceReasons = [];
    if (capture.input?.dispatchAckCountMatches !== true) {
      varianceReasons.push("CDP wheel acknowledgements did not match the dispatched count.");
    }
    if (!diagnostics.allReceivedEventsTrusted || hardMismatch.length > 0) {
      varianceReasons.push(
        `received wheel event contract mismatch in ${hardMismatch.join(",") || "trusted delivery"}.`,
      );
    }
    if (receivedCountRatio === null || receivedCountRatio < 0.9) {
      varianceReasons.push(`received event ratio is below 0.90: ${String(receivedCountRatio)}.`);
    }
    if (negativeRatio === null || negativeRatio < 0.95) {
      varianceReasons.push(`negative wheel magnitude ratio is below 0.95: ${String(negativeRatio)}.`);
    }
    if (positiveRatio === null || positiveRatio < 0.95) {
      varianceReasons.push(`positive wheel magnitude ratio is below 0.95: ${String(positiveRatio)}.`);
    }
    if (!relayConsistent) {
      varianceReasons.push("legacy mousewheel relay count does not match the observed native wheel count.");
    }
    return {
      policy,
      valid: policy === "diagnostic" ? varianceReasons.length === 0 : strictReasons.length === 0,
      strictValid: strictReasons.length === 0,
      strictReasons,
      reasons: policy === "diagnostic" ? varianceReasons : strictReasons,
      varianceAccepted: policy === "diagnostic" && varianceReasons.length === 0 && strictReasons.length > 0,
      variance: {
        receivedCountRatio,
        negativeMagnitudeRatio: negativeRatio,
        positiveMagnitudeRatio: positiveRatio,
        deliveryMode: wheelContract.deliveryMode || null,
        coalescedEventCount: wheelContract.coalescedEventCount ?? null,
        receivedTimingWithinContract: diagnostics.receivedTimingWithinContract ?? null,
        maximumReceivedScheduleErrorMilliseconds:
          diagnostics.maximumReceivedScheduleErrorMilliseconds ?? null,
      },
    };
  }

  static projectSample(input) {
    const { capture, analyzed } = input;
    const traceEnabled = input.sample.traceProfile !== NO_TRACE_PROFILE;
    const inputPolicy = input.sample.inputDeliveryPolicy || "strict";
    const wheelContract = ComparisonRunner.value(capture, "diagnostics", "wheelContract") || {};
    const inputDelivery = ComparisonRunner.buildInputDelivery(
      capture,
      wheelContract,
      inputPolicy,
    );
    const invalidReasons = [];
    if (capture.valid !== true) {
      invalidReasons.push(
        ...(capture.invalidReasons || [])
          .filter((reason) => inputPolicy !== "diagnostic" || !ComparisonRunner.isSoftInputCaptureReason(reason))
          .map((reason) => `capture: ${reason}`),
      );
    }
    if (traceEnabled && analyzed?.performanceKpi?.valid !== true) {
      invalidReasons.push(...(analyzed.performanceKpi?.invalidReasons || []).map((reason) => `analysis: ${reason}`));
    }
    if (traceEnabled && capture.trace?.completeness?.valid !== true) invalidReasons.push("capture: trace completeness is invalid.");
    if (traceEnabled && analyzed?.traceIntegrity?.valid !== true) invalidReasons.push("analysis: trace integrity is invalid.");
    const captureReceivedEventCount = capture.diagnostics?.receivedEventCount ?? null;
    const captureExpectedEventCount = capture.diagnostics?.expectedEventCount ?? capture.input?.count ?? null;
    if (
      inputPolicy !== "diagnostic" &&
      captureReceivedEventCount !== null &&
      captureExpectedEventCount !== null &&
      captureReceivedEventCount !== captureExpectedEventCount &&
      wheelContract.sequenceMatchesAllowingCoalescing !== true
    ) {
      invalidReasons.push(`capture: DOM wheel event count mismatch expected=${captureExpectedEventCount} actual=${captureReceivedEventCount}.`);
    }
    const inputAckCount = capture.input?.dispatchAcks ?? null;
    const inputReceivedCount = capture.diagnostics?.receivedEventCount ?? null;
    const coalescedEventCount = wheelContract.coalescedEventCount ?? null;
    const inputDeliveryReasons = inputDelivery.reasons;
    if (!inputDelivery.valid) {
      invalidReasons.push(...inputDeliveryReasons.map((reason) => `input: ${reason}`));
    }
    const raf = capture.diagnostics?.rafDiagnostic || null;
    const compositor = traceEnabled
      ? analyzed?.frameRate?.compositor || capture.trace?.compositorFrameRate || null
      : null;
    const presentation = traceEnabled
      ? analyzed?.frameRate?.presentation || null
      : null;
    const metrics = {
      inputAckCount,
      inputReceivedCount,
      coalescedEventCount,
      inputReceivedRatio: inputDelivery.variance.receivedCountRatio,
      negativeMagnitudeRatio: inputDelivery.variance.negativeMagnitudeRatio,
      positiveMagnitudeRatio: inputDelivery.variance.positiveMagnitudeRatio,
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
      attempt: input.attemptNumber,
      sample: input.sample,
      accepted: false,
      valid: invalidReasons.length === 0,
      invalidReasons,
      files: input.paths,
      process: {
        wheelBenchmarkExitCode: input.captureExitCode,
        analyzeTraceExitCode: input.analysisExitCode,
        analyzeTraceMode: input.analysisMode || "external-process",
      },
      environment: {
        actual: input.environment,
        comparisonContract: input.environmentContract,
        anchorContract: input.anchorContract,
      },
      fpsOverlay: input.fpsOverlay,
      input: {
        point: {
          contract: input.inputPoint,
          captured: capture.point || null,
          matches:
            capture.point?.x === input.inputPoint.page.x &&
            capture.point?.y === input.inputPoint.page.y,
        },
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
        delivery: inputDelivery,
      },
      visual: capture.visualChange || null,
      raf,
      compositor,
      presentation: {
        source: "Display::FrameDisplayed",
        frameDisplayed: presentation,
        evidence: traceEnabled ? analyzed?.evidence?.presentation || null : null,
      },
      traceIntegrity: {
        capture: traceEnabled ? capture.trace?.completeness || null : null,
        analyzed: traceEnabled ? analyzed?.traceIntegrity || null : null,
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
    const configuredPoint = ComparisonConfig.fromObject({
      schemaVersion: 1,
      sample: { canvasPoint: { xRatio: 0.25, yRatio: 0.75 } },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.deepEqual(configuredPoint.sample.canvasPoint, {
      xRatio: 0.25,
      yRatio: 0.75,
    });
    assert.throws(
      () =>
        ComparisonConfig.fromObject({
          schemaVersion: 1,
          sample: { canvasPoint: { xRatio: 0.01, yRatio: 0.5 } },
          targets: [config.targets[0], config.targets[1]],
        }),
      /sample\.canvasPoint\.xRatio/,
    );
    assert.deepEqual(
      CanvasInputPoint.resolve(
        { xRatio: 0.25, yRatio: 0.75 },
        { x: 100, y: 50, width: 1200, height: 800 },
      ),
      {
        source: "normalized-canvas-coordinate",
        normalized: { xRatio: 0.25, yRatio: 0.75 },
        page: { x: 400, y: 650 },
        canvasRect: { x: 100, y: 50, width: 1200, height: 800 },
      },
    );
    assert.deepEqual(config.environment, {
      canvasCssSize: null,
      normalizeToFirstTarget: false,
      maxResizeAttempts: 0,
      settleMs: 0,
      windowPlacement: null,
    });
    const primarySurfaceEnvironment = {
      displaySurface: {
        screen: {
          availLeft: 0,
          availTop: 0,
          availWidth: 2560,
          availHeight: 1392,
        },
        window: {
          screenX: 0,
          screenY: 0,
          outerWidth: 1377,
          outerHeight: 1039,
          innerWidth: 1438,
          innerHeight: 1134,
        },
      },
    };
    const resolvedNativePlacement = NativeWindowPlacement.resolve(
      PRIMARY_SCREEN_WINDOW_PLACEMENT,
      primarySurfaceEnvironment,
      "windows-native",
    );
    assert.deepEqual(resolvedNativePlacement, {
      left: 0,
      top: 0,
      width: 1377,
      height: 1039,
    });
    const placementArgs = [];
    NativeWindowPlacement.appendArguments(
      placementArgs,
      resolvedNativePlacement,
    );
    assert.deepEqual(placementArgs, [
      "--post-focus-window-left",
      "0",
      "--post-focus-window-top",
      "0",
      "--post-focus-window-width",
      "1377",
      "--post-focus-window-height",
      "1039",
    ]);
    assert.equal(
      NativeWindowPlacement.resolve(
        PRIMARY_SCREEN_WINDOW_PLACEMENT,
        primarySurfaceEnvironment,
        "cdp",
      ),
      null,
    );
    const validWindowPlacement = WindowSurfacePlacement.compare(
      [primarySurfaceEnvironment, primarySurfaceEnvironment],
      PRIMARY_SCREEN_WINDOW_PLACEMENT,
      ["target-a", "target-b"],
    );
    assert.equal(validWindowPlacement.valid, true);
    const crossingSurfaceEnvironment = {
      displaySurface: {
        screen: {
          availLeft: 2560,
          availTop: 0,
          availWidth: 1440,
          availHeight: 2512,
        },
        window: {
          screenX: 2651,
          screenY: 1287,
          outerWidth: 1377,
          outerHeight: 1039,
          innerWidth: 1438,
          innerHeight: 1134,
        },
      },
    };
    const invalidWindowPlacement = WindowSurfacePlacement.compare(
      [primarySurfaceEnvironment, crossingSurfaceEnvironment],
      PRIMARY_SCREEN_WINDOW_PLACEMENT,
      ["target-a", "target-b"],
    );
    assert.equal(invalidWindowPlacement.valid, false);
    assert.ok(
      invalidWindowPlacement.invalidReasons.some((reason) =>
        reason.includes("window-placement-screen-left-mismatch:target-b"),
      ),
    );
    assert.deepEqual(config.retry, DEFAULT_RETRY_POLICY);
    assert.deepEqual(config.execution, {
      reuseReadyState: false,
      prepareOnly: false,
    });
    const readyExpressionConfig = ComparisonConfig.fromObject({
      schemaVersion: 1,
      targets: [
        {
          ...config.targets[0],
          setup: {
            ...config.targets[0].setup,
            readyExpression: "true",
          },
        },
        config.targets[1],
      ],
    });
    assert.equal(readyExpressionConfig.targets[0].setup.readyExpression, "true");
    const preparedStateConfig = ComparisonConfig.fromObject({
      schemaVersion: 1,
      sample: { rounds: 1 },
      execution: { reuseReadyState: true },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.deepEqual(preparedStateConfig.execution, {
      reuseReadyState: true,
      prepareOnly: false,
    });
    const preparedStateRunner = new ComparisonRunner(
      preparedStateConfig,
      os.tmpdir(),
    );
    assert.doesNotThrow(() => preparedStateRunner.validateExecutionMode());
    const invalidPreparedStateConfig = ComparisonConfig.fromObject({
      schemaVersion: 1,
      sample: { rounds: 2 },
      execution: { reuseReadyState: true },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.throws(
      () =>
        new ComparisonRunner(invalidPreparedStateConfig, os.tmpdir()).validateExecutionMode(),
      /requires exactly one round/,
    );
    const preparationOnlyConfig = ComparisonConfig.fromObject({
      schemaVersion: 1,
      sample: { rounds: 1 },
      execution: { prepareOnly: true },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.deepEqual(preparationOnlyConfig.execution, {
      reuseReadyState: false,
      prepareOnly: true,
    });
    assert.doesNotThrow(() =>
      new ComparisonRunner(preparationOnlyConfig, os.tmpdir()).validateExecutionMode(),
    );
    const invalidPreparationOnlyConfig = ComparisonConfig.fromObject({
      schemaVersion: 1,
      sample: { rounds: 2 },
      execution: { prepareOnly: true },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.throws(
      () =>
        new ComparisonRunner(invalidPreparationOnlyConfig, os.tmpdir()).validateExecutionMode(),
      /prepareOnly requires exactly one round/,
    );
    const exactTextActionConfig = ComparisonConfig.fromObject({
      schemaVersion: 1,
      targets: [
        {
          ...config.targets[0],
          setup: {
            ...config.targets[0].setup,
            actions: [
              {
                type: "click-text",
                containerSelector: "#menu",
                itemSelector: "button",
                text: ["Isometric", "Axonometric"],
                postcondition: { selector: "#menu", visible: false },
              },
            ],
          },
        },
        config.targets[1],
      ],
    });
    assert.deepEqual(exactTextActionConfig.targets[0].setup.actions[0], {
      type: "click-text",
      containerSelector: "#menu",
      itemSelector: "button",
      text: ["Isometric", "Axonometric"],
      postcondition: { selector: "#menu", visible: false },
    });
    assert.throws(
      () =>
        ComparisonConfig.fromObject({
          schemaVersion: 1,
          targets: [
            {
              ...config.targets[0],
              setup: {
                ...config.targets[0].setup,
                actions: [
                  {
                    type: "click-text",
                    containerSelector: "#menu",
                    itemSelector: "button",
                    text: "Isometric",
                  },
                ],
              },
            },
            config.targets[1],
          ],
        }),
      /requires a postcondition/,
    );
    const selfTestConfigPath = path.join(
      os.tmpdir(),
      "compare-wheel-self-test-config.json",
    );
    const genericCli = CliArguments.parse([
      "--config",
      selfTestConfigPath,
      "--prepare-only",
      "--rounds",
      "1",
      "--max-input-retries",
      "0",
      "--output-dir",
      path.join(os.tmpdir(), "compare-wheel-self-test-output"),
    ]);
    assert.equal(genericCli.prepareOnly, true);
    const overriddenConfig = ComparisonConfig.withCliOverrides(config, genericCli);
    assert.equal(overriddenConfig.execution.prepareOnly, true);
    assert.equal(overriddenConfig.sample.rounds, 1);
    assert.equal(overriddenConfig.retry.maxInputRetries, 0);
    assert.throws(
      () =>
        CliArguments.parse([
          "--config",
          selfTestConfigPath,
          "--prepare-only",
          "--reuse-ready-state",
          "--output-dir",
          path.join(os.tmpdir(), "compare-wheel-self-test-output"),
        ]),
      /cannot be combined/,
    );
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
      normalizeToFirstTarget: false,
      maxResizeAttempts: 4,
      settleMs: 500,
      windowPlacement: null,
    });
    const placedEnvironment = ComparisonConfig.fromObject({
      schemaVersion: 1,
      environment: {
        normalizeToFirstTarget: true,
        maxResizeAttempts: 3,
        settleMs: 500,
        windowPlacement: PRIMARY_SCREEN_WINDOW_PLACEMENT,
      },
      targets: [config.targets[0], config.targets[1]],
    });
    assert.deepEqual(placedEnvironment.environment, {
      canvasCssSize: null,
      normalizeToFirstTarget: true,
      maxResizeAttempts: 3,
      settleMs: 500,
      windowPlacement: PRIMARY_SCREEN_WINDOW_PLACEMENT,
    });
    assert.deepEqual(
      ComparisonConfig.withCliOverrides(
        placedEnvironment,
        genericCli,
      ).environment,
      placedEnvironment.environment,
    );
    assert.deepEqual(RoundAttemptPlan.sample(DEFAULT_SAMPLE), {
      ...DEFAULT_SAMPLE,
      inputIntervalMs: DEFAULT_SAMPLE.durationMs / (DEFAULT_SAMPLE.count - 1),
    });
    const timing = new AttemptTiming();
    timing.add("sample", 5);
    timing.add("sample", 7);
    assert.equal(timing.toObject().phases.sample, 12);
    assert.equal(
      RoundAttemptPlan.traceEvidenceFailureReason([
        {
          sample: { traceProfile: FPS_TRACE_PROFILE },
          input: { delivery: { valid: true } },
          presentation: { evidence: { valid: true } },
          traceIntegrity: { analyzed: { valid: true } },
          invalidReasons: [],
        },
      ]),
      null,
    );
    const noTraceProjection = ComparisonRunner.projectSample({
      sampleId: "no-trace",
      roundNumber: 1,
      attemptNumber: 1,
      targetIndex: 0,
      targetName: "local",
      targetId: "target-a",
      targetUrl: "http://a.test/",
      environment: {},
      environmentContract: { valid: true },
      anchorContract: { valid: true },
      fpsOverlay: null,
      inputPoint: CanvasInputPoint.resolve(
        DEFAULT_CANVAS_POINT,
        { x: 0, y: 0, width: 100, height: 100 },
      ),
      capture: {
        valid: true,
        invalidReasons: [],
        input: {
          count: 2,
          dispatchAcks: 2,
          dispatchAckCountMatches: true,
        },
        point: { x: 50, y: 50 },
      diagnostics: {
        expectedEventCount: 2,
        receivedEventCount: 2,
        allReceivedEventsTrusted: true,
        expectedDeltaMagnitudePerDirection: 40,
        receivedNegativeDeltaMagnitude: 40,
        receivedPositiveDeltaMagnitude: 40,
        receivedEventTypes: ["CANVAS"],
          wheelContract: {
            deliveryMode: "exact",
            eventCountMatches: true,
            exactSequenceMatches: true,
            sequenceMatchesAllowingCoalescing: true,
            coalescedEventCount: 0,
          },
          rafDiagnostic: { averageFps: 60 },
          pageErrors: [],
        },
        trace: { enabled: false, completeness: null },
      },
      analyzed: null,
      captureExitCode: 0,
      analysisExitCode: null,
      analysisMode: "disabled",
      paths: { capture: "capture.json", trace: null, analyzed: null },
      sample: { traceProfile: NO_TRACE_PROFILE },
    });
    assert.equal(noTraceProjection.valid, true);
    assert.equal(noTraceProjection.compositor, null);
    assert.equal(noTraceProjection.presentation.frameDisplayed, null);
    const diagnosticDelivery = ComparisonRunner.buildInputDelivery(
      {
        input: {
          count: 600,
          dispatchAckCountMatches: true,
          legacyMousewheelBridge: {
            requested: true,
            browserLegacyCount: 0,
            relayedCount: 591,
            pluginRelayObservedCount: 591,
            preventedCount: 591,
            relayedEventsAreUntrusted: true,
          },
        },
        diagnostics: {
          receivedEventCount: 591,
          allReceivedEventsTrusted: true,
          expectedDeltaMagnitudePerDirection: 12000,
          receivedNegativeDeltaMagnitude: 11720,
          receivedPositiveDeltaMagnitude: 11720,
          receivedTimingWithinContract: false,
          maximumReceivedScheduleErrorMilliseconds: null,
        },
      },
      {
        deliveryMode: "mismatch",
        sequenceMatchesAllowingCoalescing: false,
        coalescedEventCount: 9,
        mismatch: {
          isTrusted: [],
          coordinates: [],
          deltaMode: [],
          deltaX: [],
        },
      },
      "diagnostic",
    );
    assert.equal(diagnosticDelivery.valid, true);
    assert.equal(diagnosticDelivery.strictValid, false);
    assert.equal(diagnosticDelivery.varianceAccepted, true);
    assert.equal(diagnosticDelivery.variance.receivedCountRatio, 0.985);
    assert.deepEqual(
      RoundAttemptPlan.traceEvidenceFailureReason([
        {
          sampleId: "sample-a",
          targetName: "local",
          sample: { traceProfile: FPS_TRACE_PROFILE },
          input: { delivery: { valid: true } },
          presentation: { evidence: { valid: false } },
          traceIntegrity: { analyzed: { valid: true } },
          invalidReasons: ["analysis: presentation-frame-count:0"],
        },
      ]),
      [
        {
          sampleId: "sample-a",
          targetName: "local",
          presentationValid: false,
          traceIntegrityValid: true,
          invalidReasons: ["analysis: presentation-frame-count:0"],
        },
      ],
    );
    assert.equal(
      RoundAttemptPlan.traceEvidenceFailureReason([
        {
          sample: { traceProfile: NO_TRACE_PROFILE },
          input: { delivery: { valid: true } },
          presentation: { evidence: null },
          traceIntegrity: { analyzed: null },
          invalidReasons: [],
        },
      ]),
      null,
    );
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
      { targetIndex: 0, accepted: true, valid: true, metrics: { inputAckCount: 120, inputReceivedCount: 120, coalescedEventCount: 0, rafAverageFps: 60, compositorAverageFps: 59, presentationAverageFps: 58, rafMaxFrameGapMs: 20, compositorMaxFrameGapMs: 22, presentationMaxFrameGapMs: 24 } },
      { targetIndex: 0, accepted: false, valid: false, metrics: { inputAckCount: 120, inputReceivedCount: 118, coalescedEventCount: 2, rafAverageFps: 55, compositorAverageFps: 54, presentationAverageFps: null, rafMaxFrameGapMs: 40, compositorMaxFrameGapMs: 44, presentationMaxFrameGapMs: 48 } },
    ];
    const aggregate = SummaryStore.aggregateForTarget(aggregateSamples, 0);
    assert.equal(aggregate.attemptSampleCount, 2);
    assert.equal(aggregate.sampleCount, 1);
    assert.equal(aggregate.validSampleCount, 1);
    assert.equal(aggregate.metrics.inputReceivedCount.mean, 120);
    assert.deepEqual(aggregate.metrics.inputReceivedCount.range, { min: 120, max: 120 });
    assert.deepEqual(aggregate.worstMaxGap, { metric: "presentationMaxFrameGapMs", value: 24 });
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
  if (cli.help) {
    process.stdout.write(
      `${CliArguments.usage()}\n` +
        "  Scenario-specific URLs, readiness checks, and setup actions belong in the JSON config.\n" +
        "  --rounds <1-100> and --max-input-retries <0-10> override the config.\n" +
        "  --reuse-ready-state skips reload/resize for one already-prepared comparison round.\n" +
        "  --prepare-only refreshes, normalizes, proves camera setup, and checks paired anchors without FPS overlay, trace, or wheel input.\n",
    );
    return;
  }
  if (cli.selfTest) {
    await SelfTest.run();
    return;
  }
  const loadedConfig = await ComparisonConfig.load(cli.configPath);
  const config = ComparisonConfig.withCliOverrides(loadedConfig, cli);
  const runMetadata = {
    source: "external-config",
    configPath: path.resolve(cli.configPath),
    cliOverrides: {
      rounds: cli.rounds,
      maxInputRetries: cli.maxInputRetries,
      reuseReadyState: cli.reuseReadyState,
      prepareOnly: cli.prepareOnly,
    },
    resolvedAt: new Date().toISOString(),
  };
  const runner = new ComparisonRunner(config, cli.outputDirectory, runMetadata);
  await runner.run();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exitCode = 1;
});
