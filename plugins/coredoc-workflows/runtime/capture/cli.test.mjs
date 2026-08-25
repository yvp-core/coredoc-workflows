import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../../test/test-api.mjs";

import { runCaptureCommand } from "./cli.mjs";

const TARGET = "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events";
const CONTEXT = {
  host: "claude-code",
  sessionId: "session-42",
  repositoryKey: "coredoc/coredoc-parser",
};

test("strict JSON-stdin record accepts only the event fragment and generates the durable ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-cli-"));
  const result = await runCaptureCommand(
    {
      action: "record",
      context: CONTEXT,
      event: {
        occurredAt: "2026-08-16T10:00:00.000Z",
        type: "capability.used",
        data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
      },
    },
    {
      env: {
        COREDOC_CAPTURE_ENDPOINT: TARGET,
        COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
        COREDOC_WORKFLOWS_CAPTURE_DIR: directory,
      },
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    },
  );

  assert.deepEqual(result, {
    status: "queued",
    eventId: "11111111-1111-4111-8111-111111111111",
    pending: 1,
  });
  const [file] = readdirSync(directory).filter((name) => name.endsWith(".event.json"));
  const stored = JSON.parse(readFileSync(join(directory, file), "utf8"));
  assert.equal(stored.event.sessionId, "session-42");
  assert.equal(stored.event.eventId, result.eventId);

  for (const input of [
    { action: "record", context: CONTEXT, event: {}, prompt: "private" },
    {
      action: "record",
      context: CONTEXT,
      event: {
        eventId: "11111111-1111-4111-8111-111111111111",
        occurredAt: "2026-08-16T10:00:00.000Z",
        type: "capability.used",
        data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
      },
    },
  ]) {
    await assert.rejects(runCaptureCommand(input, { env: {} }), /Unsupported/);
  }
});

test("strict JSON-stdin record carries a v2 declared workflow without changing the endpoint", async () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-capture-cli-v2-"));
  const result = await runCaptureCommand(
    {
      action: "record",
      context: CONTEXT,
      event: {
        schemaVersion: 2,
        occurredAt: "2026-08-16T10:00:00.000Z",
        runId: "cdr-20260816-a1b2c3",
        taskId: "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        type: "workflow.run.started",
        data: {
          workflowId: "change:normal",
          intent: "change",
          risk: "normal",
          scale: "normal",
          stages: [{ stageId: "tdd", after: [] }],
        },
      },
    },
    {
      env: {
        COREDOC_CAPTURE_ENDPOINT: TARGET,
        COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
        COREDOC_WORKFLOWS_CAPTURE_DIR: directory,
      },
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    },
  );

  assert.equal(result.status, "queued");
  const [file] = readdirSync(directory).filter((name) =>
    name.endsWith(".event.json"),
  );
  const stored = JSON.parse(readFileSync(join(directory, file), "utf8"));
  assert.equal(stored.event.schemaVersion, 2);
  assert.deepEqual(stored.event.data.stages, [
    { stageId: "tdd", after: [] },
  ]);
});

