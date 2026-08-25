import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../../test/test-api.mjs";

import {
  captureEvent,
  createCaptureRecorder,
  createFileOutbox,
} from "./index.mjs";
import { captureReceipt } from "./contract.mjs";

const CONTRACT_CORPUS = JSON.parse(
  readFileSync(new URL("./contract-corpus.json", import.meta.url), "utf8"),
);

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const SECOND_EVENT_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_EVENT_ID = "33333333-3333-4333-8333-333333333333";
const TARGET =
  "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events";
const MANAGED_TARGET = "http://127.0.0.1:43181/capture/v1/events";
const HEADERS = { Authorization: "Bearer pilot-capture-token" };
const EMPTY_HEALTH_COUNTERS = {
  overflow: 0,
  transportFailures: 0,
  unsupportedSchemaVersions: 0,
};

function startedEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    occurredAt: "2026-08-15T10:00:00.000Z",
    host: "claude-code",
    sessionId: "session-42",
    runId: "cdr-20260815-a1b2c3",
    repositoryKey: "coredoc/coredoc-parser",
    taskId: "cdt_pilot_42",
    type: "workflow.run.started",
    data: {
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      scale: "large",
    },
    ...overrides,
  };
}

function binding(overrides = {}) {
  return {
    endpoint: TARGET,
    workspaceId: "ws-1",
    credentialFingerprint:
      "b6c4e81d52af99541790c689c6dd2ec11312c6bea228e0ab7576ff828ea742f5",
    ...overrides,
  };
}

test("normalizes the three-event v1 contract including an opaque taskId", () => {
  assert.deepEqual(captureEvent(startedEvent()), startedEvent());

  assert.deepEqual(
    captureEvent({
      ...startedEvent({
        eventId: SECOND_EVENT_ID,
        type: "capability.used",
        runId: undefined,
        taskId: undefined,
        data: {
          kind: "skill",
          capabilityId: "coredoc-spec",
          outcome: "success",
        },
      }),
    }),
    {
      schemaVersion: 1,
      eventId: SECOND_EVENT_ID,
      occurredAt: "2026-08-15T10:00:00.000Z",
      host: "claude-code",
      sessionId: "session-42",
      repositoryKey: "coredoc/coredoc-parser",
      type: "capability.used",
      data: {
        kind: "skill",
        capabilityId: "coredoc-spec",
        outcome: "success",
      },
    },
  );
});

test("matches the shared plugin/server contract corpus", () => {
  for (const fixture of CONTRACT_CORPUS.valid) {
    assert.deepEqual(captureEvent(fixture.event), fixture.event, fixture.name);
  }
  for (const fixture of CONTRACT_CORPUS.invalid) {
    assert.throws(() => captureEvent(fixture.event), undefined, fixture.name);
  }
});

test("enforces the bounded ordered v2 stage declaration grammar", () => {
  const stages = Array.from({ length: 32 }, (_, index) => ({
    stageId: `stage-${index}`,
    after: index === 0 ? [] : [`stage-${index - 1}`],
  }));
  const event = startedEvent({
    schemaVersion: 2,
    taskId: "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    data: { ...startedEvent().data, stages },
  });

  assert.deepEqual(captureEvent(event), event);
  assert.throws(
    () =>
      captureEvent({
        ...event,
        data: {
          ...event.data,
          stages: [...stages, { stageId: "stage-32", after: ["stage-31"] }],
        },
      }),
    /at most 32/,
  );
  assert.throws(
    () =>
      captureEvent({
        ...event,
        data: {
          ...event.data,
          stages: [
            { stageId: "spec", after: [] },
            { stageId: "tdd", after: ["tdd"] },
          ],
        },
      }),
    /earlier declared stage/,
  );
});

