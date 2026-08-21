import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAXIMUM_RUN_LENGTH = 10;
const DEFAULT_TYPICAL_BURST_MAXIMUM = 4;
const EPSILON = 1e-9;

function normalizeOptions(rawOptions) {
    if (!rawOptions || typeof rawOptions !== "object") {
        throw new TypeError("options must be an object");
    }

    const requiredNames = ["count", "durationMs", "deltaMagnitude", "seed"];
    for (const name of requiredNames) {
        if (!(name in rawOptions)) {
            throw new TypeError(`options.${name} is required`);
        }
    }

    const count = rawOptions.count;
    const durationMs = rawOptions.durationMs;
    const deltaMagnitude = rawOptions.deltaMagnitude;
    const maximumRunLength = rawOptions.maximumRunLength ?? DEFAULT_MAXIMUM_RUN_LENGTH;
    const typicalBurstMaximum = rawOptions.typicalBurstMaximum ?? DEFAULT_TYPICAL_BURST_MAXIMUM;

    if (!Number.isInteger(count) || count < 1) {
        throw new RangeError("options.count must be a positive integer");
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) {
        throw new RangeError("options.durationMs must be a non-negative number");
    }
    if (count === 1 && durationMs !== 0) {
        throw new RangeError("count must be at least 2 when durationMs is greater than zero");
    }
    if (!Number.isFinite(deltaMagnitude) || deltaMagnitude <= 0) {
        throw new RangeError("options.deltaMagnitude must be a positive number");
    }
    if (!Number.isInteger(maximumRunLength) || maximumRunLength < 1) {
        throw new RangeError("options.maximumRunLength must be a positive integer");
    }
    if (!Number.isInteger(typicalBurstMaximum) || typicalBurstMaximum < 1) {
        throw new RangeError("options.typicalBurstMaximum must be a positive integer");
    }
    if (typicalBurstMaximum > maximumRunLength) {
        throw new RangeError("typicalBurstMaximum cannot exceed maximumRunLength");
    }

    return {
        count,
        durationMs,
        deltaMagnitude,
        seed: rawOptions.seed,
        maximumRunLength,
        typicalBurstMaximum,
    };
}

function hashSeed(seed) {
    const text = typeof seed === "string" ? seed : String(seed);
    let hash = 2166136261;

    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }

    return hash >>> 0;
}

function createRandom(seed) {
    let state = (hashSeed(seed) + 1831565813) >>> 0;

    return () => {
        state = Math.imul(state ^ (state >>> 15), state | 1);
        state ^= state + Math.imul(state ^ (state >>> 7), state | 61);
        return ((state ^ (state >>> 14)) >>> 0) / 4294967296;
    };
}

function randomInteger(random, minimum, maximum) {
    return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), maximum);
}

function chooseRunCount(totalMovementEvents, typicalBurstMaximum, random) {
    if (totalMovementEvents === 0) {
        return 0;
    }
    if (typicalBurstMaximum === 1) {
        return totalMovementEvents;
    }

    const minimumRunCount = Math.ceil(totalMovementEvents / typicalBurstMaximum);
    const averageRunLength = 1 + random() * (typicalBurstMaximum - 1);
    const targetRunCount = Math.round(totalMovementEvents / averageRunLength);

    return clamp(targetRunCount, minimumRunCount, totalMovementEvents);
}

function buildRunLengths(total, runCount, maximumRunLength, random) {
    const lengths = [];
    let remainingTotal = total;
    let remainingRuns = runCount;

    while (remainingRuns > 0) {
        if (remainingRuns === 1) {
            lengths.push(remainingTotal);
            break;
        }

        const minimumValue = Math.max(1, remainingTotal - (remainingRuns - 1) * maximumRunLength);
        const maximumValue = Math.min(maximumRunLength, remainingTotal - (remainingRuns - 1));
        const value = randomInteger(random, minimumValue, maximumValue);

        lengths.push(value);
        remainingTotal -= value;
        remainingRuns -= 1;
    }

    return lengths;
}

function buildMovementSigns(movementEventCount, typicalBurstMaximum, random) {
    if (movementEventCount === 0) {
        return [];
    }

    const eventsPerDirection = movementEventCount / 2;
    const runCount = chooseRunCount(eventsPerDirection, typicalBurstMaximum, random);
    const positiveRuns = buildRunLengths(eventsPerDirection, runCount, typicalBurstMaximum, random);
    const negativeRuns = buildRunLengths(eventsPerDirection, runCount, typicalBurstMaximum, random);
    const firstSign = random() < 0.5 ? 1 : -1;
    const signs = [];

    for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
        const firstRunSign = firstSign;
        const firstRunLength = firstRunSign > 0 ? positiveRuns[runIndex] : negativeRuns[runIndex];
        const secondRunSign = -firstRunSign;
        const secondRunLength = secondRunSign > 0 ? positiveRuns[runIndex] : negativeRuns[runIndex];

        for (let item = 0; item < firstRunLength; item += 1) {
            signs.push(firstRunSign);
        }
        for (let item = 0; item < secondRunLength; item += 1) {
            signs.push(secondRunSign);
        }
    }

    if (movementEventCount % 2 !== 0) {
        throw new Error("movementEventCount must be even");
    }

    return signs;
}

