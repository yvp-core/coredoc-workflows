import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { parseStageArgs, runWorkflowStage } from "./stage-run.mjs";
import {
  readWorkflowRun,
  startWorkflowRun,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-stage-cli";
const RUN_ID = "cdr-20260817-a1b2c3";
const OCCURRENCE_ID = "11111111-1111-4111-8111-111111111111";

function noRepositorySnapshot() {
  return {
    available: false,
    repoRoot: "",
    head: "",
    fingerprint: "",
    filesChanged: 0,
    trackedLinesAdded: 0,
    trackedLinesRemoved: 0,
  };
}

function declaredRun() {
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-stage-run-"),
    ),
  };
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "tdd", after: [] }],
      at: "2026-08-17T10:00:00.000Z",
    },
    { env, snapshot: noRepositorySnapshot },
  );
  return env;
}

test("parses only explicit start and finish stage boundaries", () => {
  assert.deepEqual(parseStageArgs(["start", "--stage-id", "tdd"]), {
    action: "start",
    stageId: "tdd",
  });
  assert.deepEqual(
    parseStageArgs([
      "finish",
      "--stage-id",
      "tdd",
      "--outcome",
      "blocked",
    ]),
    { action: "finish", stageId: "tdd", outcome: "blocked" },
  );
  assert.throws(
    () => parseStageArgs(["finish", "--stage-id", "tdd"]),
    /--outcome is required/i,
  );
  assert.throws(
    () =>
      parseStageArgs([
        "finish",
        "--stage-id",
        "tdd",
        "--outcome",
        "abandoned",
      ]),
    /--outcome must be one of: success, failed, blocked/i,
  );
  assert.throws(
    () => parseStageArgs(["start", "--stage-id", "not a stage"]),
    /compact stage identifier/i,
  );
});

test("persists a boundary before delivery and returns only bounded status", async () => {
  const env = declaredRun();
  const delivered = [];
  const capture = { status: "pending", durable: true, pending: 1 };
  const deliver = async (event, options) => {
    const progress = readWorkflowRun(SESSION_ID, { env }).stageProgress.tdd;
    assert.equal(progress.occurrenceId, OCCURRENCE_ID);
    delivered.push([event, options]);
    return capture;
  };

  const started = await runWorkflowStage(
    {
      action: "start",
      sessionId: SESSION_ID,
      stageId: "tdd",
      at: "2026-08-17T10:00:01.000Z",
    },
    { env, idFactory: () => OCCURRENCE_ID, deliver },
  );
  assert.deepEqual(started, {
    status: "started",
    occurrence: {
      occurrenceId: OCCURRENCE_ID,
      stageId: "tdd",
      attempt: 1,
    },
    capture,
  });
  assert.deepEqual(delivered[0], [
    {
      schemaVersion: 2,
      occurredAt: "2026-08-17T10:00:01.000Z",
      type: "workflow.stage.started",
      runId: RUN_ID,
      data: {
        occurrenceId: OCCURRENCE_ID,
        stageId: "tdd",
        attempt: 1,
      },
    },
    { env, sessionId: SESSION_ID },
  ]);
  assert.deepEqual(Object.keys(started).sort(), [
    "capture",
    "occurrence",
    "status",
  ]);
});

test("reports an actionable result when no active workflow can be found", async () => {
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-stage-run-inactive-"),
    ),
  };

  assert.deepEqual(
    await runWorkflowStage(
      {
        action: "start",
        sessionId: "session-without-active-run",
        stageId: "spec",
      },
      { env },
    ),
    {
      status: "inactive",
      reason: "active-run-unavailable",
      action: "route-again",
    },
  );
});

test("CLI applies a stage boundary to the native Codex session", () => {
  const codexSessionId = "33333333-3333-4333-8333-333333333333";
  const env = {
    ...process.env,
    CODEX_SESSION_ID: codexSessionId,
    CODEX_THREAD_ID: codexSessionId,
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
  };
  env.COREDOC_WORKFLOWS_STATE_DIR = mkdtempSync(
    join(tmpdir(), "coredoc-codex-stage-state-"),
  );
  delete env.COREDOC_WORKFLOWS_SESSION_ID;
  startWorkflowRun(
    {
      sessionId: codexSessionId,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "tdd", after: [] }],
      at: "2026-08-17T10:00:00.000Z",
    },
    { env, snapshot: noRepositorySnapshot },
  );

  const result = spawnSync(
    process.execPath,
    [
      new URL("./stage-run.mjs", import.meta.url).pathname,
      "start",
      "--stage-id",
      "tdd",
    ],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "started");
  assert.equal(
    readWorkflowRun(codexSessionId, { env }).stageProgress.tdd.stageId,
    "tdd",
  );
});

