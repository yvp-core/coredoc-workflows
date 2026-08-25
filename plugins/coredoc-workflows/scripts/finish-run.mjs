#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  COREDOC_GAP_CODES,
  COREDOC_STATUSES,
  FINDINGS_MEASUREMENTS,
  WORKFLOW_OUTCOMES,
  workflowEvent,
} from "./workflow-events.mjs";
import {
  deliverCaptureEvent,
  resolveWorkflowRuntime,
} from "./capture-client.mjs";
import { runConfiguredArtifactCheckpoint } from "./artifact-checkpoints.mjs";
import {
  abandonOpenWorkflowStage,
  completeWorkflowRun,
  finalizeWorkflowRun,
  hasWorkflowSessionAttribution,
  normalizedWorkflowSkillId,
} from "./workflow-run-state.mjs";

// The outcomes a caller of this command may record. `abandoned` is deliberately
// absent — only session teardown writes it, and it goes through the library.
export const CALLER_OUTCOMES = Object.freeze(
  WORKFLOW_OUTCOMES.filter((outcome) => outcome !== "abandoned"),
);

const VALUE_FLAGS = new Set([
  "outcome",
  "findings-measurement",
  "findings-initial",
  "findings-resolved",
  "findings-remaining",
  "findings-introduced",
  "coredoc-status",
  "coredoc-gap",
  "require-skill",
]);
const FINDING_KEYS = {
  "findings-initial": "findingsInitial",
  "findings-resolved": "findingsResolved",
  "findings-remaining": "findingsRemaining",
  "findings-introduced": "findingsIntroduced",
};

function parseCount(flag, value) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new Error(`--${flag} requires a non-negative integer`);
  }
  return Number(value);
}

export function parseFinishArgs(args) {
  const options = {
    findingsMeasurement: "not-measured",
    coredocGapCodes: [],
    requiredSkillIds: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--") || !VALUE_FLAGS.has(arg.slice(2))) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const name = arg.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    index += 1;
    if (name === "coredoc-gap") {
      options.coredocGapCodes.push(value);
    } else if (name === "require-skill") {
      if (!normalizedWorkflowSkillId(value)) {
        throw new Error("--require-skill requires a compact skill identifier");
      }
      options.requiredSkillIds.push(value);
    } else if (name in FINDING_KEYS) {
      options[FINDING_KEYS[name]] = parseCount(name, value);
    } else if (name === "findings-measurement") {
      options.findingsMeasurement = value;
    } else if (name === "coredoc-status") {
      options.coredocStatus = value;
    } else {
      options.outcome = value;
    }
  }

  // `abandoned` is reachable through the library, not this flag: session teardown
  // calls finishWorkflowRun directly. Accepting it here would let a caller record
  // a workflow that finished as one that was walked away from.
  if (!CALLER_OUTCOMES.includes(options.outcome)) {
    throw new Error(
      `--outcome must be one of: ${CALLER_OUTCOMES.join(", ")}`,
    );
  }
  if (!FINDINGS_MEASUREMENTS.includes(options.findingsMeasurement)) {
    throw new Error(
      `--findings-measurement must be one of: ${FINDINGS_MEASUREMENTS.join(", ")}`,
    );
  }
  if (
    options.coredocStatus !== undefined &&
    !COREDOC_STATUSES.includes(options.coredocStatus)
  ) {
    throw new Error(
      `--coredoc-status must be one of: ${COREDOC_STATUSES.join(", ")}`,
    );
  }
  if (
    options.coredocGapCodes.some(
      (code) => !COREDOC_GAP_CODES.includes(code),
    )
  ) {
    throw new Error(
      `--coredoc-gap must be one of: ${COREDOC_GAP_CODES.join(", ")}`,
    );
  }
  return options;
}

function observedSkillIds(summary) {
  return new Set(
    (Array.isArray(summary?.skillsUsed) ? summary.skillsUsed : [])
      .map(({ name }) => normalizedWorkflowSkillId(name))
      .filter(Boolean),
  );
}

function assertRequiredSkills(finished, outcome, requiredSkillIds) {
  const observed = observedSkillIds(finished.summary);
  const automatic =
    outcome === "success" &&
    finished.state.stageCaptureVersion !== 1 &&
    Array.isArray(finished.state.requiredSkills)
      ? finished.state.requiredSkills
      : [];

  for (const skillId of automatic) {
    const normalized = normalizedWorkflowSkillId(skillId);
    if (normalized && !observed.has(normalized)) {
      throw new Error(
        `stage ${skillId} was routed but never executed; complete it and re-run finish`,
      );
    }
  }
  for (const skillId of requiredSkillIds) {
    const normalized = normalizedWorkflowSkillId(skillId);
    if (!normalized || !observed.has(normalized)) {
      throw new Error(
        `required skill ${skillId} was never executed; complete it and re-run finish`,
      );
    }
  }
}

function openCapturedStage(finished) {
  const { state } = finished;
  if (state.stageCaptureVersion !== 1) return undefined;
  return Object.values(state.stageProgress ?? {}).find(
    (occurrence) => occurrence.finishedAt === undefined,
  );
}

function assertCapturedStages(finished, outcome) {
  const { state } = finished;
  if (state.stageCaptureVersion !== 1) return;
  const progress = state.stageProgress ?? {};
  const open = openCapturedStage(finished);
  // Only a successful finish claims the routed stages were all completed, so
  // only it fails closed on an open stage. A non-success finish records the
  // crashed occurrence as abandoned instead — refusing it would leave the run
  // active forever with no caller-reachable recovery.
  if (open && outcome === "success") {
    throw new Error(
      `stage ${open.stageId} is still open; finish it before finishing the run`,
    );
  }
  if (outcome !== "success") return;

  for (const declared of state.declaredStages ?? []) {
    const latest = Object.hasOwn(progress, declared.stageId)
      ? progress[declared.stageId]
      : undefined;
    if (latest?.finishedAt !== undefined && latest.outcome === "success") {
      continue;
    }
    throw new Error(
      `stage ${declared.stageId} has not finished successfully${
        latest?.outcome === undefined
          ? ""
          : `; latest outcome is ${latest.outcome}`
      }`,
    );
  }
}

