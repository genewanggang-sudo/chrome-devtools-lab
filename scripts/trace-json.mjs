import fs from "node:fs/promises";
import path from "node:path";

// Full-object analysis still holds JSON text, its lossless copy and parsed
// objects in memory. Stream capture has no such size limit.
export const DEFAULT_MAX_TRACE_JSON_BYTES = 256 * 1024 * 1024;

function parseLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxBytes must be a positive safe integer.");
  }
  return value;
}

function assertParseSize(byteLength, maxBytes, input = "Trace JSON") {
  if (byteLength <= maxBytes) return;
  const error = new RangeError(
    `${input} is ${byteLength} bytes, exceeding the ${maxBytes}-byte full-memory analysis limit. The raw trace is preserved; import it into Chrome Performance or explicitly raise --max-parse-bytes with sufficient Node heap.`,
  );
  error.code = "TRACE_ANALYSIS_SIZE_LIMIT";
  error.byteLength = byteLength;
  error.maxBytes = maxBytes;
  throw error;
}

export async function readTraceJsonTextFile(
  input,
  { maxBytes = DEFAULT_MAX_TRACE_JSON_BYTES } = {},
) {
  parseLimit(maxBytes);
  const resolved = path.resolve(input);
  const stat = await fs.stat(resolved);
  assertParseSize(stat.size, maxBytes, resolved);
  const text = await fs.readFile(resolved, "utf8");
  assertParseSize(Buffer.byteLength(text, "utf8"), maxBytes, resolved);
  return text;
}

export async function readTraceJsonFile(input, options = {}) {
  return parseTraceJson(await readTraceJsonTextFile(input, options), options);
}

// Drain CDP directly to disk. At most one CDP chunk is retained, and a failed
// read keeps every successfully written byte for diagnosis. Never unlink it.
export async function writeTraceStream(
  session,
  handle,
  output,
  { chunkBytes = 1024 * 1024, exclusive = true } = {},
) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new TypeError("chunkBytes must be a positive safe integer.");
  }
  const resolved = path.resolve(output);
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  let file;
  let bytesWritten = 0;
  let chunkCount = 0;
  let failure;
  try {
    file = await fs.open(resolved, exclusive ? "wx" : "w");
    let eof = false;
    while (!eof) {
      const result = await session.send("IO.read", {
        handle,
        size: chunkBytes,
      });
      const chunk = Buffer.from(
        result.data || "",
        result.base64Encoded ? "base64" : "utf8",
      );
      // FileHandle.write may make a partial write; writeFile drains the chunk.
      await file.writeFile(chunk);
      bytesWritten += chunk.length;
      chunkCount += 1;
      eof = result.eof === true;
    }
  } catch (error) {
    failure = error;
    error.traceOutput = resolved;
    error.bytesWritten = bytesWritten;
    throw error;
  } finally {
    try {
      if (file) await file.close();
    } finally {
      try {
        await session.send("IO.close", { handle });
      } catch (error) {
        if (!failure) throw error;
      }
    }
  }
  return { path: resolved, bytesWritten, chunkCount, streamClosed: true };
}

// Trace IDs are signed 64-bit integers. JSON.parse would round adjacent IDs
// into the same Number before target correlation can inspect them.
export function parseTraceJson(
  text,
  { maxBytes = DEFAULT_MAX_TRACE_JSON_BYTES } = {},
) {
  if (typeof text !== "string") throw new TypeError("Trace JSON must be text.");
  assertParseSize(Buffer.byteLength(text, "utf8"), parseLimit(maxBytes));
  const losslessText = text.replace(
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
    (token) => {
      if (token.startsWith('"') || !/^-?\d+$/.test(token)) return token;
      return Number.isSafeInteger(Number(token))
        ? token
        : JSON.stringify(token);
    },
  );
  return JSON.parse(losslessText);
}