test("normalizes the closed bounded v3 work-item start contract", () => {
  const event = startedEvent({
    schemaVersion: 3,
    taskId: undefined,
    data: {
      ...startedEvent().data,
      stages: [],
      workItems: [
        { provider: "linear", externalId: "lin-42" },
        { provider: "jira", externalId: "10042" },
        {
          provider: "jira",
          externalId: "10042",
          externalKey: "CORE-123",
        },
      ],
    },
  });
  const { taskId: _taskId, ...eventWithoutTaskId } = event;

  assert.deepEqual(captureEvent(event), {
    ...eventWithoutTaskId,
    data: {
      ...event.data,
      workItems: [
        {
          provider: "jira",
          externalId: "10042",
          externalKey: "CORE-123",
        },
        { provider: "linear", externalId: "lin-42" },
      ],
    },
  });
  assert.throws(
    () =>
      captureEvent({
        ...event,
        data: {
          ...event.data,
          workItems: [
            { provider: "jira", externalId: "10042", externalKey: "A-1" },
            { provider: "jira", externalId: "10042", externalKey: "B-2" },
          ],
        },
      }),
    /conflicting externalKey/,
  );
  assert.throws(
    () => captureEvent({ ...event, taskId: "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
    /mutually exclusive/,
  );
  assert.throws(
    () =>
      captureEvent({
        ...event,
        data: {
          ...event.data,
          workItems: [{ provider: "jira;echo", externalId: "10042" }],
        },
      }),
    /provider must match/,
  );
  assert.throws(
    () => captureEvent({ ...event, type: "workflow.stage.started" }),
    /schemaVersion 3 supports only workflow\.run\.started/,
  );
});

test("normalizes v2 occurrence UUIDs and keeps v1 task IDs opaque", () => {
  const started = captureEvent({
    schemaVersion: 2,
    eventId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    occurredAt: "2026-08-15T10:00:00.000Z",
    host: "claude-code",
    sessionId: "session-42",
    runId: "cdr-20260815-a1b2c3",
    taskId: "cdt_BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB",
    type: "workflow.run.started",
    data: {
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      scale: "normal",
      stages: [],
    },
  });
  const stage = captureEvent({
    schemaVersion: 2,
    eventId: "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD",
    occurredAt: "2026-08-15T10:01:00.000Z",
    host: "claude-code",
    sessionId: "session-42",
    runId: "cdr-20260815-a1b2c3",
    type: "workflow.stage.finished",
    data: {
      occurrenceId: "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC",
      stageId: "tdd",
      attempt: 1000,
      outcome: "abandoned",
    },
  });

  assert.equal(started.eventId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.equal(
    started.taskId,
    "cdt_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  );
  assert.equal(stage.data.occurrenceId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(captureEvent(startedEvent()).taskId, "cdt_pilot_42");
  assert.throws(
    () => captureEvent({ ...stage, data: { ...stage.data, attempt: 1001 } }),
    /attempt must be an integer between 1 and 1000/,
  );
  for (const type of ["workflow.stage.finished", "workflow.run.finished"]) {
    assert.throws(
      () => captureEvent({ ...stage, type, taskId: started.taskId }),
      /taskId is supported only on v2 workflow\.run\.started/,
    );
  }
});

test("validates the bounded workflow completion contract", () => {
  const finished = startedEvent({
    type: "workflow.run.finished",
    data: {
      outcome: "success",
      counters: {
        editCalls: 3,
        editVerifyRounds: 1,
        verificationRuns: 2,
        verificationFailures: 1,
        verificationPasses: 1,
        coredocCalls: 4,
        coredocFailures: 0,
      },
    },
  });

  assert.deepEqual(captureEvent(finished), finished);
  assert.throws(
    () => captureEvent({ ...finished, runId: undefined }),
    /workflow\.run\.finished requires runId/,
  );
  assert.throws(
    () =>
      captureEvent({
        ...finished,
        data: { ...finished.data, outcome: "unknown" },
      }),
    /Unsupported workflow outcome: unknown/,
  );
  assert.throws(
    () =>
      captureEvent({
        ...finished,
        data: {
          ...finished.data,
          counters: { ...finished.data.counters, editCalls: 1_000_001 },
        },
      }),
    /editCalls must be an integer between 0 and 1000000/,
  );
});

test("rejects parseable non-ISO timestamps as content outside the timestamp contract", () => {
  assert.throws(
    () =>
      captureEvent(
        startedEvent({
          occurredAt:
            "Sun, 06 Nov 1994 08:49:37 GMT (prompt-like text must not transit)",
        }),
      ),
    /occurredAt must be an ISO-8601 timestamp/,
  );
});

test("rejects content, removed event shapes, and unknown envelope fields", () => {
  assert.throws(
    () =>
      captureEvent(
        startedEvent({
          data: {
            ...startedEvent().data,
            taskBody: "copied task content",
          },
        }),
      ),
    /must not contain task/,
  );
  assert.throws(
    () =>
      captureEvent(
        startedEvent({
          data: {
            ...startedEvent().data,
            stages: [{ id: "spec", gate: "user-approval" }],
          },
        }),
      ),
    /Unsupported workflow.run.started data field: stages/,
  );
  assert.throws(
    () => captureEvent(startedEvent({ type: "capability.started" })),
    /Unsupported capture event type: capability.started/,
  );
  assert.throws(
    () => captureEvent(startedEvent({ host: "claude" })),
    /Unsupported capture host: claude/,
  );
  assert.throws(
    () => captureEvent({ ...startedEvent(), emitter: "plugin" }),
    /Unsupported capture event field: emitter/,
  );
});

test("keeps identical retries and persists only a content-free binding fingerprint", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-outbox-"));
  const outbox = createFileOutbox({
    directory,
    maxEntries: 2,
    binding: binding(),
  });
  const event = captureEvent(startedEvent());

  assert.deepEqual(outbox.enqueue(event), {
    status: "queued",
    eventId: EVENT_ID,
    pending: 1,
  });
  assert.deepEqual(outbox.enqueue(event), {
    status: "queued",
    eventId: EVENT_ID,
    pending: 1,
  });
  assert.throws(
    () =>
      outbox.enqueue(
        captureEvent(
          startedEvent({
            data: { ...startedEvent().data, workflowId: "review:normal" },
          }),
        ),
      ),
    /eventId already exists with different content/,
  );

  const [pending] = outbox.list();
  assert.deepEqual(pending, event);
  assert.equal(statSync(outbox.pathFor(EVENT_ID)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(outbox.pathFor(EVENT_ID), "utf8")), {
    binding: binding(),
    event,
  });
  assert.doesNotMatch(
    readFileSync(outbox.pathFor(EVENT_ID), "utf8"),
    /pilot-capture-token/,
  );

  outbox.acknowledge([EVENT_ID]);
  assert.deepEqual(outbox.list(), []);
});

test("refuses the newest event at capacity instead of deleting pending evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-overflow-"));
  const outbox = createFileOutbox({
    directory,
    maxEntries: 1,
    binding: binding(),
  });

  assert.equal(outbox.enqueue(startedEvent()).status, "queued");
  assert.deepEqual(
    outbox.enqueue(startedEvent({ eventId: SECOND_EVENT_ID })),
    { status: "overflow", eventId: SECOND_EVENT_ID, pending: 1 },
  );
  assert.deepEqual(
    outbox.list().map(({ eventId }) => eventId),
    [EVENT_ID],
  );
});

test("counts only current-binding events against capacity while retaining stale evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-stale-cap-"));
  const stale = createFileOutbox({
    directory,
    maxEntries: 1,
    binding: binding({ workspaceId: "old-workspace" }),
  });
  assert.equal(stale.enqueue(startedEvent()).status, "queued");

  writeFileSync(
    join(directory, "99999999-9999-4999-8999-999999999999.event.json"),
    "not-json\n",
    { mode: 0o600 },
  );

  const current = createFileOutbox({
    directory,
    maxEntries: 1,
    binding: binding(),
  });
  assert.deepEqual(
    current.enqueue(startedEvent({ eventId: SECOND_EVENT_ID })),
    {
      status: "queued",
      eventId: SECOND_EVENT_ID,
      pending: 1,
      bindingRefused: 1,
      unreadable: 1,
    },
  );
  assert.deepEqual(current.status(), {
    pending: 1,
    bindingRefused: 1,
    unreadable: 1,
  });
  assert.deepEqual(
    current.enqueue(startedEvent({ eventId: THIRD_EVENT_ID })),
    {
      status: "overflow",
      eventId: THIRD_EVENT_ID,
      pending: 1,
      bindingRefused: 1,
      unreadable: 1,
    },
  );
  assert.equal(stale.list().length, 1);
  assert.equal(
    readFileSync(
      join(directory, "99999999-9999-4999-8999-999999999999.event.json"),
      "utf8",
    ),
    "not-json\n",
  );
});

