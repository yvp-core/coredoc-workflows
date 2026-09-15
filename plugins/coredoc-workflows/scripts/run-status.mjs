#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  createConfiguredCaptureRecorder,
  resolveWorkflowRuntime,
} from "./capture-client.mjs";
import {
  captureStateSummary,
  readCaptureState,
} from "./capture-state.mjs";
import { resolveProjectKey } from "./project-key.mjs";
import { readSpecArtifact, specAbsolutePath } from "./spec-artifact.mjs";
import { gateEvidence, lastRunHistory } from "./workflow-gates.mjs";
import {
  hasWorkflowSessionAttribution,
  isLiveWorkflowRun,
  listParkedWorkflowRuns,
  openStageId,
  readWorkflowObservations,
  readWorkflowRun,
} from "./workflow-run-state.mjs";

// The checkout's durable facts: which runs are parked waiting for an
// acceptance, and what the last finished run left unresolved. Both are read
// under the project key, which a live run carries and which a session without
// one still resolves from its working directory.
function checkoutContext(state, { env, cwd }) {
  let projectKey = state?.projectKey;
  try {
    projectKey ??= resolveProjectKey(cwd, env);
  } catch {
    return {};
  }
  const awaitingAcceptance = listParkedWorkflowRuns({ env, projectKey }).map(
    (run) => ({
      runId: run.runId,
      parkedAt: run.parkedAt,
      ttlDays: run.ttlDays,
      ...(run.specRef === undefined ? {} : { specRef: run.specRef }),
    }),
  );
  const lastRun = lastRunHistory(projectKey, { env });
  return {
    ...(awaitingAcceptance.length === 0 ? {} : { awaitingAcceptance }),
    ...(lastRun === undefined ? {} : { lastRun }),
    ...deliverySection(projectKey, lastRun, { env, cwd }),
  };
}

/**
 * What this checkout can say about capture delivery without asking the cloud
 * (issue 05): the last run's own event states and the outbox depth for the
 * current binding. Read-only, and silent about anything it cannot read.
 */
function deliverySection(projectKey, lastRun, { env, cwd }) {
  // The live state file wins over the folded history line: a `retry-pending`
  // from another session updates the file, never the line it was folded into.
  const events =
    lastRun === undefined
      ? []
      : (() => {
          const live = readCaptureState(projectKey, lastRun.runId, { env });
          return live.length > 0
            ? live
            : Array.isArray(lastRun.capture)
              ? lastRun.capture
              : [];
        })();
  let outbox;
  try {
    outbox = createConfiguredCaptureRecorder({ env, cwd }).health();
  } catch {
    // An unconfigured or unreadable binding has no depth to report.
  }
  const delivery = {
    ...(lastRun === undefined || events.length === 0
      ? {}
      : { runId: lastRun.runId, ...captureStateSummary(events) }),
    ...(outbox === undefined ||
    (outbox.pendingCount === 0 && outbox.errorCode === null)
      ? {}
      : {
          outbox: {
            pending: outbox.pendingCount,
            errorCode: outbox.errorCode,
          },
        }),
  };
  // Silence beats an empty section: nothing to report is not a delivery fact.
  return Object.keys(delivery).length === 0 ? {} : { delivery };
}

/** Read-only: never resumes, locks, or writes, so it is safe at any moment. */
export function workflowRunStatus(
  sessionId,
  { env = process.env, cwd = process.cwd() } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }
  const state = readWorkflowRun(sessionId, { env });
  if (!isLiveWorkflowRun(state)) {
    return { status: "inactive", ...checkoutContext(state, { env, cwd }) };
  }
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
  const openStage = openStageId(state);
  // BR-7: the gate evidence is rebuilt from disk, never remembered. A stage in
  // progress is judged on its own attempt, exactly as its close will be.
  const observations = readWorkflowObservations(sessionId, {
    env,
    ...(openStage === undefined ? {} : { stageId: openStage }),
  });
  return {
    status: state.status,
    runId: state.runId,
    workflowId: state.workflowId,
    intent: state.intent,
    risk: state.risk,
    startedAt: state.startedAt,
    ...(state.suspendedAt === undefined ? {} : { suspendedAt: state.suspendedAt }),
    ...(open === undefined
      ? {}
      : { openStage: open.stageId, openStageAttempt: open.attempt }),
    ...(state.specRef === undefined ? {} : { specRef: state.specRef }),
    ...(state.bound === undefined ? {} : { bound: state.bound }),
    ...(state.acceptance === undefined
      ? {}
      : { awaitingAcceptanceSince: state.acceptance.parkedAt }),
    gates: {
      // Without an open stage the evidence spans the whole run, so a read made
      // in an earlier stage must not read as the next close's verdict: that
      // close is judged on its own attempt only (LIM-1).
      scope: openStage === undefined ? "run" : "stage",
      ...gateEvidence(observations, {
        spec:
          state.specRef === undefined
            ? undefined
            : readSpecArtifact(
                specAbsolutePath(state.specRef, {
                  repoRoot: state.repoRoot,
                  cwd,
                }),
              ),
      }),
    },
    stages,
    ...checkoutContext(state, { env, cwd }),
  };
}

