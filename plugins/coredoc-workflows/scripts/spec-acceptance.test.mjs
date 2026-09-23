import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { abandonExpiredWorkflowRuns } from "./expired-runs.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { finishWorkflowSession } from "./session-end.mjs";
import { readSpecArtifact } from "./spec-artifact.mjs";
import { lastRunHistory, readRunHistory } from "./workflow-gates.mjs";
import {
  appendWorkflowObservation,
  claimExpiredWorkflowRun,
  listParkedWorkflowRuns,
  parkWorkflowRun,
  parkedRunDirectory,
  parkedRunEnv,
  readWorkflowObservations,
  readWorkflowRun,
  startWorkflowRun,
  startWorkflowStage,
} from "./workflow-run-state.mjs";
import { runWorkflowStage } from "./stage-run.mjs";
import { workflowRunContext, workflowRunStatus } from "./run-status.mjs";
import {
  abandonSpecification,
  acceptSpecification,
  finishAcceptedSpecification,
  parseSpecArgs,
} from "./spec-acceptance.mjs";

const SESSION_A = "session-spec-a";
const RUN_A = "cdr-20260915-a1b2c3";
const RUN_B = "cdr-20260915-b2c3d4";
const PROJECT_KEY = "gates-fixture";
const SPEC_PATH = "docs/spec.md";
const SPEC_REF = `${PROJECT_KEY}:${SPEC_PATH}`;
const DRAFT = "---\nsize: m\nstatus: draft\n---\n\n# Standalone specification\n";

function harness({ gates = "enforce" } = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "coredoc-spec-accept-repo-"));
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-spec-accept-"),
    ),
    COREDOC_WORKFLOWS_REPO_KEY: PROJECT_KEY,
    COREDOC_CAPTURE_WORKSPACE_ID: "ws-fixture",
    COREDOC_WORKFLOW_GATES: gates,
  };
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  return { env, repoRoot, specFile: join(repoRoot, SPEC_PATH) };
}

const DISABLED_CAPTURE = { status: "disabled", durable: true, pending: 0 };

function recorder() {
  const delivered = [];
  return {
    delivered,
    deliver: async (event, options) => {
      delivered.push({ event, sessionId: options.sessionId, env: options.env });
      return DISABLED_CAPTURE;
    },
  };
}

const NO_ARTIFACTS = async () => ({
  status: "disabled",
  queued: 0,
  sent: 0,
  pending: 0,
});

function noGit(repoRoot) {
  return () => ({
    available: false,
    repoRoot,
    head: "",
    fingerprint: "",
    filesChanged: 0,
    trackedLinesAdded: 0,
    trackedLinesRemoved: 0,
  });
}

async function startSpecRun(
  { env, repoRoot, sessionId = SESSION_A, runId = RUN_A, at = "2026-09-15T10:00:00.000Z" },
) {
  startWorkflowRun(
    {
      sessionId,
      runId,
      workflowId: "spec:normal",
      intent: "spec",
      risk: "normal",
      declaredStages: [{ stageId: "spec", after: [] }],
      repositoryKey: PROJECT_KEY,
      bound: true,
      projectKey: PROJECT_KEY,
      specRef: SPEC_REF,
      at,
      cwd: repoRoot,
    },
    { env, snapshot: noGit(repoRoot) },
  );
  await runWorkflowStage(
    { action: "start", sessionId, stageId: "spec", at: "2026-09-15T10:00:01.000Z" },
    {
      env,
      idFactory: () => "11111111-1111-4111-8111-111111111111",
      deliver: async () => DISABLED_CAPTURE,
    },
  );
  appendWorkflowObservation(
    sessionId,
    {
      type: "coredoc",
      at: "2026-09-15T10:00:02.000Z",
      success: true,
      tool: "get_intent_context",
      access: "read",
      result: "ok",
    },
    { env },
  );
  await runWorkflowStage(
    {
      action: "finish",
      sessionId,
      stageId: "spec",
      outcome: "success",
      at: "2026-09-15T10:00:03.000Z",
    },
    { env, deliver: async () => DISABLED_CAPTURE },
  );
}

function observePropose(env, sessionId, at, { specMatch = true, created = 1 } = {}) {
  return appendWorkflowObservation(
    sessionId,
    {
      type: "coredoc",
      at,
      success: true,
      tool: "intent_propose",
      access: "write",
      result: "ok",
      specMatch,
      created,
      ...(specMatch ? {} : { refs: ["other/repo:docs/spec.md"] }),
    },
    { env },
  );
}

