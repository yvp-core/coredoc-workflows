import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "../test/test-api.mjs";

import { createCaptureRecorder } from "../runtime/capture/index.mjs";
import { createConfiguredCaptureRecorder } from "./capture-client.mjs";
import {
  retryPendingCaptureEvents,
  retrySessionStartDelivery,
} from "./retry-pending.mjs";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET =
  "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events";
const HEADERS = { Authorization: "Bearer capture-token" };
const ACCEPT_ALL_FETCH_PRELOAD = fileURLToPath(
  new URL("../test/accept-all-fetch-preload.mjs", import.meta.url),
);

function acceptAllFetchChild(script) {
  return process.versions.bun
    ? ["--preload", ACCEPT_ALL_FETCH_PRELOAD, script]
    : [script];
}

function acceptAllFetchEnv() {
  return process.versions.bun
    ? {}
    : {
        NODE_OPTIONS: `--import=${pathToFileURL(ACCEPT_ALL_FETCH_PRELOAD).href}`,
      };
}

function testEnv(directory) {
  return {
    COREDOC_CAPTURE_ENDPOINT: TARGET,
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_CAPTURE_DIR: directory,
    COREDOC_WORKFLOWS_REPO_KEY: "yvp-core/coredoc-parser",
  };
}

function seedRecorder(directory) {
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: {
      host: "claude-code",
      sessionId: "original-session",
      repositoryKey: "yvp-core/coredoc-parser",
    },
    idFactory: () => EVENT_ID,
  });
  recorder.record({
    occurredAt: "2026-08-16T10:00:00.000Z",
    type: "capability.used",
    data: {
      kind: "skill",
      capabilityId: "coredoc-spec",
      outcome: "success",
    },
  });
  return recorder;
}

test("flushes the current capture binding once within the SessionStart budget without session attribution", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-call-"));
  const env = testEnv(directory);
  const calls = [];
  const send = async () => ({
    acceptedEventIds: [],
    duplicateEventIds: [],
    rejected: [],
  });

  const result = await retryPendingCaptureEvents({
    env,
    cwd: "/repository",
    send,
    createRecorder: (options) => {
      calls.push(["create", options]);
      return {
        flush: async (flushOptions) => {
          calls.push(["flush", flushOptions]);
          return {
            attempted: 0,
            accepted: 0,
            duplicates: 0,
            rejected: 0,
            unmatched: 0,
            pending: 0,
            bindingRefused: 2,
            unreadable: 1,
            receipt: {
              acceptedEventIds: [],
              duplicateEventIds: [],
              rejected: [],
            },
          };
        },
      };
    },
  });

  assert.deepEqual(calls, [
    ["create", { env, cwd: "/repository" }],
    ["flush", { send, timeoutMs: 750 }],
  ]);
  assert.deepEqual(result, {
    status: "sent",
    attempted: 0,
    sent: 0,
    pending: 0,
    bindingRefused: 2,
    unreadable: 1,
  });
});

test("retains the stable event ID offline and removes it only after an exact receipt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-stable-"));
  const env = testEnv(directory);
  const original = seedRecorder(directory);
  const createRecorder = () =>
    createCaptureRecorder({
      directory,
      target: TARGET,
      headers: HEADERS,
      // Retry is deliberately not attributed to the new SessionStart payload.
      context: { host: "claude-code", sessionId: undefined },
    });

  const failed = await retryPendingCaptureEvents({
    env,
    createRecorder,
    send: async () => {
      throw new Error("offline");
    },
  });
  assert.deepEqual(failed, {
    status: "pending",
    attempted: 1,
    sent: 0,
    pending: 1,
  });
  assert.deepEqual(
    original.pending().map(({ eventId }) => eventId),
    [EVENT_ID],
  );

  let retriedEvent;
  const accepted = await retryPendingCaptureEvents({
    env: { ...env, COREDOC_WORKFLOWS_SESSION_ID: "different-new-session" },
    createRecorder,
    send: async (_target, batch) => {
      [retriedEvent] = batch.events;
      return {
        acceptedEventIds: [batch.events[0].eventId],
        duplicateEventIds: [],
        rejected: [],
      };
    },
  });

  assert.equal(retriedEvent.eventId, EVENT_ID);
  assert.equal(retriedEvent.sessionId, "original-session");
  assert.deepEqual(accepted, {
    status: "sent",
    attempted: 1,
    sent: 1,
    pending: 0,
    bindingRefused: 0,
    unreadable: 0,
  });
  assert.deepEqual(original.pending(), []);
});

test("SessionStart silently removes a v3 backlog event rejected by a downgraded relay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-v3-retry-"));
  const env = testEnv(directory);
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "original-session" },
    idFactory: () => EVENT_ID,
    now: () => "2026-08-18T12:00:00.000Z",
  });
  recorder.record({
    schemaVersion: 3,
    occurredAt: "2026-08-18T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260818-a1b2c3",
    data: {
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      scale: "normal",
      stages: [],
      workItems: [{ provider: "jira", externalId: "10042" }],
    },
  });

  assert.deepEqual(
    await retryPendingCaptureEvents({
      env,
      createRecorder: () => recorder,
      send: async () => ({
        acceptedEventIds: [],
        duplicateEventIds: [],
        rejected: [{ eventId: EVENT_ID, code: "INVALID_EVENT" }],
      }),
    }),
    {
      status: "sent",
      attempted: 1,
      sent: 0,
      pending: 0,
      bindingRefused: 0,
      unreadable: 0,
    },
  );
  assert.deepEqual(recorder.pending(), []);
  assert.equal(recorder.health().errorCode, null);
});

