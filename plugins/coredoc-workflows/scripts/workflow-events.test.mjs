import assert from "node:assert/strict";
import test from "../test/test-api.mjs";

import {
  mintRunId,
  RUN_ID_RE,
  workflowEvent,
} from "./workflow-events.mjs";

const RUN_ID = "cdr-20260730-a1b2c3";
const FINISHED_SUMMARY = {
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
  findingsMeasurement: "measured",
  findingsInitial: 3,
  findingsResolved: 2,
  findingsRemaining: 2,
  findingsIntroduced: 1,
  coredocStatus: "partial",
  coredocCalls: 2,
  coredocFailures: 0,
  coredocGapCodes: ["callers-incomplete"],
  skillsUsed: [
    { name: "coredoc-tdd", count: 1 },
    { name: "foreign-plugin:review", count: 2 },
  ],
};

test("mints the canonical server-compatible run ID", () => {
  const runId = mintRunId({
    at: new Date("2026-07-30T10:00:00.000Z"),
    entropy: Buffer.from("a1b2c3", "hex"),
  });

  assert.equal(runId, RUN_ID);
  assert.match(runId, RUN_ID_RE);
  assert.throws(
    () =>
      mintRunId({
        at: new Date("2026-07-30T10:00:00.000Z"),
        entropy: Buffer.from("abcd", "hex"),
      }),
    /exactly 3 bytes/,
  );
});

test("requires the route dimensions", () => {
  const base = {
    at: "2026-07-30T10:00:00.000Z",
    runId: RUN_ID,
    workflowId: "change:normal",
  };

  assert.throws(
    () => workflowEvent({ ...base, type: "route.selected" }),
    /Unsupported intent/,
  );
});

test("rejects event types inherited from Object.prototype", () => {
  assert.throws(
    () =>
      workflowEvent({
        at: "2026-07-30T10:00:00.000Z",
        runId: RUN_ID,
        workflowId: "change:normal",
        type: "toString",
        intent: "change",
        risk: "normal",
      }),
    /Unsupported event type: toString/,
  );
});

test("rejects copied task, prompt, command, source, and specimen content", () => {
  for (const field of [
    "task",
    "prompt",
    "command",
    "source",
    "diff",
    "specimen",
    "path",
  ]) {
    assert.throws(
      () =>
        workflowEvent({
          at: "2026-07-30T10:00:00.000Z",
          runId: RUN_ID,
          workflowId: "change:normal",
          type: "route.selected",
          intent: "change",
          risk: "normal",
          [field]: "large copied content",
        }),
      new RegExp(`must not persist ${field}`),
    );
  }
});

test("rejects non-canonical run IDs", () => {
  assert.throws(
    () =>
      workflowEvent({
        at: "2026-07-30T10:00:00.000Z",
        runId: "run-42",
        workflowId: "change:normal",
        type: "route.selected",
        intent: "change",
        risk: "normal",
      }),
    /canonical cdr-YYYYMMDD-xxxxxx/,
  );
});

test("rejects inconsistent or open-ended finished summaries", () => {
  const base = {
    at: "2026-07-30T10:00:12.000Z",
    runId: RUN_ID,
    workflowId: "change:normal",
    type: "workflow.finished",
    intent: "change",
    risk: "normal",
  };
  assert.throws(
    () =>
      workflowEvent({
        ...base,
        summary: { ...FINISHED_SUMMARY, findingsRemaining: 99 },
      }),
    /must balance/,
  );
  assert.throws(
    () =>
      workflowEvent({
        ...base,
        summary: {
          ...FINISHED_SUMMARY,
          coredocGapCodes: ["free-form copied MCP response"],
        },
      }),
    /closed gap vocabulary/,
  );
  assert.throws(
    () =>
      workflowEvent({
        ...base,
        summary: { ...FINISHED_SUMMARY, prompt: "copied prompt" },
      }),
    /must not persist prompt/,
  );
  assert.throws(
    () =>
      workflowEvent({
        ...base,
        summary: {
          ...FINISHED_SUMMARY,
          skillsUsed: [
            {
              name: "foreign-plugin:review",
              count: 1,
              args: "private arguments",
            },
          ],
        },
      }),
    /Unsupported skill usage field: args/,
  );
  assert.throws(
    () =>
      workflowEvent({
        ...base,
        summary: {
          ...FINISHED_SUMMARY,
          skillsUsed: [{ name: "bad skill name", count: 1 }],
        },
      }),
    /compact identifier/,
  );
  assert.throws(
    () =>
      workflowEvent({
        ...base,
        summary: {
          ...FINISHED_SUMMARY,
          skillsUsed: Array.from({ length: 191 }, (_, index) => ({
            name: `plugin:skill-${index}`,
            count: 1,
          })),
        },
      }),
    /at most 190 entries/,
  );
});
