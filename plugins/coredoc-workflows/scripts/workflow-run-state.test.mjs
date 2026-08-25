import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  abandonOpenWorkflowStage,
  appendWorkflowObservation,
  completeWorkflowRun,
  finalizeWorkflowRun,
  finishWorkflowStage,
  gitSnapshot,
  readWorkflowObservations,
  readWorkflowRun,
  startWorkflowStage,
  startWorkflowRun,
  summarizeWorkflowObservations,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-42";
const RUN_ID = "cdr-20260731-a1b2c3";
const START = {
  available: true,
  repoRoot: "/private/local/repo",
  head: "a".repeat(40),
  fingerprint: "1".repeat(64),
  filesChanged: 1,
  trackedLinesAdded: 3,
  trackedLinesRemoved: 1,
};
const END = {
  ...START,
  head: "b".repeat(40),
  fingerprint: "2".repeat(64),
  filesChanged: 2,
  trackedLinesAdded: 8,
  trackedLinesRemoved: 2,
};
function testEnv() {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-state-"),
    ),
  };
}

function startDeclaredRun(env) {
  return startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [
        { stageId: "spec", after: [] },
        { stageId: "tdd", after: ["spec"] },
      ],
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );
}

test("stores only a compact local start snapshot and never repository contents", () => {
  const env = testEnv();
  const result = startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );

  assert.equal(result.status, "started");
  assert.deepEqual(readWorkflowRun(SESSION_ID, { env }), {
    schemaVersion: 1,
    status: "active",
    sessionId: SESSION_ID,
    runId: RUN_ID,
    workflowId: "change:normal",
    intent: "change",
    risk: "normal",
    requiredSkills: [],
    startedAt: "2026-07-31T10:00:00.000Z",
    repoRoot: "/private/local/repo",
    start: {
      available: true,
      head: "a".repeat(40),
      fingerprint: "1".repeat(64),
    },
  });
});

test("stores normalized routed skill requirements in local run state", () => {
  const env = testEnv();
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      requiredSkills: [
        "coredoc-workflows:coredoc-spec",
        "coredoc-tdd",
        "coredoc-tdd",
      ],
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );

  assert.deepEqual(readWorkflowRun(SESSION_ID, { env }).requiredSkills, [
    "coredoc-spec",
    "coredoc-tdd",
  ]);
});

test("persists an exact v2 declared DAG independently of the router objects", () => {
  const env = testEnv();
  const declaredStages = [
    { stageId: "spec", after: [] },
    { stageId: "tdd", after: ["spec"] },
  ];
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      declaredStages,
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );
  declaredStages[1].after.push("mutated-after-write");

  const state = readWorkflowRun(SESSION_ID, { env });
  assert.equal(state.captureSchemaVersion, 2);
  assert.equal(state.stageCaptureVersion, 1);
  assert.deepEqual(state.stageProgress, {});
  assert.deepEqual(state.declaredStages, [
    { stageId: "spec", after: [] },
    { stageId: "tdd", after: ["spec"] },
  ]);
});