// A non-success finish closes the crashed occurrence with the same semantics
// and event as session teardown. Delivery and persistence are best-effort: a
// stage bookkeeping failure must not keep the run itself open.
async function abandonOpenStage({
  sessionId,
  at,
  env,
  timeoutMs,
  abandonStage,
  deliver,
}) {
  let abandoned;
  try {
    abandoned = abandonStage(sessionId, { at }, { env });
  } catch {
    // Deliberate best-effort: invalid persisted stage progress still finishes.
    return { status: "failed" };
  }
  if (!abandoned?.event) return { status: "failed" };
  const capture = await deliver(abandoned.event, {
    env,
    sessionId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { status: "abandoned", stageId: abandoned.occurrence.stageId, capture };
}

export async function finishWorkflowRun(
  {
    sessionId,
    outcome,
    findingsMeasurement = "not-measured",
    findingsInitial,
    findingsResolved,
    findingsRemaining,
    findingsIntroduced,
    coredocStatus,
    coredocGapCodes = [],
    requiredSkillIds = [],
    at = new Date().toISOString(),
  },
  {
    env = process.env,
    cwd = process.cwd(),
    timeoutMs,
    now = Date.now,
    complete = completeWorkflowRun,
    checkpointArtifacts = runConfiguredArtifactCheckpoint,
    deliver = deliverCaptureEvent,
    finalize = finalizeWorkflowRun,
    abandonStage = abandonOpenWorkflowStage,
  } = {},
) {
  const finished = complete(sessionId, {
    env,
    at,
    requiredSkills: requiredSkillIds,
  });
  if (!finished) {
    if (!hasWorkflowSessionAttribution(sessionId)) {
      return { status: "unattributed" };
    }
    if (outcome === "success") {
      throw new Error(
        "active workflow run state is missing or no longer active; route again instead of rerunning stages blindly",
      );
    }
    if (requiredSkillIds.length > 0) {
      throw new Error(
        "active workflow run state is missing or no longer active; route again before verifying required skills",
      );
    }
    return { status: "inactive" };
  }
  assertCapturedStages(finished, outcome);
  assertRequiredSkills(finished, outcome, requiredSkillIds);
  const stageAbandon = openCapturedStage(finished)
    ? await abandonOpenStage({
        sessionId,
        at,
        env,
        timeoutMs,
        abandonStage,
        deliver,
      })
    : undefined;
  const summary = {
    outcome,
    ...finished.summary,
    findingsMeasurement,
    findingsInitial,
    findingsResolved,
    findingsRemaining,
    findingsIntroduced,
    coredocStatus:
      coredocStatus ??
      (finished.summary.coredocCalls === 0 ? "not-used" : "not-assessed"),
    coredocGapCodes,
  };
  const event = workflowEvent({
    at,
    runId: finished.state.runId,
    workflowId: finished.state.workflowId,
    type: "workflow.finished",
    intent: finished.state.intent,
    risk: finished.state.risk,
    summary,
  });
  const captureEvent = {
    ...(finished.state.captureSchemaVersion === 2
      ? { schemaVersion: 2 }
      : {}),
    occurredAt: at,
    type: "workflow.run.finished",
    runId: finished.state.runId,
    data: {
      outcome,
      counters: {
        editCalls: finished.summary.editCalls,
        editVerifyRounds: finished.summary.editVerifyRounds,
        verificationRuns: finished.summary.verificationRuns,
        verificationFailures: finished.summary.verificationFailures,
        verificationPasses: finished.summary.verificationPasses,
        coredocCalls: finished.summary.coredocCalls,
        coredocFailures: finished.summary.coredocFailures,
      },
    },
  };
  let artifacts;
  try {
    artifacts = await checkpointArtifacts({
      env,
      cwd,
      checkpoint: outcome === "abandoned" ? "session-end" : "run-finish",
      runId: finished.state.runId,
      flush: false,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(outcome === "abandoned" && timeoutMs !== undefined
        ? { deadlineAt: now() + timeoutMs }
        : {}),
    });
  } catch {
    artifacts = {
      status: "failed",
      queued: 0,
      sent: 0,
      pending: 0,
      errorCode: "CONFIG_CONFLICT",
    };
  }
  const capture = await deliver(captureEvent, {
    env,
    sessionId,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  // Capture is fail-open: delivery state must never keep the completed local
  // workflow active and block the next route in the same host session.
  finalize(sessionId, finished.state.runId, { env });
  return {
    status: "finished",
    event,
    capture,
    artifacts,
    ...(stageAbandon === undefined ? {} : { stageAbandon }),
    pending:
      capture.status === "pending" ||
      capture.durable !== true ||
      artifacts.pending > 0,
    // The finished run is the last moment a caller is still able to judge the
    // graph tools it used. `abandoned` is written by session teardown, when no
    // caller is left to judge anything, so it never owes feedback.
    feedbackOwed: outcome !== "abandoned" && finished.summary.coredocCalls > 0,
  };
}

async function main() {
  const options = parseFinishArgs(process.argv.slice(2));
  const runtime = resolveWorkflowRuntime();
  const result = await finishWorkflowRun(
    { sessionId: runtime.sessionId, ...options },
    { env: runtime.env },
  );
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.status === "unattributed") process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
