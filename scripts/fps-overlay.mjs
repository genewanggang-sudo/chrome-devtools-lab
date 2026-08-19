#!/usr/bin/env node

import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

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

function focusTarget(targetId, timeoutMs) {
  const cdpPath = fileURLToPath(new URL("./cdp.mjs", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      cdpPath,
      "focus",
      "--target-exact",
      targetId,
      "--allow-window-focus",
      "--timeout",
      String(timeoutMs),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not focus target window");
  }
  return result.stdout.trim();
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntilInterrupted() {
  await new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function main(options) {
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
  const focus = options.focus === true;
  const focusResult = focus ? focusTarget(target.id, timeoutMs) : null;
  const session = await connect(target.webSocketDebuggerUrl, timeoutMs);
  let enabled = false;
  try {
    await session.send("DOM.enable");
    await session.send("Overlay.enable");
    await session.send("Overlay.setShowFPSCounter", { show: true });
    enabled = true;
    process.stdout.write(
      `${JSON.stringify({
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
          focusRequested: focus,
          focusResult,
          numericValueReturnedByCdp: false,
        },
      })}\n`,
    );
    if (options["until-stop"] === true) await waitUntilInterrupted();
    else await sleep(durationMs);
  } finally {
    if (enabled) {
      try {
        await session.send("Overlay.setShowFPSCounter", { show: false });
      } catch {}
    }
    session.close();
  }
}

const options = parseArgs(process.argv.slice(2));
Promise.resolve(main(options)).then(
  () => process.exit(0),
  (error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exit(1);
  },
);