async function deliverDraft({ env, repoRoot, deliver }) {
  return finishWorkflowRun(
    {
      sessionId: SESSION_A,
      outcome: "delivered-draft",
      specPath: SPEC_PATH,
      at: "2026-09-15T10:00:04.000Z",
    },
    { env, cwd: repoRoot, deliver, checkpointArtifacts: NO_ARTIFACTS },
  );
}

async function parkedFixture(options = {}) {
  const { env, repoRoot, specFile } = harness(options);
  writeFileSync(specFile, DRAFT);
  await startSpecRun({ env, repoRoot });
  return { env, repoRoot, specFile };
}

test("spec accept and abandon parse exactly one action each", () => {
  assert.deepEqual(parseSpecArgs(["accept", "--path", "docs/spec.md"]), {
    action: "accept",
    path: "docs/spec.md",
  });
  assert.deepEqual(parseSpecArgs(["accept", "--finish"]), {
    action: "accept",
    finish: true,
  });
  assert.deepEqual(
    parseSpecArgs(["accept", "--finish", "--skip-intent", "overlay offline"]),
    { action: "accept", finish: true, skipIntentReason: "overlay offline" },
  );
  assert.deepEqual(parseSpecArgs(["abandon", "--reason", "superseded"]), {
    action: "abandon",
    reason: "superseded",
  });
  assert.throws(() => parseSpecArgs(["accept"]), /either --path <spec> .* or --finish/);
  assert.throws(
    () => parseSpecArgs(["accept", "--path", "a.md", "--finish"]),
    /either --path <spec> .* or --finish/,
  );
  assert.throws(
    () => parseSpecArgs(["accept", "--path", "a.md", "--skip-intent", "x"]),
    /--skip-intent is supported only with --finish/,
  );
  assert.throws(() => parseSpecArgs(["abandon"]), /spec abandon requires --reason/);
  assert.throws(() => parseSpecArgs(["finish"]), /spec action must be accept or abandon/);
});

test("AC-4: a delivered draft is parked with no capture event and the session slot freed", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();

  const parked = await deliverDraft({ env, repoRoot, deliver });
  assert.equal(parked.status, "pending-acceptance");
  assert.equal(parked.runId, RUN_A);
  assert.equal(parked.specRef, SPEC_REF);
  assert.equal(parked.ttlDays, 14);
  // BR-5: `delivered-draft` is a local transition; the contract's outcomes are
  // success | failed | blocked | abandoned and none of them is sent here.
  assert.deepEqual(delivered, []);
  // The session slot is free and the run lives under its own directory.
  assert.equal(readWorkflowRun(SESSION_A, { env }), null);
  assert.ok(existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));
  const awaiting = listParkedWorkflowRuns({ env, projectKey: PROJECT_KEY });
  assert.equal(awaiting.length, 1);
  assert.deepEqual(
    { runId: awaiting[0].runId, reason: awaiting[0].reason, ttlDays: awaiting[0].ttlDays },
    { runId: RUN_A, reason: "awaiting-acceptance", ttlDays: 14 },
  );
  // The specification carries the pointer back to the run, and stays a draft.
  assert.deepEqual(readSpecArtifact(specFile), { status: "draft", run: RUN_A });
  const history = lastRunHistory(PROJECT_KEY, { env });
  assert.equal(history.outcome, "pending-acceptance");
  assert.equal(history.runId, RUN_A);
  assert.deepEqual(
    history.gates.map(({ stage, gate, result }) => [stage, gate, result]),
    [["spec", "intent", "passed"]],
  );
});

test("AC-4: another task routes and finishes without touching the parked run", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  const parkedObservations = readWorkflowObservations(SESSION_A, {
    env: { ...env, COREDOC_WORKFLOWS_STATE_DIR: parkedRunDirectory(PROJECT_KEY, RUN_A, env) },
  });
  assert.equal(parkedObservations.length, 1);

  startWorkflowRun(
    {
      sessionId: SESSION_A,
      runId: RUN_B,
      workflowId: "direct:normal",
      intent: "direct",
      risk: "normal",
      repositoryKey: PROJECT_KEY,
      bound: true,
      projectKey: PROJECT_KEY,
      at: "2026-09-15T11:00:00.000Z",
      cwd: repoRoot,
    },
    { env, snapshot: noGit(repoRoot) },
  );
  const finished = await finishWorkflowRun(
    {
      sessionId: SESSION_A,
      outcome: "success",
      coredocStatus: "complete",
      at: "2026-09-15T11:05:00.000Z",
    },
    { env, cwd: repoRoot, deliver, checkpointArtifacts: NO_ARTIFACTS },
  );
  assert.equal(finished.status, "finished");
  // A's record and its observations are untouched by B's whole lifecycle.
  assert.equal(listParkedWorkflowRuns({ env, projectKey: PROJECT_KEY }).length, 1);
  assert.deepEqual(
    readWorkflowObservations(SESSION_A, {
      env: {
        ...env,
        COREDOC_WORKFLOWS_STATE_DIR: parkedRunDirectory(PROJECT_KEY, RUN_A, env),
      },
    }),
    parkedObservations,
  );
  assert.equal(readRunHistory(PROJECT_KEY, { env }).length, 2);
});

