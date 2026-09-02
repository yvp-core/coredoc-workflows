import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { createHash } from "node:crypto";

import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import {
  artifactCheckpointDirectory,
  createArtifactCheckpointStore,
} from "./artifact-checkpoints.mjs";
import { sha256BindingNonce } from "./managed-otel-relay.mjs";
import { finishWorkflowSession } from "./session-end.mjs";
import {
  readWorkflowRun,
  startWorkflowStage,
  startWorkflowRun,
} from "./workflow-run-state.mjs";

test("SessionEnd queues an open stage abandonment before run finish at one timestamp", () => {
  const sessionId = "session-interrupted";
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-workflow-session-end-state-"),
  );
  const captureDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-workflow-session-end-capture-"),
  );
  const env = {
    ...process.env,
    COREDOC_WORKFLOWS_STATE_DIR: stateDirectory,
    COREDOC_WORKFLOWS_CAPTURE_DIR: captureDirectory,
    COREDOC_WORKFLOWS_REPO_KEY: "yvp-core/coredoc-parser",
    COREDOC_CAPTURE_ENDPOINT:
      "http://127.0.0.1:1/api/v1/workspaces/ws-1/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
  startWorkflowRun(
    {
      sessionId,
      runId: "cdr-20260801-a1b2c3",
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      requiredSkills: ["coredoc-spec", "coredoc-tdd"],
      declaredStages: [{ stageId: "spec", after: [] }],
      at: new Date(Date.now() - 1_000).toISOString(),
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );
  startWorkflowStage(
    sessionId,
    "spec",
    { at: new Date(Date.now() - 500).toISOString() },
    {
      env,
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    },
  );

  const result = spawnSync(
    process.execPath,
    [new URL("./session-end.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        prompt: "PROMPT_SENTINEL",
        cwd: "/private/PATH_SENTINEL",
        tool_output: "OUTPUT_SENTINEL",
      }),
      timeout: 2_500,
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  const recorder = createConfiguredCaptureRecorder({ env, sessionId });
  const pending = recorder.pending();
  assert.equal(pending.length, 2);
  for (const event of pending) {
    assert.match(event.eventId, /^[0-9a-f-]{36}$/);
    assert.equal(event.host, "claude-code");
    assert.equal(event.sessionId, sessionId);
    assert.equal(event.runId, "cdr-20260801-a1b2c3");
    assert.equal(event.repositoryKey, "yvp-core/coredoc-parser");
  }
  const stageFinished = pending.find(
    ({ type }) => type === "workflow.stage.finished",
  );
  const runFinished = pending.find(
    ({ type }) => type === "workflow.run.finished",
  );
  assert.deepEqual(stageFinished.data, {
    occurrenceId: "11111111-1111-4111-8111-111111111111",
    stageId: "spec",
    attempt: 1,
    outcome: "abandoned",
  });
  assert.equal(runFinished.data.outcome, "abandoned");
  assert.deepEqual(Object.keys(runFinished.data).sort(), ["counters", "outcome"]);
  assert.equal(stageFinished.occurredAt, runFinished.occurredAt);

  const persisted = readdirSync(captureDirectory)
    .filter((name) => name.endsWith(".event.json"))
    .map((name) => readFileSync(join(captureDirectory, name), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    persisted,
    /PROMPT_SENTINEL|PATH_SENTINEL|OUTPUT_SENTINEL/,
  );
  assert.equal(
    readdirSync(stateDirectory).some((name) => name.endsWith(".pending.json")),
    false,
  );
  assert.equal(readWorkflowRun(sessionId, { env }), null);
});

test("SessionEnd does not synthesize a stage when none is open", async () => {
  const sessionId = "session-no-open-stage";
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-session-no-stage-"),
    ),
  };
  startWorkflowRun(
    {
      sessionId,
      runId: "cdr-20260801-a1b2c3",
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "tdd", after: [] }],
      at: "2026-08-01T10:00:00.000Z",
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );
  const calls = [];
  await finishWorkflowSession(
    {
      sessionId,
      at: "2026-08-01T10:00:05.000Z",
    },
    {
      env,
      queueStage: () => calls.push("stage"),
      finishRun: async (input) => {
        calls.push(["run", input]);
        return { status: "finished" };
      },
    },
  );

  assert.deepEqual(calls, [
    [
      "run",
      {
        sessionId,
        outcome: "abandoned",
        at: "2026-08-01T10:00:05.000Z",
      },
    ],
  ]);
});

