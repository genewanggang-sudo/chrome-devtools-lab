import { EventEmitter } from "node:events";

/** A CDP connection that retains flattened child-session identities. */
export class PerformanceSession extends EventEmitter {
  #socket;
  #nextId = 0;
  #pending = new Map();
  #timeoutMs;

  constructor(timeoutMs = 30000) {
    super();
    this.#timeoutMs = timeoutMs;
  }

  async connect(url) {
    this.#socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#socket.close();
        reject(new Error("CDP connection timed out"));
      }, this.#timeoutMs);
      this.#socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.#socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          this.#socket.close();
          reject(new Error("CDP connection failed"));
        },
        { once: true },
      );
    });
    this.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(message.id);
        if (message.error)
          pending.reject(
            new Error(`${pending.method}: ${message.error.message}`),
          );
        else pending.resolve(message.result ?? {});
      } else {
        this.emit("event", message);
        this.emit(message.method, message.params, message.sessionId);
      }
    });
    this.#socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`CDP closed during ${pending.method}`));
      }
      this.#pending.clear();
      this.emit("closed");
    });
    return this;
  }

  send(method, params = {}, sessionId, timeoutMs = this.#timeoutMs) {
    if (this.#socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error(`CDP is not open: ${method}`));
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#socket.send(
          JSON.stringify({
            id,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(error);
      }
    });
  }

  async evaluate(expression, sessionId) {
    const result = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text,
      );
    return result.result?.value;
  }

  close() {
    this.#socket?.close();
  }
}
