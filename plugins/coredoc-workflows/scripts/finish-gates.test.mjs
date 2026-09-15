import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { finishWorkflowRun } from "./finish-run.mjs";
import { executeRoutedTask } from "./route-task.mjs";
import { workflowRunContext, workflowRunStatus } from "./run-status.mjs";
import { sessionStartOutput } from "./session-start.mjs";
import { runWorkflowStage } from "./stage-run.mjs";
import { COREDOC_STATUSES } from "./workflow-events.mjs";
import { lastRunHistory, readRunHistory } from "./workflow-gates.mjs";
import {
  appendWorkflowObservation,
  parkedRunDirectory,
  readWorkflowRun,
  startWorkflowRun,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-finish-gates";
const RUN_ID = "cdr-20260915-d4e5f6";
const PROJECT_KEY = "gates-fixture";
const DISABLED = { status: "disabled", durable: true, pending: 0 };
const NO_ARTIFACTS = async () => ({
  status: "disabled",
  queued: 0,
  sent: 0,
  pending: 0,
});

function testEnv(overrides = {}) {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(join(tmpdir(), "coredoc-finish-gates-")),
    COREDOC_WORKFLOWS_REPO_KEY: PROJECT_KEY,
    COREDOC_WORKFLOW_GATES: "enforce",
    ...overrides,
  };
}

function startRun(env, { bound = true, cwd = process.cwd(), runId = RUN_ID } = {}) {
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      repositoryKey: PROJECT_KEY,
      bound,
      projectKey: PROJECT_KEY,
      at: "2026-09-15T10:00:00.000Z",
      cwd,
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
        filesChanged: 0,
        trackedLinesAdded: 0,
        trackedLinesRemoved: 0,
      }),
    },
  );
}

function observeCoredoc(env, overrides) {
  return appendWorkflowObservation(
    SESSION_ID,
    {
      type: "coredoc",
      at: "2026-09-15T10:00:02.000Z",
      success: true,
      tool: "search_symbols",
      access: "read",
      result: "ok",
      ...overrides,
    },
    { env },
  );
}

function finish(env, input = {}, options = {}) {
  return finishWorkflowRun(
    {
      sessionId: SESSION_ID,
      outcome: "success",
      at: "2026-09-15T11:00:00.000Z",
      ...input,
    },
    {
      env,
      deliver: async () => DISABLED,
      checkpointArtifacts: NO_ARTIFACTS,
      ...options,
    },
  );
}

test("BR-3 refuses a successful finish whose Coredoc status resolves to not-assessed", async () => {
  const env = testEnv();
  startRun(env);
  observeCoredoc(env);
  await assert.rejects(
    () => finish(env),
    /coredoc-status resolved to not-assessed/,
  );
  // The run is still live: a refused finish never deletes the ledger.
  assert.equal(readWorkflowRun(SESSION_ID, { env }).runId, RUN_ID);
  assert.deepEqual(readRunHistory(PROJECT_KEY, { env }), []);
});

test("BR-3 accepts an explicit status, a signed skip, and an observed not_configured", async () => {
  const explicit = testEnv();
  startRun(explicit);
  observeCoredoc(explicit);
  const named = await finish(explicit, { coredocStatus: "partial" });
  assert.equal(named.status, "finished");
  assert.equal(named.event.summary.coredocStatus, "partial");
  assert.deepEqual(named.gates, [
    { stage: "finish", gate: "intent", result: "passed", reason: "coredoc-status partial" },
  ]);

  const skipped = testEnv();
  startRun(skipped);
  observeCoredoc(skipped);
  const signed = await finish(skipped, { skipIntentReason: "graph was offline" });
  assert.equal(signed.status, "finished");
  assert.equal(signed.event.summary.coredocStatus, "not-assessed");
  assert.deepEqual(signed.gates, [
    { stage: "finish", gate: "intent", result: "skipped", reason: "graph was offline" },
  ]);

  const unconfigured = testEnv();
  startRun(unconfigured);
  observeCoredoc(unconfigured, {
    tool: "get_intent_context",
    result: "not_configured",
  });
  const answered = await finish(unconfigured);
  assert.equal(answered.status, "finished");
  assert.equal(answered.event.summary.coredocStatus, "not-configured");
  assert.equal(answered.gates[0].result, "passed");
});