test("AC-9: acceptance reactivates the run, instructs the verbatim accept, and emits one success", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });

  const reactivated = acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  assert.equal(reactivated.status, "reactivated");
  assert.equal(reactivated.runId, RUN_A);
  assert.equal(reactivated.acceptIntentBefore, "coredoc-workflows spec accept --finish");
  assert.match(
    reactivated.intent,
    /do not ask again[\s\S]*verbatim[\s\S]*intent_propose[\s\S]*intent_review under that single approval/,
  );
  assert.match(reactivated.intent, /A PRD-derived specification accepts nothing/);
  assert.ok(reactivated.intent.includes(SPEC_REF), reactivated.intent);
  // Back in the session slot, so the observer records the agent's intent calls.
  assert.equal(readWorkflowRun(SESSION_A, { env }).status, "active");
  assert.ok(!existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));

  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  // No candidates precondition: with no propose observed, --finish accepts.
  const accepted = await finishAcceptedSpecification(
    { sessionId: SESSION_A, at: "2026-09-16T09:07:00.000Z" },
    { env, cwd: repoRoot, finishRun },
  );
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.gates, []);
  assert.equal(accepted.terminated, "terminated");
  assert.equal(readSpecArtifact(specFile).status, "accepted");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.type, "workflow.run.finished");
  assert.equal(delivered[0].event.data.outcome, "success");
  assert.equal(delivered[0].event.runId, RUN_A);
  // The run is recorded under the session and capture identity it started with.
  assert.equal(delivered[0].sessionId, SESSION_A);
  assert.equal(delivered[0].env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-fixture");
  assert.deepEqual(
    Object.keys(delivered[0].event.data).sort(),
    ["counters", "outcome"],
  );
  assert.equal(readWorkflowRun(SESSION_A, { env }), null);
  assert.equal(lastRunHistory(PROJECT_KEY, { env }).outcome, "success");
});

test("AC-4: spec abandon emits exactly one abandoned event and removes both ledgers", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });

  const abandoned = await abandonSpecification(
    { sessionId: "session-elsewhere", reason: "user dropped the idea", at: "2026-09-16T09:00:00.000Z" },
    {
      env,
      cwd: repoRoot,
      finishRun: (input, options) =>
        finishWorkflowRun(input, {
          ...options,
          deliver,
          checkpointArtifacts: NO_ARTIFACTS,
        }),
    },
  );
  assert.equal(abandoned.status, "abandoned");
  assert.equal(abandoned.runId, RUN_A);
  // The run ends through exactly one termination, and says so honestly.
  assert.equal(abandoned.terminated, "terminated");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.data.outcome, "abandoned");
  assert.equal(delivered[0].sessionId, SESSION_A);
  assert.ok(!existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));
  const history = lastRunHistory(PROJECT_KEY, { env });
  assert.equal(history.outcome, "abandoned");
  assert.equal(history.reason, "user dropped the idea");

  // A second abandon finds nothing and never sends a second event.
  const again = await abandonSpecification(
    { sessionId: "session-elsewhere", reason: "again", at: "2026-09-16T09:01:00.000Z" },
    { env, cwd: repoRoot },
  );
  assert.equal(again.status, "no-pending-run");
  assert.equal(again.terminated, undefined);
  assert.equal(delivered.length, 1);
});

