#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getDevToolsRuntime } from "./devtools-runtime.mjs";

// Use the same pinned runtime as offline analysis, including installed plugin
// caches without node_modules. Import in this process to avoid npx/shell chains.
try {
  const runtime = await getDevToolsRuntime();
  await import(
    pathToFileURL(
      path.join(runtime.packageRoot, "build", "src", "bin", "chrome-devtools-mcp.js"),
    ).href
  );
} catch (error) {
  console.error(`Chrome DevTools Lab could not start: ${error.message}`);
  process.exitCode = 1;
}