test("BR-3 records not-bound on an unbound checkout and never refuses there", async () => {
  const env = testEnv();
  startRun(env, { bound: false });
  observeCoredoc(env);
  const delivered = [];
  const finished = await finish(env, {}, {
    deliver: async (event) => {
      delivered.push(event);
      return DISABLED;
    },
  });
  assert.equal(finished.status, "finished");
  assert.equal(finished.event.summary.coredocStatus, "not-bound");
  assert.deepEqual(finished.gates, [
    { stage: "finish", gate: "intent", result: "not-bound" },
  ]);
  // The two new values are local vocabulary only: the capture event still
  // carries the outcome and the counters and nothing else (LIM-3).
  assert.ok(COREDOC_STATUSES.includes("not-bound"));
  assert.ok(COREDOC_STATUSES.includes("not-configured"));
  assert.equal(delivered.length, 1);
  assert.deepEqual(Object.keys(delivered[0].data).sort(), ["counters", "outcome"]);
  assert.equal(delivered[0].data.outcome, "success");
});

test("BR-3 warns instead of refusing in warn mode, and never refuses a non-success finish", async () => {
  const env = testEnv({ COREDOC_WORKFLOW_GATES: "warn" });
  startRun(env);
  observeCoredoc(env);
  const stderr = process.stderr.write;
  const printed = [];
  process.stderr.write = (text) => printed.push(text);
  let finished;
  try {
    finished = await finish(env);
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(finished.status, "finished");
  assert.equal(finished.gatesWarned, true);
  assert.deepEqual(finished.gates, [
    { stage: "finish", gate: "intent", result: "unmet" },
  ]);
  assert.match(printed[0], /coredoc-status resolved to not-assessed/);

  const failing = testEnv();
  startRun(failing);
  observeCoredoc(failing);
  const failed = await finish(failing, { outcome: "failed" });
  assert.equal(failed.status, "finished");
  assert.deepEqual(failed.gates, [
    { stage: "finish", gate: "intent", result: "unmet" },
  ]);
});

test("BR-6: the history line is written before the ledger is finalised", async () => {
  const env = testEnv();
  startRun(env);
  observeCoredoc(env);
  const order = [];
  await finish(
    env,
    { coredocStatus: "complete" },
    {
      finalize: (sessionId, runId) => {
        // The durable record is already written when the ledger is deleted.
        order.push("finalize");
        assert.equal(runId, RUN_ID);
        assert.equal(readWorkflowRun(SESSION_ID, { env }).runId, RUN_ID);
        return null;
      },
      appendHistory: (projectKey, line, options) => {
        order.push("history");
        assert.equal(projectKey, PROJECT_KEY);
        return line;
      },
    },
  );
  assert.deepEqual(order, ["history", "finalize"]);

  // With the real writers the line lands on disk with the run's gate outcomes.
  const real = testEnv();
  startRun(real);
  observeCoredoc(real);
  await finish(real, { coredocStatus: "complete" });
  const line = lastRunHistory(PROJECT_KEY, { env: real });
  assert.equal(line.runId, RUN_ID);
  assert.equal(line.intent, "change");
  assert.equal(line.workflowId, "change:normal");
  assert.equal(line.outcome, "success");
  assert.equal(line.finishedAt, "2026-09-15T11:00:00.000Z");
  assert.equal(line.coredocStatus, "complete");
  assert.deepEqual(line.gates, [
    { stage: "finish", gate: "intent", result: "passed", reason: "coredoc-status complete" },
  ]);
  // The ledger deletion itself is unchanged.
  assert.equal(readWorkflowRun(SESSION_ID, { env: real }), null);
});

test("AC-8: the next route reads back the previous run's unmet and skipped gates", async () => {
  const env = testEnv();
  startRun(env);
  observeCoredoc(env);
  await finish(env, { skipIntentReason: "graph was offline" });

  const routed = await executeRoutedTask(
    { intent: "change" },
    {
      env: { ...env, COREDOC_WORKFLOWS_SESSION_ID: SESSION_ID },
      cwd: process.cwd(),
      preflight: async () => {},
      recordCapture: async () => DISABLED,
      expireRuns: async () => [],
    },
  );
  assert.deepEqual(routed.previousRunGates, [
    {
      stage: "finish",
      gate: "intent",
      result: "skipped",
      reason: "graph was offline",
    },
  ]);
  // The route stored what the gates need to judge this run.
  const state = readWorkflowRun(SESSION_ID, { env });
  assert.equal(state.projectKey, PROJECT_KEY);
  assert.equal(state.repositoryKey, PROJECT_KEY);
  assert.equal(state.bound, false);
  assert.equal(state.specRef, undefined);
});

test("route-task records the binding and the specification artifact it was given", async () => {
  const env = testEnv();
  const repoRoot = mkdtempSync(join(tmpdir(), "coredoc-route-gates-"));
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(join(repoRoot, "docs", "spec.md"), "---\nstatus: draft\n---\n");
  const routed = await executeRoutedTask(
    { intent: "spec", specPath: "docs/spec.md" },
    {
      env: {
        ...env,
        COREDOC_WORKFLOWS_SESSION_ID: SESSION_ID,
        COREDOC_CAPTURE_WORKSPACE_ID: "ws-fixture",
      },
      cwd: repoRoot,
      preflight: async () => {},
      recordCapture: async () => DISABLED,
      expireRuns: async () => [],
    },
  );
  assert.equal(routed.runStateStatus, "started");
  const state = readWorkflowRun(SESSION_ID, { env });
  assert.equal(state.bound, true);
  assert.equal(state.repositoryKey, PROJECT_KEY);
  assert.equal(state.specRef, `${PROJECT_KEY}:docs/spec.md`);
});

test("route-task parks a run awaiting acceptance instead of overwriting it", async () => {
  const env = testEnv();
  const parkedRunId = "cdr-20260915-eeeeee";
  startRun(env, { runId: parkedRunId });
  // The shape `finish-run --outcome delivered-draft` leaves in the slot when a
  // resumable session exit re-suspended a reactivated acceptance run.
  const state = readWorkflowRun(SESSION_ID, { env });
  writeFileSync(
    join(
      env.COREDOC_WORKFLOWS_STATE_DIR,
      `${createHash("sha256").update(SESSION_ID).digest("hex")}.json`,
    ),
    `${JSON.stringify({
      ...state,
      status: "suspended",
      suspendedAt: "2026-09-15T10:30:00.000Z",
      capture: {},
      acceptance: {
        reason: "awaiting-acceptance",
        ttlDays: 14,
        parkedAt: "2026-09-15T10:30:00.000Z",
        originSessionId: SESSION_ID,
        capture: {},
        specRef: `${PROJECT_KEY}:docs/spec.md`,
      },
    })}\n`,
  );

  const routed = await executeRoutedTask(
    { intent: "change" },
    {
      env: { ...env, COREDOC_WORKFLOWS_SESSION_ID: SESSION_ID },
      cwd: process.cwd(),
      preflight: async () => {},
      recordCapture: async () => DISABLED,
      expireRuns: async () => [],
    },
  );
  assert.deepEqual(routed.parkedRun, {
    runId: parkedRunId,
    status: "parked",
    reason: "awaiting-acceptance",
  });
  assert.equal(routed.runStateStatus, "started");
  assert.ok(existsSync(parkedRunDirectory(PROJECT_KEY, parkedRunId, env)));
  assert.notEqual(readWorkflowRun(SESSION_ID, { env }).runId, parkedRunId);
});

test("AC-4d: a compacted session is re-anchored with the gate evidence on disk", async () => {
  const env = testEnv();
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "implement", after: [] }],
      repositoryKey: PROJECT_KEY,
      bound: true,
      projectKey: PROJECT_KEY,
      at: "2026-09-15T10:00:00.000Z",
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
        filesChanged: 0,
        trackedLinesAdded: 0,
        trackedLinesRemoved: 0,
      }),
    },
  );
  await runWorkflowStage(
    {
      action: "start",
      sessionId: SESSION_ID,
      stageId: "implement",
      at: "2026-09-15T10:00:01.000Z",
    },
    {
      env,
      idFactory: () => "11111111-1111-4111-8111-111111111111",
      deliver: async () => DISABLED,
    },
  );
  observeCoredoc(env, { at: "2026-09-15T10:00:02.000Z" });

  const output = sessionStartOutput(
    { hook_event_name: "SessionStart", session_id: SESSION_ID, source: "compact" },
    { env },
  );
  const context = JSON.parse(output).hookSpecificOutput.additionalContext;
  assert.ok(
    context.startsWith(
      "Coredoc workflows plugin (SessionStart hook) — this session's own recorded run state, not a new request:",
    ),
    context,
  );
  assert.ok(context.endsWith("Continue that run from this state."), context);
  assert.match(context, new RegExp(`run ${RUN_ID} `));
  assert.match(context, /Open stage: implement\./);
  assert.match(context, /mcp: satisfied/);
  assert.match(context, /intent: pending/);

  const status = workflowRunStatus(SESSION_ID, { env });
  assert.equal(status.openStage, "implement");
  assert.equal(status.openStageAttempt, 1);
  assert.deepEqual(status.gates, {
    // The open stage's own attempt, which is what its close will be judged on.
    scope: "stage",
    intent: "pending",
    candidates: "not-applicable",
    mcp: "satisfied",
  });
  assert.equal(status.bound, true);

  // The close after compaction is judged on exactly that evidence.
  const closed = await runWorkflowStage(
    {
      action: "finish",
      sessionId: SESSION_ID,
      stageId: "implement",
      outcome: "success",
      at: "2026-09-15T10:05:00.000Z",
    },
    { env, deliver: async () => DISABLED },
  );
  assert.equal(closed.status, "finished");
  assert.deepEqual(closed.gates, [
    {
      stage: "implement",
      gate: "candidates",
      result: "not-applicable",
      reason: "no specification artifact on the run",
    },
    // The read the status block reported as `mcp: satisfied` is the same
    // evidence BR-4's gate passes the close on.
    { stage: "implement", gate: "mcp", result: "passed", searches: 0, writes: 0 },
  ]);
});

test("run-status stays read-only and names the runs awaiting acceptance", () => {
  const env = testEnv();
  assert.deepEqual(workflowRunStatus("session-with-no-run", { env }), {
    status: "inactive",
  });
  assert.equal(
    workflowRunContext(workflowRunStatus("session-with-no-run", { env })),
    "",
  );
  const awaiting = {
    status: "inactive",
    awaitingAcceptance: [
      { runId: RUN_ID, parkedAt: "2026-09-15T10:00:00.000Z", ttlDays: 14, specRef: "r:docs/spec.md" },
    ],
  };
  const context = workflowRunContext(awaiting);
  assert.ok(
    context.startsWith("Coredoc workflows plugin (SessionStart hook) —"),
    context,
  );
  assert.match(context, new RegExp(`Awaiting acceptance on this checkout: ${RUN_ID}`));
  assert.match(context, /spec accept --path <spec>/);
  assert.ok(context.endsWith("Continue that run from this state."), context);
});