test("never overwrites an unreadable event file with the same ID", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-corrupt-"));
  const outbox = createFileOutbox({ directory, binding: binding() });
  writeFileSync(outbox.pathFor(EVENT_ID), "not-json\n", { mode: 0o600 });

  assert.throws(
    () => outbox.enqueue(startedEvent()),
    /eventId already exists with unreadable content/,
  );
  assert.equal(readFileSync(outbox.pathFor(EVENT_ID), "utf8"), "not-json\n");
});

test("refuses cross-binding replay and clears only receipt-named events", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-recorder-"));
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: {
      host: "claude-code",
      sessionId: "session-42",
      repositoryKey: "coredoc/coredoc-parser",
    },
    idFactory: () => EVENT_ID,
  });

  const queued = recorder.record({
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260815-a1b2c3",
    data: startedEvent().data,
  });
  assert.deepEqual(queued, { status: "queued", eventId: EVENT_ID, pending: 1 });
  assert.throws(
    () =>
      recorder.record({
        occurredAt: "2026-08-15T10:00:00.000Z",
        type: "workflow.run.started",
        runId: "cdr-20260815-a1b2c3",
        data: startedEvent().data,
        eventId: "33333333-3333-4333-8333-333333333333",
        host: "codex",
      }),
    /Unsupported capture record field/,
  );

  let wrongBindingSent = false;
  const wrongBindingRecorder = createCaptureRecorder({
    directory,
    target:
      "https://capture.invalid/api/v1/workspaces/ws-2/capture/v1/events",
    headers: { Authorization: "Bearer another-member-token" },
    context: { host: "claude-code", sessionId: "session-42" },
  });
  assert.deepEqual(
    await wrongBindingRecorder.flush({
      send: async () => {
        wrongBindingSent = true;
        throw new Error("must not send");
      },
    }),
    {
      attempted: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      unmatched: 0,
      pending: 0,
      bindingRefused: 1,
      unreadable: 0,
      receipt: {
        acceptedEventIds: [],
        duplicateEventIds: [],
        rejected: [],
      },
    },
  );
  assert.equal(wrongBindingSent, false);
  assert.equal(recorder.pending().length, 1);

  const accepted = await recorder.flush({
    send: async (_target, batch) => ({
      acceptedEventIds: batch.events.map(({ eventId }) => eventId),
      duplicateEventIds: [],
      rejected: [],
    }),
  });
  assert.deepEqual(accepted, {
    attempted: 1,
    accepted: 1,
    duplicates: 0,
    rejected: 0,
    unmatched: 0,
    pending: 0,
    bindingRefused: 0,
    unreadable: 0,
    receipt: {
      acceptedEventIds: [EVENT_ID],
      duplicateEventIds: [],
      rejected: [],
    },
  });
  assert.deepEqual(recorder.pending(), []);
});

