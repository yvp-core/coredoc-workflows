import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  finishWorkflowRun,
  parseFinishArgs,
} from "./finish-run.mjs";
import {
  appendWorkflowObservation,
  readWorkflowRun,
  startWorkflowRun,
} from "./workflow-run-state.mjs";

const STATE = {
  runId: "cdr-20260731-a1b2c3",
  workflowId: "change:high",
  intent: "change",
  risk: "high",
};
const SUMMARY = {
  durationMs: 12_000,
  changed: true,
  headChanged: false,
  filesChangedAtFinish: 3,
  trackedLinesAddedAtFinish: 20,
  trackedLinesRemovedAtFinish: 4,
  editCalls: 4,
  editVerifyRounds: 1,
  verificationRuns: 3,
  verificationFailures: 1,
  verificationPasses: 2,
  coredocCalls: 2,
  coredocFailures: 0,
  skillsUsed: [
    { name: "coredoc-tdd", count: 1 },
    { name: "foreign-plugin:review", count: 2 },
  ],
};
const DISABLED_CAPTURE = Object.freeze({
  status: "disabled",
  durable: true,
  pending: 0,
});
const deliverDisabled = async () => DISABLED_CAPTURE;

function stageCaptureState(stageProgress) {
  return {
    ...STATE,
    requiredSkills: [],
    captureSchemaVersion: 2,
    stageCaptureVersion: 1,
    declaredStages: [
      { stageId: "spec", after: [] },
      { stageId: "tdd", after: ["spec"] },
    ],
    stageProgress,
  };
}

// Only session teardown records `abandoned`, and it calls finishWorkflowRun
// directly. Accepting the value here would let a caller file a workflow that
// finished as one that was walked away from.
test("rejects abandoned as a caller-supplied outcome", () => {
  assert.throws(
    () => parseFinishArgs(["--outcome", "abandoned"]),
    /--outcome must be one of: success, failed, blocked$/m,
  );
  for (const outcome of ["success", "failed", "blocked"]) {
    assert.equal(parseFinishArgs(["--outcome", outcome]).outcome, outcome);
  }
});

test("parses only closed outcome, finding, and Coredoc gap values", () => {
  assert.deepEqual(
    parseFinishArgs([
      "--outcome",
      "success",
      "--findings-measurement",
      "measured",
      "--findings-initial",
      "3",
      "--findings-resolved",
      "2",
      "--findings-remaining",
      "2",
      "--findings-introduced",
      "1",
      "--coredoc-status",
      "partial",
      "--coredoc-gap",
      "callers-incomplete",
      "--require-skill",
      "coredoc-workflows:coredoc-spec",
      "--require-skill",
      "foreign-plugin:author-profile",
    ]),
    {
      outcome: "success",
      findingsMeasurement: "measured",
      findingsInitial: 3,
      findingsResolved: 2,
      findingsRemaining: 2,
      findingsIntroduced: 1,
      coredocStatus: "partial",
      coredocGapCodes: ["callers-incomplete"],
      requiredSkillIds: [
        "coredoc-workflows:coredoc-spec",
        "foreign-plugin:author-profile",
      ],
    },
  );
  assert.throws(
    () =>
      parseFinishArgs([
        "--outcome",
        "success",
        "--coredoc-gap",
        "copied free-form explanation",
      ]),
    /must be one of/,
  );
  assert.throws(
    () =>
      parseFinishArgs([
        "--outcome",
        "success",
        "--require-skill",
        "not a compact skill id",
      ]),
    /compact skill identifier/,
  );
});

test("accepts bare and namespaced observations for automatic routed-stage gates", async () => {
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "success",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({
        state: {
          ...STATE,
          requiredSkills: ["coredoc-spec", "coredoc-tdd"],
        },
        summary: {
          ...SUMMARY,
          skillsUsed: [
            { name: "coredoc-workflows:coredoc-spec", count: 1 },
            { name: "coredoc-tdd", count: 1 },
          ],
        },
      }),
      deliver: deliverDisabled,
    },
  );

  assert.equal(result.status, "finished");
});

