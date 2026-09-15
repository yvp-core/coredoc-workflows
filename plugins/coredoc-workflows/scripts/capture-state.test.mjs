import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { createCaptureRecorder } from "../runtime/capture/index.mjs";
import {
  createConfiguredCaptureRecorder,
  deliverCaptureEvent,
} from "./capture-client.mjs";
import {
  TERMINAL_ENTRY_TTL_DAYS,
  outboxPayloadIds,
  captureNoticeText,
  captureStatePath,
  captureStateRecorder,
  captureStateSummary,
  foldCaptureState,
  readCaptureState,
  reconcileCaptureFiles,
  reconcileCaptureState,
  recordCaptureTransitions,
  undeliveredCaptureEvents,
  undeliveredCaptureNotice,
} from "./capture-state.mjs";
import { ackCaptureHealth } from "./capture-ack.mjs";
import { resolveProjectKey } from "./project-key.mjs";
import { retryPendingCaptureEvents } from "./retry-pending.mjs";

const REPO_KEY = "yvp-core/coredoc-parser";
// The same key `session-env` and `run-status` resolve for this checkout.
const PROJECT_KEY = resolveProjectKey("/repository", {});
const RUN_ID = "cdr-20260915-aa11bb";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const TARGET =
  "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events";
const FINISHED_EVENT = Object.freeze({
  schemaVersion: 2,
  occurredAt: "2026-09-15T10:00:12.000Z",
  type: "workflow.run.finished",
  runId: RUN_ID,
  data: {
    outcome: "success",
    counters: {
      editCalls: 1,
      editVerifyRounds: 0,
      verificationRuns: 1,
      verificationFailures: 0,
      verificationPasses: 1,
      coredocCalls: 1,
      coredocFailures: 0,
    },
  },
});

function harness({ sessionId = "session-a", captureDir } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "coredoc-capture-state-"));
  const directory =
    captureDir ?? mkdtempSync(join(tmpdir(), "coredoc-capture-outbox-"));
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: stateDir,
    COREDOC_WORKFLOWS_REPO_KEY: REPO_KEY,
    COREDOC_CAPTURE_ENDPOINT: TARGET,
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_CAPTURE_DIR: directory,
  };
  const recorder = createConfiguredCaptureRecorder({
    env,
    cwd: "/repository",
    sessionId,
    idFactory: () => EVENT_ID,
    createRecorder: captureStateRecorder({
      projectKey: PROJECT_KEY,
      env,
      cwd: "/repository",
    }),
  });
  return { env, stateDir, directory, recorder };
}

function payloadPath(directory, eventId = EVENT_ID) {
  return join(directory, `${eventId}.event.json`);
}

const receipt = (body) => async () => body;

test("a queued event is recorded before any delivery attempt", () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);

  assert.deepEqual(readCaptureState(PROJECT_KEY, RUN_ID, { env }), [
    {
      eventId: EVENT_ID,
      kind: "workflow.run.finished",
      state: "queued",
      lastAttemptAt: readCaptureState(PROJECT_KEY, RUN_ID, { env })[0]
        .lastAttemptAt,
    },
  ]);
  assert.equal(existsSync(payloadPath(directory)), true);
});

test("an accepted receipt marks the event delivered and deletes the payload", async () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);
  await recorder.flush({
    send: receipt({
      acceptedEventIds: [EVENT_ID],
      duplicateEventIds: [],
      rejected: [],
    }),
  });

  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(entry.state, "delivered");
  assert.equal(entry.error, undefined);
  assert.equal(existsSync(payloadPath(directory)), false);
});

test("a duplicate receipt is delivered, not a failure", async () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);
  await recorder.flush({
    send: receipt({
      acceptedEventIds: [],
      duplicateEventIds: [EVENT_ID],
      rejected: [],
    }),
  });

  assert.equal(readCaptureState(PROJECT_KEY, RUN_ID, { env })[0].state, "delivered");
  assert.equal(existsSync(payloadPath(directory)), false);
});

