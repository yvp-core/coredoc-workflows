#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { resolveWorkflowRuntime } from "./capture-client.mjs";
import {
  hasWorkflowSessionAttribution,
  isLiveWorkflowRun,
  readWorkflowRun,
} from "./workflow-run-state.mjs";

/** Read-only: never resumes, locks, or writes, so it is safe at any moment. */
export function workflowRunStatus(sessionId, { env = process.env } = {}) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }
  const state = readWorkflowRun(sessionId, { env });
  if (!isLiveWorkflowRun(state)) return { status: "inactive" };
  const progress =
    state.stageProgress && typeof state.stageProgress === "object"
      ? state.stageProgress
      : {};
  const stages = Array.isArray(state.declaredStages)
    ? state.declaredStages.map(({ stageId }) => {
        const occurrence = progress[stageId];
        if (!occurrence) return { stageId, status: "pending" };
        return {
          stageId,
          status:
            occurrence.finishedAt === undefined ? "open" : occurrence.outcome,
          attempt: occurrence.attempt,
        };
      })
    : [];
  const open = stages.find((stage) => stage.status === "open");
  return {
    status: state.status,
    runId: state.runId,
    workflowId: state.workflowId,
    intent: state.intent,
    risk: state.risk,
    startedAt: state.startedAt,
    ...(state.suspendedAt === undefined ? {} : { suspendedAt: state.suspendedAt }),
    ...(open === undefined ? {} : { openStage: open.stageId }),
    stages,
  };
}

/** One paragraph re-anchoring a resumed or compacted session; empty without a live run. */
export function workflowRunContext(status) {
  if (!isLiveWorkflowRun(status)) return "";
  const closed = status.stages
    .filter((stage) => stage.status !== "pending" && stage.status !== "open")
    .map((stage) => `${stage.stageId}=${stage.status}`);
  const pending = status.stages
    .filter((stage) => stage.status === "pending")
    .map((stage) => stage.stageId);
  return [
    `Coredoc workflow run ${status.runId} (${status.workflowId}) is ${status.status} in this session.`,
    status.openStage === undefined
      ? "No stage is open."
      : `Open stage: ${status.openStage}.`,
    closed.length > 0 ? `Closed stages: ${closed.join(", ")}.` : "",
    pending.length > 0 ? `Not started: ${pending.join(", ")}.` : "",
    "Do not run route-task again; continue with coredoc-workflows stage-run and finish-run. Run `coredoc-workflows run-status` whenever unsure.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function main() {
  const runtime = resolveWorkflowRuntime();
  const result = workflowRunStatus(runtime.sessionId, { env: runtime.env });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