test("AC-4b: a resumable SessionEnd re-suspends the reactivated run and keeps the propose", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  observePropose(env, SESSION_A, "2026-09-16T09:01:00.000Z");

  const ended = await finishWorkflowSession(
    { sessionId: SESSION_A, at: "2026-09-16T09:02:00.000Z", reason: "prompt_input_exit" },
    { env, finishRun },
  );
  assert.deepEqual(ended.run, { status: "suspended", runId: RUN_A });
  assert.equal(readWorkflowRun(SESSION_A, { env }).status, "suspended");
  assert.deepEqual(delivered, []);
  // The evidence already gathered survives the exit.
  assert.equal(
    readWorkflowObservations(SESSION_A, { env }).filter(
      (event) => event.tool === "intent_propose",
    ).length,
    1,
  );

  // `--resume` finds the run in its own slot and accepts on the kept evidence.
  const found = acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T10:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  assert.equal(found.status, "reactivated");
  const accepted = await finishAcceptedSpecification(
    { sessionId: SESSION_A, at: "2026-09-16T10:01:00.000Z" },
    { env, cwd: repoRoot, finishRun },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(readSpecArtifact(specFile).status, "accepted");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.data.outcome, "success");
});

test("a run re-suspended in another session is taken by a fresh session, not left behind", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  await deliverDraft({ env, repoRoot, deliver });

  // Session B accepts, proposes, and exits with a resumable reason.
  const sessionB = "session-spec-b";
  assert.equal(
    acceptSpecification(
      { sessionId: sessionB, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
      { env, cwd: repoRoot },
    ).status,
    "reactivated",
  );
  observePropose(env, sessionB, "2026-09-16T09:01:00.000Z");
  await finishWorkflowSession(
    { sessionId: sessionB, at: "2026-09-16T09:02:00.000Z", reason: "prompt_input_exit" },
    { env, finishRun },
  );
  assert.equal(readWorkflowRun(sessionB, { env }).status, "suspended");

  // Session C never saw B. The run has to move into C's slot, because the
  // observer only ever writes to the current session's ledger.
  const sessionC = "session-spec-c";
  const taken = acceptSpecification(
    { sessionId: sessionC, path: SPEC_PATH, at: "2026-09-17T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  assert.equal(taken.status, "reactivated");
  assert.equal(taken.runId, RUN_A);
  assert.equal(readWorkflowRun(sessionB, { env }), null);
  assert.equal(readWorkflowRun(sessionC, { env }).status, "active");
  assert.ok(!existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));
  // B's propose came with it, and a propose made in C is observed here too.
  observePropose(env, sessionC, "2026-09-17T09:01:00.000Z");
  assert.equal(
    readWorkflowObservations(sessionC, { env }).filter(
      (event) => event.tool === "intent_propose",
    ).length,
    2,
  );

  const accepted = await finishAcceptedSpecification(
    { sessionId: sessionC, at: "2026-09-17T09:02:00.000Z" },
    { env, cwd: repoRoot, finishRun },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(readSpecArtifact(specFile).status, "accepted");
  // One event, under the identity of the session that started the run.
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.data.outcome, "success");
  assert.equal(delivered[0].sessionId, SESSION_A);
  assert.equal(delivered[0].env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-fixture");
});

test("re-parking never restarts the 14-day acceptance clock", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { delivered, deliver } = recorder();
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  await deliverDraft({ env, repoRoot, deliver });
  const parkedAt = "2026-09-15T10:00:04.000Z";

  // Three weekly rounds of accept + resumable exit + re-park by the next route.
  for (const [week, date] of [
    [1, "2026-09-22"],
    [2, "2026-09-29"],
    [3, "2026-10-06"],
  ]) {
    const at = `${date}T09:00:00.000Z`;
    assert.equal(
      acceptSpecification(
        { sessionId: SESSION_A, path: SPEC_PATH, at },
        { env, cwd: repoRoot },
      ).status,
      "reactivated",
      `week ${week}`,
    );
    await finishWorkflowSession(
      { sessionId: SESSION_A, at, reason: "prompt_input_exit" },
      { env, finishRun },
    );
    // What `route-task` does before starting the next run.
    parkWorkflowRun(SESSION_A, { runId: RUN_A, at }, { env });
    const [parked] = listParkedWorkflowRuns({ env, projectKey: PROJECT_KEY });
    assert.equal(parked.parkedAt, parkedAt, `week ${week}`);
    assert.equal(parked.ttlDays, 14, `week ${week}`);
    assert.equal(parked.reason, "awaiting-acceptance", `week ${week}`);
  }

  const swept = await abandonExpiredWorkflowRuns(
    {
      ownSessionId: "session-router",
      projectKey: PROJECT_KEY,
      now: Date.parse(parkedAt) + 15 * 86_400_000,
    },
    { env, finishRun },
  );
  assert.deepEqual(swept, [
    {
      runId: RUN_A,
      sessionId: SESSION_A,
      status: "finished",
      reason: "acceptance-expired",
    },
  ]);
  const finishedEvents = delivered.filter(
    ({ event }) => event.type === "workflow.run.finished",
  );
  assert.equal(finishedEvents.length, 1);
  // Recorded at the original suspension, not at the last re-park.
  assert.equal(finishedEvents[0].event.occurredAt, parkedAt);
  assert.equal(lastRunHistory(PROJECT_KEY, { env }).outcome, "acceptance-expired");
});

test("a parked run an expiry sweep already claimed cannot be reactivated", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });

  // The sweep wins the race: it marks the run `abandoning` under its own lock.
  const claimed = claimExpiredWorkflowRun(
    SESSION_A,
    {
      now: Date.parse("2026-09-15T10:00:04.000Z") + 15 * 86_400_000,
      ttlMs: 14 * 86_400_000,
      staleClaimMs: 600_000,
    },
    { env: parkedRunEnv(PROJECT_KEY, RUN_A, env) },
  );
  assert.equal(claimed.state.status, "abandoning");

  const answer = acceptSpecification(
    { sessionId: "session-late", path: SPEC_PATH, at: "2026-09-30T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  assert.equal(answer.status, "no-pending-run");
  assert.equal(readWorkflowRun("session-late", { env }), null);
  assert.deepEqual(delivered, []);
});

