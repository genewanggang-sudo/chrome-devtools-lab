#!/usr/bin/env node

import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_DURATION_MS = 60000;
const DEFAULT_TIMEOUT_MS = 10000;

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) options[key] = true;
    else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

function integerOption(options, name, fallback, minimum, maximum) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `Invalid --${name}: ${options[name]}. Use ${minimum}..${maximum}.`,
    );
  }
  return value;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function selectTarget(options) {
  const host = String(options.host || DEFAULT_HOST);
  const port = integerOption(options, "port", DEFAULT_PORT, 1, 65535);
  const targetId = options["target-exact"];
  if (typeof targetId !== "string" || targetId.length === 0) {
    throw new Error("FPS overlay requires --target-exact <target ID>.");
  }
  const targets = await getJson(`http://${host}:${port}/json/list`);
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.id === targetId,
  );
  if (!target) throw new Error(`Exact page target was not found: ${targetId}`);
  if (typeof target.webSocketDebuggerUrl !== "string") {
    throw new Error(`Target has no page WebSocket: ${targetId}`);
  }
  return { host, port, target };
}

function connect(webSocketUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map();
    let opened = false;

    const fail = (error) => {
      for (const request of pending.values()) request.reject(error);
      pending.clear();
      if (!opened) reject(error);
    };

    const connectionTimer = setTimeout(() => {
      fail(new Error(`Timed out connecting to ${webSocketUrl}`));
      socket.close();
    }, timeoutMs);

    socket.addEventListener("open", () => {
      clearTimeout(connectionTimer);
      opened = true;
      resolve({
        send(method, params = {}) {
          const id = nextId++;
          return new Promise((resolveRequest, rejectRequest) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rejectRequest(new Error(`Timed out waiting for ${method}`));
            }, timeoutMs);
            pending.set(id, {
              resolve: (value) => {
                clearTimeout(timer);
                resolveRequest(value);
              },
              reject: (error) => {
                clearTimeout(timer);
                rejectRequest(error);
              },
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
      if (message.id == null) return;
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result || {});
    });
    socket.addEventListener("error", () =>
      fail(new Error("CDP WebSocket error")),
    );
    socket.addEventListener("close", () => {
      if (pending.size > 0) fail(new Error("CDP WebSocket closed"));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForStop(input = process.stdin, signalEmitter = process) {
  return new Promise((resolve) => {
    let pending = "";

    const finish = (reason) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      signalEmitter.off("SIGINT", onInterrupt);
      signalEmitter.off("SIGTERM", onTerminate);
      resolve(reason);
    };
    const onData = (chunk) => {
      pending += String(chunk);
      if (pending.trim().toLowerCase() === "stop") {
        finish("stdin-stop");
        return;
      }
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      if (lines.some((line) => line.trim().toLowerCase() === "stop")) {
        finish("stdin-stop");
      }
    };
    const onEnd = () => finish("stdin-eof");
    const onError = () => finish("stdin-error");
    const onInterrupt = () => finish("sigint");
    const onTerminate = () => finish("sigterm");

    input.setEncoding("utf8");
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    signalEmitter.once("SIGINT", onInterrupt);
    signalEmitter.once("SIGTERM", onTerminate);
    input.resume();
  });
}

async function main(options) {
  if (options["until-stop"] !== undefined && options["until-stop"] !== true) {
    throw new Error("--until-stop does not accept a value; write stop followed by a newline to stdin.");
  }
  const timeoutMs = integerOption(
    options,
    "timeout",
    DEFAULT_TIMEOUT_MS,
    1000,
    600000,
  );
  const durationMs = integerOption(
    options,
    "duration",
    DEFAULT_DURATION_MS,
    1000,
    4 * 60 * 60 * 1000,
  );
  const { target } = await selectTarget(options);
  const focusRequested = options.focus === true;
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  try {
    await session.send("DOM.enable");
    await session.send("Overlay.enable");
    await session.send("Overlay.setShowFPSCounter", { show: true });
    process.stdout.write(
      `${JSON.stringify({
        event: "ready",
        target: {
          id: target.id,
          title: target.title,
          url: target.url,
        },
        overlay: {
          enabled: true,
          source: "Chrome DevTools Overlay.setShowFPSCounter",
          sessionHeld: true,
          durationMilliseconds: options["until-stop"]
            ? null
            : durationMs,
          untilStop: options["until-stop"] === true,
          stopProtocol: options["until-stop"]
            ? "Write stop to stdin; a trailing newline is optional."
            : null,
          focusRequested,
          focusApplied: false,
          numericValueReturnedByCdp: false,
        },
      })}\n`,
    );
    if (options["until-stop"] === true) await waitForStop();
    else await sleep(durationMs);
  } finally {
    try {
      await session.send("Overlay.setShowFPSCounter", { show: false });
    } catch {}
    session.close();
  }
}

async function runSelfTest() {
  const parsed = parseArgs(["--target-exact", "page-1", "--until-stop"]);
  if (parsed["target-exact"] !== "page-1" || parsed["until-stop"] !== true) {
    throw new Error("parseArgs self-test failed");
  }

  const { PassThrough } = await import("node:stream");
  const input = new PassThrough();
  const signals = new PassThrough();
  const stopped = waitForStop(input, signals);
  input.write("stop\n");
  const reason = await stopped;
  if (reason !== "stdin-stop") throw new Error("stdin stop self-test failed");
}

const options = parseArgs(process.argv.slice(2));
const command = options["self-test"] === true ? runSelfTest() : main(options);
Promise.resolve(command).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exit(1);
  },
);
