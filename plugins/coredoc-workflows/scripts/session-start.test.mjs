import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { sessionStartOutput } from "./session-start.mjs";
import {
  readWorkflowRun,
  startWorkflowStage,
  startWorkflowRun,
  suspendWorkflowRun,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-start-test";
const RUN_ID = "cdr-20260801-a1b2c3";
const NO_GIT = () => ({ available: false, repoRoot: "", head: "", fingerprint: "" });

function testEnv() {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-session-start-"),
    ),
  };
}

function startRunWithOpenStage(env) {
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "spec", after: [] }],
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
}

function event(overrides) {
  return { hook_event_name: "SessionStart", session_id: SESSION_ID, ...overrides };
}

test("a compacted session is told about its open run", () => {
  const env = testEnv();
  startRunWithOpenStage(env);
  const output = sessionStartOutput(event({ source: "compact" }), { env });
  const parsed = JSON.parse(output);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(
    parsed.hookSpecificOutput.additionalContext,
    new RegExp(`run ${RUN_ID} .* is active in this session\\. Open stage: spec\\.`),
  );
});

test("a resumed session reactivates its suspended run before describing it", () => {
  const env = testEnv();
  startRunWithOpenStage(env);
  suspendWorkflowRun(SESSION_ID, { at: "2026-08-01T10:05:00.000Z" }, { env });
  const output = sessionStartOutput(event({ source: "resume" }), { env });
  assert.match(
    JSON.parse(output).hookSpecificOutput.additionalContext,
    /is active in this session/,
  );
  const state = readWorkflowRun(SESSION_ID, { env });
  assert.equal(state.status, "active");
  assert.equal(state.suspendedAt, undefined);
  assert.equal(state.stageProgress.spec.finishedAt, undefined);
});

test("fresh sessions, subagents, other hooks, and sessions without a run stay silent", () => {
  const env = testEnv();
  assert.equal(sessionStartOutput(event({ source: "compact" }), { env }), "");
  startRunWithOpenStage(env);
  suspendWorkflowRun(SESSION_ID, { at: "2026-08-01T10:05:00.000Z" }, { env });
  assert.equal(sessionStartOutput(event({ source: "startup" }), { env }), "");
  assert.equal(sessionStartOutput(event({ source: "clear" }), { env }), "");
  assert.equal(
    sessionStartOutput(
      event({ source: "resume", agent_id: "scout-1", agent_type: "coredoc-scout" }),
      { env },
    ),
    "",
  );
  assert.equal(
    sessionStartOutput(
      { hook_event_name: "SessionEnd", session_id: SESSION_ID, source: "resume" },
      { env },
    ),
    "",
  );
  assert.equal(
    sessionStartOutput(event({ source: "resume", session_id: "not a session id" }), {
      env,
    }),
    "",
  );
  // None of the silent paths touched the suspended run.
  assert.equal(readWorkflowRun(SESSION_ID, { env }).status, "suspended");
});

test("SessionStart CLI emits the hook JSON on resume and nothing on startup", () => {
  const env = {
    ...testEnv(),
    HOME: mkdtempSync(join(tmpdir(), "coredoc-session-start-home-")),
  };
  startRunWithOpenStage(env);
  suspendWorkflowRun(SESSION_ID, { at: "2026-08-01T10:05:00.000Z" }, { env });
  const script = new URL("./session-start.mjs", import.meta.url).pathname;
  const resumed = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env,
    input: JSON.stringify(event({ source: "resume", cwd: "/private/PATH_SENTINEL" })),
    timeout: 2_500,
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stderr, "");
  assert.equal(
    JSON.parse(resumed.stdout).hookSpecificOutput.hookEventName,
    "SessionStart",
  );
  assert.equal(readWorkflowRun(SESSION_ID, { env }).status, "active");

  const started = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env,
    input: JSON.stringify(event({ source: "startup" })),
    timeout: 2_500,
  });
  assert.equal(started.status, 0, started.stderr);
  assert.equal(started.stdout, "");
  assert.equal(started.stderr, "");
});

test("a held stage lock defers the resume but still re-anchors the session", () => {
  const env = testEnv();
  startRunWithOpenStage(env);
  suspendWorkflowRun(SESSION_ID, { at: "2026-08-01T10:05:00.000Z" }, { env });
  const key = createHash("sha256").update(SESSION_ID).digest("hex");
  writeFileSync(join(env.COREDOC_WORKFLOWS_STATE_DIR, `${key}.json.lock`), "");
  const output = sessionStartOutput(event({ source: "resume" }), { env });
  assert.match(
    JSON.parse(output).hookSpecificOutput.additionalContext,
    /is suspended in this session\. Open stage: spec\./,
  );
  assert.equal(readWorkflowRun(SESSION_ID, { env }).status, "suspended");
});