test("strict JSON-stdin flush is bounded and disabled mode creates nothing", async () => {
  let flushOptions;
  const flushed = await runCaptureCommand(
    { action: "flush", timeoutMs: 750 },
    {
      env: {
        COREDOC_CAPTURE_ENDPOINT: TARGET,
        COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
        COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/not-used",
      },
      createRecorder: () => ({
        flush: async (options) => {
          flushOptions = options;
          return { attempted: 0, pending: 0 };
        },
      }),
    },
  );
  assert.deepEqual(flushed, { attempted: 0, pending: 0 });
  assert.deepEqual(flushOptions, { timeoutMs: 750 });

  const directory = join(mkdtempSync(join(tmpdir(), "coredoc-capture-cli-off-")), "missing");
  assert.deepEqual(
    await runCaptureCommand(
      {
        action: "record",
        context: CONTEXT,
        event: {
          occurredAt: "2026-08-16T10:00:00.000Z",
          type: "capability.used",
          data: { kind: "skill", capabilityId: "coredoc-spec", outcome: "success" },
        },
      },
      { env: { COREDOC_CAPTURE_ENDPOINT: "", COREDOC_WORKFLOWS_CAPTURE_DIR: directory } },
    ),
    { status: "disabled" },
  );
  assert.throws(() => readdirSync(directory));

  await assert.rejects(
    runCaptureCommand(
      {
        action: "record",
        context: CONTEXT,
        event: {
          occurredAt: "2026-08-16T10:00:00.000Z",
          type: "capability.used",
          data: {
            kind: "skill",
            capabilityId: "coredoc-spec",
            outcome: "success",
            prompt: "must-never-cross-the-contract",
          },
        },
      },
      { env: { COREDOC_CAPTURE_ENDPOINT: "" } },
    ),
    /must not contain prompt/,
  );

  await assert.rejects(
    runCaptureCommand({ action: "flush", timeoutMs: 5_000 }, { env: {} }),
    /timeoutMs/,
  );
});

test("passes the managed relay workspace identity into the runtime recorder", async () => {
  let options;
  await runCaptureCommand(
    { action: "flush" },
    {
      env: {
        COREDOC_CAPTURE_ENDPOINT:
          "http://127.0.0.1:43181/capture/v1/events",
        COREDOC_CAPTURE_HEADERS:
          "X-Coredoc-Relay-Binding=local_binding_abcdefghijklmnopqrstuvwxyz012345",
        COREDOC_CAPTURE_WORKSPACE_ID: "ws-1",
        COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/not-used",
      },
      createRecorder: (value) => {
        options = value;
        return {
          flush: async () => ({ attempted: 0, pending: 0 }),
        };
      },
    },
  );
  assert.equal(options.workspaceId, "ws-1");
});

test("managed CLI records into the global binding-hash outbox without a cwd directory", async () => {
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-capture-cli-managed-"));
  const nonce = "local_binding_abcdefghijklmnopqrstuvwxyz012345";
  const result = await runCaptureCommand(
    {
      action: "record",
      context: CONTEXT,
      event: {
        occurredAt: "2026-08-16T15:00:00.000Z",
        type: "capability.used",
        data: { kind: "skill", capabilityId: "coredoc-tdd", outcome: "success" },
      },
    },
    {
      env: {
        COREDOC_CAPTURE_ENDPOINT:
          "http://127.0.0.1:43181/capture/v1/events",
        COREDOC_CAPTURE_HEADERS: `X-Coredoc-Relay-Binding=${nonce}`,
        COREDOC_CAPTURE_WORKSPACE_ID: "ws-1",
        COREDOC_WORKFLOWS_STATE_HOME: stateHome,
      },
      idFactory: () => "11111111-1111-4111-8111-111111111111",
    },
  );
  assert.equal(result.status, "queued");
  const hash = createHash("sha256").update(nonce).digest("hex");
  const directory = join(stateHome, "capture-relay", "outbox", hash);
  assert.equal(statSync(directory).mode & 0o777, 0o700);
  assert.equal(
    readdirSync(directory).filter((name) => name.endsWith(".event.json")).length,
    1,
  );
});

test("strict JSON-stdin rejects unknown actions and oversized input without echoing content", async () => {
  const sentinel = "PRIVATE_COMMAND_SENTINEL";
  await assert.rejects(
    runCaptureCommand({ action: sentinel }, { env: {} }),
    (error) => {
      assert.equal(error.message, "Unsupported capture action");
      assert.doesNotMatch(error.message, new RegExp(sentinel));
      return true;
    },
  );

  const result = spawnSync(
    process.execPath,
    [new URL("./cli.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      input: JSON.stringify({ action: "record", private: "x".repeat(70_000) }),
      env: { ...process.env, COREDOC_CAPTURE_ENDPOINT: "" },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "capture command exceeds 65536 bytes\n");
});