test("enforces the declared DAG and permits only one open stage", () => {
  const env = testEnv();
  startDeclaredRun(env);

  assert.throws(
    () =>
      startWorkflowStage(
        SESSION_ID,
        "tdd",
        { at: "2026-07-31T10:00:01.000Z" },
        { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
      ),
    /dependency spec must finish successfully before stage tdd can start/i,
  );

  const started = startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:02.000Z" },
    { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
  );
  assert.equal(started.status, "started");
  assert.deepEqual(started.occurrence, {
    occurrenceId: "11111111-1111-4111-8111-111111111111",
    stageId: "spec",
    attempt: 1,
    startedAt: "2026-07-31T10:00:02.000Z",
  });
  assert.throws(
    () =>
      startWorkflowStage(
        SESSION_ID,
        "tdd",
        { at: "2026-07-31T10:00:03.000Z" },
        { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
      ),
    /stage spec is already open/i,
  );
  assert.throws(
    () =>
      finishWorkflowStage(
        SESSION_ID,
        "tdd",
        "success",
        { at: "2026-07-31T10:00:03.000Z" },
        { env },
      ),
    /stage spec is open; finish it before stage tdd/i,
  );
  assert.throws(
    () =>
      startWorkflowStage(
        SESSION_ID,
        "unknown",
        { at: "2026-07-31T10:00:03.000Z" },
        { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
      ),
    /stage unknown was not declared/i,
  );
});

test("replays exact stage boundaries and rejects a conflicting finish", () => {
  const env = testEnv();
  startDeclaredRun(env);
  const occurrenceId = "11111111-1111-4111-8111-111111111111";
  const started = startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:01.000Z" },
    { env, idFactory: () => occurrenceId },
  );
  const replayedStart = startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:09.000Z" },
    { env, idFactory: () => "99999999-9999-4999-8999-999999999999" },
  );
  assert.equal(replayedStart.status, "replayed");
  assert.deepEqual(replayedStart.event, started.event);
  assert.deepEqual(replayedStart.occurrence, started.occurrence);

  const finished = finishWorkflowStage(
    SESSION_ID,
    "spec",
    "success",
    { at: "2026-07-31T10:00:02.000Z" },
    { env },
  );
  const replayedFinish = finishWorkflowStage(
    SESSION_ID,
    "spec",
    "success",
    { at: "2026-07-31T10:00:10.000Z" },
    { env },
  );
  assert.equal(replayedFinish.status, "replayed");
  assert.deepEqual(replayedFinish.event, finished.event);
  assert.deepEqual(replayedFinish.occurrence, finished.occurrence);
  assert.throws(
    () =>
      finishWorkflowStage(
        SESSION_ID,
        "spec",
        "failed",
        { at: "2026-07-31T10:00:11.000Z" },
        { env },
      ),
    /stage spec already finished with outcome success/i,
  );
});

test("increments the latest stage attempt and gates dependents on its outcome", () => {
  const env = testEnv();
  startDeclaredRun(env);
  startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:01.000Z" },
    { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
  );
  finishWorkflowStage(
    SESSION_ID,
    "spec",
    "success",
    { at: "2026-07-31T10:00:02.000Z" },
    { env },
  );
  const second = startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:03.000Z" },
    { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
  );
  assert.equal(second.occurrence.attempt, 2);
  finishWorkflowStage(
    SESSION_ID,
    "spec",
    "failed",
    { at: "2026-07-31T10:00:04.000Z" },
    { env },
  );
  assert.throws(
    () =>
      startWorkflowStage(
        SESSION_ID,
        "tdd",
        { at: "2026-07-31T10:00:05.000Z" },
        { env, idFactory: () => "33333333-3333-4333-8333-333333333333" },
      ),
    /dependency spec must finish successfully before stage tdd can start/i,
  );
});

test("abandons only an actually open stage at the supplied terminal timestamp", () => {
  const env = testEnv();
  startDeclaredRun(env);
  assert.equal(
    abandonOpenWorkflowStage(
      SESSION_ID,
      { at: "2026-07-31T10:00:01.000Z" },
      { env },
    ),
    null,
  );
  startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:02.000Z" },
    { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
  );

  const abandoned = abandonOpenWorkflowStage(
    SESSION_ID,
    { at: "2026-07-31T10:00:03.000Z" },
    { env },
  );
  assert.equal(abandoned.status, "finished");
  assert.equal(abandoned.event.occurredAt, "2026-07-31T10:00:03.000Z");
  assert.deepEqual(abandoned.event.data, {
    occurrenceId: "11111111-1111-4111-8111-111111111111",
    stageId: "spec",
    attempt: 1,
    outcome: "abandoned",
  });
  assert.equal(
    abandonOpenWorkflowStage(
      SESSION_ID,
      { at: "2026-07-31T10:00:04.000Z" },
      { env },
    ),
    null,
  );
});

test("refuses a finish before its start without poisoning persisted replay", () => {
  const env = testEnv();
  startDeclaredRun(env);
  startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:02.000Z" },
    { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
  );

  assert.throws(
    () =>
      finishWorkflowStage(
        SESSION_ID,
        "spec",
        "success",
        { at: "2026-07-31T10:00:01.000Z" },
        { env },
      ),
    /finish time cannot precede its start time/i,
  );
  assert.throws(
    () =>
      abandonOpenWorkflowStage(
        SESSION_ID,
        { at: "2026-07-31T10:00:01.000Z" },
        { env },
      ),
    /finish time cannot precede its start time/i,
  );
  assert.deepEqual(readWorkflowRun(SESSION_ID, { env }).stageProgress.spec, {
    occurrenceId: "11111111-1111-4111-8111-111111111111",
    stageId: "spec",
    attempt: 1,
    startedAt: "2026-07-31T10:00:02.000Z",
  });
});

test("fails closed when persisted stage progress is malformed", () => {
  const env = testEnv();
  startDeclaredRun(env);
  const state = readWorkflowRun(SESSION_ID, { env });
  state.stageProgress = {
    spec: {
      occurrenceId: "11111111-1111-4111-8111-111111111111",
      stageId: "spec",
      attempt: 0,
      startedAt: "2026-07-31T10:00:01.000Z",
    },
  };
  const statePath = join(
    env.COREDOC_WORKFLOWS_STATE_DIR,
    `${createHash("sha256").update(SESSION_ID).digest("hex")}.json`,
  );
  writeFileSync(statePath, `${JSON.stringify(state)}\n`, "utf8");

  assert.throws(
    () =>
      startWorkflowStage(
        SESSION_ID,
        "spec",
        { at: "2026-07-31T10:00:02.000Z" },
        { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
      ),
    /persisted stage progress is invalid/i,
  );
});

function lockPathFor(env) {
  return join(
    env.COREDOC_WORKFLOWS_STATE_DIR,
    `${createHash("sha256").update(SESSION_ID).digest("hex")}.json.lock`,
  );
}

test("holds an advisory lock across a stage transition and releases it", () => {
  const env = testEnv();
  startDeclaredRun(env);
  const lock = lockPathFor(env);
  let heldDuringTransition = false;

  startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:01.000Z" },
    {
      env,
      idFactory: () => {
        heldDuringTransition = existsSync(lock);
        return "11111111-1111-4111-8111-111111111111";
      },
    },
  );

  assert.equal(heldDuringTransition, true);
  assert.equal(existsSync(lock), false);

  finishWorkflowStage(
    SESSION_ID,
    "spec",
    "success",
    { at: "2026-07-31T10:00:02.000Z" },
    { env },
  );
  assert.equal(existsSync(lock), false);
});

test("refuses a concurrent stage transition while a fresh lock is held", () => {
  const env = testEnv();
  startDeclaredRun(env);
  const lock = lockPathFor(env);
  writeFileSync(lock, "", { encoding: "utf8", mode: 0o600 });

  assert.throws(
    () =>
      startWorkflowStage(
        SESSION_ID,
        "spec",
        { at: "2026-07-31T10:00:01.000Z" },
        { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
      ),
    /locked by another command/i,
  );
  // The holder's lock survives a refused attempt.
  assert.equal(existsSync(lock), true);
  assert.equal(readWorkflowRun(SESSION_ID, { env }).stageProgress.spec, undefined);
});

test("takes over a stale lock left by a crashed stage command", () => {
  const env = testEnv();
  startDeclaredRun(env);
  const lock = lockPathFor(env);
  writeFileSync(lock, "", { encoding: "utf8", mode: 0o600 });
  const staleSeconds = (Date.now() - 60_000) / 1_000;
  utimesSync(lock, staleSeconds, staleSeconds);

  const started = startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-07-31T10:00:01.000Z" },
    { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
  );

  assert.equal(started.status, "started");
  assert.equal(existsSync(lock), false);
  assert.equal(
    readWorkflowRun(SESSION_ID, { env }).stageProgress.spec.occurrenceId,
    "11111111-1111-4111-8111-111111111111",
  );
});

test("refuses to finish a declared stage that was never started", () => {
  const env = testEnv();
  startDeclaredRun(env);

  assert.throws(
    () =>
      finishWorkflowStage(
        SESSION_ID,
        "spec",
        "success",
        { at: "2026-07-31T10:00:01.000Z" },
        { env },
      ),
    /stage spec is not open/i,
  );
  assert.equal(readWorkflowRun(SESSION_ID, { env }).stageProgress.spec, undefined);
});

test("refuses to overwrite an active run or its observations", () => {
  const env = testEnv();
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      requiredSkills: ["coredoc-spec", "coredoc-tdd"],
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );
  appendWorkflowObservation(
    SESSION_ID,
    {
      type: "skill",
      skillId: "coredoc-spec",
      at: "2026-07-31T10:00:01.000Z",
    },
    { env },
  );

  assert.throws(
    () =>
      startWorkflowRun(
        {
          sessionId: SESSION_ID,
          runId: "cdr-20260731-d4e5f6",
          workflowId: "review:normal",
          intent: "review",
          risk: "normal",
          at: "2026-07-31T10:00:02.000Z",
        },
        { env, snapshot: () => END },
      ),
    /workflow run .* is already active.*finish or abandon it/i,
  );
  assert.equal(readWorkflowRun(SESSION_ID, { env }).runId, RUN_ID);
  assert.deepEqual(readWorkflowObservations(SESSION_ID, { env }), [
    {
      type: "skill",
      skillId: "coredoc-spec",
      at: "2026-07-31T10:00:01.000Z",
    },
  ]);
});

test("detects a real Git worktree change using a source-free fingerprint", () => {
  const repo = mkdtempSync(join(tmpdir(), "coredoc-workflow-git-"));
  execFileSync("git", ["init", "-q", repo]);
  const before = gitSnapshot(repo);
  writeFileSync(join(repo, "new-file.txt"), "private source text\n", "utf8");
  const after = gitSnapshot(repo);

  assert.equal(before.available, true);
  assert.equal(after.available, true);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.equal(after.filesChanged, 1);
  assert.doesNotMatch(JSON.stringify(after), /new-file|private source/);
});

test("detects another edit to a tracked file that was already dirty at start", () => {
  const repo = mkdtempSync(join(tmpdir(), "coredoc-workflow-dirty-git-"));
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(join(repo, "tracked.txt"), "baseline\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "tracked.txt"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Workflow Test",
    "-c",
    "user.email=workflow@example.test",
    "commit",
    "-qm",
    "baseline",
  ]);
  writeFileSync(join(repo, "tracked.txt"), "first dirty value\n", "utf8");
  const before = gitSnapshot(repo);
  writeFileSync(join(repo, "tracked.txt"), "second dirty value\n", "utf8");
  const after = gitSnapshot(repo);

  assert.equal(before.filesChanged, 1);
  assert.equal(after.filesChanged, 1);
  assert.notEqual(before.fingerprint, after.fingerprint);
  assert.doesNotMatch(JSON.stringify(after), /first dirty|second dirty/);
});

