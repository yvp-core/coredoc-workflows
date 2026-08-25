#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { abandonOpenWorkflowStage } from "./workflow-run-state.mjs";

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
  },
  {
    env = process.env,
    timeoutMs = 750,
    queueStage = queueStageCapture,
    finishRun = finishWorkflowRun,
  } = {},
) {
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
  if (event?.hook_event_name !== "SessionEnd") return;
  await finishWorkflowSession({ sessionId: event.session_id });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    /* Session shutdown must not be held open by capture delivery. */
  });
}