function buildOffsets(count, durationMs, random) {
    if (count === 1) {
        return [0];
    }
    if (durationMs === 0) {
        return Array.from({ length: count }, () => 0);
    }

    const gaps = [];
    let totalGap = 0;

    for (let index = 0; index < count - 1; index += 1) {
        const gap = 0.75 + random();
        gaps.push(gap);
        totalGap += gap;
    }

    const offsets = [0];
    let elapsedGap = 0;

    for (const gap of gaps) {
        elapsedGap += gap;
        offsets.push((elapsedGap / totalGap) * durationMs);
    }

    offsets[offsets.length - 1] = durationMs;
    return offsets;
}

function buildValidationMetrics(events) {
    let positiveMagnitude = 0;
    let negativeMagnitude = 0;
    let zeroCount = 0;
    let currentSign = 0;
    let currentRunLength = 0;
    let maximumObservedRunLength = 0;
    const burstLengths = [];

    for (const event of events) {
        const sign = Math.sign(event.deltaY);

        if (sign === 0) {
            zeroCount += 1;
            if (currentRunLength > 0) {
                burstLengths.push(currentRunLength);
            }
            currentSign = 0;
            currentRunLength = 0;
            continue;
        }

        if (sign > 0) {
            positiveMagnitude += Math.abs(event.deltaY);
        } else {
            negativeMagnitude += Math.abs(event.deltaY);
        }

        if (sign === currentSign) {
            currentRunLength += 1;
        } else {
            if (currentRunLength > 0) {
                burstLengths.push(currentRunLength);
            }
            currentSign = sign;
            currentRunLength = 1;
        }
        maximumObservedRunLength = Math.max(maximumObservedRunLength, currentRunLength);
    }

    if (currentRunLength > 0) {
        burstLengths.push(currentRunLength);
    }

    return {
        eventCount: events.length,
        positiveMagnitude,
        negativeMagnitude,
        totalDeltaY: events.reduce((sum, event) => sum + event.deltaY, 0),
        zeroCount,
        maximumObservedRunLength,
        burstLengths,
        offsetStart: events.length > 0 ? events[0].offsetMilliseconds : null,
        offsetEnd: events.length > 0 ? events[events.length - 1].offsetMilliseconds : null,
    };
}

export function buildHumanWheelSequence(rawOptions) {
    const options = normalizeOptions(rawOptions);
    const random = createRandom(options.seed);
    const movementEventCount = options.count % 2 === 0 ? options.count : options.count - 1;
    const signs = buildMovementSigns(movementEventCount, options.typicalBurstMaximum, random);

    if (options.count % 2 !== 0) {
        const zeroIndex = randomInteger(random, 0, signs.length);
        signs.splice(zeroIndex, 0, 0);
    }

    const offsets = buildOffsets(options.count, options.durationMs, random);
    const events = signs.map((sign, index) => ({
        offsetMilliseconds: offsets[index],
        deltaX: 0,
        deltaY: sign * options.deltaMagnitude,
    }));

    const validation = validateWheelSequence(events, options);
    if (!validation.valid) {
        throw new Error(`generated wheel sequence is invalid: ${validation.errors.join("; ")}`);
    }

    return events;
}

