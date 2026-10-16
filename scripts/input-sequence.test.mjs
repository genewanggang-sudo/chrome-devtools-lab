import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { InputSequence } from "./input-sequence.mjs";

function runAnimationCadenceProbe(callbackOffsetsMs) {
  const source = fs.readFileSync(new URL("./cdp.mjs", import.meta.url), "utf8");
  const expressionFunction = source.slice(
    source.indexOf("function animationCadenceProbeExpression("),
    source.indexOf("async function probeAnimationFrames("),
  );
  const expression = new Function(
    "RAF_PROBE_WINDOW_MS",
    "RAF_PROBE_MIN_FRAMES",
    "RAF_PROBE_MAX_GAP_MS",
    `${expressionFunction}; return animationCadenceProbeExpression();`,
  )(500, 10, 150);
  let now = 0;
  let frameIndex = 0;
  let nextHandle = 0;
  const pending = new Map();
  const cancelled = [];
  const timerDelays = [];
  const result = new Function(
    "performance",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setTimeout",
    `return ${expression};`,
  )(
    { now: () => now },
    (callback) => {
      const handle = ++nextHandle;
      const at = callbackOffsetsMs[frameIndex++];
      if (at !== undefined) pending.set(handle, { at, callback });
      return handle;
    },
    (handle) => {
      cancelled.push(handle);
      pending.delete(handle);
    },
    (callback, delay) => {
      timerDelays.push(delay);
      pending.set(++nextHandle, { at: now + delay, callback });
    },
  );
  while (pending.size > 0) {
    const [handle, event] = [...pending].sort((a, b) => a[1].at - b[1].at)[0];
    pending.delete(handle);
    now = event.at;
    event.callback(now);
  }
  return { result, cancelled, timerDelays };
}

test("activation cadence rejects sparse callbacks and activation bursts", async () => {
  const cases = [
    { name: "no callbacks", offsets: [] },
    { name: "two-frame activation burst", offsets: [16, 32] },
    {
      name: "ten-frame burst followed by suspension",
      offsets: Array.from({ length: 10 }, (_, index) => (index + 1) * 16),
    },
    { name: "one slow callback", offsets: [400] },
    {
      name: "delayed first callback",
      offsets: Array.from({ length: 20 }, (_, index) => 151 + index * 16),
    },
    {
      name: "internal callback pause",
      offsets: [16, 32, 48, 64, 80, 280, 296, 312, 328, 344, 360, 376, 392],
    },
  ];
  for (const { name, offsets } of cases) {
    const { result } = runAnimationCadenceProbe(offsets);
    const cadence = await result;
    assert.equal(cadence.live, false, name);
    assert.equal(cadence.elapsedMs, 500, name);
    assert.ok(cadence.invalidReasons.length > 0, name);
    assert.ok(cadence.maximumGapMs >= 150, name);
  }
});

test("activation cadence observes the entire window and cancels its next callback", async () => {
  const { result, cancelled, timerDelays } = runAnimationCadenceProbe(
    Array.from({ length: 40 }, (_, index) => (index + 1) * 16),
  );
  const cadence = await result;
  assert.equal(cadence.live, true);
  assert.deepEqual(cadence.invalidReasons, []);
  assert.equal(cadence.scope, "root-document");
  assert.equal(cadence.metric, "request-animation-frame-cadence");
  assert.equal(cadence.frames, 31);
  assert.equal(cadence.elapsedMs, 500);
  assert.equal(cadence.maximumGapMs, 16);
  assert.equal(cadence.gapsMs.at(-1), 4);
  assert.deepEqual(timerDelays, [500]);
  assert.equal(cancelled.length, 1);
});

