#!/usr/bin/env node

// Aggregate a V8 .cpuprofile into self-time attribution per function, per
// source line, and per URL. Complements analyze-trace.mjs: traces find long
// tasks, CPU profiles attribute the time inside them to functions and lines.
// Line numbers in a .cpuprofile are 0-based; this analyzer reports 1-based
// line/column values so they match editors and the sources panel.

import fs from "node:fs/promises";
import path from "node:path";

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

function aggregate(profile) {
  const nodes = profile.nodes || [];
  const samples = profile.samples || [];
  const timeDeltas = profile.timeDeltas || [];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("Profile has no nodes");
  }

  const byId = new Map();
  for (const node of nodes) byId.set(node.id, node);

  // Self time: attribute each inter-sample delta to the sampled node.
  let attribution = "timeDeltas";
  let hasDeltas = Array.isArray(timeDeltas) && timeDeltas.length > 0;
  const selfUs = new Map();
  if (hasDeltas) {
    for (let index = 0; index < samples.length; index += 1) {
      const id = samples[index];
      const delta = Math.max(0, Number(timeDeltas[index] || 0));
      selfUs.set(id, (selfUs.get(id) || 0) + delta);
    }
  } else if (typeof nodes[0].hitCount === "number") {
    attribution = "hitCount";
    for (const node of nodes) {
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
      parentOf.set(childId, node.id);
    }
  }

  // Total time per node: iterative post-order over children.
  const totalUs = new Map();
  const state = new Map();
  const work = [];
  for (const node of nodes) {
    if (!parentOf.has(node.id)) work.push(node.id);
  }
  if (work.length === 0) work.push(nodes[0].id);
  while (work.length > 0) {
    const id = work[work.length - 1];
    const phase = state.get(id) || 0;
    if (phase === 0) {
      state.set(id, 1);
      const node = byId.get(id);
      for (const childId of node.children || []) {
        if (byId.has(childId)) work.push(childId);
      }
    } else {
      work.pop();
      const node = byId.get(id);
      let sum = selfUs.get(id) || 0;
      for (const childId of node.children || []) {
        sum += totalUs.get(childId) || 0;
      }
      totalUs.set(id, sum);
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
    const nodeTotal = totalUs.get(node.id) || 0;

    let fn = functions.get(key);
    if (!fn) {
      fn = {
        functionName: callFrame.functionName || "(anonymous)",
        url: callFrame.url || "",
        line: (callFrame.lineNumber ?? -1) + 1,
        column: (callFrame.columnNumber ?? -1) + 1,
        selfUs: 0,
        totalUs: 0,
        nodeCount: 0,
        callFrame,
      };
      functions.set(key, fn);
    }
    fn.selfUs += nodeSelf;
    fn.totalUs += nodeTotal;
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
    selfMs: round1(fn.selfUs / 1000),
    totalMs: round1(fn.totalUs / 1000),
    selfPercent:
      totalProfiledUs > 0
        ? round1((fn.selfUs / totalProfiledUs) * 100)
        : 0,
    nodeCount: fn.nodeCount,
  });
  const toLineRow = (ln) => ({
    url: ln.url,
    line: ln.line,
    column: ln.column,
    functionName: ln.functionName,
    selfMs: round1(ln.selfUs / 1000),
    selfPercent:
      totalProfiledUs > 0
        ? round1((ln.selfUs / totalProfiledUs) * 100)
        : 0,
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
    samples,
    timeDeltas,
    hotFunctions: functionRows.sort(bySelf),
    expensiveFunctions: functionRows.slice().sort(byTotal),
    hotLines: [...lines.values()]
      .sort(bySelf)
      .map(toLineRow),
    hotUrls: [...urls.values()]
      .sort(bySelf)
      .map((u) => ({
        url: u.url,
        selfMs: round1(u.selfUs / 1000),
        selfPercent:
          totalProfiledUs > 0
            ? round1((u.selfUs / totalProfiledUs) * 100)
            : 0,
      })),
    toFunctionRow,
  };
}

function buildSpeedscope(profile, aggregated, inputName) {
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
  for (let index = 0; index < rawSamples.length; index += 1) {
    const stack = [];
    let cursor = rawSamples[index];
    while (cursor !== undefined) {
      const node = byId.get(cursor);
      if (!node) break;
      stack.push(frameIndexOf(node.callFrame || {}));
      cursor = parentOf.get(cursor);
    }
    stack.reverse(); // speedscope expects root -> leaf order.
    samples.push(stack);
    weights.push(Math.max(0, Number(timeDeltas[index] || 0)));
  }

  return {
    $schema: "https://www.speedscope.app/file-format-schema.json",
    shared: { frames },
    profiles: [
      {
        type: "sampled",
        name: inputName,
        unit: "microseconds",
        startValue: 0,
        endValue: aggregated.totalProfiledUs,
        samples,
        weights,
      },
    ],
  };
}

function buildFlamegraphData(profile, aggregated) {
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
      s: round1((selfUs.get(id) || 0) / 1000),
      t: round1((totalUs.get(id) || 0) / 1000),
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
    totalMs: round1(totalProfiledUs / 1000),
    rects,
  };
}

function flamegraphHtml(data, hotLines, title) {
  const payload = JSON.stringify({ data, hotLines: hotLines.slice(0, 12) })
    .replace(/</g, "\\u003c");
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
<table id="hotlines"><thead><tr><th>self ms</th><th>location</th><th>function</th></tr></thead><tbody></tbody></table>
<script>
const payload = ${payload};
const meta = document.getElementById("meta");
meta.textContent = "profiled self time total: " + payload.data.totalMs + " ms; rows below are the top lines by self time.";
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
    textContent: rect.n + "\\n" + (rect.u ? rect.u + ":" + rect.l : "(no url)") + "\\nself " + rect.s + " ms / total " + rect.t + " ms"
  }));
  element.addEventListener("mousemove", (event) => {
    tooltip.style.display = "block";
    tooltip.style.left = event.clientX + 12 + "px";
    tooltip.style.top = event.clientY + 12 + "px";
    tooltip.innerHTML = "<b>" + rect.n + "</b><br>" + (rect.u ? rect.u + ":" + rect.l : "(no url)") +
      "<br>self " + rect.s + " ms / total " + rect.t + " ms";
  });
  element.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
  chart.appendChild(element);
}
const tbody = document.querySelector("#hotlines tbody");
for (const line of payload.hotLines) {
  const row = document.createElement("tr");
  const cells = [String(line.selfMs), line.url + ":" + line.line, line.functionName];
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
  const profiledMs = round1(aggregated.totalProfiledUs / 1000);

  const summary = {
    ok: true,
    input: path.resolve(input),
    meta: {
      profiledSelfTimeMs: profiledMs,
      attribution: aggregated.attribution,
      sampleCount: aggregated.samples.length,
      nodeCount: profile.nodes.length,
      samplingIntervalNote:
        "V8 samples the stack on an interval; self time is the sum of inter-sample deltas attributed to the sampled node. Sampling attributes time to functions: line/column mark the sampled function's definition position (the jump target in editors/DevTools), not the individual executing statement. For statement-level frequency, capture with capture-cpu-profile.mjs --coverage.",
      convention: "line/column are 1-based for direct use in editors and DevTools",
    },
    hotFunctions: aggregated.hotFunctions.slice(0, limit).map(aggregated.toFunctionRow),
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

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || error}\n`);
  process.exitCode = 1;
});