export function validateWheelSequence(events, rawOptions) {
    const errors = [];
    let options;

    try {
        options = normalizeOptions(rawOptions);
    } catch (error) {
        return {
            valid: false,
            errors: [error instanceof Error ? error.message : String(error)],
            metrics: null,
        };
    }

    if (!Array.isArray(events)) {
        return {
            valid: false,
            errors: ["events must be an array"],
            metrics: null,
        };
    }
    if (events.length !== options.count) {
        errors.push(`expected ${options.count} events, received ${events.length}`);
    }

    for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (!event || typeof event !== "object") {
            errors.push(`event ${index} must be an object`);
            continue;
        }
        if (!Number.isFinite(event.offsetMilliseconds) || event.offsetMilliseconds < 0) {
            errors.push(`event ${index} has an invalid offsetMilliseconds`);
        }
        if (event.deltaX !== 0) {
            errors.push(`event ${index} deltaX must be 0`);
        }
        if (!Number.isFinite(event.deltaY)) {
            errors.push(`event ${index} has an invalid deltaY`);
        } else if (event.deltaY !== 0 && Math.abs(Math.abs(event.deltaY) - options.deltaMagnitude) > EPSILON) {
            errors.push(`event ${index} deltaY magnitude does not match deltaMagnitude`);
        }
    }

    const metrics = buildValidationMetrics(events.filter((event) => event && typeof event === "object" && Number.isFinite(event.deltaY)));
    if (events.length > 0) {
        if (Math.abs(events[0]?.offsetMilliseconds ?? Number.NaN) > EPSILON) {
            errors.push("first event offsetMilliseconds must be 0");
        }
        const lastOffset = events[events.length - 1]?.offsetMilliseconds;
        if (!Number.isFinite(lastOffset) || Math.abs(lastOffset - options.durationMs) > EPSILON) {
            errors.push("last event offsetMilliseconds must equal durationMs");
        }
    }

    for (let index = 1; index < events.length; index += 1) {
        const previous = events[index - 1]?.offsetMilliseconds;
        const current = events[index]?.offsetMilliseconds;
        if (Number.isFinite(previous) && Number.isFinite(current) && current < previous) {
            errors.push(`event offsets must be monotonic at index ${index}`);
            break;
        }
    }

    if (Math.abs(metrics.positiveMagnitude - metrics.negativeMagnitude) > EPSILON) {
        errors.push("positive and negative delta magnitudes must be equal");
    }
    if (metrics.maximumObservedRunLength > options.maximumRunLength) {
        errors.push(`same-direction run exceeds maximumRunLength (${options.maximumRunLength})`);
    }

    return {
        valid: errors.length === 0,
        errors,
        metrics,
    };
}

function runSelfTest() {
    const options = {
        count: 120,
        durationMs: 20_000,
        deltaMagnitude: 40,
        seed: "wheel-sequence-self-test",
        maximumRunLength: 10,
        typicalBurstMaximum: 4,
    };
    const sequence = buildHumanWheelSequence(options);
    const repeated = buildHumanWheelSequence(options);
    const different = buildHumanWheelSequence({ ...options, seed: "different-seed" });
    const report = validateWheelSequence(sequence, options);

    assert.equal(report.valid, true, report.errors.join("; "));
    assert.deepEqual(sequence, repeated);
    assert.notDeepEqual(sequence, different);
    assert.equal(sequence.length, options.count);
    assert.equal(sequence[0].offsetMilliseconds, 0);
    assert.equal(sequence.at(-1).offsetMilliseconds, options.durationMs);
    assert.equal(report.metrics.positiveMagnitude, report.metrics.negativeMagnitude);
    assert.equal(report.metrics.totalDeltaY, 0);
    assert.ok(report.metrics.maximumObservedRunLength <= options.maximumRunLength);
    assert.ok(report.metrics.maximumObservedRunLength <= options.typicalBurstMaximum);
    assert.ok(report.metrics.burstLengths.every((length) => length >= 1 && length <= 4));
    assert.ok(sequence.every((event) => event.deltaX === 0));
    assert.ok(sequence.every((event, index) => index === 0 || event.offsetMilliseconds >= sequence[index - 1].offsetMilliseconds));

    const oddOptions = { ...options, count: 9, durationMs: 800, seed: 9 };
    const oddSequence = buildHumanWheelSequence(oddOptions);
    const oddReport = validateWheelSequence(oddSequence, oddOptions);
    assert.equal(oddReport.valid, true, oddReport.errors.join("; "));
    assert.equal(oddReport.metrics.zeroCount, 1);
    assert.equal(oddReport.metrics.positiveMagnitude, oddReport.metrics.negativeMagnitude);

    const zeroDurationOptions = { ...options, count: 2, durationMs: 0, seed: 10 };
    const zeroDurationSequence = buildHumanWheelSequence(zeroDurationOptions);
    assert.equal(validateWheelSequence(zeroDurationSequence, zeroDurationOptions).valid, true);
    assert.equal(zeroDurationSequence[0].offsetMilliseconds, 0);
    assert.equal(zeroDurationSequence[1].offsetMilliseconds, 0);

    const invalidSequence = sequence.map((event) => ({ ...event }));
    invalidSequence[0].deltaY = options.deltaMagnitude * 2;
    const invalidReport = validateWheelSequence(invalidSequence, options);
    assert.equal(invalidReport.valid, false);
    assert.ok(invalidReport.errors.some((error) => error.includes("magnitude")));

    assert.throws(
        () => buildHumanWheelSequence({ ...options, typicalBurstMaximum: 11 }),
        /typicalBurstMaximum cannot exceed maximumRunLength/,
    );
    assert.throws(
        () => buildHumanWheelSequence({ ...options, count: 1, durationMs: 1 }),
        /count must be at least 2/,
    );

    console.log("wheel-sequence self-test passed");
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : null;

if (invokedFile === currentFile && process.argv.includes("--self-test")) {
    runSelfTest();
}