test("semantic capture uses a local relay binding without a cloud bearer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-local-binding-"));
  const localNonce = "local-relay-binding-one";
  const headers = { "X-Coredoc-Relay-Binding": localNonce };
  const recorder = createCaptureRecorder({
    directory,
    target: MANAGED_TARGET,
    workspaceId: "ws-1",
    headers,
    context: {
      host: "claude-code",
      sessionId: "session-42",
      repositoryKey: "coredoc/coredoc-parser",
    },
    idFactory: () => EVENT_ID,
  });
  recorder.record({
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260815-a1b2c3",
    data: startedEvent().data,
  });

  const eventName = readdirSync(directory).find((entry) =>
    entry.endsWith(".event.json"),
  );
  assert.ok(eventName);
  const eventPath = join(directory, eventName);
  const persisted = readFileSync(eventPath, "utf8");
  assert.doesNotMatch(persisted, new RegExp(localNonce));
  assert.deepEqual(JSON.parse(persisted).binding, {
    endpoint: MANAGED_TARGET,
    workspaceId: "ws-1",
    credentialFingerprint: createHash("sha256")
      .update(localNonce)
      .digest("hex"),
  });

  let sentOptions;
  const result = await recorder.flush({
    send: async (_target, batch, options) => {
      sentOptions = options;
      return {
        acceptedEventIds: batch.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      };
    },
  });
  assert.equal(result.accepted, 1);
  assert.deepEqual(sentOptions.headers, headers);
  assert.equal(
    Object.keys(sentOptions.headers).some(
      (name) => name.toLowerCase() === "authorization",
    ),
    false,
  );
  assert.throws(
    () =>
      createCaptureRecorder({
        directory: mkdtempSync(join(tmpdir(), "coredoc-capture-ambiguous-binding-")),
        target: MANAGED_TARGET,
        workspaceId: "ws-1",
        headers: { ...headers, Authorization: "Bearer cloud-token" },
        context: { host: "claude-code", sessionId: "session-42" },
      }),
    /exactly one supported binding header/,
  );
});

test("binds only the exact managed relay endpoint to an explicit compact workspace", () => {
  const options = {
    directory: mkdtempSync(join(tmpdir(), "coredoc-capture-workspace-binding-")),
    headers: { "X-Coredoc-Relay-Binding": "local-relay-binding-one" },
    context: { host: "claude-code", sessionId: "session-42" },
  };

  assert.doesNotThrow(() =>
    createCaptureRecorder({
      ...options,
      target: MANAGED_TARGET,
      workspaceId: "ws-1",
    }),
  );
  assert.doesNotThrow(() =>
    createCaptureRecorder({
      ...options,
      target: TARGET,
      headers: HEADERS,
    }),
  );
  for (const invalid of [
    { target: MANAGED_TARGET },
    { target: MANAGED_TARGET, workspaceId: "invalid/workspace" },
    { target: TARGET, workspaceId: "ws-2", headers: HEADERS },
    {
      target:
        "http://127.0.0.1:43181/api/v1/workspaces/ws-1/capture/v1/events",
      workspaceId: "ws-1",
    },
    {
      target: "http://127.0.0.1:43181/capture/v1/events/",
      workspaceId: "ws-1",
    },
  ]) {
    assert.throws(() => createCaptureRecorder({ ...options, ...invalid }));
  }
});