function mouseTransaction(overrides = {}) {
  const method = "Input.dispatchMouseEvent";
  const durationMs = 80;
  const params = {
    button: "middle",
    buttons: 4,
    pointerType: "mouse",
    x: 100,
    y: 100,
  };
  const cleanup = {
    method,
    params: { ...params, type: "mouseReleased", buttons: 0 },
  };
  return {
    events: [
      { method, offsetMs: 0, params: { ...params, type: "mousePressed" } },
      ...Array.from({ length: 4 }, (_, i) => ({
        method,
        offsetMs: (i + 1) * 20,
        params: { ...params, type: "mouseMoved", x: 110 + i * 10 },
      })),
      { ...cleanup, offsetMs: durationMs },
    ],
    cleanup,
    durationMs,
    maximumInFlight: 16,
    maximumScheduleErrorMs: 80,
    ...overrides,
  };
}

function mockSession(ackDelayMs, fail = () => false) {
  const sent = [];
  return {
    sent,
    send(method, params) {
      const record = {
        method,
        params: { ...params },
        sentAt: performance.now(),
      };
      sent.push(record);
      return new Promise((resolve, reject) =>
        setTimeout(() => {
          if (fail(record, sent)) reject(new Error("mock ACK failure"));
          else resolve({});
        }, ackDelayMs),
      );
    },
  };
}

test("drag duration stays fixed across 5ms, 250ms and 1000ms ACKs", async () => {
  const results = await Promise.all(
    [5, 250, 1000].map(async (delay) => {
      const session = mockSession(delay);
      const timing = await InputSequence.run(session, mouseTransaction());
      assert.equal(timing.valid, true, timing.invalidReasons.join("; "));
      assert.equal(session.sent.length, 6);
      assert.ok(timing.actualDurationMilliseconds >= 70);
      assert.ok(
        timing.actualDurationMilliseconds < 160,
        JSON.stringify(timing),
      );
      assert.equal(timing.releaseAcknowledged, true);
      assert.equal(timing.cleanup.attempted, false);
      if (delay === 1000) {
        assert.equal(timing.maximumInFlightObserved, 6);
        assert.ok(timing.totalDurationMilliseconds >= 1000);
        assert.ok(
          timing.maximumDispatchAcknowledgementLatencyMilliseconds >= 900,
        );
      }
      return timing.actualDurationMilliseconds;
    }),
  );
  assert.ok(Math.max(...results) - Math.min(...results) < 80);
});

test("backpressure marks the transaction invalid and promptly releases the button", async () => {
  const session = mockSession(200);
  const timing = await InputSequence.run(
    session,
    mouseTransaction({ maximumInFlight: 2 }),
  );
  assert.equal(timing.valid, false);
  assert.ok(
    timing.invalidReasons.some((reason) => reason.includes("in-flight")),
  );
  assert.equal(timing.maximumInFlightObserved, 2);
  assert.equal(timing.cleanup.acknowledged, true);
  assert.equal(session.sent.at(-1).params.type, "mouseReleased");
  assert.equal(session.sent.at(-1).params.buttons, 0);
  assert.ok(session.sent.at(-1).sentAt - session.sent[0].sentAt < 160);
  assert.equal(session.sent.at(-1).params.x, 110);
});

test("asynchronous event failure stops expansion and releases at the last dispatched position", async () => {
  const session = mockSession(
    1,
    (record) => record.params.type === "mouseMoved",
  );
  const timing = await InputSequence.run(session, mouseTransaction());
  assert.equal(timing.valid, false);
  assert.ok(
    timing.invalidReasons.some((reason) => reason.includes("mock ACK failure")),
  );
  assert.equal(timing.cleanup.acknowledged, true);
  assert.equal(session.sent.at(-1).params.type, "mouseReleased");
  assert.equal(session.sent.at(-1).params.x, 110);
  assert.equal(
    session.sent.filter((record) => record.params.type === "mouseMoved").length,
    1,
  );
});

test("synchronous transport failure receives the same mandatory release", async () => {
  const sent = [];
  const session = {
    send(method, params) {
      sent.push(params);
      if (params.type === "mouseMoved") throw new Error("sync send failed");
      return Promise.resolve({});
    },
  };
  const timing = await InputSequence.run(session, mouseTransaction());
  assert.equal(timing.valid, false);
  assert.equal(timing.cleanup.acknowledged, true);
  assert.equal(sent.at(-1).type, "mouseReleased");
});