test("a transport failure keeps the payload and records the error", async () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);
  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw Object.assign(new Error("TRANSPORT_UNAVAILABLE"), {
          code: "TRANSPORT_UNAVAILABLE",
        });
      },
    }),
  );

  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(entry.state, "failed");
  assert.equal(entry.error, "TRANSPORT_UNAVAILABLE");
  assert.equal(existsSync(payloadPath(directory)), true);
  assert.deepEqual(
    recorder.pending().map(({ eventId }) => eventId),
    [EVENT_ID],
  );
});

test("a rejection is recorded before its payload is deleted and is never retried", async () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);
  const observed = [];
  await recorder.flush({
    send: async () => {
      observed.push(["send", existsSync(payloadPath(directory))]);
      return {
        acceptedEventIds: [],
        duplicateEventIds: [],
        rejected: [{ eventId: EVENT_ID, code: "UNSUPPORTED_SCHEMA_VERSION" }],
      };
    },
  });

  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.deepEqual(observed, [["send", true]]);
  assert.equal(entry.state, "rejected");
  assert.equal(entry.rejectionCode, "UNSUPPORTED_SCHEMA_VERSION");
  // State first, payload after: the rejection outlives the payload it names.
  assert.equal(existsSync(payloadPath(directory)), false);
  assert.deepEqual(recorder.pending(), []);

  const retried = [];
  await retryPendingCaptureEvents({
    env,
    cwd: "/repository",
    send: async (...args) => {
      retried.push(args);
      return { acceptedEventIds: [], duplicateEventIds: [], rejected: [] };
    },
  });
  assert.deepEqual(retried, []);
  assert.equal(
    readCaptureState(PROJECT_KEY, RUN_ID, { env })[0].state,
    "rejected",
  );
});

test("a payload missing while the state says failed is recorded as lost", async () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);
  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw Object.assign(new Error("TRANSPORT_UNAVAILABLE"), {
          code: "TRANSPORT_UNAVAILABLE",
        });
      },
    }),
  );
  rmSync(payloadPath(directory));

  await retryPendingCaptureEvents({
    env,
    cwd: "/repository",
    send: receipt({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [],
    }),
  });

  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(entry.state, "failed");
  assert.equal(entry.error, "payload_missing");
});

test("an outbox that cannot take a new event surfaces the overflow, never silence", () => {
  const { env, directory } = harness();
  const full = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: { Authorization: "Bearer capture-token" },
    maxEntries: 1,
    context: {
      host: "claude-code",
      sessionId: "session-a",
      repositoryKey: REPO_KEY,
    },
    idFactory: () => EVENT_ID,
    onTransition: (entries) =>
      recordCaptureTransitions(entries, { projectKey: PROJECT_KEY, env }),
  });
  full.record(FINISHED_EVENT);
  const evicted = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: { Authorization: "Bearer capture-token" },
    maxEntries: 1,
    context: {
      host: "claude-code",
      sessionId: "session-a",
      repositoryKey: REPO_KEY,
    },
    idFactory: () => "22222222-2222-4222-8222-222222222222",
    onTransition: (entries) =>
      recordCaptureTransitions(entries, { projectKey: PROJECT_KEY, env }),
  });

  // The outbox never drops a payload it already holds: it refuses the new one,
  // and the refusal is a recorded `failed: evicted`, not a lost event.
  const queued = evicted.record({
    ...FINISHED_EVENT,
    occurredAt: "2026-09-15T10:00:14.000Z",
  });
  assert.equal(queued.status, "overflow");
  assert.equal(existsSync(payloadPath(directory)), true);
  const entries = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(entries.length, 2);
  assert.deepEqual(
    entries.map(({ state, error }) => [state, error]),
    [
      ["queued", undefined],
      ["failed", "overflow"],
    ],
  );
});

