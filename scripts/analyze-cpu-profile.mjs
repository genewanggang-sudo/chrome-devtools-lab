#!/usr/bin/env node

// Aggregate a V8 .cpuprofile into self-time attribution per function, per
// source line, and per URL. Complements analyze-trace.mjs: traces find long
// tasks, CPU profiles attribute the time inside them to functions and lines.
// Line numbers in a .cpuprofile are 0-based; this analyzer reports 1-based
// line/column values so they match editors and the sources panel.

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next == null || next.startsWith("--")) {
      options[key] = true;
    } else {
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
      `Invalid --${name}: ${options[name]}. Use an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function frameKey(callFrame) {
  return [
    callFrame.functionName || "(anonymous)",
    callFrame.url || "",
    callFrame.lineNumber ?? -1,
    callFrame.columnNumber ?? -1,
  ].join("|");
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

export function aggregate(profile) {
  const nodes = profile.nodes || [];
  let samples = profile.samples || [];
  let timeDeltas = profile.timeDeltas || [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("Profile has no nodes");
  }

  if (!Array.isArray(samples) || !Array.isArray(timeDeltas)) {
    throw new Error("Profile samples and timeDeltas must be arrays");
  }
  const byId = new Map();
  for (const node of nodes) {
    if (!Number.isInteger(node.id) || byId.has(node.id)) {
      throw new Error(
        `Profile has an invalid or duplicate node ID: ${node.id}`,
      );
    }
    byId.set(node.id, node);
  }

  // Keep counts distinct from measured microseconds. A profile without deltas
  // cannot establish elapsed time, even when startTime/endTime are present.
  const timed = timeDeltas.length > 0;
  let attribution = timed ? "timeDeltas" : "sampleCount";
  const selfUs = new Map();
  let normalization = { negativeDeltaCount: 0, reorderedSampleCount: 0 };
  if (timed) {
    if (samples.length !== timeDeltas.length) {
      throw new Error(
        "Profile samples/timeDeltas length mismatch; timing is incomplete",
      );
    }
    let timestamp = 0;
    const timestampedSamples = [];
    for (let index = 0; index < samples.length; index += 1) {
      const id = samples[index];
      const delta = timeDeltas[index];
      if (!byId.has(id))
        throw new Error(`Sample references unknown node: ${id}`);
      if (typeof delta !== "number" || !Number.isFinite(delta)) {
        throw new Error(
          `Invalid timeDeltas[${index}]: expected finite microseconds`,
        );
      }
      timestamp += delta;
      if (timestamp < 0)
        throw new Error(
          `Invalid timeDeltas[${index}]: sample precedes profile start`,
        );
      if (delta < 0) normalization.negativeDeltaCount += 1;
      timestampedSamples.push({ id, timestamp, originalIndex: index });
    }
    if (normalization.negativeDeltaCount > 0) {
      // DevTools CPUProfileDataModel.sortSamples also reconstructs cumulative
      // timestamps then sorts samples together with their timestamps. Preserve
      // elapsed duration instead of silently replacing negative deltas with 0.
      timestampedSamples.sort(
        (left, right) => left.timestamp - right.timestamp,
      );
      let previousTimestamp = 0;
      samples = [];
      timeDeltas = [];
      for (const [index, sample] of timestampedSamples.entries()) {
        samples.push(sample.id);
        timeDeltas.push(sample.timestamp - previousTimestamp);
        previousTimestamp = sample.timestamp;
        if (sample.originalIndex !== index)
          normalization.reorderedSampleCount += 1;
      }
    }
    for (let index = 0; index < samples.length; index += 1) {
      const id = samples[index];
      const delta = timeDeltas[index];
      selfUs.set(id, (selfUs.get(id) || 0) + delta);
    }
  } else if (samples.length > 0) {
    for (const id of samples) {
      if (!byId.has(id))
        throw new Error(`Sample references unknown node: ${id}`);
      selfUs.set(id, (selfUs.get(id) || 0) + 1);
    }
  } else if (nodes.some((node) => typeof node.hitCount === "number")) {
    attribution = "hitCount";
    for (const node of nodes) {
      if (
        node.hitCount != null &&
        (!Number.isInteger(node.hitCount) || node.hitCount < 0)
      ) {
        throw new Error(`Invalid hitCount for node ${node.id}`);
      }
      if (node.hitCount > 0) selfUs.set(node.id, node.hitCount);
    }
  } else {
    throw new Error(
      "Profile has neither samples/timeDeltas nor hitCount; nothing to attribute",
    );
  }

  const parentOf = new Map();
  for (const node of nodes) {
    for (const childId of node.children || []) {
      if (!byId.has(childId))
        throw new Error(`Node references unknown child: ${childId}`);
      if (parentOf.has(childId))
        throw new Error(`Node has multiple parent references: ${childId}`);
      parentOf.set(childId, node.id);
    }
  }
  // Validate the tree before walking sampled stacks (including unsampled nodes).
  const verified = new Set();
  for (const node of nodes) {
    const visiting = new Set();
    let cursor = node.id;
    while (cursor !== undefined && !verified.has(cursor)) {
      if (visiting.has(cursor))
        throw new Error(`Profile node tree contains a cycle: ${cursor}`);
      visiting.add(cursor);
      cursor = parentOf.get(cursor);
    }
    for (const id of visiting) verified.add(id);
  }

  // Call-tree nodes retain their own inclusive values for the flamegraph.
  // Logical function totals are a stack union: recursive appearances in the
  // same sample count once. Grouping weights by leaf first is equivalent to
  // visiting every sample, and avoids repeatedly walking identical stacks.
  const totalUs = new Map();
  const functionTotalUs = new Map();
  for (const [leafId, weight] of selfUs) {
    const seenFunctions = new Set();
    let cursor = leafId;
    while (cursor !== undefined) {
      const key = frameKey(byId.get(cursor).callFrame || {});
      totalUs.set(cursor, (totalUs.get(cursor) || 0) + weight);
      if (!seenFunctions.has(key)) {
        functionTotalUs.set(key, (functionTotalUs.get(key) || 0) + weight);
        seenFunctions.add(key);
      }
      cursor = parentOf.get(cursor);
    }
  }

  const totalProfiledUs = [...selfUs.values()].reduce((a, b) => a + b, 0);

  // Group node instances into logical entries.
  const functions = new Map();
  const lines = new Map();
  const urls = new Map();
  for (const node of nodes) {
    const callFrame = node.callFrame || {};
    const key = frameKey(callFrame);
    const nodeSelf = selfUs.get(node.id) || 0;

    let fn = functions.get(key);
    if (!fn) {
      fn = {
        functionName: callFrame.functionName || "(anonymous)",
        url: callFrame.url || "",
        line: (callFrame.lineNumber ?? -1) + 1,
        column: (callFrame.columnNumber ?? -1) + 1,
        selfUs: 0,
        totalUs: functionTotalUs.get(key) || 0,
        nodeCount: 0,
        callFrame,
      };
      functions.set(key, fn);
    }
    fn.selfUs += nodeSelf;
    fn.nodeCount += 1;

    if (callFrame.url) {
      const lineKey = `${callFrame.url}|${callFrame.lineNumber ?? -1}`;
      let ln = lines.get(lineKey);
      if (!ln) {
        ln = {
          url: callFrame.url,
          line: (callFrame.lineNumber ?? -1) + 1,
          column: (callFrame.columnNumber ?? -1) + 1,
          functionName: callFrame.functionName || "(anonymous)",
          selfUs: 0,
          nodeCount: 0,
        };
        lines.set(lineKey, ln);
      }
      ln.selfUs += nodeSelf;
      ln.nodeCount += 1;

      let u = urls.get(callFrame.url);
      if (!u) {
        u = { url: callFrame.url, selfUs: 0 };
        urls.set(callFrame.url, u);
      }
      u.selfUs += nodeSelf;
    }
  }

  const toFunctionRow = (fn) => ({
    functionName: fn.functionName,
    url: fn.url,
    line: fn.line,
    column: fn.column,
    selfMs: timed ? round1(fn.selfUs / 1000) : null,
    totalMs: timed ? round1(fn.totalUs / 1000) : null,
    ...(!timed ? { selfCount: fn.selfUs, totalCount: fn.totalUs } : {}),
    selfPercent:
      totalProfiledUs > 0 ? round1((fn.selfUs / totalProfiledUs) * 100) : 0,
    nodeCount: fn.nodeCount,
  });
  const toLineRow = (ln) => ({
    url: ln.url,
    line: ln.line,
    column: ln.column,
    functionName: ln.functionName,
    selfMs: timed ? round1(ln.selfUs / 1000) : null,
    ...(!timed ? { selfCount: ln.selfUs } : {}),
    selfPercent:
      totalProfiledUs > 0 ? round1((ln.selfUs / totalProfiledUs) * 100) : 0,
    nodeCount: ln.nodeCount,
  });

  const bySelf = (a, b) => b.selfUs - a.selfUs;
  const byTotal = (a, b) => b.totalUs - a.totalUs;
  const functionRows = [...functions.values()];
  return {
    selfUs,
    totalUs,
    parentOf,
    byId,
    totalProfiledUs,
    attribution,
    timed,
    quality: describeProfileQuality(
      profile,
      timed,
      totalProfiledUs,
      timeDeltas,
      normalization,
    ),
    samples,
    timeDeltas,
    hotFunctions: functionRows.sort(bySelf),
    expensiveFunctions: functionRows.slice().sort(byTotal),
    hotLines: [...lines.values()].sort(bySelf).map(toLineRow),
    hotUrls: [...urls.values()].sort(bySelf).map((u) => ({
      url: u.url,
      selfMs: timed ? round1(u.selfUs / 1000) : null,
      ...(!timed ? { selfCount: u.selfUs } : {}),
      selfPercent:
        totalProfiledUs > 0 ? round1((u.selfUs / totalProfiledUs) * 100) : 0,
    })),
    toFunctionRow,
  };
}

function describeProfileQuality(
  profile,
  timed,
  totalWeight,
  deltas,
  normalization,
) {
  const warnings = [];
  if (!timed) {
    warnings.push(
      "Timing deltas are unavailable: values are counts, not elapsed time; no temporal order can be inferred from hit counts.",
    );
    return { timingAvailable: false, warnings };
  }
  if (normalization.negativeDeltaCount > 0) {
    warnings.push(
      "Negative raw deltas were normalized by sorting cumulative timestamps and their samples together, matching DevTools sample-order normalization; raw input is unchanged. This report attributes each interval to its ending sample rather than claiming exact DevTools trace-engine equivalence.",
    );
  }
  const ordered = deltas
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const medianUs =
    ordered.length > 0 ? ordered[Math.floor(ordered.length / 2)] : 0;
  const gapThresholdUs = Math.max(50000, medianUs * 10);
  const largeGaps = deltas.filter((value) => value > gapThresholdUs);
  const boundsAvailable =
    Number.isFinite(profile.startTime) &&
    Number.isFinite(profile.endTime) &&
    profile.endTime >= profile.startTime;
  const durationUs = boundsAvailable
    ? profile.endTime - profile.startTime
    : null;
  if (!boundsAvailable)
    warnings.push(
      "Valid startTime/endTime are unavailable; capture-window coverage cannot be checked.",
    );
  if (
    durationUs !== null &&
    Math.abs(durationUs - totalWeight) > Math.max(5000, durationUs * 0.01)
  ) {
    warnings.push(
      "Attributed sample duration differs from the capture bounds by more than 1% or 5ms; do not interpret the sample sum as complete capture coverage.",
    );
  }
  if (largeGaps.length > 0) {
    warnings.push(
      "Large inter-sample gaps exist; their elapsed time is attributed to a sampled stack and is not proof of continuous CPU execution or lost events.",
    );
  }
  if (totalWeight === 0)
    warnings.push(
      "All sample deltas are zero; no elapsed time can be attributed.",
    );
  return {
    timingAvailable: true,
    profileDurationMs: durationUs === null ? null : round1(durationUs / 1000),
    attributedSampleTimeMs: round1(totalWeight / 1000),
    unrepresentedDurationMs:
      durationUs === null
        ? null
        : round1(Math.max(0, durationUs - totalWeight) / 1000),
    sampleDurationOverrunMs:
      durationUs === null
        ? null
        : round1(Math.max(0, totalWeight - durationUs) / 1000),
    coverageRatio: durationUs > 0 ? totalWeight / durationUs : null,
    medianIntervalUs: medianUs,
    largestIntervalUs: deltas.reduce(
      (maximum, value) => Math.max(maximum, value),
      0,
    ),
    largeGapThresholdUs: gapThresholdUs,
    largeGapCount: largeGaps.length,
    largeGapTimeMs: round1(
      largeGaps.reduce((sum, value) => sum + value, 0) / 1000,
    ),
    ...normalization,
    warnings,
  };
}

export function buildSpeedscope(profile, aggregated, inputName) {
  const frameIndexByKey = new Map();
  const frames = [];
  const frameIndexOf = (callFrame) => {
    const key = frameKey(callFrame);
    let index = frameIndexByKey.get(key);
    if (index === undefined) {
      index = frames.length;
      frameIndexByKey.set(key, index);
      frames.push({
        name: callFrame.functionName || "(anonymous)",
        file: callFrame.url || undefined,
        line: (callFrame.lineNumber ?? -1) + 1,
        col: (callFrame.columnNumber ?? -1) + 1,
      });
    }
    return index;
  };
  for (const node of profile.nodes) {
    frameIndexOf(node.callFrame || {});
  }

  const samples = [];
  const weights = [];
  const { selfUs, parentOf, byId } = aggregated;
  const { samples: rawSamples, timeDeltas } = aggregated;
  const weightedSamples =
    rawSamples.length > 0
      ? rawSamples.map((id, index) => [
          id,
          aggregated.timed ? timeDeltas[index] : 1,
        ])
      : [...selfUs.entries()];
  for (const [id, weight] of weightedSamples) {
    const stack = [];
    let cursor = id;
    while (cursor !== undefined) {
      const node = byId.get(cursor);
      if (!node) break;
      stack.push(frameIndexOf(node.callFrame || {}));
      cursor = parentOf.get(cursor);
    }
    stack.reverse(); // speedscope expects root -> leaf order.
    samples.push(stack);
    weights.push(weight);
  }

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles: [
      {
        type: "sampled",
        name:
          aggregated.attribution === "hitCount"
            ? `${inputName} (unordered hit counts)`
            : inputName,
        unit: aggregated.timed ? "microseconds" : "none",
        startValue: 0,
        endValue: aggregated.totalProfiledUs,
        samples,
        weights,
      },
    ],
  };
}

export function buildFlamegraphData(profile, aggregated) {
  const { selfUs, totalUs, parentOf, byId, totalProfiledUs } = aggregated;
  const roots = [];
  for (const node of profile.nodes) {
    if (!parentOf.has(node.id)) roots.push(node.id);
  }
  const rects = [];
  const stack = [];
  let rootX = 0;
  const rootEntries = roots.map((id) => {
    const entry = { id, depth: 0, x0: rootX };
    rootX += totalUs.get(id) || 0;
    return entry;
  });
  for (let index = rootEntries.length - 1; index >= 0; index -= 1) {
    stack.push(rootEntries[index]);
  }
  while (stack.length > 0) {
    const { id, depth, x0 } = stack.pop();
    const node = byId.get(id);
    if (!node) continue;
    const callFrame = node.callFrame || {};
    rects.push({
      d: depth,
      x: x0,
      w: totalUs.get(id) || 0,
      n: callFrame.functionName || "(anonymous)",
      u: callFrame.url || "",
      l: (callFrame.lineNumber ?? -1) + 1,
      s: aggregated.timed
        ? round1((selfUs.get(id) || 0) / 1000)
        : selfUs.get(id) || 0,
      t: aggregated.timed
        ? round1((totalUs.get(id) || 0) / 1000)
        : totalUs.get(id) || 0,
    });
    let childX = x0;
    const children = (node.children || []).filter((childId) =>
      byId.has(childId),
    );
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const childTotal = totalUs.get(children[index]) || 0;
      stack.push({
        id: children[index],
        depth: depth + 1,
        x0: childX,
      });
      childX += childTotal;
    }
  }
  return {
    totalMs: aggregated.timed ? round1(totalProfiledUs / 1000) : null,
    totalCount: aggregated.timed ? null : totalProfiledUs,
    unit: aggregated.timed ? "ms" : "count",
    rects,
  };
}

function flamegraphHtml(data, hotLines, title) {
  const payload = JSON.stringify({
    data,
    hotLines: hotLines.slice(0, 12),
  }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Flame graph - ${title}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 16px; background: #fafafa; color: #222; }
  h1 { font-size: 16px; }
  .meta { color: #555; font-size: 13px; margin-bottom: 12px; }
  #chart { width: 100%; border: 1px solid #ddd; background: #fff; }
  table { border-collapse: collapse; font-size: 13px; margin-top: 16px; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 4px 8px; text-align: left; }
  th { background: #f0f0f0; }
  #tooltip { position: fixed; display: none; pointer-events: none; background: #222; color: #fff;
    padding: 6px 8px; font-size: 12px; border-radius: 4px; max-width: 480px; z-index: 10; }
</style>
</head>
<body>
<h1>Flame graph</h1>
<div class="meta" id="meta"></div>
<svg id="chart" height="0"></svg>
<div id="tooltip"></div>
<table id="hotlines"><thead><tr><th id="self-unit">self ms</th><th>location</th><th>function</th></tr></thead><tbody></tbody></table>
<script>
const payload = ${payload};
const meta = document.getElementById("meta");
const unit = payload.data.unit;
meta.textContent = "Aggregate call tree (not a chronological timeline). Total: " +
  (unit === "ms" ? payload.data.totalMs : payload.data.totalCount) + " " + unit + "; rows below group sampled function definition locations, not executing statements.";
document.getElementById("self-unit").textContent = "self " + unit;
const ROW = 18;
const rects = payload.data.rects;
const chart = document.getElementById("chart");
const totalWidth = rects.reduce((max, rect) => Math.max(max, rect.x + rect.w), 0) || 1;
const maxDepth = rects.reduce((max, rect) => Math.max(max, rect.d), 0);
chart.setAttribute("height", String((maxDepth + 1) * ROW + 4));
const svgns = "http://www.w3.org/2000/svg";
const tooltip = document.getElementById("tooltip");
function hue(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}
for (const rect of rects) {
  const widthFraction = rect.w / totalWidth;
  if (widthFraction <= 0.0005) continue;
  const element = document.createElementNS(svgns, "rect");
  const x = (rect.x / totalWidth) * 100;
  element.setAttribute("x", x + "%");
  element.setAttribute("y", rect.d * ROW + 2);
  element.setAttribute("width", "calc(" + widthFraction * 100 + "% - 1px)");
  element.setAttribute("height", ROW - 2);
  const gray = /^(\\(root\\)|\\(program\\)|\\(idle\\)|\\(garbage collector\\))$/.test(rect.n);
  element.setAttribute("fill", gray ? "#b0b0b0" : "hsl(" + hue(rect.u || rect.n) + ", 65%, " + (78 - Math.min(rect.d, 6) * 4) + "%)");
  element.setAttribute("stroke", "#ffffff");
  element.appendChild(Object.assign(document.createElementNS(svgns, "title"), {
    textContent: rect.n + "\\n" + (rect.u ? rect.u + ":" + rect.l : "(no url)") + "\\nself " + rect.s + " " + unit + " / total " + rect.t + " " + unit
  }));
  element.addEventListener("mousemove", (event) => {
    tooltip.style.display = "block";
    tooltip.style.left = event.clientX + 12 + "px";
    tooltip.style.top = event.clientY + 12 + "px";
    tooltip.innerHTML = "<b>" + rect.n + "</b><br>" + (rect.u ? rect.u + ":" + rect.l : "(no url)") +
      "<br>self " + rect.s + " " + unit + " / total " + rect.t + " " + unit;
  });
  element.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
  chart.appendChild(element);
}
const tbody = document.querySelector("#hotlines tbody");
for (const line of payload.hotLines) {
  const row = document.createElement("tr");
  const cells = [String(unit === "ms" ? line.selfMs : line.selfCount), line.url + ":" + line.line, line.functionName];
  for (const text of cells) {
    const cell = document.createElement("td");
    cell.textContent = text;
    row.appendChild(cell);
  }
  tbody.appendChild(row);
}
</script>
</body>
</html>
`;
}

