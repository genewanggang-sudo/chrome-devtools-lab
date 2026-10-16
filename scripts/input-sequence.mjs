import { setTimeout as sleepFor } from "node:timers/promises";

/** One exclusive, deadline-paced input transaction; ACKs never pace its events. */
export class InputSequence {
  static validate(transaction) {
    if (!transaction || typeof transaction !== "object")
      throw new TypeError("Input sequence requires a transaction.");
    const {
      events,
      cleanup,
      durationMs,
      maximumInFlight,
      maximumScheduleErrorMs,
    } = transaction;
    if (!Array.isArray(events) || events.length < 2 || events.length > 512)
      throw new RangeError("Input sequence requires 2 through 512 events.");
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 10000)
      throw new RangeError(
        "Input sequence duration must be 0 through 10000ms.",
      );
    if (
      !Number.isInteger(maximumInFlight) ||
      maximumInFlight < 1 ||
      maximumInFlight > 128
    )
      throw new RangeError(
        "Input sequence in-flight limit must be 1 through 128.",
      );
    if (
      !Number.isFinite(maximumScheduleErrorMs) ||
      maximumScheduleErrorMs < 0 ||
      maximumScheduleErrorMs > 1000
    )
      throw new RangeError(
        "Input sequence schedule tolerance must be 0 through 1000ms.",
      );
    const method = events[0]?.method;
    if (
      !["Input.dispatchMouseEvent", "Input.dispatchTouchEvent"].includes(method)
    )
      throw new TypeError(
        "Input sequence only supports mouse or touch dispatch.",
      );
    let previousOffset = -1;
    for (const event of events) {
      if (
        event?.method !== method ||
        !Number.isFinite(event.offsetMs) ||
        event.offsetMs < previousOffset ||
        event.offsetMs > durationMs
      )
        throw new TypeError(
          "Input sequence events require one method and monotonic bounded offsets.",
        );
      InputSequence.validateParams(method, event.params);
      previousOffset = event.offsetMs;
    }
    if (events[0].offsetMs !== 0 || events.at(-1).offsetMs !== durationMs)
      throw new RangeError("Input sequence must span its declared duration.");
    const firstType =
      method === "Input.dispatchMouseEvent" ? "mousePressed" : "touchStart";
    const lastType =
      method === "Input.dispatchMouseEvent" ? "mouseReleased" : "touchEnd";
    const moveType =
      method === "Input.dispatchMouseEvent" ? "mouseMoved" : "touchMove";
    if (
      events[0].params.type !== firstType ||
      events.at(-1).params.type !== lastType ||
      events.slice(1, -1).some((event) => event.params.type !== moveType)
    )
      throw new TypeError(
        "Input sequence must contain one press, moves, and one release.",
      );
    if (cleanup?.method !== method)
      throw new TypeError("Input sequence requires matching cleanup.");
    InputSequence.validateParams(method, cleanup.params);
    if (method === "Input.dispatchMouseEvent") {
      const button = events[0].params.button;
      const mask = { left: 1, right: 2, middle: 4, back: 8, forward: 16 }[
        button
      ];
      if (
        !mask ||
        events
          .slice(0, -1)
          .some(
            (event) =>
              event.params.button !== button || event.params.buttons !== mask,
          ) ||
        events.at(-1).params.buttons !== 0 ||
        events.at(-1).params.button !== button ||
        cleanup.params.type !== lastType ||
        cleanup.params.button !== button ||
        cleanup.params.buttons !== 0
      )
        throw new TypeError(
          "Mouse sequence must preserve one held button and release it.",
        );
    } else if (
      cleanup.params.type !== "touchCancel" ||
      cleanup.params.touchPoints.length !== 0 ||
      events.at(-1).params.touchPoints.length !== 0
    ) {
      throw new TypeError(
        "Touch sequence requires an empty end and cancel cleanup.",
      );
    }
    // Freeze a detached wire snapshot before the first event can reach Chrome.
    return JSON.parse(JSON.stringify(transaction));
  }

  static validateParams(method, params) {
    if (!params || typeof params !== "object" || Array.isArray(params))
      throw new TypeError("Input event parameters must be an object.");
    if (method === "Input.dispatchMouseEvent") {
      if (
        !["mousePressed", "mouseMoved", "mouseReleased"].includes(
          params.type,
        ) ||
        !Number.isFinite(params.x) ||
        !Number.isFinite(params.y)
      )
        throw new TypeError(
          "Mouse sequence requires finite coordinates and a pointer event.",
        );
    } else if (
      !["touchStart", "touchMove", "touchEnd", "touchCancel"].includes(
        params.type,
      ) ||
      !Array.isArray(params.touchPoints)
    ) {
      throw new TypeError(
        "Touch sequence requires touch events and point arrays.",
      );
    }
  }

  static async run(session, rawTransaction, clock = {}) {
    const transaction = InputSequence.validate(rawTransaction);
    const now = clock.now ?? (() => performance.now());
    const sleep =
      clock.sleep ??
      ((ms) => sleepFor(ms, undefined, { signal: clock.signal }));
    const start = now();
    const pending = new Set();
    const samples = [];
    const errors = [];
    let maximumInFlightObserved = 0;
    let maximumDispatchScheduleErrorMilliseconds = 0;
    let lastParams = transaction.events[0].params;
    let pressed = false;
    let releaseAcknowledged = false;
    let dispatchEndedAt = start;

    const dispatch = (event) => {
      const sent = now();
      const sample = {
        type: event.params.type,
        offsetMilliseconds: event.offsetMs,
        sentAtMilliseconds: sent - start,
        acknowledgementLatencyMilliseconds: null,
        error: null,
      };
      samples.push(sample);
      let job;
      let acknowledgement;
      try {
        acknowledgement = session.send(event.method, event.params);
      } catch (error) {
        acknowledgement = Promise.reject(error);
      }
      // Record at the actual send boundary, not a later Promise callback.
      job = Promise.resolve(acknowledgement)
        .then(
          () => {
            sample.acknowledgementLatencyMilliseconds = now() - sent;
            if (["mouseReleased", "touchEnd"].includes(event.params.type))
              releaseAcknowledged = true;
          },
          (error) => {
            sample.error = String(error?.message ?? error);
            errors.push(`${sample.type}: ${sample.error}`);
          },
        )
        .finally(() => pending.delete(job));
      pending.add(job);
      maximumInFlightObserved = Math.max(maximumInFlightObserved, pending.size);
    };

    try {
      for (const event of transaction.events) {
        const due = start + event.offsetMs;
        const delay = due - now();
        if (clock.signal?.aborted)
          throw new Error("Input transaction cancelled.");
        if (delay > 0) await InputSequence.wait(delay, sleep, clock.signal);
        if (clock.signal?.aborted)
          throw new Error("Input transaction cancelled.");
        if (errors.length > 0) break;
        const error = Math.abs(now() - due);
        maximumDispatchScheduleErrorMilliseconds = Math.max(
          maximumDispatchScheduleErrorMilliseconds,
          error,
        );
        if (error > transaction.maximumScheduleErrorMs) {
          errors.push(`input dispatch schedule exceeded tolerance: ${error}ms`);
          break;
        }
        if (pending.size >= transaction.maximumInFlight) {
          errors.push(
            `input dispatch in-flight limit exceeded: ${transaction.maximumInFlight}`,
          );
          break;
        }
        lastParams = event.params;
        pressed = true;
        dispatch(event);
      }
    } catch (error) {
      errors.push(String(error?.message ?? error));
    } finally {
      dispatchEndedAt = now();
    }

    const cleanup = { attempted: false, acknowledged: false, error: null };
    const release = async () => {
      cleanup.attempted = true;
      const params = { ...transaction.cleanup.params };
      if (transaction.cleanup.method === "Input.dispatchMouseEvent") {
        params.x = lastParams.x;
        params.y = lastParams.y;
      }
      try {
        // One safety release is permitted beyond the regular in-flight cap.
        await session.send(transaction.cleanup.method, params);
        cleanup.acknowledged = true;
      } catch (error) {
        cleanup.error = String(error?.message ?? error);
        errors.push(`input cleanup failed: ${cleanup.error}`);
      }
    };
    // Release promptly when scheduling fails, before waiting for slow ACKs.
    if (pressed && errors.length > 0) await release();
    await Promise.all([...pending]);
    if (pressed && !releaseAcknowledged && !cleanup.attempted) await release();
    const actualDurationMilliseconds = dispatchEndedAt - start;
    const dispatchCountMatches = samples.length === transaction.events.length;
    const durationWithinContract =
      Math.abs(actualDurationMilliseconds - transaction.durationMs) <=
      transaction.maximumScheduleErrorMs;
    if (!dispatchCountMatches)
      errors.push(
        `input dispatch count mismatch: ${samples.length}/${transaction.events.length}`,
      );
    if (!durationWithinContract)
      errors.push(
        `input duration out of contract: ${actualDurationMilliseconds}ms requested=${transaction.durationMs}ms`,
      );
    return {
      valid: errors.length === 0 && releaseAcknowledged,
      invalidReasons: errors,
      requestedDurationMilliseconds: transaction.durationMs,
      actualDurationMilliseconds,
      totalDurationMilliseconds: now() - start,
      durationWithinContract,
      dispatchCountMatches,
      dispatchedEventCount: samples.length,
      acknowledgementCount: samples.filter(
        (sample) => sample.acknowledgementLatencyMilliseconds !== null,
      ).length,
      maximumDispatchScheduleErrorMilliseconds,
      maximumDispatchAcknowledgementLatencyMilliseconds: Math.max(
        0,
        ...samples.map(
          (sample) => sample.acknowledgementLatencyMilliseconds ?? 0,
        ),
      ),
      maximumInFlightObserved,
      maximumInFlightAllowed: transaction.maximumInFlight,
      releaseAcknowledged,
      cleanup,
      samples,
    };
  }

  static wait(delay, sleep, signal) {
    if (!signal) return sleep(delay);
    if (signal.aborted)
      return Promise.reject(new Error("Input transaction cancelled."));
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error("Input transaction cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve()
        .then(() => sleep(delay))
        .then(resolve, reject)
        .finally(() => {
          signal.removeEventListener("abort", abort);
        });
    });
  }
}
