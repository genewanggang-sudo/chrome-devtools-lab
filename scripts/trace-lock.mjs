#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const LOCK_FORMAT = "chrome-devtools-lab.trace-lock";
const LOCK_VERSION = 1;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9333;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_MS = 100;
const DEFAULT_STALE_MS = 5 * 60_000;
const DEFAULT_INITIALIZATION_GRACE_MS = 5_000;

export class TraceLockTimeoutError extends Error {
    constructor(message, details) {
        super(message);
        this.name = "TraceLockTimeoutError";
        this.code = "TRACE_LOCK_TIMEOUT";
        this.details = details;
    }
}

function validateOptions(options) {
    const host = String(options.host ?? DEFAULT_HOST).trim();
    const port = Number(options.port ?? DEFAULT_PORT);
    const timeoutMs = Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const retryMs = Number(options.retryMs ?? DEFAULT_RETRY_MS);
    const staleMs = Number(options.staleMs ?? DEFAULT_STALE_MS);
    const initializationGraceMs = Number(
        options.initializationGraceMs ?? DEFAULT_INITIALIZATION_GRACE_MS,
    );
    const lockDir = path.resolve(
        String(options.lockDir ?? path.join(os.tmpdir(), "chrome-devtools-lab")),
    );

    if (host.length === 0) throw new TypeError("Trace lock host must not be empty.");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new RangeError("Trace lock port must be an integer from 1 to 65535.");
    }
    for (const [name, value, minimum] of [
        ["timeoutMs", timeoutMs, 0],
        ["retryMs", retryMs, 1],
        ["staleMs", staleMs, 1],
        ["initializationGraceMs", initializationGraceMs, 0],
    ]) {
        if (!Number.isFinite(value) || value < minimum) {
            throw new RangeError(`Trace lock ${name} must be at least ${minimum}.`);
        }
    }
    if (
        options.metadata !== undefined &&
        (options.metadata === null ||
            Array.isArray(options.metadata) ||
            typeof options.metadata !== "object")
    ) {
        throw new TypeError("Trace lock metadata must be an object when provided.");
    }

    return {
        host,
        port,
        timeoutMs,
        retryMs,
        staleMs,
        initializationGraceMs,
        lockDir,
        metadata: options.metadata ?? {},
    };
}

function sleep(durationMs) {
    return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== "ESRCH";
    }
}

function isOwnLockRecord(record, options) {
    return (
        record !== null &&
        typeof record === "object" &&
        record.format === LOCK_FORMAT &&
        record.version === LOCK_VERSION &&
        typeof record.id === "string" &&
        record.id.length > 0 &&
        Number.isInteger(record.pid) &&
        record.pid > 0 &&
        record.host === options.host &&
        record.port === options.port &&
        Number.isFinite(Date.parse(record.createdAt)) &&
        Number.isFinite(Date.parse(record.expiresAt))
    );
}

/**
 * Returns the host-and-port-specific slot paths without creating anything.
 */
export function getTraceLockPaths({ host = DEFAULT_HOST, port = DEFAULT_PORT, lockDir } = {}) {
    const options = validateOptions({ host, port, lockDir });
    const key = createHash("sha256")
        .update(`${options.host}\u0000${options.port}`)
        .digest("hex");
    const lockDirectory = path.join(options.lockDir, `tracing-${key}.lock`);
    return {
        lockDirectory,
        lockPath: path.join(lockDirectory, "owner.json"),
    };
}

/**
 * A lease for the Chrome DevTools Tracing singleton at one CDP endpoint.
 *
 * The returned instance must be released, preferably from a finally block.
 */
export class ChromeTracingLock {
    #options;
    #paths;
    #record;
    #released = false;

    constructor(options, paths, record) {
        this.#options = options;
        this.#paths = paths;
        this.#record = record;
    }

    get host() {
        return this.#options.host;
    }

    get port() {
        return this.#options.port;
    }

    get lockPath() {
        return this.#paths.lockPath;
    }

    get metadata() {
        return this.#record.metadata;
    }