test("SessionEnd persists and queues the abandoned stage before run finish", async () => {
  const sessionId = "session-open-stage-order";
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-session-stage-order-"),
    ),
  };
  startWorkflowRun(
    {
      sessionId,
      runId: "cdr-20260801-a1b2c3",
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "tdd", after: [] }],
      at: "2026-08-01T10:00:00.000Z",
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );
  startWorkflowStage(
    sessionId,
    "tdd",
    { at: "2026-08-01T10:00:01.000Z" },
    {
      env,
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    },
  );
  const calls = [];
  await finishWorkflowSession(
    {
      sessionId,
      at: "2026-08-01T10:00:05.000Z",
    },
    {
      env,
      queueStage: (event) => {
        const progress = readWorkflowRun(sessionId, { env }).stageProgress.tdd;
        assert.equal(progress.outcome, "abandoned");
        calls.push(["stage", event]);
        return { status: "queued" };
      },
      finishRun: async (input) => {
        calls.push(["run", input]);
        return { status: "finished" };
      },
    },
  );

  assert.deepEqual(calls.map(([kind]) => kind), ["stage", "run"]);
  assert.equal(calls[0][1].occurredAt, "2026-08-01T10:00:05.000Z");
  assert.equal(calls[1][1].at, "2026-08-01T10:00:05.000Z");
});