test("a failed run.finished from one session is replayed byte-identically by another", async () => {
  const { env, recorder, directory } = harness({ sessionId: "session-a" });
  recorder.record(FINISHED_EVENT);
  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw Object.assign(new Error("TRANSPORT_UNAVAILABLE"), {
          code: "TRANSPORT_UNAVAILABLE",
        });
      },
    }),
  );
  const persisted = JSON.parse(readFileSync(payloadPath(directory), "utf8"));

  // Session B: a different host session, a different session id in the
  // environment, the same checkout and the same binding.
  const sent = [];
  const replay = await retryPendingCaptureEvents({
    env: { ...env, COREDOC_WORKFLOWS_SESSION_ID: "session-b" },
    cwd: "/repository",
    send: async (target, batch) => {
      sent.push([target, batch]);
      return {
        acceptedEventIds: batch.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      };
    },
  });

  assert.equal(replay.status, "sent");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].events, [persisted.event]);
  // The server's run/session consistency check sees session A, the session that
  // opened the run, not the session that replayed it.
  assert.equal(sent[0][1].events[0].sessionId, "session-a");
  assert.equal(sent[0][1].events[0].eventId, EVENT_ID);
  assert.equal(sent[0][1].events[0].occurredAt, FINISHED_EVENT.occurredAt);
  assert.equal(
    readCaptureState(PROJECT_KEY, RUN_ID, { env })[0].state,
    "delivered",
  );
});

test("the SessionStart notice names the backlog and stays silent when clean", async () => {
  const { env, recorder } = harness();
  assert.equal(captureNoticeText({ env, cwd: "/repository" }), "");

  recorder.record(FINISHED_EVENT);
  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw Object.assign(new Error("TRANSPORT_UNAVAILABLE"), {
          code: "TRANSPORT_UNAVAILABLE",
        });
      },
    }),
  );

  const notice = captureNoticeText({ env, cwd: "/repository" });
  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(
    notice,
    `coredoc capture: 1 events from ${entry.lastAttemptAt} not delivered (relay unreachable) — run \`coredoc-workflows capture-health\``,
  );
});

test("rejections are surfaced with their code", () => {
  assert.equal(
    undeliveredCaptureNotice(
      [
        {
          eventId: EVENT_ID,
          kind: "workflow.run.finished",
          state: "rejected",
          lastAttemptAt: "2026-09-15T10:00:13.000Z",
          rejectionCode: "UNSUPPORTED_SCHEMA_VERSION",
        },
      ],
      { relay: "healthy" },
    ),
    "coredoc capture: 1 events rejected (UNSUPPORTED_SCHEMA_VERSION) — run `coredoc-workflows capture-health`, then `capture-health --ack` once handled",
  );
  assert.equal(undeliveredCaptureNotice([], { relay: "healthy" }), "");
});

test("the fold reconciles, summarises, and clears a fully delivered run", () => {
  const { env, stateDir } = harness();
  const delivered = [
    {
      eventId: EVENT_ID,
      kind: "workflow.run.started",
      state: "delivered",
      lastAttemptAt: "2026-09-15T10:00:01.000Z",
    },
  ];
  assert.deepEqual(reconcileCaptureState(delivered, { pending: [] }), delivered);
  assert.deepEqual(
    reconcileCaptureState([{ ...delivered[0], state: "queued" }], {
      pending: [],
    })[0],
    { ...delivered[0], state: "failed", error: "payload_missing" },
  );
  // A payload the current binding cannot send is not a lost payload.
  assert.deepEqual(
    reconcileCaptureState([{ ...delivered[0], state: "queued" }], {
      pending: [],
      present: [EVENT_ID],
    })[0],
    { ...delivered[0], state: "failed", error: "binding_mismatch" },
  );
  assert.deepEqual(captureStateSummary(delivered), {
    kinds: {
      "workflow.run.started": {
        delivered: 1,
        queued: 0,
        failed: 0,
        rejected: 0,
      },
    },
  });
  assert.equal(foldCaptureState(PROJECT_KEY, RUN_ID, { env }), undefined);
  assert.equal(existsSync(join(stateDir, PROJECT_KEY, "capture")), false);
  assert.deepEqual(undeliveredCaptureEvents(PROJECT_KEY, { env }), []);
  assert.equal(
    captureStatePath(PROJECT_KEY, RUN_ID, env),
    join(stateDir, PROJECT_KEY, "capture", `${RUN_ID}.json`),
  );
});