    static async acquire(rawOptions = {}) {
        const options = validateOptions(rawOptions);
        const paths = getTraceLockPaths(options);
        const deadline = Date.now() + options.timeoutMs;
        let lastState = "no lock state was observed";

        await fs.mkdir(options.lockDir, { recursive: true });
        while (true) {
            const record = ChromeTracingLock.#createRecord(options);
            try {
                await fs.mkdir(paths.lockDirectory);
                await ChromeTracingLock.#writeOwner(paths.lockPath, record);
                return new ChromeTracingLock(options, paths, record);
            } catch (error) {
                if (error?.code !== "EEXIST") {
                    await ChromeTracingLock.#removeEmptyDirectory(paths.lockDirectory);
                    throw error;
                }
            }

            const state = await ChromeTracingLock.#inspect(paths, options);
            lastState = state.description;
            if (state.reclaimable) {
                await ChromeTracingLock.#reclaim(paths, options, state.record);
                continue;
            }

            const remainingMs = deadline - Date.now();
            if (remainingMs <= 0) {
                throw new TraceLockTimeoutError(
                    `Timed out after ${options.timeoutMs}ms acquiring the Chrome DevTools tracing lock for ${options.host}:${options.port} at ${paths.lockPath}; ${lastState}.`,
                    {
                        host: options.host,
                        port: options.port,
                        lockPath: paths.lockPath,
                        timeoutMs: options.timeoutMs,
                        lastState,
                    },
                );
            }
            await sleep(Math.min(options.retryMs, remainingMs));
        }
    }

    async release() {
        if (this.#released) return false;
        const state = await ChromeTracingLock.#inspect(this.#paths, this.#options);
        if (!state.record || state.record.id !== this.#record.id) {
            this.#released = true;
            return false;
        }

        try {
            await fs.unlink(this.#paths.lockPath);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        try {
            await fs.rmdir(this.#paths.lockDirectory);
        } catch (error) {
            if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
        }
        this.#released = true;
        return true;
    }

    static #createRecord(options) {
        const createdAt = new Date();
        return {
            format: LOCK_FORMAT,
            version: LOCK_VERSION,
            id: randomUUID(),
            pid: process.pid,
            host: options.host,
            port: options.port,
            createdAt: createdAt.toISOString(),
            expiresAt: new Date(createdAt.getTime() + options.staleMs).toISOString(),
            metadata: options.metadata,
        };
    }

    static async #writeOwner(lockPath, record) {
        const contents = `${JSON.stringify(record)}\n`;
        const handle = await fs.open(lockPath, "wx");
        try {
            await handle.writeFile(contents, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
    }

    static async #inspect(paths, options) {
        let text;
        try {
            text = await fs.readFile(paths.lockPath, "utf8");
        } catch (error) {
            if (error?.code === "ENOENT") {
                try {
                    const stat = await fs.stat(paths.lockDirectory);
                    const ageMs = Date.now() - stat.mtimeMs;
                    return {
                        record: null,
                        reclaimable: false,
                        description: `lock slot has no ownership record (age ${Math.max(0, Math.round(ageMs))}ms) and will not be removed`,
                    };
                } catch (statError) {
                    if (statError?.code === "ENOENT") {
                        return {
                            record: null,
                            reclaimable: false,
                            description: "lock slot disappeared while waiting",
                        };
                    }
                    throw statError;
                }
            }
            throw error;
        }

        let record;
        try {
            record = JSON.parse(text);
        } catch {
            return {
                record: null,
                reclaimable: false,
                description: "lock record is not valid JSON and will not be removed",
            };
        }
        if (!isOwnLockRecord(record, options)) {
            return {
                record: null,
                reclaimable: false,
                description: "lock record is not owned by this trace-lock module and will not be removed",
            };
        }

        const expiresAtMs = Date.parse(record.expiresAt);
        const expired = expiresAtMs <= Date.now();
        const ownerAlive = isProcessAlive(record.pid);
        return {
            record,
            reclaimable: expired || !ownerAlive,
            description: expired
                ? `expired lock owned by pid ${record.pid}`
                : ownerAlive
                    ? `active lock owned by pid ${record.pid} until ${record.expiresAt}`
                    : `dead-process lock owned by pid ${record.pid}`,
        };
    }

    static async #reclaim(paths, options, expectedRecord) {
        if (!expectedRecord) return;

        const current = await ChromeTracingLock.#inspect(paths, options);
        if (
            !current.reclaimable ||
            !current.record ||
            current.record.id !== expectedRecord.id
        ) {
            return;
        }
        try {
            await fs.unlink(paths.lockPath);
        } catch (error) {
            if (error?.code !== "ENOENT") throw error;
        }
        await ChromeTracingLock.#removeEmptyDirectory(paths.lockDirectory);
    }

    static async #removeEmptyDirectory(directory) {
        try {
            await fs.rmdir(directory);
        } catch (error) {
            if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
        }
    }
}