test("rejects successful completion before every routed stage runs", async () => {
  const calls = [];
  await assert.rejects(
    finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome: "success",
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: { ...STATE, requiredSkills: ["coredoc-spec", "coredoc-tdd"] },
          summary: {
            ...SUMMARY,
            skillsUsed: [{ name: "coredoc-spec", count: 1 }],
          },
        }),
        deliver: async () => {
          calls.push("deliver");
          return DISABLED_CAPTURE;
        },
        finalize: () => calls.push("finalize"),
      },
    ),
    /stage coredoc-tdd was routed but never executed/,
  );
  assert.deepEqual(calls, []);
});

const OPEN_SPEC = Object.freeze({
  occurrenceId: "11111111-1111-4111-8111-111111111111",
  stageId: "spec",
  attempt: 1,
  startedAt: "2026-07-31T10:00:01.000Z",
});

test("refuses a successful run finish while a captured stage is open", async () => {
  const calls = [];
  await assert.rejects(
    finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome: "success",
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: stageCaptureState({ spec: OPEN_SPEC }),
          summary: SUMMARY,
        }),
        deliver: async () => {
          calls.push("deliver");
          return DISABLED_CAPTURE;
        },
        finalize: () => calls.push("finalize"),
        abandonStage: () => {
          calls.push("abandon");
          return null;
        },
      },
    ),
    /stage spec is still open/i,
  );
  assert.deepEqual(calls, []);
});

// A crashed stage must not strand the run: the only other closer is SessionEnd.
test("abandons the open stage and still finishes a non-success run", async () => {
  for (const outcome of ["failed", "blocked", "abandoned"]) {
    const delivered = [];
    const finalized = [];
    const result = await finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome,
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: stageCaptureState({ spec: OPEN_SPEC }),
          summary: SUMMARY,
        }),
        deliver: async (event) => {
          delivered.push(event.type);
          return DISABLED_CAPTURE;
        },
        finalize: (...args) => finalized.push(args),
        abandonStage: (sessionId, { at }) => ({
          status: "finished",
          occurrence: {
            ...OPEN_SPEC,
            finishedAt: at,
            outcome: "abandoned",
          },
          event: {
            schemaVersion: 2,
            occurredAt: at,
            type: "workflow.stage.finished",
            runId: STATE.runId,
            data: {
              occurrenceId: OPEN_SPEC.occurrenceId,
              stageId: "spec",
              attempt: 1,
              outcome: "abandoned",
            },
          },
        }),
      },
    );

    assert.equal(result.status, "finished", outcome);
    assert.deepEqual(
      result.stageAbandon,
      { status: "abandoned", stageId: "spec", capture: DISABLED_CAPTURE },
      outcome,
    );
    assert.deepEqual(
      delivered,
      ["workflow.stage.finished", "workflow.run.finished"],
      outcome,
    );
    assert.equal(finalized.length, 1, outcome);
  }
});

test("finishes a non-success run when the open stage cannot be abandoned", async () => {
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "failed",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({
        state: stageCaptureState({ spec: OPEN_SPEC }),
        summary: SUMMARY,
      }),
      deliver: deliverDisabled,
      finalize: () => {},
      abandonStage: () => {
        throw new Error("persisted stage progress is invalid; route again");
      },
    },
  );

  assert.equal(result.status, "finished");
  assert.deepEqual(result.stageAbandon, { status: "failed" });
});

test("requires every declared captured stage to finish successfully on success", async () => {
  const spec = {
    occurrenceId: "11111111-1111-4111-8111-111111111111",
    stageId: "spec",
    attempt: 1,
    startedAt: "2026-07-31T10:00:01.000Z",
    finishedAt: "2026-07-31T10:00:02.000Z",
    outcome: "success",
  };
  await assert.rejects(
    finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome: "success",
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: stageCaptureState({ spec }),
          summary: SUMMARY,
        }),
        deliver: deliverDisabled,
      },
    ),
    /stage tdd has not finished successfully/i,
  );

  const failedTdd = {
    occurrenceId: "22222222-2222-4222-8222-222222222222",
    stageId: "tdd",
    attempt: 1,
    startedAt: "2026-07-31T10:00:03.000Z",
    finishedAt: "2026-07-31T10:00:04.000Z",
    outcome: "failed",
  };
  await assert.rejects(
    finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome: "success",
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: stageCaptureState({ spec, tdd: failedTdd }),
          summary: SUMMARY,
        }),
        deliver: deliverDisabled,
      },
    ),
    /stage tdd has not finished successfully.*latest outcome is failed/i,
  );

  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "success",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({
        state: {
          ...stageCaptureState({
            spec,
            tdd: { ...failedTdd, outcome: "success" },
          }),
          requiredSkills: ["coredoc-spec", "coredoc-tdd"],
        },
        summary: { ...SUMMARY, skillsUsed: [] },
      }),
      deliver: deliverDisabled,
    },
  );
  assert.equal(result.status, "finished");
});