test("AC-4b: a terminal SessionEnd abandons once and leaves no run to accept", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { delivered, deliver } = recorder();
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  observePropose(env, SESSION_A, "2026-09-16T09:01:00.000Z");

  const ended = await finishWorkflowSession(
    { sessionId: SESSION_A, at: "2026-09-16T09:02:00.000Z", reason: "clear" },
    { env, finishRun },
  );
  assert.equal(ended.run.status, "finished");
  const finishedEvents = delivered.filter(
    ({ event }) => event.type === "workflow.run.finished",
  );
  assert.equal(finishedEvents.length, 1);
  assert.equal(finishedEvents[0].event.data.outcome, "abandoned");
  assert.equal(finishedEvents[0].sessionId, SESSION_A);
  // Session slot and parked directory are gone together.
  assert.equal(readWorkflowRun(SESSION_A, { env }), null);
  assert.ok(!existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));
  assert.equal(
    acceptSpecification(
      { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T11:00:00.000Z" },
      { env, cwd: repoRoot },
    ).status,
    "no-pending-run",
  );
  assert.equal(
    delivered.filter(({ event }) => event.type === "workflow.run.finished").length,
    1,
  );
});

test("AC-4b: expiry from another session abandons under the run's own identity", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });

  const thirteenDays = Date.parse("2026-09-15T10:00:04.000Z") + 13 * 86_400_000;
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  assert.deepEqual(
    await abandonExpiredWorkflowRuns(
      { ownSessionId: "session-router", projectKey: PROJECT_KEY, now: thirteenDays },
      { env, finishRun },
    ),
    [],
  );

  const fifteenDays = Date.parse("2026-09-15T10:00:04.000Z") + 15 * 86_400_000;
  const swept = await abandonExpiredWorkflowRuns(
    { ownSessionId: "session-router", projectKey: PROJECT_KEY, now: fifteenDays },
    {
      env: { ...env, COREDOC_CAPTURE_WORKSPACE_ID: "ws-of-the-router" },
      finishRun,
    },
  );
  assert.deepEqual(swept, [
    {
      runId: RUN_A,
      sessionId: SESSION_A,
      status: "finished",
      reason: "acceptance-expired",
    },
  ]);
  const finishedEvents = delivered.filter(
    ({ event }) => event.type === "workflow.run.finished",
  );
  assert.equal(finishedEvents.length, 1);
  assert.equal(finishedEvents[0].event.data.outcome, "abandoned");
  assert.equal(finishedEvents[0].sessionId, SESSION_A);
  // The router's own binding never stands in for the run's.
  assert.equal(finishedEvents[0].env.COREDOC_CAPTURE_WORKSPACE_ID, "ws-fixture");
  // The abandonment is dated at the suspension, not at the discovery.
  assert.equal(finishedEvents[0].event.occurredAt, "2026-09-15T10:00:04.000Z");
  assert.ok(!existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));
  assert.equal(lastRunHistory(PROJECT_KEY, { env }).outcome, "acceptance-expired");

  // The sweep is idempotent: a second pass finds nothing and sends nothing.
  assert.deepEqual(
    await abandonExpiredWorkflowRuns(
      { ownSessionId: "session-router", projectKey: PROJECT_KEY, now: fifteenDays },
      { env, finishRun },
    ),
    [],
  );
  assert.equal(
    delivered.filter(({ event }) => event.type === "workflow.run.finished").length,
    1,
  );
});

