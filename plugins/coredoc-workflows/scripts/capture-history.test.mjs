import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  captureStatePath,
  recordCaptureTransitions,
} from "./capture-state.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { workflowRunStatus } from "./run-status.mjs";
import {
  appendRunHistory,
  lastRunHistory,
  readRunHistory,
} from "./workflow-gates.mjs";
import { startWorkflowRun } from "./workflow-run-state.mjs";

const SESSION_ID = "session-capture-history";
const RUN_ID = "cdr-20260915-cc33dd";
const PROJECT_KEY = "capture-history-fixture";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const DISABLED = { status: "disabled", durable: true, pending: 0 };
const NO_ARTIFACTS = async () => ({
  status: "disabled",
  queued: 0,
  sent: 0,
  pending: 0,
});

function testEnv() {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-capture-history-"),
    ),
    COREDOC_WORKFLOWS_REPO_KEY: PROJECT_KEY,
  };
}

function startRun(env) {
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      repositoryKey: PROJECT_KEY,
      bound: false,
      projectKey: PROJECT_KEY,
      at: "2026-09-15T10:00:00.000Z",
      cwd: process.cwd(),
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

function seedCapture(env, entries) {
  // As the recorder really does it: every event is queued by the session that
  // emits it before any delivery result lands on it, which is also what marks
  // the run's owning project.
  recordCaptureTransitions(
    entries.flatMap((entry) => [
      ...(entry.state === "queued" ? [] : [{ runId: RUN_ID, ...entry, state: "queued" }]),
      { runId: RUN_ID, ...entry },
    ]),
    { projectKey: PROJECT_KEY, env },
  );
}

async function finish(env, { stderr }) {
  return finishWorkflowRun(
    { sessionId: SESSION_ID, outcome: "success", at: "2026-09-15T10:00:30.000Z" },
    {
      env,
      stderr,
      deliver: async () => DISABLED,
      checkpointArtifacts: NO_ARTIFACTS,
    },
  );
}

test("a finished run carries its delivery state into the history line", async () => {
  const env = testEnv();
  startRun(env);
  seedCapture(env, [
    {
      eventId: EVENT_ID,
      kind: "workflow.run.started",
      state: "delivered",
      lastAttemptAt: "2026-09-15T10:00:01.000Z",
    },
  ]);
  const written = [];
  const result = await finish(env, { stderr: { write: (l) => written.push(l) } });

  assert.deepEqual(lastRunHistory(PROJECT_KEY, { env }).capture, [
    {
      eventId: EVENT_ID,
      kind: "workflow.run.started",
      state: "delivered",
      lastAttemptAt: "2026-09-15T10:00:01.000Z",
    },
  ]);
  // Everything delivered: nothing to say, and no file left behind.
  assert.deepEqual(written, []);
  assert.equal(result.captureNotice, undefined);
  assert.equal(existsSync(captureStatePath(PROJECT_KEY, RUN_ID, env)), false);
});

test("a close whose own events did not deliver says so on stderr", async () => {
  const env = testEnv();
  startRun(env);
  seedCapture(env, [
    {
      eventId: EVENT_ID,
      kind: "workflow.run.finished",
      state: "failed",
      lastAttemptAt: "2026-09-15T10:00:29.000Z",
      error: "TRANSPORT_UNAVAILABLE",
    },
  ]);
  const written = [];
  const result = await finish(env, { stderr: { write: (l) => written.push(l) } });

  assert.deepEqual(written, [
    "coredoc capture: 1 events from 2026-09-15T10:00:29.000Z not delivered (relay healthy) — run `coredoc-workflows capture-health`\n",
  ]);
  assert.equal(
    result.captureNotice,
    "coredoc capture: 1 events from 2026-09-15T10:00:29.000Z not delivered (relay healthy) — run `coredoc-workflows capture-health`",
  );
  // The state file survives the run: it is still the only record of the event.
  assert.equal(existsSync(captureStatePath(PROJECT_KEY, RUN_ID, env)), true);
});

test("the history trim keeps an older run whose events never arrived", () => {
  const env = testEnv();
  appendRunHistory(
    PROJECT_KEY,
    {
      runId: "cdr-oldest-undelivered",
      outcome: "success",
      capture: [
        {
          eventId: EVENT_ID,
          kind: "workflow.run.finished",
          state: "failed",
          lastAttemptAt: "2026-09-01T10:00:00.000Z",
          error: "TRANSPORT_UNAVAILABLE",
        },
      ],
    },
    { env },
  );
  for (let index = 0; index < 200; index += 1) {
    appendRunHistory(
      PROJECT_KEY,
      { runId: `cdr-delivered-${index}`, outcome: "success", capture: [] },
      { env },
    );
  }

  const history = readRunHistory(PROJECT_KEY, { env });
  assert.equal(history.length, 201);
  assert.equal(history[0].runId, "cdr-oldest-undelivered");
  assert.equal(history.at(-1).runId, "cdr-delivered-199");

  // One more delivered run trims another delivered line, never the exempt one.
  appendRunHistory(
    PROJECT_KEY,
    { runId: "cdr-delivered-200", outcome: "success", capture: [] },
    { env },
  );
  const trimmed = readRunHistory(PROJECT_KEY, { env });
  assert.equal(trimmed.length, 201);
  assert.equal(trimmed[0].runId, "cdr-oldest-undelivered");
  assert.equal(trimmed[1].runId, "cdr-delivered-1");
});

test("run-status reports the last run's delivery state", async () => {
  const env = testEnv();
  startRun(env);
  seedCapture(env, [
    {
      eventId: EVENT_ID,
      kind: "workflow.run.finished",
      state: "rejected",
      lastAttemptAt: "2026-09-15T10:00:29.000Z",
      rejectionCode: "UNSUPPORTED_SCHEMA_VERSION",
    },
  ]);
  await finish(env, { stderr: { write: () => undefined } });

  const status = workflowRunStatus(SESSION_ID, { env });
  assert.equal(status.status, "inactive");
  assert.deepEqual(status.delivery, {
    runId: RUN_ID,
    kinds: {
      "workflow.run.finished": {
        delivered: 0,
        queued: 0,
        failed: 0,
        rejected: 1,
      },
    },
    lastRejectionCode: "UNSUPPORTED_SCHEMA_VERSION",
  });
});

test("an inactive close names the run that was already finished", async () => {
  const env = testEnv();
  startRun(env);
  await finish(env, { stderr: { write: () => undefined } });

  const again = await finishWorkflowRun(
    { sessionId: SESSION_ID, outcome: "failed", at: "2026-09-15T10:00:40.000Z" },
    { env, deliver: async () => DISABLED, checkpointArtifacts: NO_ARTIFACTS },
  );
  assert.deepEqual(again, {
    status: "inactive",
    lastRun: { runId: RUN_ID, outcome: "success" },
  });
});