test("allows non-success after the current stage closes and future stages are omitted", async () => {
  for (const outcome of ["failed", "blocked", "abandoned"]) {
    const result = await finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome,
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: stageCaptureState({
            spec: {
              occurrenceId: "11111111-1111-4111-8111-111111111111",
              stageId: "spec",
              attempt: 1,
              startedAt: "2026-07-31T10:00:01.000Z",
              finishedAt: "2026-07-31T10:00:02.000Z",
              outcome: "failed",
            },
          }),
          summary: SUMMARY,
        }),
        deliver: deliverDisabled,
      },
    );
    assert.equal(result.status, "finished", outcome);
  }
});

test("bypasses automatic routed-stage gates for non-success outcomes", async () => {
  for (const outcome of ["failed", "blocked", "abandoned"]) {
    const result = await finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome,
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: {},
        complete: () => ({
          state: { ...STATE, requiredSkills: ["coredoc-spec"] },
          summary: { ...SUMMARY, skillsUsed: [] },
        }),
        deliver: deliverDisabled,
      },
    );
    assert.equal(result.event.summary.outcome, outcome);
  }
});

test("enforces explicit skill requirements for every outcome", async () => {
  for (const outcome of ["success", "failed", "blocked", "abandoned"]) {
    await assert.rejects(
      finishWorkflowRun(
        {
          sessionId: "session-42",
          outcome,
          requiredSkillIds: ["foreign-plugin:author-profile"],
          at: "2026-07-31T10:00:12.000Z",
        },
        {
          env: {},
          complete: () => ({
            state: STATE,
            summary: { ...SUMMARY, skillsUsed: [] },
          }),
          deliver: deliverDisabled,
        },
      ),
      /required skill foreign-plugin:author-profile was never executed/,
    );
  }
});

test("prioritizes explicit skill requirements in bounded observations", async () => {
  let completionOptions;
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "success",
      requiredSkillIds: ["foreign-plugin:author-profile"],
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: (_sessionId, options) => {
        completionOptions = options;
        return {
          state: STATE,
          summary: {
            ...SUMMARY,
            skillsUsed: [
              { name: "foreign-plugin:author-profile", count: 1 },
            ],
          },
        };
      },
      deliver: deliverDisabled,
    },
  );

  assert.equal(result.status, "finished");
  assert.deepEqual(completionOptions.requiredSkills, [
    "foreign-plugin:author-profile",
  ]);
});

test("distinguishes unattributed hosts from missing active run state", async () => {
  assert.deepEqual(
    await finishWorkflowRun(
      {
        sessionId: undefined,
        outcome: "success",
        at: "2026-07-31T10:00:12.000Z",
      },
      { env: {}, complete: () => null },
    ),
    { status: "unattributed" },
  );

  const result = await finishWorkflowRun(
    {
      sessionId: undefined,
      outcome: "abandoned",
      at: "2026-07-31T10:00:12.000Z",
    },
    { env: {}, complete: () => null },
  );
  assert.deepEqual(result, { status: "unattributed" });

  assert.deepEqual(
    await finishWorkflowRun(
      {
        sessionId: undefined,
        outcome: "blocked",
        requiredSkillIds: ["foreign-plugin:author-profile"],
        at: "2026-07-31T10:00:12.000Z",
      },
      { env: {}, complete: () => null },
    ),
    { status: "unattributed" },
  );

  await assert.rejects(
    finishWorkflowRun(
      {
        sessionId: "session-state-was-lost",
        outcome: "success",
        at: "2026-07-31T10:00:12.000Z",
      },
      { env: {}, complete: () => null },
    ),
    /active workflow run state is missing.*route again/i,
  );

  assert.deepEqual(
    await finishWorkflowRun(
      {
        sessionId: "session-no-active-run",
        outcome: "abandoned",
        at: "2026-07-31T10:00:12.000Z",
      },
      { env: {}, complete: () => null },
    ),
    { status: "inactive" },
  );
});

