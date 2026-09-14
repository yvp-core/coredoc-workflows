import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  abandonExpiredWorkflowRuns,
  captureIdentityEnv,
} from "./expired-runs.mjs";
import {
  readWorkflowRun,
  startWorkflowStage,
  startWorkflowRun,
  suspendWorkflowRun,
} from "./workflow-run-state.mjs";

const TTL_MS = 72 * 60 * 60 * 1000;
const NOW = Date.parse("2026-08-10T12:00:00.000Z");
const STALE_AT = "2026-08-01T10:05:00.000Z";
const END = {
  available: true,
  repoRoot: "/private/parked/repo",
  head: "b".repeat(40),
  fingerprint: "2".repeat(64),
  filesChanged: 2,
  trackedLinesAdded: 5,
  trackedLinesRemoved: 1,
};
const NO_GIT = () => ({ available: false, repoRoot: "", head: "", fingerprint: "" });

function testEnv() {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-expired-runs-"),
    ),
  };
}

function parkRun(
  sessionId,
  env,
  {
    suspendedAt = STALE_AT,
    runId = "cdr-20260801-a1b2c3",
    capture = {},
    repoRoot = "",
    withStage = true,
  } = {},
) {
  startWorkflowRun(
    {
      sessionId,
      runId,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "spec", after: [] }],
      at: "2026-08-01T10:00:00.000Z",
    },
    {
      env,
      snapshot: () => ({ ...NO_GIT(), repoRoot, available: repoRoot !== "" }),
    },
  );
  if (withStage) {
    startWorkflowStage(
      sessionId,
      "spec",
      { at: "2026-08-01T10:00:01.000Z" },
      { env, idFactory: () => "11111111-1111-4111-8111-111111111111" },
    );
  }
  suspendWorkflowRun(
    sessionId,
    { at: suspendedAt, capture },
    { env, snapshot: () => END },
  );
}

test("capture identity is exactly the capture variables, never the rest of the environment", () => {
  assert.deepEqual(
    captureIdentityEnv({
      COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture",
      COREDOC_CAPTURE_HEADERS: "X-Coredoc-Relay-Ingress=nonce",
      COREDOC_CAPTURE_REPOSITORY_STATE: "resolved",
      COREDOC_WORKFLOWS_REPO_KEY: "org/repo",
      COREDOC_WORKFLOWS_CAPTURE_DIR: "/private/capture",
      COREDOC_WORKFLOWS_SESSION_ID: "session-1",
      COREDOC_WORKFLOWS_STATE_DIR: "/private/state",
      HOME: "/private/home",
      PATH: "/usr/bin",
      COREDOC_CAPTURE_UNSET: undefined,
    }),
    {
      COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:43181/capture",
      COREDOC_CAPTURE_HEADERS: "X-Coredoc-Relay-Ingress=nonce",
      COREDOC_CAPTURE_REPOSITORY_STATE: "resolved",
      COREDOC_WORKFLOWS_REPO_KEY: "org/repo",
      COREDOC_WORKFLOWS_CAPTURE_DIR: "/private/capture",
    },
  );
});

test("an expired run is finished under its own identity, at its suspension time, with its own snapshot", async () => {
  const env = {
    ...testEnv(),
    COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:1/router",
    COREDOC_CAPTURE_BINDING_ID: "binding-router",
    COREDOC_WORKFLOWS_REPO_KEY: "router/repo",
    HOME: "/private/home",
  };
  parkRun("session-gone", env, {
    capture: {
      COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:1/own",
      COREDOC_CAPTURE_BINDING_ID: "binding-own",
    },
    repoRoot: "/private/parked/repo",
  });
  const calls = [];
  const expired = await abandonExpiredWorkflowRuns(
    { ownSessionId: "session-router", now: NOW },
    {
      env,
      queueStage: (event, options) => {
        calls.push(["stage", event.data.outcome, options.env, options.sessionId]);
        return { status: "queued", durable: true };
      },
      finishRun: async (input, options) => {
        const finished = options.complete(input.sessionId, {
          env: options.env,
          at: input.at,
        });
        calls.push(["run", input, options.env, options.cwd, finished.summary]);
        return { status: "finished" };
      },
    },
  );
  assert.deepEqual(expired, [
    {
      runId: "cdr-20260801-a1b2c3",
      sessionId: "session-gone",
      status: "finished",
      stageCapture: "queued",
    },
  ]);
  const ownIdentity = {
    COREDOC_WORKFLOWS_STATE_DIR: env.COREDOC_WORKFLOWS_STATE_DIR,
    HOME: "/private/home",
    COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:1/own",
    COREDOC_CAPTURE_BINDING_ID: "binding-own",
  };
  assert.deepEqual(calls[0], ["stage", "abandoned", ownIdentity, "session-gone"]);
  const [, input, runEnv, cwd, summary] = calls[1];
  assert.deepEqual(input, {
    sessionId: "session-gone",
    outcome: "abandoned",
    at: STALE_AT,
  });
  // The router's repository key and binding never reach the parked run.
  assert.deepEqual(runEnv, ownIdentity);
  assert.equal(cwd, "/private/parked/repo");
  assert.equal(summary.filesChangedAtFinish, END.filesChanged);
  assert.equal(summary.changed, true);
});