test("derives rework only when an edit follows a failed verification", () => {
  assert.deepEqual(
    summarizeWorkflowObservations([
      { type: "edit", at: "2026-07-31T10:00:01.000Z" },
      {
        type: "verify",
        kind: "test",
        success: false,
        at: "2026-07-31T10:00:02.000Z",
      },
      {
        type: "verify",
        kind: "test",
        success: false,
        at: "2026-07-31T10:00:03.000Z",
      },
      { type: "edit", at: "2026-07-31T10:00:04.000Z" },
      { type: "edit", at: "2026-07-31T10:00:05.000Z" },
      {
        type: "verify",
        kind: "typecheck",
        success: true,
        at: "2026-07-31T10:00:06.000Z",
      },
      {
        type: "coredoc",
        success: false,
        at: "2026-07-31T10:00:07.000Z",
      },
      {
        type: "skill",
        skillId: "foreign-plugin:review",
        at: "2026-07-31T10:00:08.000Z",
      },
      {
        type: "skill",
        skillId: "foreign-plugin:review",
        at: "2026-07-31T10:00:09.000Z",
      },
      {
        type: "skill",
        skillId: "coredoc-tdd",
        at: "2026-07-31T10:00:10.000Z",
      },
    ]),
    {
      editCalls: 3,
      editVerifyRounds: 1,
      verificationRuns: 3,
      verificationFailures: 2,
      verificationPasses: 1,
      coredocCalls: 1,
      coredocFailures: 1,
      skillsUsed: [
        { name: "coredoc-tdd", count: 1 },
        { name: "foreign-plugin:review", count: 2 },
      ],
    },
  );
});

