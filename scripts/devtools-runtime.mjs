import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const DEVTOOLS_MCP_VERSION = "1.10.1";
const require = createRequire(import.meta.url);
const runFile = promisify(execFile);
let runtimePromise;
let localeReady = false;

async function matchingPackage(file) {
  try {
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    return manifest.name === "chrome-devtools-mcp" &&
      manifest.version === DEVTOOLS_MCP_VERSION
      ? path.dirname(file)
      : null;
  } catch {
    return null;
  }
}

function npmCliCandidates() {
  const suffix = ["node_modules", "npm", "bin", "npm-cli.js"];
  const roots = [
    // Hosts may run this server with a bundled Node that has no npm next to
    // it, while the machine keeps a full Node.js install elsewhere. Prefer
    // an explicit override, then the usual install locations.
    process.env.CHROME_LAB_NPM_CLI ? [process.env.CHROME_LAB_NPM_CLI] : [],
    [path.dirname(process.execPath)],
    (process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean),
    process.env.NVM_SYMLINK ? [process.env.NVM_SYMLINK] : [],
    process.env.ProgramFiles
      ? [path.join(process.env.ProgramFiles, "nodejs")]
      : [],
    process.env["ProgramFiles(x86)"]
      ? [path.join(process.env["ProgramFiles(x86)"], "nodejs")]
      : [],
    process.env.APPDATA ? [path.join(process.env.APPDATA, "npm")] : [],
  ].flat();
  return roots.map((root) =>
    root.endsWith("npm-cli.js") ? root : path.join(root, ...suffix),
  );
}

async function npmCLI() {
  for (const candidate of npmCliCandidates()) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* Try the next Node installation. */
    }
  }
  throw new Error(
    "A matching native DevTools runtime was not installed, and npm-cli.js could not be found. Set CHROME_LAB_NPM_CLI to a npm-cli.js path, install Node.js with npm, or run npm ci in the plugin directory.",
  );
}

async function resolveRuntime() {
  try {
    const local = await matchingPackage(
      require.resolve("chrome-devtools-mcp/package.json"),
    );
    if (local)
      return {
        packageRoot: local,
        version: DEVTOOLS_MCP_VERSION,
        source: "plugin dependency",
      };
  } catch {
    /* Installed plugin caches need not contain node_modules. */
  }
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"),
    "chrome-devtools-lab",
    "runtimes",
    `chrome-devtools-mcp-${DEVTOOLS_MCP_VERSION}`,
  );
  const packageFile = path.join(
    cacheRoot,
    "node_modules",
    "chrome-devtools-mcp",
    "package.json",
  );
  const readyFile = path.join(cacheRoot, ".ready.json");
  const completedCache = async () => {
    try {
      const marker = JSON.parse(await fs.readFile(readyFile, "utf8"));
      return marker.version === DEVTOOLS_MCP_VERSION
        ? matchingPackage(packageFile)
        : null;
    } catch {
      return null;
    }
  };
  const cached = await completedCache();
  if (cached)
    return {
      packageRoot: cached,
      version: DEVTOOLS_MCP_VERSION,
      source: "user runtime cache",
    };
  if (process.env.CHROME_LAB_NO_RUNTIME_INSTALL === "1")
    throw new Error(
      "The pinned native DevTools runtime is missing. Run npm ci in the plugin directory or allow its one-time cached installation.",
    );
  await fs.mkdir(cacheRoot, { recursive: true });
  const lockFile = path.join(cacheRoot, ".install.lock");
  let lock;
  const started = Date.now();
  while (!lock) {
    try {
      lock = await fs.open(lockFile, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const ready = await completedCache();
      if (ready)
        return {
          packageRoot: ready,
          version: DEVTOOLS_MCP_VERSION,
          source: "user runtime cache",
        };
      if (Date.now() - started > 180_000)
        throw new Error(
          `Another native runtime installation has not completed. Inspect ${lockFile} before retrying.`,
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  try {
    await lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    console.error(
      `Installing the pinned Chrome DevTools runtime ${DEVTOOLS_MCP_VERSION} into its user cache (once).`,
    );
    await runFile(
      process.execPath,
      [
        await npmCLI(),
        "install",
        "--prefix",
        cacheRoot,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        "--save-exact",
        `chrome-devtools-mcp@${DEVTOOLS_MCP_VERSION}`,
      ],
      { windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const installed = await matchingPackage(packageFile);
    if (!installed)
      throw new Error(
        `Native DevTools runtime installation did not produce ${DEVTOOLS_MCP_VERSION}.`,
      );
    await fs.writeFile(
      readyFile,
      JSON.stringify({
        version: DEVTOOLS_MCP_VERSION,
        completedAt: new Date().toISOString(),
      }),
    );
    return {
      packageRoot: installed,
      version: DEVTOOLS_MCP_VERSION,
      source: "user runtime cache",
    };
  } finally {
    await lock.close();
    await fs.unlink(lockFile).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function getDevToolsRuntime() {
  runtimePromise ??= resolveRuntime().catch((error) => {
    runtimePromise = undefined;
    throw error;
  });
  return runtimePromise;
}

export async function loadDevTools() {
  const runtime = await getDevToolsRuntime();
  return import(
    pathToFileURL(
      path.join(runtime.packageRoot, "build", "src", "third_party", "index.js"),
    ).href
  );
}

export async function loadTraceParser() {
  const runtime = await getDevToolsRuntime();
  const [thirdParty, processor] = await Promise.all([
    loadDevTools(),
    import(
      pathToFileURL(
        path.join(
          runtime.packageRoot,
          "build",
          "src",
          "processors",
          "PerformanceTrace.js",
        ),
      ).href
    ),
  ]);
  if (!localeReady) {
    // Match the official MCP's headless DevTools locale initialization without
    // installing its browser models or altering a recording connection.
    const { DevTools } = thirdParty;
    DevTools.I18n.DevToolsLocale.DevToolsLocale.instance({
      create: true,
      data: {
        navigatorLanguage: "en-US",
        settingLanguage: "en-US",
        lookupClosestDevToolsLocale: (locale) => locale,
      },
    });
    DevTools.I18n.i18n.registerLocaleDataForTest("en-US", {});
    localeReady = true;
  }
  return { DevTools: thirdParty.DevTools, ...processor, runtime };
}