test("a run parked without capture stays uncaptured and checkpoints no artifacts", async () => {
  const env = {
    ...testEnv(),
    COREDOC_CAPTURE_ENDPOINT: "http://127.0.0.1:1/router",
    COREDOC_WORKFLOWS_REPO_KEY: "router/repo",
  };
  parkRun("session-gone", env, { withStage: false });
  const options = [];
  await abandonExpiredWorkflowRuns(
    { now: NOW },
    {
      env,
      finishRun: async (_input, received) => {
        options.push(received);
        return { status: "finished" };
      },
    },
  );
  assert.equal(options.length, 1);
  assert.deepEqual(options[0].env, {
    COREDOC_WORKFLOWS_STATE_DIR: env.COREDOC_WORKFLOWS_STATE_DIR,
  });
  assert.equal(options[0].cwd, undefined);
  assert.deepEqual(await options[0].checkpointArtifacts(), {
    status: "disabled",
    queued: 0,
    sent: 0,
    pending: 0,
  });
});

test("the sweep skips fresh and own runs, takes the oldest first, and stops at five", async () => {
  const env = testEnv();
  parkRun("session-fresh", env, { suspendedAt: "2026-08-10T11:00:00.000Z" });
  parkRun("session-own", env);
  for (const [index, sessionId] of [
    "session-e",
    "session-b",
    "session-d",
    "session-a",
    "session-c",
    "session-f",
  ].entries()) {
    parkRun(sessionId, env, {
      suspendedAt: `2026-08-01T10:1${index}:00.000Z`,
      runId: `cdr-20260801-00000${index}`,
    });
  }
  const finished = [];
  const expired = await abandonExpiredWorkflowRuns(
    { ownSessionId: "session-own", now: NOW },
    {
      env,
      queueStage: () => ({ status: "queued", durable: true }),
      finishRun: async (input) => {
        finished.push(input.sessionId);
        return { status: "finished" };
      },
    },
  );
  assert.deepEqual(finished, [
    "session-e",
    "session-b",
    "session-d",
    "session-a",
    "session-c",
  ]);
  assert.equal(expired.length, 5);
  assert.equal(readWorkflowRun("session-f", { env }).status, "suspended");
  assert.equal(readWorkflowRun("session-own", { env }).status, "suspended");
  assert.equal(readWorkflowRun("session-fresh", { env }).status, "suspended");
});

test("one failing run is reported and the sweep continues with the next", async () => {
  const env = testEnv();
  parkRun("session-poison", env, { suspendedAt: "2026-08-01T10:10:00.000Z" });
  parkRun("session-fine", env, {
    suspendedAt: "2026-08-01T10:11:00.000Z",
    runId: "cdr-20260801-ffffff",
  });
  const expired = await abandonExpiredWorkflowRuns(
    { now: NOW },
    {
      env,
      queueStage: () => ({ status: "queued", durable: true }),
      finishRun: async (input) => {
        if (input.sessionId === "session-poison") throw new Error("outbox full");
        return { status: "finished" };
      },
    },
  );
  assert.deepEqual(expired, [
    {
      runId: "cdr-20260801-a1b2c3",
      sessionId: "session-poison",
      status: "failed",
      message: "outbox full",
    },
    {
      runId: "cdr-20260801-ffffff",
      sessionId: "session-fine",
      status: "finished",
      stageCapture: "queued",
    },
  ]);
  // The failed run stays claimed for a while so the next sweep does not
  // immediately duplicate the attempt.
  assert.equal(readWorkflowRun("session-poison", { env }).status, "abandoning");
});

test("an expired run is closed end to end without a capture endpoint", async () => {
  const env = {
    ...testEnv(),
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
  parkRun("session-gone", env);
  const expired = await abandonExpiredWorkflowRuns({ now: NOW }, { env });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].status, "finished");
  assert.equal(readWorkflowRun("session-gone", { env }), null);
});
