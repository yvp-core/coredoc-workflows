#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { retryReconcileConfiguredArtifacts } from "./artifact-checkpoints.mjs";
import { createConfiguredCaptureRecorder } from "./capture-client.mjs";

const RETRY_TIMEOUT_MS = 750;
const MAX_SESSION_START_INPUT_BYTES = 64 * 1024;
const MAX_CWD_LENGTH = 4_096;

/** Flush the current capture binding once; persisted events own their session IDs. */
export async function retryPendingCaptureEvents({
  env = process.env,
  cwd = process.cwd(),
  createRecorder = createConfiguredCaptureRecorder,
  send,
  timeoutMs = RETRY_TIMEOUT_MS,
} = {}) {
  if (!env.COREDOC_CAPTURE_ENDPOINT) {
    return { status: "disabled", attempted: 0, sent: 0 };
  }

  let recorder;
  try {
    recorder = createRecorder({ env, cwd });
    const delivered = await recorder.flush({
      ...(send === undefined ? {} : { send }),
      timeoutMs,
    });
    return {
      status: delivered.pending === 0 ? "sent" : "pending",
      attempted: delivered.attempted,
      sent: delivered.accepted + delivered.duplicates,
      pending: delivered.pending,
      bindingRefused: delivered.bindingRefused,
      unreadable: delivered.unreadable,
    };
  } catch {
    if (!recorder) {
      return { status: "failed", attempted: 0, sent: 0 };
    }
    try {
      const pending = recorder.pending().length;
      return {
        status: "pending",
        attempted: pending,
        sent: 0,
        pending,
      };
    } catch {
      return { status: "failed", attempted: 0, sent: 0 };
    }
  }
}

export async function retrySessionStartDelivery({
  env = process.env,
  cwd = process.cwd(),
  timeoutMs = RETRY_TIMEOUT_MS,
  retryCapture = retryPendingCaptureEvents,
  retryArtifacts = retryReconcileConfiguredArtifacts,
} = {}) {
  const capture = await retryCapture({ env, cwd, timeoutMs });
  const artifacts = await retryArtifacts({ env, cwd, timeoutMs });
  return { capture, artifacts };
}

function validSessionStartCwd(event, fallback) {
  const cwd = event?.cwd;
  return event?.hook_event_name === "SessionStart" &&
    typeof cwd === "string" &&
    cwd.length > 0 &&
    cwd.length <= MAX_CWD_LENGTH &&
    !cwd.includes("\0") &&
    isAbsolute(cwd)
    ? cwd
    : fallback;
}

async function sessionStartCwd(
  input = process.stdin,
  fallback = process.cwd(),
) {
  let body = "";
  let bytes = 0;
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_SESSION_START_INPUT_BYTES) return fallback;
    body += chunk;
  }
  try {
    return validSessionStartCwd(JSON.parse(body || "{}"), fallback);
  } catch {
    return fallback;
  }
}

async function main() {
  const cwd = await sessionStartCwd();
  await retrySessionStartDelivery({ cwd });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    /* Capture retry is best-effort and must stay silent during SessionStart. */
  });
}