test("refuses a cloud bearer at the managed loopback target", () => {
  assert.throws(
    () =>
      createCaptureRecorder({
        directory: mkdtempSync(join(tmpdir(), "coredoc-capture-managed-auth-")),
        target: MANAGED_TARGET,
        workspaceId: "ws-1",
        headers: HEADERS,
        context: { host: "claude-code", sessionId: "session-42" },
      }),
    /managed capture target requires X-Coredoc-Relay-Binding/,
  );
});

test("refuses a local relay binding at a direct-cloud target", () => {
  assert.throws(
    () =>
      createCaptureRecorder({
        directory: mkdtempSync(join(tmpdir(), "coredoc-capture-direct-local-")),
        target: TARGET,
        headers: { "X-Coredoc-Relay-Binding": "local-relay-binding-one" },
        context: { host: "claude-code", sessionId: "session-42" },
      }),
    /direct capture target requires Authorization/,
  );
});

test("terminal receipt rejection is removed without retaining an open server code", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-rejected-"));
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => EVENT_ID,
    now: () => "2026-08-16T14:10:00.000Z",
  });
  recorder.record({
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260815-a1b2c3",
    data: startedEvent().data,
  });

  assert.deepEqual(
    await recorder.flush({
      send: async () => ({
        acceptedEventIds: [],
        duplicateEventIds: [],
        rejected: [{ eventId: EVENT_ID, code: "INVALID_EVENT" }],
      }),
    }),
    {
      attempted: 1,
      accepted: 0,
      duplicates: 0,
      rejected: 1,
      unmatched: 0,
      pending: 0,
      bindingRefused: 0,
      unreadable: 0,
      receipt: {
        acceptedEventIds: [],
        duplicateEventIds: [],
        rejected: [{ eventId: EVENT_ID, code: "INVALID_EVENT" }],
      },
    },
  );
  assert.deepEqual(recorder.health(), {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: null,
    updatedAt: "2026-08-16T14:10:00.000Z",
    counters: EMPTY_HEALTH_COUNTERS,
  });
});

test("a downgraded relay terminally removes a pending v3 relation without a durable diagnostic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-v3-downgrade-"));
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => EVENT_ID,
    now: () => "2026-08-18T14:10:00.000Z",
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

  const flushed = await recorder.flush({
    send: async () => ({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: EVENT_ID, code: "INVALID_EVENT" }],
    }),
  });

  assert.equal(flushed.pending, 0);
  assert.deepEqual(recorder.pending(), []);
  assert.deepEqual(recorder.health(), {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: null,
    updatedAt: "2026-08-18T14:10:00.000Z",
    counters: EMPTY_HEALTH_COUNTERS,
  });
});

test("hostile receipts never delete pending evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-hostile-"));
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => EVENT_ID,
  });
  recorder.record({
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260815-a1b2c3",
    data: startedEvent().data,
  });

  const unattempted = "99999999-9999-4999-8999-999999999999";
  for (const receipt of [
    { acceptedEventIds: [unattempted], duplicateEventIds: [], rejected: [] },
    { acceptedEventIds: [EVENT_ID, EVENT_ID], duplicateEventIds: [], rejected: [] },
    { acceptedEventIds: [EVENT_ID], duplicateEventIds: [EVENT_ID], rejected: [] },
    {
      acceptedEventIds: [EVENT_ID],
      duplicateEventIds: [],
      rejected: [{ eventId: EVENT_ID, code: "INVALID_EVENT" }],
    },
  ]) {
    await assert.rejects(recorder.flush({ send: async () => receipt }));
    assert.deepEqual(
      recorder.pending().map(({ eventId }) => eventId),
      [EVENT_ID],
    );
  }

  assert.throws(() =>
    captureReceipt(
      { acceptedEventIds: [], duplicateEventIds: [], rejected: [{ eventId: unattempted, code: "INVALID" }] },
      [EVENT_ID],
    ),
  );
});

