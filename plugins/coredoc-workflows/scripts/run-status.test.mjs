import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { workflowRunContext, workflowRunStatus } from "./run-status.mjs";
import {
  finishWorkflowStage,
  readWorkflowRun,
  startWorkflowStage,
  startWorkflowRun,
  suspendWorkflowRun,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-status";
const RUN_ID = "cdr-20260801-a1b2c3";
const NO_GIT = () => ({ available: false, repoRoot: "", head: "", fingerprint: "" });

function testEnv() {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-run-status-"),
    ),
  };
}

function startThreeStageRun(env) {
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [
        { stageId: "spec", after: [] },
        { stageId: "tdd", after: ["spec"] },
        { stageId: "review", after: ["tdd"] },
      ],
      at: "2026-08-01T10:00:00.000Z",
    },
    { env, snapshot: NO_GIT },
  );
  startWorkflowStage(
    SESSION_ID,
    "spec",
    { at: "2026-08-01T10:00:01.000Z" },
    { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
  );
  finishWorkflowStage(
    SESSION_ID,
    "spec",
    "success",
    { at: "2026-08-01T10:00:02.000Z" },
    { env },
  );
  startWorkflowStage(
    SESSION_ID,
    "tdd",
    { at: "2026-08-01T10:00:03.000Z" },
    { env, idFactory: () => "22222222-2222-4222-8222-222222222222" },
  );
}

test("run status distinguishes unattributed, inactive, and live runs", () => {
  const env = testEnv();
  assert.deepEqual(workflowRunStatus("", { env }), { status: "unattributed" });
  assert.deepEqual(workflowRunStatus(SESSION_ID, { env }), {
    status: "inactive",
  });

  startThreeStageRun(env);
  assert.deepEqual(workflowRunStatus(SESSION_ID, { env }), {
    status: "active",
    runId: RUN_ID,
    workflowId: "change:normal",
    intent: "change",
    risk: "normal",
    startedAt: "2026-08-01T10:00:00.000Z",
    openStage: "tdd",
    openStageAttempt: 1,
    // BR-7: gate evidence is rebuilt from the observations on disk. This run
    // has none, and no specification, so nothing is satisfied and the
    // candidate gate does not apply.
    gates: {
      // A stage is open, so the evidence is that attempt's own.
      scope: "stage",
      intent: "pending",
      candidates: "not-applicable",
      mcp: "pending",
    },
    stages: [
      { stageId: "spec", status: "success", attempt: 1 },
      { stageId: "tdd", status: "open", attempt: 1 },
      { stageId: "review", status: "pending" },
    ],
  });

  suspendWorkflowRun(SESSION_ID, { at: "2026-08-01T10:05:00.000Z" }, { env });
  const suspended = workflowRunStatus(SESSION_ID, { env });
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspendedAt, "2026-08-01T10:05:00.000Z");
  // Reading status is never a lifecycle command: it does not resume.
  assert.equal(readWorkflowRun(SESSION_ID, { env }).status, "suspended");
});

test("run context re-anchors a live run and says nothing otherwise", () => {
  const env = testEnv();
  assert.equal(workflowRunContext(workflowRunStatus(SESSION_ID, { env })), "");
  startThreeStageRun(env);
  const context = workflowRunContext(workflowRunStatus(SESSION_ID, { env }));
  // The block is injected by a hook with no author, so it names its origin and
  // its standing first: a resumed session must not read it as an untrusted
  // system-reminder and ignore it.
  assert.ok(
    context.startsWith(
      "Coredoc workflows plugin (SessionStart hook) — this session's own recorded run state, not a new request:",
    ),
    context,
  );
  assert.ok(context.endsWith("Continue that run from this state."), context);
  assert.equal(context.includes("\n"), false);
  assert.match(context, new RegExp(`run ${RUN_ID} \\(change:normal\\) is active`));
  assert.match(context, /Open stage: tdd\./);
  assert.match(context, /Closed stages: spec=success\./);
  assert.match(context, /Not started: review\./);
  assert.match(context, /Do not run route-task again/);
  assert.match(context, /coredoc-workflows run-status/);
});

test("run status CLI prints the session's run as JSON and exits successfully", () => {
  const env = testEnv();
  startThreeStageRun(env);
  const script = new URL("./run-status.mjs", import.meta.url).pathname;
  const live = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...env,
      COREDOC_WORKFLOWS_SESSION_ID: SESSION_ID,
      HOME: mkdtempSync(join(tmpdir(), "coredoc-run-status-home-")),
    },
  });
  assert.equal(live.status, 0, live.stderr);
  assert.equal(live.stderr, "");
  const parsed = JSON.parse(live.stdout);
  assert.equal(parsed.status, "active");
  assert.equal(parsed.openStage, "tdd");

  const none = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...env,
      COREDOC_WORKFLOWS_SESSION_ID: "session-without-run",
      HOME: mkdtempSync(join(tmpdir(), "coredoc-run-status-home-")),
    },
  });
  assert.equal(none.status, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), { status: "inactive" });
});

test("run context says when no stage is open and when the run is suspended", () => {
  const env = testEnv();
  startThreeStageRun(env);
  finishWorkflowStage(
    SESSION_ID,
    "tdd",
    "blocked",
    { at: "2026-08-01T10:00:04.000Z" },
    { env },
  );
  suspendWorkflowRun(SESSION_ID, { at: "2026-08-01T10:05:00.000Z" }, { env });
  const context = workflowRunContext(workflowRunStatus(SESSION_ID, { env }));
  assert.match(context, /is suspended in this session\. No stage is open\./);
  assert.match(context, /Closed stages: spec=success, tdd=blocked\./);
  assert.match(context, /Not started: review\./);
});