/**
 * Acquires the host-and-port-specific Chrome Tracing lock.
 */
export async function acquireTraceLock(options = {}) {
    return ChromeTracingLock.acquire(options);
}

/**
 * Runs work under the tracing lock and always attempts release in finally.
 */
export async function withTraceLock(options, callback) {
    if (typeof callback !== "function") {
        throw new TypeError("withTraceLock requires an async or sync callback.");
    }
    const lock = await acquireTraceLock(options);
    try {
        return await callback(lock);
    } finally {
        await lock.release();
    }
}

async function writeSelfTestRecord(paths, options, overrides) {
    await fs.mkdir(paths.lockDirectory);
    const now = Date.now();
    const record = {
        format: LOCK_FORMAT,
        version: LOCK_VERSION,
        id: randomUUID(),
        pid: process.pid,
        host: options.host,
        port: options.port,
        createdAt: new Date(now - 2_000).toISOString(),
        expiresAt: new Date(now - 1_000).toISOString(),
        metadata: { selfTest: true },
        ...overrides,
    };
    await fs.writeFile(paths.lockPath, `${JSON.stringify(record)}\n`, "utf8");
}

export async function selfTestTraceLock() {
    const temporaryDirectory = await fs.mkdtemp(
        path.join(os.tmpdir(), "chrome-devtools-lab-trace-lock-self-test-"),
    );
    const options = {
        host: "trace-lock-self-test",
        port: 45_678,
        lockDir: temporaryDirectory,
        retryMs: 10,
        staleMs: 1_000,
    };
    const paths = getTraceLockPaths(options);
    try {
        const first = await acquireTraceLock({ ...options, metadata: { test: "first" } });
        assert.equal(await fs.stat(first.lockPath).then(() => true), true);
        await assert.rejects(
            acquireTraceLock({ ...options, timeoutMs: 50 }),
            (error) => error instanceof TraceLockTimeoutError,
        );
        assert.equal(await first.release(), true);
        assert.equal(await first.release(), false);

        const second = await acquireTraceLock(options);
        assert.equal(await second.release(), true);

        await writeSelfTestRecord(paths, options, {});
        const reclaimedExpired = await acquireTraceLock(options);
        assert.notEqual(reclaimedExpired.metadata.selfTest, true);
        await reclaimedExpired.release();

        await writeSelfTestRecord(paths, options, {
            pid: 999_999_999,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        const reclaimedDeadProcess = await acquireTraceLock(options);
        await reclaimedDeadProcess.release();

        return {
            ok: true,
            checks: ["exclusive", "release", "expired-recovery", "dead-process-recovery"],
        };
    } finally {
        await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
}

const invokedPath = process.argv[1]
    ? pathToFileURL(path.resolve(process.argv[1])).href
    : null;

if (invokedPath === import.meta.url) {
    if (process.argv.slice(2).length !== 1 || process.argv[2] !== "--self-test") {
        process.stderr.write("Usage: node scripts/trace-lock.mjs --self-test\n");
        process.exitCode = 1;
    } else {
        selfTestTraceLock()
            .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
            .catch((error) => {
                process.stderr.write(`${error.stack || error.message || error}\n`);
                process.exitCode = 1;
            });
    }
}