test("a null rejection records request failure while unmatched local events remain pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-null-rejection-"));
  const ids = [EVENT_ID, SECOND_EVENT_ID];
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => ids.shift(),
    now: () => "2026-08-16T14:11:00.000Z",
  });
  recorder.record({
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260815-a1b2c3",
    data: startedEvent().data,
  });
  recorder.record({
    occurredAt: "2026-08-15T10:01:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
  });

  assert.deepEqual(
    await recorder.flush({
      send: async () => ({
        acceptedEventIds: [EVENT_ID],
        duplicateEventIds: [],
        rejected: [{ eventId: null, code: "REQUEST_INVALID" }],
      }),
    }),
    {
      attempted: 2,
      accepted: 1,
      duplicates: 0,
      rejected: 1,
      unmatched: 1,
      pending: 1,
      bindingRefused: 0,
      unreadable: 0,
      receipt: {
        acceptedEventIds: [EVENT_ID],
        duplicateEventIds: [],
        rejected: [{ eventId: null, code: "REQUEST_INVALID" }],
      },
    },
  );
  assert.deepEqual(
    recorder.pending().map(({ eventId }) => eventId),
    [SECOND_EVENT_ID],
  );
  assert.deepEqual(recorder.health(), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "OUTBOX_PENDING",
    updatedAt: "2026-08-16T14:11:00.000Z",
    counters: EMPTY_HEALTH_COUNTERS,
  });
});

test("records a durable local overflow diagnostic when capacity refuses an event", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "coredoc-capture-overflow-health-"),
  );
  const ids = [EVENT_ID, SECOND_EVENT_ID, THIRD_EVENT_ID];
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => ids.shift(),
    maxEntries: 1,
    now: () => "2026-08-16T14:12:00.000Z",
  });
  const event = {
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "capability.used",
    data: {
      kind: "skill",
      capabilityId: "coredoc-spec",
      outcome: "success",
    },
  };

  assert.equal(recorder.record(event).status, "queued");
  assert.equal(recorder.record(event).status, "overflow");
  assert.equal(recorder.record(event).status, "overflow");
  assert.deepEqual(recorder.health(), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "OUTBOX_OVERFLOW",
    updatedAt: "2026-08-16T14:12:00.000Z",
    counters: { ...EMPTY_HEALTH_COUNTERS, overflow: 2 },
  });
});

test("network failure leaves the stable event pending", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-offline-"));
  const recorder = createCaptureRecorder({
    directory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => EVENT_ID,
  });
  recorder.record({
    occurredAt: "2026-08-15T10:00:00.000Z",
    type: "workflow.run.started",
    runId: "cdr-20260815-a1b2c3",
    data: startedEvent().data,
  });

  await assert.rejects(
    recorder.flush({
      send: async () => {
        throw new Error("offline");
      },
    }),
    /offline/,
  );
  assert.deepEqual(
    recorder.pending().map(({ eventId }) => eventId),
    [EVENT_ID],
  );
});

test("persists bounded transport and auth diagnostics and clears them after delivery", async () => {
  const cases = [
    { target: TARGET, headers: HEADERS, status: 401, code: "AUTH_REJECTED" },
    { target: TARGET, headers: HEADERS, status: 403, code: "AUTH_REJECTED" },
    {
      target: MANAGED_TARGET,
      headers: { "X-Coredoc-Relay-Binding": "local-relay-binding-one" },
      workspaceId: "ws-1",
      status: 401,
      code: "BINDING_MISMATCH",
    },
  ];

  for (const [index, fixture] of cases.entries()) {
    const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-http-health-"));
    const recorder = createCaptureRecorder({
      directory,
      target: fixture.target,
      headers: fixture.headers,
      ...(fixture.workspaceId === undefined
        ? {}
        : { workspaceId: fixture.workspaceId }),
      context: { host: "claude-code", sessionId: `session-${index}` },
      idFactory: () => EVENT_ID,
      now: () => "2026-08-16T14:00:00.000Z",
    });
    recorder.record({
      occurredAt: "2026-08-16T13:59:00.000Z",
      type: "capability.used",
      data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
    });
    await assert.rejects(
      recorder.flush({
        send: async () => {
          throw Object.assign(
            new Error("PRIVATE_RAW_RESPONSE /Users/private/capture.json"),
            { status: fixture.status },
          );
        },
      }),
    );
    assert.deepEqual(recorder.health(), {
      schemaVersion: 1,
      pendingCount: 1,
      errorCode: fixture.code,
      updatedAt: "2026-08-16T14:00:00.000Z",
      counters: {
        ...EMPTY_HEALTH_COUNTERS,
        transportFailures: 1,
      },
    });
    const healthPath = join(directory, "capture-health.json");
    assert.equal(statSync(healthPath).mode & 0o777, 0o600);
    assert.doesNotMatch(
      readFileSync(healthPath, "utf8"),
      /PRIVATE_RAW_RESPONSE|\/Users\/private|capture\.json|Bearer|Authorization/,
    );

    await recorder.flush({
      send: async (_target, batch) => ({
        acceptedEventIds: batch.events.map(({ eventId }) => eventId),
        duplicateEventIds: [],
        rejected: [],
      }),
    });
    assert.deepEqual(recorder.health(), {
      schemaVersion: 1,
      pendingCount: 0,
      errorCode: null,
      updatedAt: "2026-08-16T14:00:00.000Z",
      counters: {
        ...EMPTY_HEALTH_COUNTERS,
        transportFailures: 1,
      },
    });
  }
});

