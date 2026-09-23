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
import { captureIdentityEnv, runCaptureEnv } from "./capture-identity.mjs";
import {
  captureStateRecorder,
  foldCaptureState,
  relayHealth,
  undeliveredCaptureNotice,
} from "./capture-state.mjs";

import { runConfiguredArtifactCheckpoint } from "./artifact-checkpoints.mjs";
import {
  normalizedSpecPath,
  readSpecArtifact,
  removeSpecArtifactKey,
  specAbsolutePath,
  specRefFor,
  writeSpecArtifactKey,
} from "./spec-artifact.mjs";
import {
  appendRunHistory,
  applyGates,
  hasUndeliveredCapture,
  lastRunAddendum,
  evaluateFinishGate,
  gateMode,
  recordAbandonedStageGates,
  resolveCoredocStatus,
  runIsBound,
  skipReason,
} from "./workflow-gates.mjs";
import {
  abandonOpenWorkflowStage,
  completeWorkflowRun,
  finalizeWorkflowRun,
  hasWorkflowSessionAttribution,
  normalizedWorkflowSkillId,
  liveWorkflowRun,
  parkWorkflowRun,
  readWorkflowObservations,
  readWorkflowRun,
  terminateRun,
  workflowRunGates,
} from "./workflow-run-state.mjs";

// The outcomes a caller of this command may record. `abandoned` is deliberately
// absent — only session teardown writes it, and it goes through the library.
// `delivered-draft` is local-only: it parks a standalone specification run to
// wait for the user's acceptance (BR-5) and sends no capture event, so it is
// deliberately absent from the contract's outcomes.
export const PARKED_OUTCOME = "delivered-draft";
export const CALLER_OUTCOMES = Object.freeze([
  ...WORKFLOW_OUTCOMES.filter((outcome) => outcome !== "abandoned"),
  PARKED_OUTCOME,
]);
export const ACCEPTANCE_TTL_DAYS = 14;

// BR-5 — a run awaiting acceptance has exactly two successful ends, and this
// command is neither: `spec accept --finish` writes the draft -> accepted
// transition once the specification's own intent is accepted. Finishing it here would
// close the run, delete its state and leave the specification a draft pointing
// at a run that no longer exists. Not a gate: no mode relaxes it, because it is
// the wrong terminal path rather than missing evidence.
export const ACCEPTANCE_REFUSAL_CODE = "acceptance-run-not-finishable";
export const ACCEPTANCE_REFUSAL = `${ACCEPTANCE_REFUSAL_CODE}: this run is a standalone specification awaiting acceptance: close it with \`coredoc-workflows spec accept --finish\` or \`spec abandon --reason "<text>"\`; \`--outcome failed|blocked\` records the unmet gates and removes the specification's run pointer.`;

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
  "spec-path",
  "skip-intent",
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
    } else if (name === "spec-path") {
      options.specPath = value;
    } else if (name === "skip-intent") {
      options.skipIntentReason = skipReason("skip-intent", value);
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
  projectKey,
  historyEnv,
  deliverEnv,
  deliverSessionId,
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
    env: deliverEnv,
    sessionId: deliverSessionId,
    createRecorder: captureStateRecorder({ projectKey, env: historyEnv }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { status: "abandoned", stageId: abandoned.occurrence.stageId, capture };
}

/**
 * One durable line per run, in the checkout's own history, written before the
 * ledger is deleted. Bookkeeping never blocks a finish: a run routed before
 * gates existed has no project key and simply records nothing.
 */
function recordRunHistory(state, line, { env, appendHistory }) {
  if (state.projectKey === undefined) return undefined;
  try {
    // The run's delivery state joins its history line here (issue 05): the
    // file is keyed by run id, so a retry from another session has already
    // updated it by the time the run is closed.
    const capture = foldCaptureState(state.projectKey, state.runId, { env });
    return appendHistory(
      state.projectKey,
      {
        runId: state.runId,
        intent: state.intent,
        workflowId: state.workflowId,
        ...(state.specRef === undefined ? {} : { specRef: state.specRef }),
        ...line,
        ...(capture === undefined ? {} : { capture }),
      },
      { env },
    );
  } catch {
    // Deliberate fail-open: an unwritable history must not keep the run open.
    return undefined;
  }
}

function parkedCoredocStatus(state, observations) {
  return resolveCoredocStatus({
    bound: state.bound,
    coredocCalls: observations.filter((event) => event.type === "coredoc").length,
    observations,
  });
}

/** The specification this run is about, from `--spec-path` or from the route. */
export function runSpecRef(state, specPath) {
  if (specPath === undefined) return state.specRef;
  return specRefFor(
    state.repositoryKey,
    normalizedSpecPath(specPath, state.repoRoot),
  );
}

/**
 * BR-5 — a standalone specification run that delivered a draft is parked, not
 * finished. The run keeps its observations and its capture identity, the spec
 * carries the pointer back to it, the session slot is freed, and NO capture
 * event is sent: `delivered-draft` is a local, non-terminal transition.
 */
async function parkDeliveredDraft(
  { sessionId, specPath, at },
  { env, historyEnv, park, appendHistory, readObservations },
) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }
  const state = liveWorkflowRun(sessionId, { env });
  if (!state) return { status: "inactive", ...lastRunAddendum({ env: historyEnv }) };
  if (state.intent !== "spec") {
    throw new Error(
      `--outcome ${PARKED_OUTCOME} is only for a standalone spec run; this run's intent is ${state.intent}`,
    );
  }
  const specRef = runSpecRef(state, specPath);
  if (specRef === undefined) {
    throw new Error(
      `--outcome ${PARKED_OUTCOME} requires --spec-path <repository-relative path> to the delivered draft`,
    );
  }
  const absolute = specAbsolutePath(specRef, { repoRoot: state.repoRoot });
  const artifact = readSpecArtifact(absolute);
  if (artifact === undefined) {
    throw new Error(`the specification ${specRef} does not exist at ${absolute}`);
  }
  if (artifact.status !== "draft") {
    throw new Error(
      `the specification ${specRef} is ${artifact.status ?? "unstated"}, not draft; finish the run instead of parking it`,
    );
  }
  const parked = park(
    sessionId,
    {
      runId: state.runId,
      reason: "awaiting-acceptance",
      ttlDays: ACCEPTANCE_TTL_DAYS,
      specRef,
      capture: captureIdentityEnv(env),
      at,
    },
    { env },
  );
  if (!parked) {
    return {
      status: "inactive",
      ...lastRunAddendum({ env: historyEnv, projectKey: state.projectKey }),
    };
  }
  // The pointer the later `spec accept` follows back to this run, written only
  // once the run is actually parked. `spec accept` also finds the run by its
  // `specRef`, so a document that could not be updated is still recoverable.
  const pointed = writeSpecArtifactKey(absolute, "run", state.runId);
  const history = recordRunHistory(
    { ...state, specRef },
    {
      outcome: "pending-acceptance",
      finishedAt: at,
      coredocStatus: parkedCoredocStatus(state, readObservations(sessionId, { env })),
      gates: workflowRunGates(state),
    },
    { env: historyEnv, appendHistory },
  );
  return {
    status: "pending-acceptance",
    runId: state.runId,
    specRef,
    ttlDays: ACCEPTANCE_TTL_DAYS,
    ...(pointed ? {} : { specPointer: "not-written" }),
    acceptWith: `coredoc-workflows spec accept --path ${specRef.slice(specRef.indexOf(":") + 1)}`,
    ...(history === undefined ? {} : { history }),
  };
}