test("CLI reports unattributed completion as structured non-success", () => {
  const env = {
    ...process.env,
    COREDOC_WORKFLOWS_SESSION_ID: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
  const result = spawnSync(
    process.execPath,
    [
      new URL("./finish-run.mjs", import.meta.url).pathname,
      "--outcome",
      "success",
    ],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { status: "unattributed" });
  assert.equal(result.stderr, "");
});

test("CLI finishes the active run for the native Codex session", () => {
  const codexSessionId = "44444444-4444-4444-8444-444444444444";
  const env = {
    ...process.env,
    CODEX_SESSION_ID: codexSessionId,
    CODEX_THREAD_ID: codexSessionId,
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-codex-finish-state-"),
    ),
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
  };
  delete env.COREDOC_WORKFLOWS_SESSION_ID;
  startWorkflowRun(
    {
      sessionId: codexSessionId,
      runId: "cdr-20260818-a1b2c3",
      workflowId: "direct",
      intent: "direct",
      risk: "normal",
      declaredStages: [],
      at: "2026-08-18T10:00:00.000Z",
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

  const result = spawnSync(
    process.execPath,
    [
      new URL("./finish-run.mjs", import.meta.url).pathname,
      "--outcome",
      "success",
    ],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "finished");
  assert.equal(readWorkflowRun(codexSessionId, { env }), null);
});

test("keeps a paused run open and resumes completion with the same run ID", async () => {
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-finish-gate-"),
    ),
  };
  const sessionId = "session-paused";
  const runId = "cdr-20260731-d4e5f6";
  startWorkflowRun(
    {
      sessionId,
      runId,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      requiredSkills: [
        "coredoc-spec",
        "coredoc-plan-review",
        "coredoc-tdd",
        "coredoc-review",
      ],
      at: "2026-07-31T10:00:00.000Z",
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
  for (const skillId of [
    "coredoc-workflows:coredoc-spec",
    "coredoc-plan-review",
  ]) {
    appendWorkflowObservation(
      sessionId,
      { type: "skill", skillId, at: "2026-07-31T10:00:05.000Z" },
      { env },
    );
  }

  await assert.rejects(
    finishWorkflowRun(
      { sessionId, outcome: "success", at: "2026-07-31T10:00:10.000Z" },
      { env, deliver: deliverDisabled },
    ),
    /stage coredoc-tdd was routed but never executed/,
  );
  assert.equal(readWorkflowRun(sessionId, { env }).runId, runId);

  for (const skillId of ["coredoc-tdd", "coredoc-workflows:coredoc-review"]) {
    appendWorkflowObservation(
      sessionId,
      { type: "skill", skillId, at: "2026-07-31T10:00:11.000Z" },
      { env },
    );
  }
  const result = await finishWorkflowRun(
    { sessionId, outcome: "success", at: "2026-07-31T10:00:12.000Z" },
    { env, deliver: deliverDisabled },
  );

  assert.equal(result.event.runId, runId);
  assert.equal(readWorkflowRun(sessionId, { env }), null);
});

test("delivers one exact C1 finish event before finalizing local run evidence", async () => {
  const calls = [];
  const captureResult = {
    status: "sent",
    durable: true,
    eventId: "11111111-1111-4111-8111-111111111111",
    pending: 0,
    bindingRefused: 1,
    unreadable: 2,
  };
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "success",
      findingsMeasurement: "measured",
      findingsInitial: 3,
      findingsResolved: 2,
      findingsRemaining: 2,
      findingsIntroduced: 1,
      coredocStatus: "partial",
      coredocGapCodes: ["callers-incomplete"],
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      timeoutMs: 750,
      complete: () => ({ state: STATE, summary: SUMMARY }),
      deliver: async (...args) => {
        calls.push(["deliver", ...args]);
        return captureResult;
      },
      finalize: (...args) => calls.push(["finalize", ...args]),
    },
  );

  assert.equal(result.status, "finished");
  assert.deepEqual(result.capture, captureResult);
  assert.equal(result.pending, false);
  assert.equal(result.event.type, "workflow.finished");
  assert.deepEqual(result.event.summary, {
    outcome: "success",
    durationMs: 12_000,
    changed: true,
    headChanged: false,
    editCalls: 4,
    editVerifyRounds: 1,
    verificationRuns: 3,
    verificationFailures: 1,
    verificationPasses: 2,
    filesChangedAtFinish: 3,
    trackedLinesAddedAtFinish: 20,
    trackedLinesRemovedAtFinish: 4,
    findingsInitial: 3,
    findingsResolved: 2,
    findingsRemaining: 2,
    findingsIntroduced: 1,
    findingsMeasurement: "measured",
    coredocStatus: "partial",
    coredocCalls: 2,
    coredocFailures: 0,
    coredocGapCodes: ["callers-incomplete"],
    skillsUsed: [
      { name: "coredoc-tdd", count: 1 },
      { name: "foreign-plugin:review", count: 2 },
    ],
  });
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["deliver", "finalize"],
  );
  assert.deepEqual(calls[0], [
    "deliver",
    {
      occurredAt: "2026-07-31T10:00:12.000Z",
      type: "workflow.run.finished",
      runId: STATE.runId,
      data: {
        outcome: "success",
        counters: {
          editCalls: 4,
          editVerifyRounds: 1,
          verificationRuns: 3,
          verificationFailures: 1,
          verificationPasses: 2,
          coredocCalls: 2,
          coredocFailures: 0,
        },
      },
    },
    { env: {}, sessionId: "session-42", timeoutMs: 750 },
  ]);
  assert.deepEqual(calls[1], [
    "finalize",
    "session-42",
    STATE.runId,
    { env: {} },
  ]);
});