test("default transport classifies bounded HTTP status without parsing an error body", async (t) => {
  let responseStatus = 401;
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("PRIVATE_RAW_RESPONSE /Users/private/capture.json", {
        status: responseStatus,
      }),
  );
  const cases = [
    { target: TARGET, headers: HEADERS, status: 401, code: "AUTH_REJECTED" },
    { target: TARGET, headers: HEADERS, status: 403, code: "AUTH_REJECTED" },
    { target: TARGET, headers: HEADERS, status: 500, code: "TRANSPORT_UNAVAILABLE" },
    {
      target: MANAGED_TARGET,
      headers: { "X-Coredoc-Relay-Binding": "local-relay-binding-one" },
      workspaceId: "ws-1",
      status: 401,
      code: "BINDING_MISMATCH",
    },
  ];
  for (const [index, fixture] of cases.entries()) {
    responseStatus = fixture.status;
    const recorder = createCaptureRecorder({
      directory: mkdtempSync(join(tmpdir(), "coredoc-capture-default-http-")),
      target: fixture.target,
      headers: fixture.headers,
      ...(fixture.workspaceId === undefined
        ? {}
        : { workspaceId: fixture.workspaceId }),
      context: { host: "claude-code", sessionId: `session-http-${index}` },
      idFactory: () => EVENT_ID,
      now: () => "2026-08-16T14:00:00.000Z",
    });
    recorder.record({
      occurredAt: "2026-08-16T13:59:00.000Z",
      type: "capability.used",
      data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
    });
    await assert.rejects(
      recorder.flush(),
      (error) => error?.code === fixture.code && error.message === fixture.code,
    );
    assert.equal(recorder.health().errorCode, fixture.code);
    assert.doesNotMatch(
      JSON.stringify(recorder.health()),
      /PRIVATE_RAW_RESPONSE|\/Users\/private|capture\.json/,
    );
  }
});