test("completes source-free evidence and finalizes only the matching run", () => {
  const env = testEnv();
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );

  assert.equal(
    appendWorkflowObservation(
      SESSION_ID,
      {
        type: "verify",
        kind: "test",
        success: false,
        at: "2026-07-31T10:00:01.000Z",
        command: "pnpm test --token secret",
      },
      { env },
    ).status,
    "recorded",
  );
  appendWorkflowObservation(
    SESSION_ID,
    { type: "edit", at: "2026-07-31T10:00:02.000Z" },
    { env },
  );
  appendWorkflowObservation(
    SESSION_ID,
    {
      type: "skill",
      skillId: "foreign-plugin:review",
      at: "2026-07-31T10:00:03.000Z",
      args: "private skill arguments",
    },
    { env },
  );

  const finished = completeWorkflowRun(SESSION_ID, {
    env,
    at: "2026-07-31T10:00:05.000Z",
    snapshot: () => END,
  });
  assert.deepEqual(finished.summary, {
    durationMs: 5_000,
    changed: true,
    headChanged: true,
    filesChangedAtFinish: 2,
    trackedLinesAddedAtFinish: 8,
    trackedLinesRemovedAtFinish: 2,
    editCalls: 1,
    editVerifyRounds: 1,
    verificationRuns: 1,
    verificationFailures: 1,
    verificationPasses: 0,
    coredocCalls: 0,
    coredocFailures: 0,
    skillsUsed: [{ name: "foreign-plugin:review", count: 1 }],
  });
  assert.doesNotMatch(JSON.stringify(finished), /pnpm|secret|private skill arguments/);
  assert.equal(finalizeWorkflowRun(SESSION_ID, RUN_ID, { env }).runId, RUN_ID);
  assert.equal(readWorkflowRun(SESSION_ID, { env }), null);
  assert.deepEqual(readWorkflowObservations(SESSION_ID, { env }), []);
});