function acceptanceSentence(status) {
  const awaiting = status?.awaitingAcceptance ?? [];
  if (awaiting.length === 0) return "";
  return `Awaiting acceptance on this checkout: ${awaiting
    .map((run) => `${run.runId}${run.specRef === undefined ? "" : ` (${run.specRef})`}`)
    .join(", ")}. Accept with \`coredoc-workflows spec accept --path <spec>\`.`;
}

// The block is injected by a hook, so the model meets it with no author. On a
// real `--resume` an unattributed paragraph was read as an untrusted
// system-reminder and ignored, which is the one failure BR-7 cannot afford: it
// says who wrote it, that it is this session's own recorded state rather than a
// new request, and what to do with it.
const CONTEXT_ORIGIN =
  "Coredoc workflows plugin (SessionStart hook) — this session's own recorded run state, not a new request:";
const CONTEXT_CLOSING = "Continue that run from this state.";

/** One paragraph re-anchoring a resumed or compacted session; empty without a live run. */
export function workflowRunContext(status) {
  if (!isLiveWorkflowRun(status)) {
    const awaiting = acceptanceSentence(status);
    return awaiting === "" ? "" : `${CONTEXT_ORIGIN} ${awaiting} ${CONTEXT_CLOSING}`;
  }
  const closed = status.stages
    .filter((stage) => stage.status !== "pending" && stage.status !== "open")
    .map((stage) => `${stage.stageId}=${stage.status}`);
  const pending = status.stages
    .filter((stage) => stage.status === "pending")
    .map((stage) => stage.stageId);
  return [
    CONTEXT_ORIGIN,
    `workflow run ${status.runId} (${status.workflowId}) is ${status.status} in this session.`,
    status.openStage === undefined
      ? "No stage is open."
      : `Open stage: ${status.openStage}.`,
    closed.length > 0 ? `Closed stages: ${closed.join(", ")}.` : "",
    pending.length > 0 ? `Not started: ${pending.join(", ")}.` : "",
    status.specRef === undefined ? "" : `Specification: ${status.specRef}.`,
    status.gates === undefined
      ? ""
      : `Gate evidence ${status.gates.scope === "run" ? "across the run so far (no stage is open, so the next close is judged on its own attempt)" : "in the open attempt"}: intent: ${status.gates.intent}, candidates: ${status.gates.candidates}, mcp: ${status.gates.mcp}.`,
    status.lastRun === undefined
      ? ""
      : `Previous run ${status.lastRun.runId} finished ${status.lastRun.outcome}.`,
    acceptanceSentence(status),
    // A run awaiting acceptance has its own two ends (BR-5); pointing a
    // recovering session at `finish-run` sends it to the one command that
    // refuses the close and, before that refusal existed, destroyed the run.
    status.awaitingAcceptanceSince === undefined
      ? "Do not run route-task again; continue with coredoc-workflows stage-run and finish-run. Run `coredoc-workflows run-status` whenever unsure."
      : 'Do not run route-task again and do not finish this run with finish-run: it is a standalone specification awaiting acceptance, so close it with `coredoc-workflows spec accept --finish` (after the intent_propose) or `coredoc-workflows spec abandon --reason "<text>"`. Run `coredoc-workflows run-status` whenever unsure.',
    CONTEXT_CLOSING,
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