test("disabled capture neither constructs nor scans an outbox", async () => {
  const result = await retryPendingCaptureEvents({
    env: {
      COREDOC_CAPTURE_ENDPOINT: "",
      COREDOC_WORKFLOWS_SESSION_ID: "session-start-must-not-matter",
    },
    createRecorder: () => {
      throw new Error("disabled retry must not inspect capture state");
    },
  });
  assert.deepEqual(result, { status: "disabled", attempted: 0, sent: 0 });
});

test("SessionStart retry CLI is silent", () => {
  const result = spawnSync(
    process.execPath,
    [new URL("./retry-pending.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COREDOC_CAPTURE_ENDPOINT: "",
        COREDOC_CAPTURE_HEADERS: "",
        COREDOC_WORKFLOWS_SESSION_ID: "session-start",
      },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("SessionStart payload cwd selects the staged capture namespace", () => {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-home-"));
  const payloadCwd = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-payload-"));
  const processCwd = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-process-"));
  const env = {
    ...process.env,
    ...acceptAllFetchEnv(),
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    COREDOC_CAPTURE_ENDPOINT: TARGET,
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_REPO_KEY: "yvp-core/coredoc-parser",
  };
  const staged = createConfiguredCaptureRecorder({
    cwd: payloadCwd,
    env,
    sessionId: "original-session",
    createRecorder: (options) =>
      createCaptureRecorder({ ...options, idFactory: () => EVENT_ID }),
  });
  staged.record({
    occurredAt: "2026-08-16T10:00:00.000Z",
    type: "capability.used",
    data: {
      kind: "skill",
      capabilityId: "coredoc-spec",
      outcome: "success",
    },
  });

  const result = spawnSync(
    process.execPath,
    acceptAllFetchChild(new URL("./retry-pending.mjs", import.meta.url).pathname),
    {
      cwd: processCwd,
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "new-session-must-not-own-retry",
        cwd: payloadCwd,
      }),
      timeout: 2_500,
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(staged.pending(), []);
});

test("oversized SessionStart input silently falls back to the process cwd", () => {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-bounded-"));
  const processCwd = mkdtempSync(join(tmpdir(), "coredoc-capture-retry-fallback-"));
  const env = {
    ...process.env,
    ...acceptAllFetchEnv(),
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
    COREDOC_CAPTURE_ENDPOINT: TARGET,
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_REPO_KEY: "yvp-core/coredoc-parser",
  };
  const staged = createConfiguredCaptureRecorder({
    cwd: processCwd,
    env,
    sessionId: "original-session",
    createRecorder: (options) =>
      createCaptureRecorder({ ...options, idFactory: () => EVENT_ID }),
  });
  staged.record({
    occurredAt: "2026-08-16T10:00:00.000Z",
    type: "capability.used",
    data: {
      kind: "skill",
      capabilityId: "coredoc-spec",
      outcome: "success",
    },
  });

  const result = spawnSync(
    process.execPath,
    acceptAllFetchChild(new URL("./retry-pending.mjs", import.meta.url).pathname),
    {
      cwd: processCwd,
      encoding: "utf8",
      env,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        cwd: "/must/not/select/this/namespace",
        padding: "x".repeat(64 * 1024),
      }),
      timeout: 2_500,
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.deepEqual(staged.pending(), []);
});

test("SessionStart retries capture then retries, reconciles, and flushes artifact checkpoints", async () => {
  const calls = [];
  const result = await retrySessionStartDelivery({
    env: { COREDOC_CAPTURE_ENDPOINT: "managed" },
    cwd: "/synthetic/repository",
    retryCapture: async (options) => {
      calls.push(["capture", options]);
      return { status: "sent", attempted: 1, sent: 1, pending: 0 };
    },
    retryArtifacts: async (options) => {
      calls.push(["artifacts", options]);
      return { status: "sent", attempted: 2, queued: 1, sent: 2, pending: 0 };
    },
  });
  assert.deepEqual(calls, [
    [
      "capture",
      {
        env: { COREDOC_CAPTURE_ENDPOINT: "managed" },
        cwd: "/synthetic/repository",
        timeoutMs: 750,
      },
    ],
    [
      "artifacts",
      {
        env: { COREDOC_CAPTURE_ENDPOINT: "managed" },
        cwd: "/synthetic/repository",
        timeoutMs: 750,
      },
    ],
  ]);
  assert.deepEqual(result, {
    capture: { status: "sent", attempted: 1, sent: 1, pending: 0 },
    artifacts: { status: "sent", attempted: 2, queued: 1, sent: 2, pending: 0 },
  });
});