test("a backlog delivered in the same SessionStart prints nothing", async () => {
  const { env, recorder } = harness();
  recorder.record(FINISHED_EVENT);
  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw Object.assign(new Error("TRANSPORT_UNAVAILABLE"), {
          code: "TRANSPORT_UNAVAILABLE",
        });
      },
    }),
  );
  assert.notEqual(captureNoticeText({ env, cwd: "/repository" }), "");

  // `retry-pending` runs last in the SessionStart group and prints the notice
  // only after its own flush, so what it cleared is never reported.
  await retryPendingCaptureEvents({
    env,
    cwd: "/repository",
    send: async (target, batch) => ({
      acceptedEventIds: batch.events.map(({ eventId }) => eventId),
      duplicateEventIds: [],
      rejected: [],
    }),
  });
  assert.equal(captureNoticeText({ env, cwd: "/repository" }), "");
});

test("terminal entries are acknowledged on demand and aged out on their own", async () => {
  const { env, recorder } = harness();
  recorder.record(FINISHED_EVENT);
  await recorder.flush({
    send: receipt({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: EVENT_ID, code: "UNSUPPORTED_SCHEMA_VERSION" }],
    }),
  });
  const [rejected] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(rejected.state, "rejected");

  // Before the TTL the rejection keeps being reported.
  reconcileCaptureFiles(PROJECT_KEY, [], {
    env,
    present: [],
    now: Date.parse(rejected.lastAttemptAt) + 13 * 24 * 60 * 60 * 1000,
  });
  assert.equal(readCaptureState(PROJECT_KEY, RUN_ID, { env }).length, 1);

  reconcileCaptureFiles(PROJECT_KEY, [], {
    env,
    present: [],
    now:
      Date.parse(rejected.lastAttemptAt) +
      (TERMINAL_ENTRY_TTL_DAYS + 1) * 24 * 60 * 60 * 1000,
  });
  assert.deepEqual(readCaptureState(PROJECT_KEY, RUN_ID, { env }), []);
  assert.equal(existsSync(captureStatePath(PROJECT_KEY, RUN_ID, env)), false);
  assert.equal(captureNoticeText({ env, cwd: "/repository" }), "");
});

test("capture-health --ack drops what nothing can act on and keeps the rest", async () => {
  const { env, recorder, directory } = harness();
  recorder.record(FINISHED_EVENT);
  await recorder.flush({
    send: receipt({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: EVENT_ID, code: "UNSUPPORTED_SCHEMA_VERSION" }],
    }),
  });
  const queuedId = "44444444-4444-4444-8444-444444444444";
  createCaptureRecorder({
    directory,
    target: TARGET,
    headers: { Authorization: "Bearer capture-token" },
    context: {
      host: "claude-code",
      sessionId: "session-a",
      repositoryKey: REPO_KEY,
    },
    idFactory: () => queuedId,
    onTransition: (entries) =>
      recordCaptureTransitions(entries, { projectKey: PROJECT_KEY, env }),
  }).record({ ...FINISHED_EVENT, occurredAt: "2026-09-15T10:00:20.000Z" });

  assert.deepEqual(ackCaptureHealth({ env, cwd: "/repository" }), {
    acknowledged: 1,
  });
  assert.deepEqual(
    readCaptureState(PROJECT_KEY, RUN_ID, { env }).map(
      ({ eventId, state }) => [eventId, state],
    ),
    [[queuedId, "queued"]],
  );
  assert.match(
    captureNoticeText({ env, cwd: "/repository" }),
    /1 events from .* not delivered/,
  );
});