test("records network, unsupported schema, overflow, and pending as closed current facts", async () => {
  const networkDirectory = mkdtempSync(join(tmpdir(), "coredoc-capture-network-health-"));
  const network = createCaptureRecorder({
    directory: networkDirectory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-network" },
    idFactory: () => EVENT_ID,
    now: () => "2026-08-16T14:01:00.000Z",
  });
  network.record({
    occurredAt: "2026-08-16T14:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  });
  assert.equal(network.health().errorCode, "OUTBOX_PENDING");
  await assert.rejects(
    network.flush({
      send: async () => {
        throw new Error("PRIVATE_NETWORK_DIAGNOSTIC");
      },
    }),
  );
  assert.deepEqual(network.health(), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "TRANSPORT_UNAVAILABLE",
    updatedAt: "2026-08-16T14:01:00.000Z",
    counters: {
      ...EMPTY_HEALTH_COUNTERS,
      transportFailures: 1,
    },
  });

  const unsupportedDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-capture-unsupported-health-"),
  );
  const unsupported = createCaptureRecorder({
    directory: unsupportedDirectory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-unsupported" },
    idFactory: () => EVENT_ID,
    now: () => "2026-08-16T14:02:00.000Z",
  });
  unsupported.record({
    occurredAt: "2026-08-16T14:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  });
  await unsupported.flush({
    send: async () => ({
      acceptedEventIds: [],
      duplicateEventIds: [],
      rejected: [{ eventId: EVENT_ID, code: "UNSUPPORTED_SCHEMA_VERSION" }],
    }),
  });
  assert.deepEqual(unsupported.health(), {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: "UNSUPPORTED_SCHEMA_VERSION",
    updatedAt: "2026-08-16T14:02:00.000Z",
    counters: {
      ...EMPTY_HEALTH_COUNTERS,
      unsupportedSchemaVersions: 1,
    },
  });

  const overflowDirectory = mkdtempSync(join(tmpdir(), "coredoc-capture-closed-overflow-"));
  const ids = [EVENT_ID, SECOND_EVENT_ID];
  const overflow = createCaptureRecorder({
    directory: overflowDirectory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-overflow" },
    idFactory: () => ids.shift(),
    maxEntries: 1,
    now: () => "2026-08-16T14:03:00.000Z",
  });
  const event = {
    occurredAt: "2026-08-16T14:00:00.000Z",
    type: "capability.used",
    data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
  };
  assert.equal(overflow.record(event).status, "queued");
  assert.equal(overflow.health().errorCode, "OUTBOX_PENDING");
  assert.equal(overflow.record(event).status, "overflow");
  assert.deepEqual(overflow.health(), {
    schemaVersion: 1,
    pendingCount: 1,
    errorCode: "OUTBOX_OVERFLOW",
    updatedAt: "2026-08-16T14:03:00.000Z",
    counters: { ...EMPTY_HEALTH_COUNTERS, overflow: 1 },
  });
});

test("health derives stale binding and unreadable entry facts from the current outbox", () => {
  const staleDirectory = mkdtempSync(join(tmpdir(), "coredoc-capture-health-stale-"));
  const stale = createFileOutbox({
    directory: staleDirectory,
    binding: binding({ workspaceId: "old-workspace" }),
  });
  stale.enqueue(startedEvent());
  const current = createCaptureRecorder({
    directory: staleDirectory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-current" },
  });
  assert.deepEqual(current.health(), {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: "BINDING_MISMATCH",
    updatedAt: null,
    counters: EMPTY_HEALTH_COUNTERS,
  });

  const unreadableDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-capture-health-unreadable-"),
  );
  writeFileSync(join(unreadableDirectory, `${EVENT_ID}.event.json`), "not-json\n", {
    mode: 0o600,
  });
  const unreadable = createCaptureRecorder({
    directory: unreadableDirectory,
    target: TARGET,
    headers: HEADERS,
    context: { host: "claude-code", sessionId: "session-current" },
  });
  assert.deepEqual(unreadable.health(), {
    schemaVersion: 1,
    pendingCount: 0,
    errorCode: "CONFIG_CONFLICT",
    updatedAt: null,
    counters: EMPTY_HEALTH_COUNTERS,
  });
});

test("health refuses non-0600, symlinked, oversized, and malformed diagnostic files", () => {
  const privateSentinel = "PRIVATE_HEALTH_SENTINEL /Users/private/health.json";
  for (const fixture of ["mode", "symlink", "oversized", "malformed"]) {
    const directory = mkdtempSync(join(tmpdir(), `coredoc-capture-health-${fixture}-`));
    const healthPath = join(directory, "capture-health.json");
    if (fixture === "symlink") {
      const target = join(directory, "private-target.json");
      writeFileSync(target, privateSentinel, { mode: 0o600 });
      symlinkSync(target, healthPath);
    } else if (fixture === "oversized") {
      writeFileSync(healthPath, "x".repeat(8_192), { mode: 0o600 });
    } else if (fixture === "malformed") {
      writeFileSync(healthPath, `${privateSentinel}\n`, { mode: 0o600 });
    } else {
      writeFileSync(
        healthPath,
        `${JSON.stringify({
          schemaVersion: 1,
          pendingCount: 0,
          errorCode: null,
          updatedAt: "2026-08-16T14:00:00.000Z",
          counters: EMPTY_HEALTH_COUNTERS,
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(healthPath, 0o644);
    }
    const recorder = createCaptureRecorder({
      directory,
      target: TARGET,
      headers: HEADERS,
      context: { host: "claude-code", sessionId: "session-health" },
    });
    const health = recorder.health();
    assert.deepEqual(health, {
      schemaVersion: 1,
      pendingCount: 0,
      errorCode: "CONFIG_CONFLICT",
      updatedAt: null,
      counters: EMPTY_HEALTH_COUNTERS,
    });
    assert.doesNotMatch(JSON.stringify(health), /PRIVATE|\/Users\/private/);
  }
});

test("disabled recorder creates no opt-out backlog", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-disabled-"));
  const recorder = createCaptureRecorder({
    directory,
    target: "",
    context: { host: "claude-code", sessionId: "session-42" },
    idFactory: () => EVENT_ID,
  });

  assert.deepEqual(
    recorder.record({
      occurredAt: "2026-08-15T10:00:00.000Z",
      type: "workflow.run.started",
      runId: "cdr-20260815-a1b2c3",
      data: startedEvent().data,
    }),
    { status: "disabled" },
  );
  assert.deepEqual(recorder.pending(), []);
});