test("finishes a declared v2 run with the unchanged v1 finish data", async () => {
  const calls = [];
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "blocked",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({
        state: {
          ...STATE,
          captureSchemaVersion: 2,
          declaredStages: [{ stageId: "tdd", after: [] }],
        },
        summary: SUMMARY,
      }),
      deliver: async (event) => {
        calls.push(event);
        return DISABLED_CAPTURE;
      },
      finalize: () => {},
    },
  );

  assert.equal(result.status, "finished");
  assert.deepEqual(calls, [
    {
      schemaVersion: 2,
      occurredAt: "2026-07-31T10:00:12.000Z",
      type: "workflow.run.finished",
      runId: STATE.runId,
      data: {
        outcome: "blocked",
        counters: {
          editCalls: 4,
          editVerifyRounds: 1,
          verificationRuns: 3,
          verificationFailures: 1,
          verificationPasses: 2,
          coredocCalls: 2,
          coredocFailures: 0,
        },
      },
    },
  ]);
});

test("finalizes local run evidence when the durably queued event is pending", async () => {
  const calls = [];
  const captureResult = {
    status: "pending",
    durable: true,
    eventId: "22222222-2222-4222-8222-222222222222",
    pending: 1,
  };
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "abandoned",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({ state: STATE, summary: SUMMARY }),
      deliver: async (...args) => {
        calls.push(["deliver", ...args]);
        return captureResult;
      },
      finalize: (...args) => calls.push(["finalize", ...args]),
    },
  );

  assert.equal(result.event.summary.outcome, "abandoned");
  assert.deepEqual(result.capture, captureResult);
  assert.equal(result.pending, true);
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["deliver", "finalize"],
  );
});

test("finalizes the active run after surfacing a non-durable overflow", async () => {
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-finish-overflow-"),
    ),
  };
  startWorkflowRun(
    {
      sessionId: "session-42",
      ...STATE,
      at: "2026-07-31T10:00:00.000Z",
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
  const captureResult = {
    status: "overflow",
    durable: false,
    eventId: "33333333-3333-4333-8333-333333333333",
    pending: 100,
    bindingRefused: 2,
    unreadable: 1,
  };
  const result = await finishWorkflowRun(
    { sessionId: "session-42", outcome: "success", at: "2026-07-31T10:00:12.000Z" },
    {
      env,
      deliver: async (...args) => {
        calls.push(["deliver", ...args]);
        return captureResult;
      },
    },
  );

  assert.deepEqual(result.capture, captureResult);
  assert.equal(result.pending, true);
  assert.deepEqual(calls.map(([kind]) => kind), ["deliver"]);
  assert.equal(readWorkflowRun("session-42", { env }), null);
});

test("finalizes when capture fails before durable recording", async () => {
  const calls = [];
  const captureResult = { status: "failed", durable: false };
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "failed",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({ state: STATE, summary: SUMMARY }),
      deliver: async () => captureResult,
      finalize: (...args) => calls.push(args),
    },
  );

  assert.deepEqual(result.capture, captureResult);
  assert.equal(result.pending, true);
  assert.deepEqual(calls, [["session-42", STATE.runId, { env: {} }]]);
});

