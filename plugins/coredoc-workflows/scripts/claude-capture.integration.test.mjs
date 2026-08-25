import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { createCaptureRecorder } from "../runtime/capture/index.mjs";
import { deliverCaptureEvent } from "./capture-client.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { runWorkflowStage } from "./stage-run.mjs";
import { observeHookEvent } from "./workflow-observer.mjs";
import {
  prepareRoutedTask,
  recordRoutedTaskCapture,
} from "./route-task.mjs";
import {
  completeWorkflowRun,
  readWorkflowRun,
  startWorkflowRun,
} from "./workflow-run-state.mjs";

const REAL_USER_PROMPT_EXPANSION = JSON.parse(
  readFileSync(
    new URL(
      "./hosts/fixtures/claude-2.1.232-user-prompt-expansion.redacted.json",
      import.meta.url,
    ),
    "utf8",
  ),
).payload;

const SESSION_ID = "session-e2e";
const RUN_ID = "cdr-20260816-a1b2c3";
const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
];
const OCCURRENCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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

test("explicit stage boundaries emit an exact private-data-free v2 sequence", async () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-claude-capture-e2e-"));
  const env = {
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_CAPTURE_DIR: join(root, "capture"),
    COREDOC_WORKFLOWS_REPO_KEY: "coredoc/coredoc-parser",
    COREDOC_WORKFLOWS_SESSION_ID: SESSION_ID,
    COREDOC_WORKFLOWS_STATE_DIR: join(root, "runs"),
    // Legacy workflow OTLP configuration must not affect semantic capture.
    OTEL_EXPORTER_OTLP_ENDPOINT: "https://legacy.invalid/otel",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer LEGACY_SENTINEL",
  };
  const sent = [];
  const remainingIds = [...IDS];
  const send = async (_target, batch) => {
    sent.push(...batch.events);
    return {
      acceptedEventIds: batch.events.map(({ eventId }) => eventId),
      duplicateEventIds: [],
      rejected: [],
    };
  };
  const createRecorder = (options) => {
    const recorder = createCaptureRecorder({
      ...options,
      idFactory: () => remainingIds.shift(),
    });
    return {
      ...recorder,
      flush: (flushOptions = {}) =>
        recorder.flush({ ...flushOptions, send }),
    };
  };

  const routed = prepareRoutedTask(
    { intent: "change", risk: "normal", scale: "normal" },
    {
      at: new Date("2026-08-16T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  assert.equal(routed.route.runId, RUN_ID);
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: routed.route.runId,
      workflowId: routed.route.workflowId,
      intent: routed.route.intent,
      risk: routed.route.risk,
      requiredSkills: routed.route.stages.map(({ skill }) => skill),
      declaredStages: routed.route.stages.map(({ id, after }) => ({
        stageId: id,
        after,
      })),
      at: routed.event.at,
    },
    { env, snapshot: noRepositorySnapshot },
  );
  assert.equal(
    (
      await recordRoutedTaskCapture(routed, { env, createRecorder })
    ).status,
    "sent",
  );
  assert.equal(
    (
      await runWorkflowStage(
        {
          action: "start",
          sessionId: SESSION_ID,
          stageId: "tdd",
          at: "2026-08-16T10:00:00.500Z",
        },
        {
          env,
          idFactory: () => OCCURRENCE_ID,
          deliver: (event, options) =>
            deliverCaptureEvent(event, { ...options, createRecorder }),
        },
      )
    ).status,
    "started",
  );

  const observations = [
    REAL_USER_PROMPT_EXPANSION,
    {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "coredoc-tdd", args: "ARGS_SENTINEL" },
      tool_response: { content: "RESULT_SENTINEL" },
    },
    { hook_event_name: "PostToolUse", tool_name: "Edit" },
    {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "pnpm test -- PRIVATE_COMMAND_SENTINEL" },
      error: "OUTPUT_SENTINEL",
    },
    { hook_event_name: "PostToolUse", tool_name: "Edit" },
    {
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
    },
  ];
  for (const [index, observation] of observations.entries()) {
    observeHookEvent(
      { ...observation, session_id: SESSION_ID },
      {
        env,
        at: `2026-08-16T10:00:0${index + 1}.000Z`,
        createRecorder,
      },
    );
  }
  assert.equal(
    (
      await runWorkflowStage(
        {
          action: "finish",
          sessionId: SESSION_ID,
          stageId: "tdd",
          outcome: "success",
          at: "2026-08-16T10:00:09.000Z",
        },
        {
          env,
          deliver: (event, options) =>
            deliverCaptureEvent(event, { ...options, createRecorder }),
        },
      )
    ).status,
    "finished",
  );

  const result = await finishWorkflowRun(
    {
      sessionId: SESSION_ID,
      outcome: "success",
      at: "2026-08-16T10:00:10.000Z",
    },
    {
      env,
      complete: (sessionId, options) =>
        completeWorkflowRun(sessionId, {
          ...options,
          snapshot: noRepositorySnapshot,
        }),
      deliver: (event, options) =>
        deliverCaptureEvent(event, { ...options, createRecorder }),
    },
  );

  assert.equal(result.status, "finished");
  assert.equal(result.capture.status, "sent");
  assert.equal(readWorkflowRun(SESSION_ID, { env }), null);
  assert.deepEqual(
    sent.map(({ eventId, type }) => ({ eventId, type })),
    [
      { eventId: IDS[0], type: "workflow.run.started" },
      { eventId: IDS[1], type: "workflow.stage.started" },
      { eventId: IDS[2], type: "capability.used" },
      { eventId: IDS[3], type: "capability.used" },
      { eventId: IDS[4], type: "workflow.stage.finished" },
      { eventId: IDS[5], type: "workflow.run.finished" },
    ],
  );
  assert.deepEqual(
    sent.map(({ schemaVersion }) => schemaVersion),
    [2, 2, 1, 1, 2, 2],
  );
  assert.deepEqual(sent[0].data.stages, [{ stageId: "tdd", after: [] }]);
  assert.deepEqual(
    sent.map(({ sessionId, runId }) => ({ sessionId, runId })),
    Array.from({ length: 6 }, () => ({ sessionId: SESSION_ID, runId: RUN_ID })),
  );
  assert.deepEqual(sent[1].data, {
    occurrenceId: OCCURRENCE_ID,
    stageId: "tdd",
    attempt: 1,
  });
  assert.deepEqual(sent[4].data, {
    occurrenceId: OCCURRENCE_ID,
    stageId: "tdd",
    attempt: 1,
    outcome: "success",
  });
  assert.deepEqual(sent[5].data, {
    outcome: "success",
    counters: {
      editCalls: 2,
      editVerifyRounds: 1,
      verificationRuns: 2,
      verificationFailures: 1,
      verificationPasses: 1,
      coredocCalls: 0,
      coredocFailures: 0,
    },
  });
  assert.deepEqual(sent[2].data, {
    kind: "skill",
    capabilityId: "coredoc-fixture:fixture-capability",
    outcome: "unknown",
  });
  assert.deepEqual(Object.keys(sent[5].data).sort(), ["counters", "outcome"]);
  assert.doesNotMatch(
    JSON.stringify(sent),
    /PROMPT_SENTINEL|ARGS_SENTINEL|RESULT_SENTINEL|PATH_SENTINEL|TRANSCRIPT_SENTINEL|PRIVATE_COMMAND_SENTINEL|OUTPUT_SENTINEL|LEGACY_SENTINEL/,
  );
});