test("acceptance refuses while another run is active and reports an unknown spec", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  startWorkflowRun(
    {
      sessionId: SESSION_A,
      runId: RUN_B,
      workflowId: "direct:normal",
      intent: "direct",
      risk: "normal",
      repositoryKey: PROJECT_KEY,
      bound: true,
      projectKey: PROJECT_KEY,
      at: "2026-09-16T08:00:00.000Z",
      cwd: repoRoot,
    },
    { env, snapshot: noGit(repoRoot) },
  );
  assert.throws(
    () =>
      acceptSpecification(
        { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
        { env, cwd: repoRoot },
      ),
    new RegExp(`${RUN_B} is active in this session; finish or abandon ${RUN_B} first`),
  );

  writeFileSync(join(repoRoot, "docs", "other.md"), DRAFT);
  assert.equal(
    acceptSpecification(
      { sessionId: "session-fresh", path: "docs/other.md" },
      { env, cwd: repoRoot },
    ).status,
    "no-pending-run",
  );
  assert.throws(
    () =>
      acceptSpecification(
        { sessionId: "session-fresh", path: "docs/absent.md" },
        { env, cwd: repoRoot },
      ),
    /no specification at docs\/absent\.md/,
  );
  assert.equal(readSpecArtifact(specFile).status, "draft");
});

test("a signed skip accepts the specification and records the reason", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  const accepted = await finishAcceptedSpecification(
    {
      sessionId: SESSION_A,
      skipIntentReason: "workspace has no intent capability",
      at: "2026-09-16T09:01:00.000Z",
    },
    {
      env,
      cwd: repoRoot,
      finishRun: (input, options) =>
        finishWorkflowRun(input, {
          ...options,
          deliver,
          checkpointArtifacts: NO_ARTIFACTS,
        }),
    },
  );
  assert.equal(accepted.status, "accepted");
  assert.deepEqual(accepted.gates, [
    {
      stage: "accept",
      gate: "intent",
      result: "skipped",
      reason: "workspace has no intent capability",
    },
  ]);
  assert.equal(readSpecArtifact(specFile).status, "accepted");
  assert.equal(delivered.length, 1);
  const history = lastRunHistory(PROJECT_KEY, { env });
  assert.ok(
    history.gates.some(
      (gate) =>
        gate.gate === "intent" &&
        gate.reason === "workspace has no intent capability",
    ),
    JSON.stringify(history.gates),
  );
});

test("LIM-2: acceptance with no intent call accepts without a warning or a recorded gate", async () => {
  const { env, repoRoot, specFile } = await parkedFixture({ gates: "warn" });
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  const stderr = process.stderr.write;
  const printed = [];
  process.stderr.write = (text) => printed.push(text);
  let accepted;
  try {
    accepted = await finishAcceptedSpecification(
      { sessionId: SESSION_A, at: "2026-09-16T09:01:00.000Z" },
      {
        env,
        cwd: repoRoot,
        finishRun: (input, options) =>
          finishWorkflowRun(input, {
            ...options,
            deliver,
            checkpointArtifacts: NO_ARTIFACTS,
          }),
      },
    );
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.gatesWarned, undefined);
  assert.deepEqual(accepted.gates, []);
  assert.deepEqual(printed, []);
  assert.equal(readSpecArtifact(specFile).status, "accepted");
  assert.equal(delivered.length, 1);
});

test("delivered-draft refuses a non-spec run and a specification that is not a draft", async () => {
  const { env, repoRoot, specFile } = harness();
  writeFileSync(specFile, DRAFT.replace("status: draft", "status: accepted"));
  await startSpecRun({ env, repoRoot });
  await assert.rejects(
    () => deliverDraft({ env, repoRoot, deliver: recorder().deliver }),
    /is accepted, not draft/,
  );

  const other = harness();
  writeFileSync(other.specFile, DRAFT);
  startWorkflowRun(
    {
      sessionId: SESSION_A,
      runId: RUN_B,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      repositoryKey: PROJECT_KEY,
      bound: true,
      projectKey: PROJECT_KEY,
      at: "2026-09-15T10:00:00.000Z",
      cwd: other.repoRoot,
    },
    { env: other.env, snapshot: noGit(other.repoRoot) },
  );
  await assert.rejects(
    () =>
      finishWorkflowRun(
        {
          sessionId: SESSION_A,
          outcome: "delivered-draft",
          specPath: SPEC_PATH,
          at: "2026-09-15T10:01:00.000Z",
        },
        { env: other.env, cwd: other.repoRoot, checkpointArtifacts: NO_ARTIFACTS },
      ),
    /only for a standalone spec run; this run's intent is change/,
  );
});

