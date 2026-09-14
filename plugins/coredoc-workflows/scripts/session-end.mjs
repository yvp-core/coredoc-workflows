#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import { captureIdentityEnv } from "./expired-runs.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import {
  abandonOpenWorkflowStage,
  suspendWorkflowRun,
} from "./workflow-run-state.mjs";

// Claude reports why a session ended. `clear` and `logout` discard the
// conversation, so its run can never continue. An exit from the prompt, a
// switch to another session with /resume, or any other exit is resumable with
// the same session ID, so the run waits instead of being recorded abandoned.
// A missing or unknown reason abandons, as every SessionEnd did before
// suspension existed.
const RESUMABLE_END_REASONS = new Set(["prompt_input_exit", "resume", "other"]);

function queueStageCapture(
  event,
  { env = process.env, sessionId } = {},
) {
  try {
    const queued = createConfiguredCaptureRecorder({ env, sessionId }).record(
      event,
    );
    return {
      ...queued,
      durable: queued.status === "queued" || queued.status === "disabled",
    };
  } catch {
    // Deliberate best-effort: capture delivery is telemetry on the SessionEnd
    // path and must never keep the run from being recorded abandoned.
    return { status: "failed", durable: false };
  }
}

export async function finishWorkflowSession(
  {
    sessionId,
    at = new Date().toISOString(),
    reason,
  },
  {
    env = process.env,
    timeoutMs = 750,
    queueStage = queueStageCapture,
    finishRun = finishWorkflowRun,
  } = {},
) {
  if (RESUMABLE_END_REASONS.has(reason)) {
    const suspended = suspendWorkflowRun(
      sessionId,
      { at, capture: captureIdentityEnv(env) },
      { env },
    );
    return {
      run: suspended
        ? { status: "suspended", runId: suspended.runId }
        : { status: "inactive" },
    };
  }
  let abandoned = null;
  let stageAbandonFailed = false;
  try {
    abandoned = abandonOpenWorkflowStage(sessionId, { at }, { env });
  } catch {
    // Deliberate best-effort: invalid persisted stage progress must never stop
    // SessionEnd from recording the run itself as abandoned.
    stageAbandonFailed = true;
  }
  const stageCapture = abandoned
    ? queueStage(abandoned.event, { env, sessionId })
    : null;
  const run = await finishRun(
    { sessionId, outcome: "abandoned", at },
    { env, timeoutMs },
  );
  return {
    run,
    ...(stageCapture === null ? {} : { stageCapture }),
    ...(stageAbandonFailed ? { stageAbandon: { status: "failed" } } : {}),
  };
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input || "{}");
  // Claude supplies the parent's session_id to hooks running inside subagents
  // and distinguishes those invocations with agent_id. A child teardown must
  // never abandon the parent workflow run.
  if (
    event?.hook_event_name !== "SessionEnd" ||
    Object.hasOwn(event, "agent_id")
  ) {
    return;
  }
  await finishWorkflowSession({
    sessionId: event.session_id,
    ...(typeof event.reason === "string" ? { reason: event.reason } : {}),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    /* Session shutdown must not be held open by capture delivery. */
  });
}