test("failed normal release is retried and cleanup failures remain explicit", async () => {
  let releases = 0;
  const session = {
    send(method, params) {
      if (params.type === "mouseReleased") {
        releases++;
        return Promise.reject(new Error("release unavailable"));
      }
      return Promise.resolve({});
    },
  };
  const timing = await InputSequence.run(session, mouseTransaction());
  assert.equal(timing.valid, false);
  assert.equal(releases, 2);
  assert.equal(timing.releaseAcknowledged, false);
  assert.equal(timing.cleanup.attempted, true);
  assert.match(timing.cleanup.error, /release unavailable/);
});

test("late scheduling is invalidated instead of emitting a catch-up burst", async () => {
  let time = 0;
  const sent = [];
  const timing = await InputSequence.run(
    {
      send(method, params) {
        sent.push(params);
        return Promise.resolve({});
      },
    },
    mouseTransaction({ maximumScheduleErrorMs: 5 }),
    {
      now: () => time,
      sleep: async (ms) => {
        time += ms + 100;
      },
    },
  );
  assert.equal(timing.valid, false);
  assert.equal(timing.dispatchedEventCount, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].type, "mouseReleased");
});

test("touch failure cancels the active contacts", async () => {
  const method = "Input.dispatchTouchEvent";
  const session = mockSession(
    1,
    (record) => record.params.type === "touchMove",
  );
  const timing = await InputSequence.run(session, {
    events: [
      {
        method,
        offsetMs: 0,
        params: { type: "touchStart", touchPoints: [{ id: 1, x: 1, y: 1 }] },
      },
      {
        method,
        offsetMs: 20,
        params: { type: "touchMove", touchPoints: [{ id: 1, x: 2, y: 2 }] },
      },
      { method, offsetMs: 40, params: { type: "touchEnd", touchPoints: [] } },
    ],
    cleanup: { method, params: { type: "touchCancel", touchPoints: [] } },
    durationMs: 40,
    maximumInFlight: 8,
    maximumScheduleErrorMs: 80,
  });
  assert.equal(timing.valid, false);
  assert.equal(timing.cleanup.acknowledged, true);
  assert.equal(session.sent.at(-1).params.type, "touchCancel");
  assert.deepEqual(session.sent.at(-1).params.touchPoints, []);
});

test("transaction validation rejects arbitrary commands and inconsistent held-button masks before sending", async () => {
  const session = mockSession(1);
  const invalid = mouseTransaction();
  invalid.events[2].method = "Runtime.evaluate";
  await assert.rejects(InputSequence.run(session, invalid), /one method/);
  const badButtons = mouseTransaction();
  badButtons.events[1].params.buttons = 0;
  await assert.rejects(InputSequence.run(session, badButtons), /held button/);
  assert.equal(session.sent.length, 0);
});

test("the production bridge queue holds an entire transaction ahead of unrelated target commands", async () => {
  const source = fs.readFileSync(new URL("./cdp.mjs", import.meta.url), "utf8");
  const queueSource = source.slice(
    source.indexOf("function enqueueBridgeCommand("),
    source.indexOf("function createKeepAliveCommandBridge("),
  );
  const enqueue = new Function(
    `${queueSource}; return enqueueBridgeCommand;`,
  )();
  const queues = new Map();
  const session = mockSession(100);
  let nextCommandAt;
  const input = enqueue(queues, "frozen-target", () =>
    InputSequence.run(session, mouseTransaction()),
  );
  const next = enqueue(queues, "frozen-target", () => {
    nextCommandAt = performance.now();
  });
  const other = enqueue(queues, "other-target", () => "independent");
  assert.equal(await other, "independent");
  const timing = await input;
  await next;
  assert.equal(timing.valid, true);
  assert.equal(timing.maximumInFlightObserved, 6);
  assert.ok(nextCommandAt >= session.sent.at(-1).sentAt + 90);
  assert.equal(queues.size, 0);
});