test("refuses to finalize a different active run", () => {
  const env = testEnv();
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: "2026-07-31T10:00:00.000Z",
    },
    { env, snapshot: () => START },
  );
  assert.throws(
    () => finalizeWorkflowRun(SESSION_ID, "cdr-20260731-d4e5f6", { env }),
    /must match the active run/,
  );
  assert.equal(readWorkflowRun(SESSION_ID, { env }).runId, RUN_ID);
});

test("does nothing when no routed workflow is active", () => {
  const env = testEnv();
  assert.equal(
    appendWorkflowObservation(
      SESSION_ID,
      { type: "edit", at: "2026-07-31T10:00:00.000Z" },
      { env },
    ).status,
    "inactive",
  );
  assert.equal(completeWorkflowRun(SESSION_ID, { env }), null);
  assert.equal(finalizeWorkflowRun(SESSION_ID, RUN_ID, { env }), null);
});

test("bounds distinct skill identifiers while retaining repeated counts", () => {
  const at = "2026-07-31T10:00:00.000Z";
  const events = Array.from({ length: 191 }, (_, index) => ({
    type: "skill",
    skillId: `plugin:skill-${String(index).padStart(3, "0")}`,
    at,
  }));
  events.push({ type: "skill", skillId: "plugin:skill-000", at });

  const summary = summarizeWorkflowObservations(events);
  assert.equal(summary.skillsUsed.length, 190);
  assert.deepEqual(summary.skillsUsed[0], {
    name: "plugin:skill-000",
    count: 2,
  });
  assert.equal(
    summary.skillsUsed.some(({ name }) => name === "plugin:skill-190"),
    false,
  );
});

test("retains routed skills when bounded observations fill with foreign skills", () => {
  const at = "2026-07-31T10:00:00.000Z";
  const events = Array.from({ length: 190 }, (_, index) => ({
    type: "skill",
    skillId: `foreign-plugin:skill-${String(index).padStart(3, "0")}`,
    at,
  }));
  events.push({
    type: "skill",
    skillId: "coredoc-workflows:coredoc-tdd",
    at,
  });

  const summary = summarizeWorkflowObservations(events, {
    requiredSkills: ["coredoc-tdd"],
  });
  assert.equal(summary.skillsUsed.length, 190);
  assert.equal(
    summary.skillsUsed.some(
      ({ name }) => name === "coredoc-workflows:coredoc-tdd",
    ),
    true,
  );
  assert.equal(
    summary.skillsUsed.some(
      ({ name }) => name === "foreign-plugin:skill-000",
    ),
    false,
  );
});