test("a refused capture binding loses the event loudly, never silently", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coredoc-capture-conflict-"));
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: stateDir,
    COREDOC_WORKFLOWS_REPO_KEY: REPO_KEY,
    // The endpoint names `ws-verify`; the configured workspace id says
    // otherwise, so `createCaptureRecorder` refuses to build a binding.
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws-verify/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_CAPTURE_WORKSPACE_ID: "00000000-0000-4000-8000-000000000000",
    COREDOC_WORKFLOWS_CAPTURE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-capture-conflict-outbox-"),
    ),
  };
  const conflict =
    "CAPTURE_BINDING_CONFLICT: capture workspaceId conflicts with the capture target";

  const capture = await deliverCaptureEvent(FINISHED_EVENT, {
    env,
    cwd: "/repository",
    sessionId: "session-a",
    createRecorder: captureStateRecorder({
      projectKey: PROJECT_KEY,
      env,
      cwd: "/repository",
    }),
  });

  // The lifecycle command's own result names the conflict.
  assert.deepEqual(capture, {
    status: "failed",
    error: conflict,
    durable: false,
  });
  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env });
  assert.equal(entry.kind, "workflow.run.finished");
  assert.equal(entry.state, "failed");
  assert.equal(entry.error, conflict);
  assert.equal(
    captureNoticeText({ env, cwd: "/repository" }),
    "coredoc capture: 1 events not recorded (capture binding conflict: capture workspaceId conflicts with the capture target) — run `coredoc-workflows capture-health`",
  );
  // Nothing can retry an event that never reached an outbox: it is terminal.
  assert.deepEqual(ackCaptureHealth({ env, cwd: "/repository" }), {
    acknowledged: 1,
  });
  assert.equal(captureNoticeText({ env, cwd: "/repository" }), "");
});

test("a shared outbox records a delivery under the project whose run owns it", async () => {
  // Two checkouts on one machine: one state root, one capture binding, one
  // outbox. Project A emits the event; project B's SessionStart retry is what
  // actually delivers it.
  const stateDir = mkdtempSync(join(tmpdir(), "coredoc-capture-shared-"));
  const outbox = mkdtempSync(join(tmpdir(), "coredoc-capture-shared-outbox-"));
  // Same binding, same state root; the project key is what differs, and it is
  // derived from each checkout's own working directory.
  const PROJECT_B = resolveProjectKey("/other-repository", {});
  const envA = {
    COREDOC_WORKFLOWS_STATE_DIR: stateDir,
    COREDOC_WORKFLOWS_REPO_KEY: REPO_KEY,
    COREDOC_CAPTURE_ENDPOINT: TARGET,
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_CAPTURE_DIR: outbox,
  };
  const envB = envA;
  assert.notEqual(PROJECT_B, PROJECT_KEY);

  const recorderA = createConfiguredCaptureRecorder({
    env: envA,
    cwd: "/repository",
    sessionId: "session-a",
    idFactory: () => EVENT_ID,
    createRecorder: captureStateRecorder({
      projectKey: PROJECT_KEY,
      env: envA,
      cwd: "/repository",
    }),
  });
  recorderA.record(FINISHED_EVENT);
  await assert.rejects(
    recorderA.flush({
      send: async () => {
        throw Object.assign(new Error("TRANSPORT_UNAVAILABLE"), {
          code: "TRANSPORT_UNAVAILABLE",
        });
      },
    }),
  );

  const replay = await retryPendingCaptureEvents({
    env: { ...envB, COREDOC_WORKFLOWS_SESSION_ID: "session-b" },
    cwd: "/other-repository",
    send: async (_target, batch) => ({
      acceptedEventIds: batch.events.map(({ eventId }) => eventId),
      duplicateEventIds: [],
      rejected: [],
    }),
  });
  assert.equal(replay.status, "sent");

  // The transition lands on the run's OWN project, not on the one that flushed.
  assert.equal(
    readCaptureState(PROJECT_KEY, RUN_ID, { env: envA })[0].state,
    "delivered",
  );
  assert.deepEqual(readCaptureState(PROJECT_B, RUN_ID, { env: envB }), []);

  // And A's own reconciliation no longer mistakes a delivered event whose
  // payload is gone for a lost one.
  reconcileCaptureFiles(
    PROJECT_KEY,
    [],
    { env: envA, present: outboxPayloadIds({ env: envA, cwd: "/repository" }) },
  );
  const [entry] = readCaptureState(PROJECT_KEY, RUN_ID, { env: envA });
  assert.equal(entry.state, "delivered");
  assert.equal(entry.error, undefined);
});