test("the specification frontmatter is never rewritten by a read", () => {
  const { specFile } = harness();
  writeFileSync(specFile, DRAFT);
  const before = readFileSync(specFile, "utf8");
  readSpecArtifact(specFile);
  assert.equal(readFileSync(specFile, "utf8"), before);
});

test("a refused finish leaves the specification a draft and the run reactivated", async () => {
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  observePropose(env, SESSION_A, "2026-09-16T09:01:00.000Z");
  // A declared stage that never finished successfully: `finish-run` fails
  // closed, and the acceptance must not have been written before that.
  startWorkflowStage(
    SESSION_A,
    "spec",
    { at: "2026-09-16T09:02:00.000Z" },
    { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
  );
  await assert.rejects(
    () =>
      finishAcceptedSpecification(
        { sessionId: SESSION_A, at: "2026-09-16T09:03:00.000Z" },
        {
          env,
          cwd: repoRoot,
          finishRun: (input, options) =>
            finishWorkflowRun(input, {
              ...options,
              deliver,
              checkpointArtifacts: NO_ARTIFACTS,
            }),
        },
      ),
    /stage spec is still open/,
  );
  assert.equal(readSpecArtifact(specFile).status, "draft");
  assert.equal(readSpecArtifact(specFile).run, RUN_A);
  assert.deepEqual(delivered, []);
  assert.equal(readWorkflowRun(SESSION_A, { env }).runId, RUN_A);
});

test("the run pointer is written after parking and removed when the run ends", async () => {
  const accepted = await parkedFixture();
  const first = recorder();
  await deliverDraft({ env: accepted.env, repoRoot: accepted.repoRoot, deliver: first.deliver });
  assert.equal(readSpecArtifact(accepted.specFile).run, RUN_A);
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env: accepted.env, cwd: accepted.repoRoot },
  );
  observePropose(accepted.env, SESSION_A, "2026-09-16T09:01:00.000Z");
  await finishAcceptedSpecification(
    { sessionId: SESSION_A, at: "2026-09-16T09:02:00.000Z" },
    {
      env: accepted.env,
      cwd: accepted.repoRoot,
      finishRun: (input, options) =>
        finishWorkflowRun(input, {
          ...options,
          deliver: first.deliver,
          checkpointArtifacts: NO_ARTIFACTS,
        }),
    },
  );
  // The document keeps its status and loses the pointer to the finished run.
  assert.deepEqual(readSpecArtifact(accepted.specFile), { status: "accepted" });

  const dropped = await parkedFixture();
  const second = recorder();
  await deliverDraft({ env: dropped.env, repoRoot: dropped.repoRoot, deliver: second.deliver });
  await abandonSpecification(
    { sessionId: "session-elsewhere", reason: "superseded", at: "2026-09-16T09:00:00.000Z" },
    {
      env: dropped.env,
      cwd: dropped.repoRoot,
      finishRun: (input, options) =>
        finishWorkflowRun(input, {
          ...options,
          deliver: second.deliver,
          checkpointArtifacts: NO_ARTIFACTS,
        }),
    },
  );
  assert.deepEqual(readSpecArtifact(dropped.specFile), { status: "draft" });
});

test("an acceptance run expiring from its session slot is recorded as acceptance-expired", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { delivered, deliver } = recorder();
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver,
      checkpointArtifacts: NO_ARTIFACTS,
    });
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  // Re-suspended in its own slot and never taken again: the main sweep, not the
  // parked one, is what finds it.
  await finishWorkflowSession(
    { sessionId: SESSION_A, at: "2026-09-16T09:05:00.000Z", reason: "prompt_input_exit" },
    { env, finishRun },
  );
  assert.equal(readWorkflowRun(SESSION_A, { env }).status, "suspended");

  const swept = await abandonExpiredWorkflowRuns(
    {
      ownSessionId: "session-router",
      projectKey: PROJECT_KEY,
      now: Date.parse("2026-09-15T10:00:04.000Z") + 15 * 86_400_000,
    },
    { env, finishRun },
  );
  assert.deepEqual(
    swept.map(({ runId, status, reason }) => ({ runId, status, reason })),
    [{ runId: RUN_A, status: "finished", reason: "acceptance-expired" }],
  );
  assert.equal(lastRunHistory(PROJECT_KEY, { env }).outcome, "acceptance-expired");
  assert.equal(
    delivered.filter(({ event }) => event.type === "workflow.run.finished").length,
    1,
  );
});