test("capture misconfiguration never blocks the next routed run", async () => {
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-finish-misconfigured-"),
    ),
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "",
  };
  startWorkflowRun(
    {
      sessionId: "session-42",
      ...STATE,
      at: "2026-07-31T10:00:00.000Z",
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

  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "failed",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env,
      complete: () => ({
        state: readWorkflowRun("session-42", { env }),
        summary: SUMMARY,
      }),
    },
  );

  assert.deepEqual(result.capture, { status: "failed", durable: false });
  assert.equal(readWorkflowRun("session-42", { env }), null);
  assert.equal(
    startWorkflowRun(
      {
        sessionId: "session-42",
        ...STATE,
        runId: "cdr-20260731-d4e5f6",
        at: "2026-07-31T10:00:13.000Z",
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
    ).status,
    "started",
  );
});

test("distinguishes unmeasured findings and unused Coredoc from zero findings", async () => {
  const result = await finishWorkflowRun(
    {
      sessionId: "session-42",
      outcome: "blocked",
      at: "2026-07-31T10:00:12.000Z",
    },
    {
      env: {},
      complete: () => ({
        state: STATE,
        summary: { ...SUMMARY, coredocCalls: 0, coredocFailures: 0 },
      }),
      deliver: deliverDisabled,
    },
  );

  assert.equal(result.event.summary.findingsMeasurement, "not-measured");
  assert.equal(result.event.summary.findingsInitial, null);
  assert.equal(result.event.summary.coredocStatus, "not-used");
  assert.deepEqual(result.capture, DISABLED_CAPTURE);
  assert.equal(result.pending, false);
});

test("owes graph feedback only when a caller used the graph and is still there", async () => {
  const finish = (outcome, coredocCalls) =>
    finishWorkflowRun(
      { sessionId: "session-42", outcome, at: "2026-07-31T10:00:12.000Z" },
      {
        env: {},
        complete: () => ({
          state: STATE,
          summary: { ...SUMMARY, coredocCalls, coredocFailures: 0 },
        }),
        deliver: deliverDisabled,
      },
    );

  for (const outcome of ["success", "failed", "blocked"]) {
    assert.equal((await finish(outcome, 2)).feedbackOwed, true, outcome);
    assert.equal((await finish(outcome, 0)).feedbackOwed, false, outcome);
  }

  // Session teardown writes `abandoned` with no caller left to author feedback.
  assert.equal((await finish("abandoned", 2)).feedbackOwed, false);
});

test("claims no feedback is owed when the host supplies no completion evidence", async () => {
  for (const outcome of ["blocked", "abandoned"]) {
    const result = await finishWorkflowRun(
      { sessionId: undefined, outcome, at: "2026-07-31T10:00:12.000Z" },
      { env: {}, complete: () => null },
    );
    assert.equal(result.feedbackOwed, undefined, outcome);
  }
});

test("normal finish and SessionEnd queue artifacts locally before capture", async () => {
  for (const outcome of ["success", "abandoned"]) {
    const calls = [];
    const result = await finishWorkflowRun(
      {
        sessionId: "session-42",
        outcome,
        at: "2026-07-31T10:00:12.000Z",
      },
      {
        env: { COREDOC_WORKFLOWS_REPO_KEY: "acme/api" },
        cwd: "/synthetic/repository",
        timeoutMs: 750,
        now: () => 1_000,
        complete: () => ({ state: STATE, summary: SUMMARY }),
        checkpointArtifacts: async (options) => {
          calls.push(["artifacts", options]);
          return { status: "queued", queued: 1, sent: 0, pending: 1 };
        },
        deliver: async () => {
          calls.push(["capture"]);
          return DISABLED_CAPTURE;
        },
        finalize: () => calls.push(["finalize"]),
      },
    );

    assert.deepEqual(calls.map(([kind]) => kind), ["artifacts", "capture", "finalize"]);
    assert.deepEqual(calls[0][1], {
      env: { COREDOC_WORKFLOWS_REPO_KEY: "acme/api" },
      cwd: "/synthetic/repository",
      checkpoint: outcome === "success" ? "run-finish" : "session-end",
      runId: STATE.runId,
      flush: false,
      timeoutMs: 750,
      ...(outcome === "abandoned" ? { deadlineAt: 1_750 } : {}),
    });
    assert.equal(result.artifacts.pending, 1);
    assert.equal(result.pending, true);
  }
});