/**
 * The terminal end of an acceptance run closed as `failed` or `blocked`: the
 * run and its parked directory go together, and the specification stops
 * pointing at a run that no longer exists.
 */
function terminateAcceptanceRun(state, sessionId, { env, cwd }) {
  const specRef = state.specRef ?? state.acceptance?.specRef;
  if (specRef !== undefined) {
    removeSpecArtifactKey(
      specAbsolutePath(specRef, { repoRoot: state.repoRoot, cwd }),
      "run",
    );
  }
  return terminateRun(sessionId, state.runId, {
    env,
    ...(state.projectKey === undefined ? {} : { projectKey: state.projectKey }),
  });
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
    specPath,
    skipIntentReason,
    at = new Date().toISOString(),
  },
  {
    env = process.env,
    cwd = process.cwd(),
    stderr = process.stderr,
    timeoutMs,
    now = Date.now,
    complete = completeWorkflowRun,
    checkpointArtifacts = runConfiguredArtifactCheckpoint,
    deliver = deliverCaptureEvent,
    finalize = finalizeWorkflowRun,
    abandonStage = abandonOpenWorkflowStage,
    park = parkWorkflowRun,
    appendHistory = appendRunHistory,
    readObservations = readWorkflowObservations,
    // The parked-run sweep addresses a run through its own directory; the
    // durable history still belongs to the checkout, never inside the run.
    historyEnv = env,
    historyOutcome,
    historyReason,
    // BR-3 belongs to `finish-run`; BR-5's acceptance finish is the
    // acceptance itself and passes false.
    assessCoredocStatus = true,
    // Set only by `spec-acceptance.mjs`, the one caller allowed to end a run
    // that is awaiting acceptance.
    acceptanceTerminal = false,
  } = {},
) {
  if (outcome === PARKED_OUTCOME) {
    return parkDeliveredDraft(
      { sessionId, specPath, at },
      { env, historyEnv, park, appendHistory, readObservations },
    );
  }
  const finished = complete(sessionId, {
    env,
    at,
    requiredSkills: requiredSkillIds,
    // Measurement failures must not strand failed, blocked or abandoned runs.
    allowUnavailableRepositories: outcome !== "success",
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
    return { status: "inactive", ...lastRunAddendum({ env: historyEnv, cwd }) };
  }
  assertCapturedStages(finished, outcome);
  assertRequiredSkills(finished, outcome, requiredSkillIds);
  const { state } = finished;
  // The generic finish of an acceptance run: `success` is refused outright, and
  // `failed`/`blocked` are allowed but routed through the acceptance terminal
  // path below, so the run leaves no dangling `run:` pointer behind.
  const acceptanceClose = !acceptanceTerminal && state.acceptance !== undefined;
  if (acceptanceClose && outcome === "success") {
    throw new Error(ACCEPTANCE_REFUSAL);
  }
  const resolvedCoredocStatus = resolveCoredocStatus({
    explicit: coredocStatus,
    bound: state.bound,
    coredocCalls: finished.summary.coredocCalls,
    observations: readObservations(sessionId, { env }),
  });
  const gated = applyGates(
    assessCoredocStatus
      ? [
          evaluateFinishGate({
            coredocStatus: resolvedCoredocStatus,
            bound: runIsBound(state),
            ...(skipIntentReason === undefined ? {} : { reason: skipIntentReason }),
          }),
        ]
      : [],
    { outcome, bound: runIsBound(state), mode: gateMode(env) },
  );
  if (gated.refusal !== undefined) throw new Error(gated.refusal);
  // A run parked for acceptance is recorded under the session that started it:
  // the server rejects a `workflow.run.finished` whose session is not the one
  // that opened the run.
  const deliverSessionId = state.acceptance?.originSessionId ?? sessionId;
  const deliverEnv = state.acceptance?.capture
    ? runCaptureEnv(env, state.acceptance.capture)
    : env;
  const openStage = openCapturedStage(finished);
  // AC-7: a non-success finish abandons the open occurrence; its gates are
  // recorded as unmet first, so the history line below carries them.
  if (openStage) recordAbandonedStageGates(sessionId, { env, cwd, at });
  const stageAbandon = openStage
    ? await abandonOpenStage({
        sessionId,
        at,
        env,
        projectKey: state.projectKey,
        historyEnv,
        deliverEnv,
        deliverSessionId,
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
    coredocStatus: resolvedCoredocStatus,
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
    env: deliverEnv,
    sessionId: deliverSessionId,
    // The delivery identity is the run's own (BR-5); the state file it updates
    // belongs to the checkout's history, so it is keyed by `historyEnv`.
    createRecorder: captureStateRecorder({
      projectKey: state.projectKey,
      env: historyEnv,
      cwd,
    }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  // The gate outcomes outlive the ledger (BR-6): the history line is written
  // before the finalize that deletes the run state and its observations.
  const history = recordRunHistory(
    state,
    {
      outcome: historyOutcome ?? outcome,
      finishedAt: at,
      ...(historyReason === undefined ? {} : { reason: historyReason }),
      coredocStatus: resolvedCoredocStatus,
      // Re-read: an abandoned open stage recorded its gates on the run after
      // `complete` took this snapshot.
      gates: [
        ...workflowRunGates(readWorkflowRun(sessionId, { env }) ?? state),
        ...gated.results,
      ],
    },
    { env: historyEnv, appendHistory },
  );
  // Loud fail-open (issue 05): the run closes either way, but never silently
  // when its own events are still sitting in the outbox.
  const captureNotice = hasUndeliveredCapture(history)
    ? undeliveredCaptureNotice(history.capture, {
        relay: relayHealth({ env: deliverEnv, cwd }),
      })
    : "";
  if (captureNotice !== "") stderr.write(`${captureNotice}\n`);
  // Capture is fail-open: delivery state must never keep the completed local
  // workflow active and block the next route in the same host session.
  if (acceptanceClose) {
    terminateAcceptanceRun(state, sessionId, { env, cwd });
  } else {
    finalize(sessionId, finished.state.runId, { env });
  }
  return {
    status: "finished",
    ...(finished.repositoryMeasurement ? { repositoryMeasurement: finished.repositoryMeasurement } : {}),
    ...(captureNotice === "" ? {} : { captureNotice }),
    event,
    capture,
    artifacts,
    ...(gated.results.length === 0 ? {} : { gates: gated.results }),
    ...(gated.warned === undefined ? {} : { gatesWarned: true }),
    ...(history === undefined ? {} : { history }),
    ...(stageAbandon === undefined ? {} : { stageAbandon }),
    pending:
      capture.status === "pending" ||
      capture.durable !== true ||
      artifacts.pending > 0,
    // The finished run is the last moment a caller is still able to judge the
    // session: the route, the skills, the task context, and any graph tools it
    // used. `abandoned` is written by session teardown, when no caller is left
    // to judge anything, so it never owes feedback. `feedbackScope` says
    // whether graph-tool judgment belongs in the record at all.
    feedbackOwed: outcome !== "abandoned",
    ...(outcome === "abandoned"
      ? {}
      : { feedbackScope: finished.summary.coredocCalls > 0 ? "graph+session" : "session" }),
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