test("the actual bridge batch route authenticates ownership and queues later commands behind the complete transaction", async () => {
  const source = fs.readFileSync(new URL("./cdp.mjs", import.meta.url), "utf8");
  const queueSource = source.slice(
    source.indexOf("function enqueueBridgeCommand("),
    source.indexOf("function createKeepAliveCommandBridge("),
  );
  const bridgeSource = source.slice(
    source.indexOf("function createKeepAliveCommandBridge("),
    source.indexOf("function closeKeepAliveCommandBridge("),
  );
  const enqueue = new Function(
    `${queueSource}; return enqueueBridgeCommand;`,
  )();
  let handleRequest;
  const http = {
    createServer(handler) {
      handleRequest = handler;
      return {
        once() {},
        removeListener() {},
        listen(port, host, ready) {
          ready();
        },
        address() {
          return { port: 1 };
        },
        close() {},
      };
    },
  };
  const createBridge = new Function(
    "http",
    "normalize",
    "randomUUID",
    "readBridgeRequest",
    "writeBridgeResponse",
    "validateCommandTimeout",
    "enqueueBridgeCommand",
    "InputSequence",
    "DEFAULT_HOST",
    "DEFAULT_COMMAND_TIMEOUT_MS",
    `${bridgeSource}; return createKeepAliveCommandBridge;`,
  )(
    http,
    (value) => value.toLowerCase(),
    () => "frozen-secret",
    (request) => request.body,
    (response, statusCode, body) => {
      response.writableEnded = true;
      response.resolve({ statusCode, body });
    },
    (value) => value,
    enqueue,
    InputSequence,
    "127.0.0.1",
    10000,
  );
  const session = mockSession(100);
  await createBridge([{ target: { id: "ExactTarget" }, session }]);
  const request = (url, body) =>
    new Promise((resolve) => {
      void handleRequest(
        { method: "POST", url, body },
        { writableEnded: false, resolve, once() {} },
      );
    });
  const batch = {
    token: "frozen-secret",
    targetId: "ExactTarget",
    transaction: mouseTransaction(),
  };
  assert.equal(
    (await request("/input-sequence", { ...batch, token: "wrong" })).statusCode,
    400,
  );
  assert.equal(
    (await request("/input-sequence", { ...batch, targetId: "OtherTarget" }))
      .statusCode,
    400,
  );
  assert.equal(session.sent.length, 0);
  const input = request("/input-sequence", batch);
  const command = request("/command", {
    token: "frozen-secret",
    targetId: "EXACTTARGET",
    method: "Runtime.evaluate",
    params: {},
  });
  const result = await input;
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.result.valid, true);
  assert.equal(result.body.result.maximumInFlightObserved, 6);
  assert.equal((await command).statusCode, 200);
  assert.equal(session.sent.at(-1).method, "Runtime.evaluate");
  assert.ok(session.sent.at(-1).sentAt - session.sent.at(-2).sentAt >= 90);
});

test("client cancellation interrupts a long deadline wait and releases before draining ACKs", async () => {
  const transaction = mouseTransaction();
  transaction.durationMs = 1000;
  for (const event of transaction.events) event.offsetMs *= 12.5;
  const session = mockSession(200);
  const cancellation = new AbortController();
  const timer = setTimeout(() => cancellation.abort(), 20);
  try {
    const timing = await InputSequence.run(session, transaction, {
      signal: cancellation.signal,
    });
    assert.equal(timing.valid, false);
    assert.equal(timing.dispatchedEventCount, 1);
    assert.equal(timing.cleanup.acknowledged, true);
    assert.equal(session.sent.at(-1).params.type, "mouseReleased");
    assert.ok(session.sent.at(-1).sentAt - session.sent[0].sentAt < 160);
  } finally {
    clearTimeout(timer);
  }
});

test("a disconnected queued client never starts its transaction", async () => {
  const session = mockSession(1);
  const cancellation = new AbortController();
  cancellation.abort();
  const timing = await InputSequence.run(session, mouseTransaction(), {
    signal: cancellation.signal,
  });
  assert.equal(timing.valid, false);
  assert.equal(session.sent.length, 0);
  assert.equal(timing.cleanup.attempted, false);
});