test("a reactivated acceptance run cannot be finished success by finish-run", async () => {
  // Not a gate: no mode relaxes it, because it is the wrong terminal path
  // rather than missing evidence.
  for (const gates of ["enforce", "warn"]) {
    const { env, repoRoot, specFile } = await parkedFixture({ gates });
    const { delivered, deliver } = recorder();
    await deliverDraft({ env, repoRoot, deliver });
    acceptSpecification(
      { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
      { env, cwd: repoRoot },
    );

    await assert.rejects(
      () =>
        finishWorkflowRun(
          {
            sessionId: SESSION_A,
            outcome: "success",
            coredocStatus: "complete",
            at: "2026-09-16T09:05:00.000Z",
          },
          { env, cwd: repoRoot, deliver, checkpointArtifacts: NO_ARTIFACTS },
        ),
      /acceptance-run-not-finishable[\s\S]*spec accept --finish[\s\S]*spec abandon/,
    );

    // Nothing was destroyed: the run is still reactivated, the specification is
    // still a draft pointing at it, and no event went out.
    assert.equal(readWorkflowRun(SESSION_A, { env }).runId, RUN_A);
    assert.equal(readWorkflowRun(SESSION_A, { env }).status, "active");
    assert.deepEqual(readSpecArtifact(specFile), { status: "draft", run: RUN_A });
    assert.deepEqual(delivered, []);
    assert.equal(lastRunHistory(PROJECT_KEY, { env }).outcome, "pending-acceptance");

    // The remedy in the refusal still works afterwards.
    observePropose(env, SESSION_A, "2026-09-16T09:06:00.000Z");
    const accepted = await finishAcceptedSpecification(
      { sessionId: SESSION_A, at: "2026-09-16T09:07:00.000Z" },
      {
        env,
        cwd: repoRoot,
        finishRun: (input, options) =>
          finishWorkflowRun(input, {
            ...options,
            deliver,
            checkpointArtifacts: NO_ARTIFACTS,
          }),
      },
    );
    assert.equal(accepted.status, "accepted");
    assert.equal(readSpecArtifact(specFile).status, "accepted");
  }
});

test("finish-run failed closes an acceptance run through its terminal path", async () => {
  const SESSION_LATER = "session-spec-later";
  const { env, repoRoot, specFile } = await parkedFixture();
  const { delivered, deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  // The approval session is not the session that opened the run.
  acceptSpecification(
    { sessionId: SESSION_LATER, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );

  const finished = await finishWorkflowRun(
    {
      sessionId: SESSION_LATER,
      outcome: "failed",
      coredocStatus: "complete",
      at: "2026-09-16T09:05:00.000Z",
    },
    { env, cwd: repoRoot, deliver, checkpointArtifacts: NO_ARTIFACTS },
  );
  assert.equal(finished.status, "finished");

  // Exactly one finished event, under the session that opened the run.
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sessionId, SESSION_A);
  assert.equal(delivered[0].event.type, "workflow.run.finished");
  assert.equal(delivered[0].event.data.outcome, "failed");
  // The history records the outcome, and the specification keeps its status but
  // loses the pointer to a run that no longer exists.
  const history = lastRunHistory(PROJECT_KEY, { env });
  assert.equal(history.runId, RUN_A);
  assert.equal(history.outcome, "failed");
  assert.deepEqual(readSpecArtifact(specFile), { status: "draft" });
  assert.equal(readWorkflowRun(SESSION_LATER, { env }), null);
  assert.ok(!existsSync(parkedRunDirectory(PROJECT_KEY, RUN_A, env)));
  assert.equal(
    acceptSpecification(
      { sessionId: SESSION_LATER, path: SPEC_PATH, at: "2026-09-16T09:06:00.000Z" },
      { env, cwd: repoRoot },
    ).status,
    "no-pending-run",
  );
});

test("the SessionStart block of a reactivated acceptance run names the acceptance commands", async () => {
  const { env, repoRoot } = await parkedFixture();
  const { deliver } = recorder();
  await deliverDraft({ env, repoRoot, deliver });
  acceptSpecification(
    { sessionId: SESSION_A, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );

  const context = workflowRunContext(
    workflowRunStatus(SESSION_A, { env, cwd: repoRoot }),
  );
  assert.match(context, /spec accept --finish/);
  assert.match(context, /spec abandon --reason/);
  assert.match(context, /do not finish this run with finish-run/);
  assert.equal(/continue with coredoc-workflows stage-run and finish-run/.test(context), false);
});
