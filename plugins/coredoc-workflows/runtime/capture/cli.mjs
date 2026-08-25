#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { captureContext } from "./contract.mjs";
import { captureHeaders, createCaptureRecorder } from "./index.mjs";
import { captureDirectory } from "../../scripts/capture-client.mjs";

const MAX_TIMEOUT_MS = 4_000;
const MAX_INPUT_BYTES = 65_536;

function exactObject(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.has(field)) throw new Error(`Unsupported ${label} field: ${field}`);
  }
  return value;
}

function recordCommand(input) {
  const command = exactObject(input, new Set(["action", "context", "event"]), "capture command");
  const context = captureContext(command.context);
  const event = exactObject(
    command.event,
    new Set([
      "schemaVersion",
      "occurredAt",
      "type",
      "runId",
      "taskId",
      "data",
    ]),
    "capture command event",
  );
  return { context, event };
}

function flushCommand(input) {
  const command = exactObject(input, new Set(["action", "timeoutMs"]), "capture command");
  if (
    command.timeoutMs !== undefined &&
    (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 100 || command.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new Error(`timeoutMs must be an integer between 100 and ${MAX_TIMEOUT_MS}`);
  }
  return command.timeoutMs;
}

export async function runCaptureCommand(
  input,
  {
    env = process.env,
    cwd = process.cwd(),
    createRecorder = createCaptureRecorder,
    idFactory,
  } = {},
) {
  if (input?.action === "record") {
    const { context, event } = recordCommand(input);
    const recorder = createRecorder({
      directory: captureDirectory(cwd, env),
      target: env.COREDOC_CAPTURE_ENDPOINT ?? "",
      headers: captureHeaders(env.COREDOC_CAPTURE_HEADERS ?? ""),
      ...(env.COREDOC_CAPTURE_WORKSPACE_ID === undefined
        ? {}
        : { workspaceId: env.COREDOC_CAPTURE_WORKSPACE_ID }),
      context,
      ...(idFactory === undefined ? {} : { idFactory }),
    });
    return recorder.record(event);
  }
  if (input?.action === "flush") {
    const timeoutMs = flushCommand(input);
    const recorder = createRecorder({
      directory: captureDirectory(cwd, env),
      target: env.COREDOC_CAPTURE_ENDPOINT ?? "",
      headers: captureHeaders(env.COREDOC_CAPTURE_HEADERS ?? ""),
      ...(env.COREDOC_CAPTURE_WORKSPACE_ID === undefined
        ? {}
        : { workspaceId: env.COREDOC_CAPTURE_WORKSPACE_ID }),
    });
    return recorder.flush(timeoutMs === undefined ? {} : { timeoutMs });
  }
  throw new Error("Unsupported capture action");
}

async function main() {
  let raw = "";
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
    if (bytes > MAX_INPUT_BYTES) {
      throw new Error(`capture command exceeds ${MAX_INPUT_BYTES} bytes`);
    }
    raw += chunk;
  }
  let input;
  try {
    input = JSON.parse(raw || "{}");
  } catch {
    throw new Error("capture command must be valid JSON");
  }
  const result = await runCaptureCommand(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