test("CLI keeps one attributed workflow active when the working directory changes", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-stage-cwd-"));
  const stateHome = join(root, "state-home");
  const routeCwd = join(root, "workspace");
  const stageCwd = join(routeCwd, "repository");
  mkdirSync(stageCwd, { recursive: true });
  const env = {
    ...process.env,
    COREDOC_WORKFLOWS_SESSION_ID: "session-stage-cwd-change",
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
  delete env.COREDOC_WORKFLOWS_STATE_DIR;
  delete env.COREDOC_WORKFLOWS_REPO_KEY;

  const routed = spawnSync(
    process.execPath,
    [
      new URL("./route-task.mjs", import.meta.url).pathname,
      "--intent",
      "change",
    ],
    { cwd: routeCwd, encoding: "utf8", env },
  );
  assert.equal(routed.status, 0, routed.stderr);
  assert.equal(JSON.parse(routed.stdout).runStateStatus, "started");

  const started = spawnSync(
    process.execPath,
    [
      new URL("./stage-run.mjs", import.meta.url).pathname,
      "start",
      "--stage-id",
      "implement",
    ],
    { cwd: routeCwd, encoding: "utf8", env },
  );
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.equal(JSON.parse(started.stdout).status, "started");

  const finished = spawnSync(
    process.execPath,
    [
      new URL("./stage-run.mjs", import.meta.url).pathname,
      "finish",
      "--stage-id",
      "implement",
      "--outcome",
      "success",
    ],
    { cwd: stageCwd, encoding: "utf8", env },
  );
  assert.equal(finished.status, 0, finished.stderr || finished.stdout);
  assert.equal(JSON.parse(finished.stdout).status, "finished");

  const finalized = spawnSync(
    process.execPath,
    [
      new URL("./finish-run.mjs", import.meta.url).pathname,
      "--outcome",
      "failed",
    ],
    { cwd: stageCwd, encoding: "utf8", env },
  );
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  assert.equal(JSON.parse(finalized.stdout).status, "finished");
});

test("replays exact stored events and then records the explicit finish", async () => {
  const env = declaredRun();
  const delivered = [];
  const deliver = async (event) => {
    delivered.push(event);
    return { status: "disabled", durable: true, pending: 0 };
  };
  await runWorkflowStage(
    {
      action: "start",
      sessionId: SESSION_ID,
      stageId: "tdd",
      at: "2026-08-17T10:00:01.000Z",
    },
    { env, idFactory: () => OCCURRENCE_ID, deliver },
  );
  const replay = await runWorkflowStage(
    {
      action: "start",
      sessionId: SESSION_ID,
      stageId: "tdd",
      at: "2026-08-17T10:00:09.000Z",
    },
    {
      env,
      idFactory: () => "99999999-9999-4999-8999-999999999999",
      deliver,
    },
  );
  assert.equal(replay.status, "replayed");
  assert.deepEqual(delivered[1], delivered[0]);

  const finished = await runWorkflowStage(
    {
      action: "finish",
      sessionId: SESSION_ID,
      stageId: "tdd",
      outcome: "success",
      at: "2026-08-17T10:00:10.000Z",
    },
    { env, deliver },
  );
  assert.equal(finished.status, "finished");
  assert.deepEqual(finished.occurrence, {
    occurrenceId: OCCURRENCE_ID,
    stageId: "tdd",
    attempt: 1,
  });
  assert.deepEqual(delivered[2], {
    schemaVersion: 2,
    occurredAt: "2026-08-17T10:00:10.000Z",
    type: "workflow.stage.finished",
    runId: RUN_ID,
    data: {
      occurrenceId: OCCURRENCE_ID,
      stageId: "tdd",
      attempt: 1,
      outcome: "success",
    },
  });
});