async function writeJson(output, value) {
  await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
  await fs.writeFile(
    path.resolve(output),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  return path.resolve(output);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = options.input;
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Analysis requires --input <profile.cpuprofile>.");
  }
  const output = options.output;
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("Analysis requires --output <summary.json>.");
  }
  const limit = integerOption(options, "limit", 25, 1, 500);
  const profile = JSON.parse(await fs.readFile(path.resolve(input), "utf8"));
  if (!Array.isArray(profile.nodes)) {
    throw new Error("Input is not a .cpuprofile (missing nodes[])");
  }
  const aggregated = aggregate(profile);
  const profiledMs = aggregated.timed
    ? round1(aggregated.totalProfiledUs / 1000)
    : null;

  const summary = {
    ok: true,
    input: path.resolve(input),
    meta: {
      profiledSelfTimeMs: profiledMs,
      attribution: aggregated.attribution,
      unit: aggregated.timed ? "milliseconds" : "count",
      ...(!aggregated.timed
        ? { profiledSampleCount: aggregated.totalProfiledUs }
        : {}),
      quality: aggregated.quality,
      sampleCount: aggregated.samples.length,
      nodeCount: profile.nodes.length,
      samplingIntervalNote:
        "V8 samples stacks on an interval. With timeDeltas, self time sums deltas assigned to sampled nodes; logical function total time counts a function only once per sampled stack, including recursion. Without deltas, only counts are reported. line/column mark function definition positions in captured/generated scripts, not executing statements or source-mapped TypeScript. Optional precise coverage reports instrumented range counts, not exact statement frequencies or elapsed time.",
      convention:
        "line/column are 1-based for direct use in editors and DevTools",
    },
    hotFunctions: aggregated.hotFunctions
      .slice(0, limit)
      .map(aggregated.toFunctionRow),
    expensiveByTotalTime: aggregated.expensiveFunctions
      .slice(0, limit)
      .map(aggregated.toFunctionRow),
    hotSourceLines: aggregated.hotLines.slice(0, limit),
    hotUrls: aggregated.hotUrls.slice(0, limit),
  };

  const written = [];
  if (typeof options.speedscope === "string" && options.speedscope.length > 0) {
    written.push(
      await writeJson(
        options.speedscope,
        buildSpeedscope(profile, aggregated, path.basename(input)),
      ),
    );
  }
  if (typeof options.flamegraph === "string" && options.flamegraph.length > 0) {
    const htmlPath = path.resolve(options.flamegraph);
    await fs.mkdir(path.dirname(htmlPath), { recursive: true });
    await fs.writeFile(
      htmlPath,
      flamegraphHtml(
        buildFlamegraphData(profile, aggregated),
        aggregated.hotLines,
        path.basename(input),
      ),
      "utf8",
    );
    written.push(htmlPath);
  }
  await writeJson(output, summary);
  written.push(path.resolve(output));

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        output: path.resolve(output),
        extraOutputs: written.filter((p) => p !== path.resolve(output)),
        profiledSelfTimeMs: profiledMs,
        quality: aggregated.quality,
        sampleCount: aggregated.samples.length,
        topFunctions: aggregated.hotFunctions
          .slice(0, 5)
          .map(aggregated.toFunctionRow),
        topSourceLines: aggregated.hotLines.slice(0, 5),
      },
      null,
      2,
    )}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message || error}\n`);
    process.exitCode = 1;
  });
}