// The abandon call is bookkeeping; the run record is the evidence. A corrupt
// stage record used to throw past the finish and leave the run active forever.
test("SessionEnd finishes the run as abandoned when stage progress is corrupt", async () => {
  const sessionId = "session-corrupt-stage";
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-workflow-session-corrupt-stage-"),
  );
  const env = { COREDOC_WORKFLOWS_STATE_DIR: stateDirectory };
  startWorkflowRun(
    {
      sessionId,
      runId: "cdr-20260801-a1b2c3",
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [
        { stageId: "spec", after: [] },
        { stageId: "tdd", after: ["spec"] },
      ],
      at: "2026-08-01T10:00:00.000Z",
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );
  const statePath = join(
    stateDirectory,
    `${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  const corrupted = JSON.parse(readFileSync(statePath, "utf8"));
  // Two open occurrences: the exact state a lost concurrent write produced,
  // which every later stage read rejects.
  corrupted.stageProgress = {
    spec: {
      occurrenceId: "11111111-1111-4111-8111-111111111111",
      stageId: "spec",
      attempt: 1,
      startedAt: "2026-08-01T10:00:01.000Z",
    },
    tdd: {
      occurrenceId: "22222222-2222-4222-8222-222222222222",
      stageId: "tdd",
      attempt: 1,
      startedAt: "2026-08-01T10:00:02.000Z",
    },
  };
  writeFileSync(statePath, `${JSON.stringify(corrupted)}\n`, "utf8");

  const result = await finishWorkflowSession(
    { sessionId, at: "2026-08-01T10:00:05.000Z" },
    {
      env,
      finishRun: (input, options) =>
        finishWorkflowRun(input, {
          ...options,
          checkpointArtifacts: async () => ({
            status: "disabled",
            queued: 0,
            sent: 0,
            pending: 0,
          }),
          deliver: async () => ({
            status: "disabled",
            durable: true,
            pending: 0,
          }),
        }),
    },
  );

  assert.deepEqual(result.stageAbandon, { status: "failed" });
  assert.equal(result.run.status, "finished");
  assert.equal(result.run.event.summary.outcome, "abandoned");
  assert.equal(readWorkflowRun(sessionId, { env }), null);
});

test("SessionEnd clears the run and records overflow health when the outbox is full", () => {
  const sessionId = "session-overflow";
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-workflow-session-end-overflow-state-"),
  );
  const captureDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-workflow-session-end-overflow-capture-"),
  );
  const env = {
    ...process.env,
    COREDOC_WORKFLOWS_STATE_DIR: stateDirectory,
    COREDOC_WORKFLOWS_CAPTURE_DIR: captureDirectory,
    COREDOC_CAPTURE_ENDPOINT:
      "http://127.0.0.1:1/api/v1/workspaces/ws-1/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
  };
  startWorkflowRun(
    {
      sessionId,
      runId: "cdr-20260801-a1b2c3",
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: new Date(Date.now() - 1_000).toISOString(),
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );
  const recorder = createConfiguredCaptureRecorder({ env, sessionId });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      recorder.record({
        occurredAt: new Date(Date.now() + index).toISOString(),
        type: "capability.used",
        data: {
          kind: "skill",
          capabilityId: `skill-${index}`,
          outcome: "success",
        },
      }).status,
      "queued",
    );
  }

  const result = spawnSync(
    process.execPath,
    [new URL("./session-end.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: sessionId,
      }),
      timeout: 2_500,
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(recorder.pending().length, 100);
  assert.equal(recorder.health().counters.overflow, 1);
  assert.equal(readWorkflowRun(sessionId, { env }), null);
});

test("SessionEnd queues configured artifacts locally without artifact fetch and stays within 750 ms", () => {
  const sessionId = "session-artifact-checkpoint";
  const repository = mkdtempSync(join(tmpdir(), "coredoc-session-end-artifact-repo-"));
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-session-end-artifact-home-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "coredoc-session-end-artifact-run-"));
  const fetchSentinel = join(stateHome, "artifact-fetch-was-called");
  mkdirSync(join(repository, ".coredoc"), { recursive: true });
  mkdirSync(join(repository, ".scratch", "delivery"), { recursive: true });
  writeFileSync(
    join(repository, ".coredoc", "delivery-observability.json"),
    JSON.stringify({
      schemaVersion: 1,
      artifacts: [{ glob: ".scratch/*/spec.md", kind: "spec" }],
    }),
  );
  writeFileSync(
    join(repository, ".scratch", "delivery", "spec.md"),
    "---\ncoredoc:\n  task_id: cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n  artifact_id: cda_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n  kind: spec\n---\n# V1\n",
  );
  const nonce = "session-end-local-binding";
  const env = {
    ...process.env,
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(
      [
        'import { writeFileSync } from "node:fs";',
        "globalThis.fetch = async (url) => {",
        '  if (String(url).includes("/delivery/v2/")) writeFileSync(process.env.ARTIFACT_FETCH_SENTINEL, "called");',
        '  throw new Error("offline");',
        "};",
      ].join("\n"),
    )}`,
    ARTIFACT_FETCH_SENTINEL: fetchSentinel,
    COREDOC_WORKFLOWS_STATE_DIR: stateDirectory,
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    COREDOC_WORKFLOWS_REPO_KEY: "coredoc/coredoc-parser",
    COREDOC_CAPTURE_ENDPOINT:
      "http://127.0.0.1:43181/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${nonce}`,
    COREDOC_CAPTURE_WORKSPACE_ID: "workspace-one",
  };
  startWorkflowRun(
    {
      sessionId,
      runId: "cdr-20260816-a1b2c3",
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: new Date(Date.now() - 1_000).toISOString(),
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: repository,
        head: "",
        fingerprint: "",
      }),
    },
  );

  const startedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    [new URL("./session-end.mjs", import.meta.url).pathname],
    {
      cwd: repository,
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        cwd: repository,
      }),
      timeout: 1_500,
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.ok(elapsed <= 750, `SessionEnd took ${elapsed}ms`);
  assert.equal(existsSync(fetchSentinel), false);

  const store = createArtifactCheckpointStore({
    directory: artifactCheckpointDirectory(
      join(stateHome, "capture-agent", "capture-relay"),
      sha256BindingNonce(nonce),
    ),
  });
  const [pending] = store.pending();
  assert.equal(pending.body.checkpoint, "session-end");
  assert.equal(pending.body.runId, "cdr-20260816-a1b2c3");
  assert.equal(pending.body.repositoryKey, "coredoc/coredoc-parser");
});
