import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  executeRoutedTask,
  inferTaskSignals,
  prepareRoutedTask,
  recordRoutedTaskCapture,
  routeTask,
} from "./route-task.mjs";
import { readWorkflowRun } from "./workflow-run-state.mjs";

const TASK_ID = "cdt_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

test("prepares a routed task with one canonical run ID and route event", () => {
  const routed = prepareRoutedTask(
    { intent: "change", risk: "high" },
    {
      at: new Date("2026-07-30T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );

  assert.equal(routed.route.runId, "cdr-20260730-a1b2c3");
  assert.equal(routed.route.workflowId, "change:high");
  assert.deepEqual(routed.event, {
    schemaVersion: 1,
    at: "2026-07-30T10:00:00.000Z",
    runId: "cdr-20260730-a1b2c3",
    workflowId: "change:high",
    type: "route.selected",
    intent: "change",
    risk: "high",
  });
});

test("records the routed workflow through the v2 declared-DAG capture contract", async () => {
  const routed = prepareRoutedTask(
    {
      intent: "change",
      risk: "normal",
      scale: "large",
      taskId: TASK_ID,
    },
    {
      at: new Date("2026-08-15T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  const calls = [];

  const result = await recordRoutedTaskCapture(routed, {
    env: {
      COREDOC_CAPTURE_ENDPOINT:
        "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
      COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
      COREDOC_WORKFLOWS_SESSION_ID: "session-42",
      COREDOC_WORKFLOWS_REPO_KEY: "coredoc/coredoc-parser",
      COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/unused-capture-dir",
    },
    createRecorder: (options) => {
      const { idFactory, ...configuration } = options;
      assert.equal(typeof idFactory, "function");
      calls.push(["create", configuration]);
      return {
        record: (event) => {
          calls.push(["record", event]);
          return { status: "queued", eventId: "event-42", pending: 1 };
        },
        flush: async () => {
          calls.push(["flush"]);
          return {
            attempted: 1,
            accepted: 1,
            duplicates: 0,
            rejected: 0,
            pending: 0,
            bindingRefused: 0,
            receipt: {
              acceptedEventIds: ["event-42"],
              duplicateEventIds: [],
              rejected: [],
            },
          };
        },
      };
    },
  });

  assert.equal(result.status, "sent");
  assert.deepEqual(calls[0], [
    "create",
    {
      directory: "/tmp/unused-capture-dir",
      target:
        "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
      headers: { Authorization: "Bearer capture-token" },
      context: {
        host: "claude-code",
        sessionId: "session-42",
        repositoryKey: "coredoc/coredoc-parser",
      },
    },
  ]);
  assert.deepEqual(calls[1], [
    "record",
    {
      schemaVersion: 2,
      occurredAt: "2026-08-15T10:00:00.000Z",
      type: "workflow.run.started",
      runId: "cdr-20260815-a1b2c3",
      taskId: TASK_ID,
      data: {
        workflowId: "change:large:normal",
        intent: "change",
        risk: "normal",
        scale: "large",
        stages: [
          { stageId: "spec", after: [] },
          { stageId: "design", after: ["spec"] },
          { stageId: "tdd", after: ["design"] },
          { stageId: "review", after: ["tdd"] },
        ],
      },
    },
  ]);
  assert.deepEqual(calls[2], ["flush"]);
  assert.equal(Object.hasOwn(routed.event, "taskId"), false);
  assert.equal(Object.hasOwn(calls[1][1].data, "taskId"), false);
});

test("canonicalizes related work items and emits only the start fact as v3", async () => {
  const routed = prepareRoutedTask(
    {
      intent: "change",
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
    {
      at: new Date("2026-08-18T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  let recorded;

  await recordRoutedTaskCapture(routed, {
    env: {
      COREDOC_CAPTURE_ENDPOINT:
        "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
      COREDOC_WORKFLOWS_SESSION_ID: "session-42",
      COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/unused-capture-dir",
    },
    createRecorder: () => ({
      record: (event) => {
        recorded = event;
        return { status: "queued", eventId: "event-42", pending: 1 };
      },
      flush: async () => ({
        pending: 0,
        bindingRefused: 0,
        unreadable: 0,
        receipt: {
          acceptedEventIds: ["event-42"],
          duplicateEventIds: [],
          rejected: [],
        },
      }),
    }),
  });

  assert.deepEqual(routed.route.workItems, [
    { provider: "jira", externalId: "10042", externalKey: "CORE-123" },
    { provider: "linear", externalId: "lin-42" },
  ]);
  assert.equal(recorded.schemaVersion, 3);
  assert.deepEqual(recorded.data.workItems, routed.route.workItems);
  assert.equal(Object.hasOwn(recorded, "taskId"), false);
});

test("omits taskId from capture when the route is not task-linked", async () => {
  const routed = prepareRoutedTask(
    { intent: "direct" },
    {
      at: new Date("2026-08-15T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  let recorded;

  await recordRoutedTaskCapture(routed, {
    env: {
      COREDOC_CAPTURE_ENDPOINT:
        "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
      COREDOC_WORKFLOWS_SESSION_ID: "session-42",
      COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/unused-capture-dir",
    },
    createRecorder: () => ({
      record: (event) => {
        recorded = event;
        return { status: "queued", eventId: "event-42", pending: 1 };
      },
      flush: async () => ({
        attempted: 1,
        accepted: 1,
        duplicates: 0,
        rejected: 0,
        pending: 0,
        bindingRefused: 0,
        receipt: {
          acceptedEventIds: ["event-42"],
          duplicateEventIds: [],
          rejected: [],
        },
      }),
    }),
  });

  assert.equal(Object.hasOwn(routed.route, "taskId"), false);
  assert.equal(Object.hasOwn(recorded, "taskId"), false);
});

test("keeps the durable capture outbox stable when a standalone repo gains config", async () => {
  const routed = prepareRoutedTask(
    { intent: "change", risk: "normal", scale: "normal" },
    {
      at: new Date("2026-08-15T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  const stateHome = mkdtempSync(join(tmpdir(), "coredoc-capture-state-"));
  const repo = join(stateHome, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  const configuredDirectories = [];
  const env = {
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_SESSION_ID: "session-42",
    COREDOC_WORKFLOWS_STATE_HOME: stateHome,
  };
  const createRecorder = (options) => {
    configuredDirectories.push(options.directory);
    return {
      record: () => ({ status: "queued", eventId: "event-42", pending: 1 }),
      flush: async () => ({
        attempted: 1,
        accepted: 1,
        duplicates: 0,
        rejected: 0,
        pending: 0,
        bindingRefused: 0,
        receipt: {
          acceptedEventIds: ["event-42"],
          duplicateEventIds: [],
          rejected: [],
        },
      }),
    };
  };

  await recordRoutedTaskCapture(routed, {
    cwd: repo,
    env,
    createRecorder,
  });
  writeFileSync(
    join(repo, "coredoc.config.json"),
    `${JSON.stringify({
      projects: [{ id: "pilot", repos: [{ path: "." }] }],
    })}\n`,
  );
  await recordRoutedTaskCapture(routed, { cwd: repo, env, createRecorder });

  assert.equal(configuredDirectories.length, 2);
  assert.equal(configuredDirectories[0], configuredDirectories[1]);
  assert.match(configuredDirectories[0], /\/state\/capture-events$/);
});

test("distinguishes a durable delivery failure from capture misconfiguration", async () => {
  const routed = prepareRoutedTask(
    { intent: "change", risk: "normal", scale: "normal" },
    {
      at: new Date("2026-08-15T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  const env = {
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_SESSION_ID: "session-42",
    COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/unused-capture-dir",
  };

  assert.deepEqual(
    await recordRoutedTaskCapture(routed, {
      env,
      createRecorder: () => ({
        record: () => ({ status: "queued", eventId: "event-42", pending: 1 }),
        flush: async () => {
          throw new Error("offline");
        },
        pending: () => [{ eventId: "event-42" }],
      }),
    }),
    { status: "pending", eventId: "event-42", pending: 1 },
  );

  assert.deepEqual(
    await recordRoutedTaskCapture(routed, {
      env,
      createRecorder: () => {
        throw new Error("missing credential");
      },
    }),
    { status: "failed" },
  );
});

test("reports an immediately rejected v3 route independently of older outbox receipts", async () => {
  const routed = prepareRoutedTask(
    {
      intent: "change",
      risk: "normal",
      scale: "normal",
      workItems: [{ provider: "jira", externalId: "10042" }],
    },
    {
      at: new Date("2026-08-15T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  const env = {
    COREDOC_CAPTURE_ENDPOINT:
      "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_SESSION_ID: "session-42",
    COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/unused-capture-dir",
  };

  const result = await recordRoutedTaskCapture(routed, {
    env,
    createRecorder: () => ({
      record: () => ({ status: "queued", eventId: "current-event", pending: 2 }),
      flush: async () => ({
        attempted: 2,
        accepted: 1,
        duplicates: 0,
        rejected: 1,
        unmatched: 0,
        pending: 0,
        bindingRefused: 2,
        unreadable: 1,
        receipt: {
          acceptedEventIds: ["older-event"],
          duplicateEventIds: [],
          rejected: [{ eventId: "current-event", code: "INVALID_EVENT" }],
        },
      }),
    }),
  });

  assert.deepEqual(result, {
    status: "rejected",
    eventId: "current-event",
    pending: 0,
    bindingRefused: 2,
    unreadable: 1,
  });

  const requestFailure = await recordRoutedTaskCapture(routed, {
    env,
    createRecorder: () => ({
      record: () => ({ status: "queued", eventId: "current-event", pending: 1 }),
      flush: async () => ({
        attempted: 1,
        accepted: 0,
        duplicates: 0,
        rejected: 1,
        unmatched: 1,
        pending: 1,
        bindingRefused: 0,
        unreadable: 0,
        receipt: {
          acceptedEventIds: [],
          duplicateEventIds: [],
          rejected: [{ eventId: null, code: "REQUEST_INVALID" }],
        },
      }),
    }),
  });
  assert.deepEqual(requestFailure, {
    status: "pending",
    eventId: "current-event",
    pending: 1,
  });
});

test("never reuses an unrelated OTLP credential for capture", async () => {
  const routed = prepareRoutedTask(
    { intent: "direct", risk: "normal", scale: "normal" },
    {
      at: new Date("2026-08-15T10:00:00.000Z"),
      entropy: Buffer.from("a1b2c3", "hex"),
    },
  );
  let configuredHeaders;

  const result = await recordRoutedTaskCapture(routed, {
    env: {
      COREDOC_CAPTURE_ENDPOINT:
        "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer unrelated-otel-token",
      COREDOC_WORKFLOWS_SESSION_ID: "session-42",
      COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/unused-capture-dir",
    },
    createRecorder: (options) => {
      configuredHeaders = options.headers;
      throw new Error("capture credential missing");
    },
  });

  assert.deepEqual(configuredHeaders, {});
  assert.deepEqual(result, { status: "failed" });
});

test("CLI stores the exact routed DAG and every completion requirement", () => {
  const sessionId = "session-route-large";
  const env = {
    ...process.env,
    COREDOC_WORKFLOWS_SESSION_ID: sessionId,
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-route-"),
    ),
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
  const output = execFileSync(
    process.execPath,
    [
      new URL("./route-task.mjs", import.meta.url).pathname,
      "--intent",
      "change",
      "--scale",
      "large",
    ],
    { encoding: "utf8", env },
  );

  assert.deepEqual(JSON.parse(output).stages.map(({ skill }) => skill), [
    "coredoc-spec",
    "coredoc-plan-review",
    "coredoc-tdd",
    "coredoc-review",
  ]);
  assert.equal(JSON.parse(output).runStateStatus, "started");
  assert.deepEqual(readWorkflowRun(sessionId, { env }).requiredSkills, [
    "coredoc-spec",
    "coredoc-plan-review",
    "coredoc-tdd",
    "coredoc-review",
  ]);
  assert.equal(readWorkflowRun(sessionId, { env }).captureSchemaVersion, 2);
  assert.deepEqual(readWorkflowRun(sessionId, { env }).declaredStages, [
    { stageId: "spec", after: [] },
    { stageId: "design", after: ["spec"] },
    { stageId: "tdd", after: ["design"] },
    { stageId: "review", after: ["tdd"] },
  ]);

  const reroute = spawnSync(
    process.execPath,
    [
      new URL("./route-task.mjs", import.meta.url).pathname,
      "--intent",
      "review",
    ],
    { encoding: "utf8", env },
  );
  assert.equal(reroute.status, 1);
  assert.match(reroute.stderr, /already active.*finish or abandon it/i);
  assert.equal(readWorkflowRun(sessionId, { env }).workflowId, "change:large:normal");
});

test("CLI composes an exact task ID with inferred task text in either argument order", () => {
  const script = new URL("./route-task.mjs", import.meta.url).pathname;
  const argumentSets = [
    ["--task-id", TASK_ID, "--task", "fix the broken parser"],
    ["--task", "fix the broken parser", "--task-id", TASK_ID],
  ];

  for (const [index, args] of argumentSets.entries()) {
    const output = JSON.parse(
      execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          COREDOC_WORKFLOWS_SESSION_ID: `session-task-link-${index}`,
          COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
            join(tmpdir(), "coredoc-workflow-task-link-"),
          ),
          COREDOC_CAPTURE_ENDPOINT: "",
          COREDOC_CAPTURE_HEADERS: "",
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
          OTEL_EXPORTER_OTLP_HEADERS: "",
        },
      }),
    );

    assert.equal(output.intent, "change");
    assert.equal(output.taskId, TASK_ID);
  }
});

test("CLI accepts repeated work-item groups and canonicalizes them before routing", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coredoc-workflow-work-items-"));
  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [
        new URL("./route-task.mjs", import.meta.url).pathname,
        "--intent",
        "change",
        "--work-item-provider",
        "linear",
        "--work-item-external-id",
        "lin-42",
        "--work-item-provider",
        "jira",
        "--work-item-external-id",
        "10042",
        "--work-item-provider",
        "jira",
        "--work-item-external-id",
        "10042",
        "--work-item-external-key",
        "CORE-123",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COREDOC_WORKFLOWS_SESSION_ID: "session-work-item-route",
          COREDOC_WORKFLOWS_STATE_DIR: stateDir,
          COREDOC_CAPTURE_ENDPOINT: "",
          COREDOC_CAPTURE_HEADERS: "",
        },
      },
    ),
  );

  assert.deepEqual(output.workItems, [
    { provider: "jira", externalId: "10042", externalKey: "CORE-123" },
    { provider: "linear", externalId: "lin-42" },
  ]);
  assert.equal(readWorkflowRun("session-work-item-route", {
    env: { COREDOC_WORKFLOWS_STATE_DIR: stateDir },
  }).captureSchemaVersion, 2);
});

test("CLI refuses malformed or unsafe work-item groups before local writes", () => {
  const unsafeIds = [
    "has space",
    '"quoted"',
    "`backtick`",
    "$(subshell)",
    "left&&right",
    "left|right",
    "left>right",
    "left<right",
    "left\\right",
    "left(right)",
    "left\nright",
    "*.glob",
    "?.glob",
    "[abc]",
  ];
  const nineGroups = Array.from({ length: 9 }, (_, index) => [
    "--work-item-provider",
    "jira",
    "--work-item-external-id",
    String(10000 + index),
  ]).flat();
  const invalidGroups = [
    ["--work-item-provider", "jira"],
    ["--work-item-external-id", "10042"],
    [
      "--work-item-provider",
      "jira;touch",
      "--work-item-external-id",
      "10042",
    ],
    [
      "--work-item-provider",
      "jira",
      "--work-item-external-id",
      "10042",
      "--work-item-external-key",
      "A-1",
      "--work-item-provider",
      "jira",
      "--work-item-external-id",
      "10042",
      "--work-item-external-key",
      "B-2",
    ],
    [
      "--task-id",
      TASK_ID,
      "--work-item-provider",
      "jira",
      "--work-item-external-id",
      "10042",
    ],
    nineGroups,
    ...unsafeIds.map((externalId) => [
      "--work-item-provider",
      "jira",
      "--work-item-external-id",
      externalId,
    ]),
  ];

  for (const [index, workItemArgs] of invalidGroups.entries()) {
    const root = mkdtempSync(join(tmpdir(), "coredoc-workflow-invalid-item-"));
    const stateDir = join(root, "state");
    const captureDir = join(root, "capture");
    const result = spawnSync(
      process.execPath,
      [
        new URL("./route-task.mjs", import.meta.url).pathname,
        "--intent",
        "change",
        ...workItemArgs,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COREDOC_WORKFLOWS_SESSION_ID: `session-invalid-item-${index}`,
          COREDOC_WORKFLOWS_STATE_DIR: stateDir,
          COREDOC_WORKFLOWS_CAPTURE_DIR: captureDir,
          COREDOC_CAPTURE_ENDPOINT:
            "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
          COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
        },
      },
    );

    assert.equal(result.status, 1, workItemArgs.join(" "));
    assert.equal(existsSync(stateDir), false, workItemArgs.join(" "));
    assert.equal(existsSync(captureDir), false, workItemArgs.join(" "));
  }
});

test("managed relay schema refusal happens before run state or outbox delivery", async () => {
  const calls = [];
  await assert.rejects(
    executeRoutedTask(
      {
        intent: "change",
        workItems: [{ provider: "jira", externalId: "10042" }],
      },
      {
        preflight: async (schemaVersion) => {
          calls.push(["preflight", schemaVersion]);
          throw new Error("old relay");
        },
        startRun: () => calls.push(["state"]),
        recordCapture: async () => calls.push(["capture"]),
      },
    ),
    /old relay/,
  );

  assert.deepEqual(calls, [["preflight", 3]]);
});

// Inference fills what the caller left out; a flag the caller typed is a
// decision, not a hint, so it must survive the inferred signals.
test("CLI lets explicit signal flags override inference from task text", () => {
  const script = new URL("./route-task.mjs", import.meta.url).pathname;
  const argumentSets = [
    ["--task", "fix the broken parser", "--intent", "review", "--risk", "high"],
    ["--risk", "high", "--intent", "review", "--task", "fix the broken parser"],
  ];

  for (const [index, args] of argumentSets.entries()) {
    const output = JSON.parse(
      execFileSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          COREDOC_WORKFLOWS_SESSION_ID: `session-explicit-flags-${index}`,
          COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
            join(tmpdir(), "coredoc-workflow-explicit-flags-"),
          ),
          COREDOC_CAPTURE_ENDPOINT: "",
          COREDOC_CAPTURE_HEADERS: "",
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
          OTEL_EXPORTER_OTLP_HEADERS: "",
        },
      }),
    );

    assert.equal(output.intent, "review");
    assert.equal(output.risk, "high");
    assert.equal(output.workflowId, "review:high");
  }

  // Signals the caller did not supply still come from the task text.
  const inferred = JSON.parse(
    execFileSync(
      process.execPath,
      [script, "--task", "fix the broken parser", "--risk", "high"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          COREDOC_WORKFLOWS_SESSION_ID: "session-explicit-flags-partial",
          COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
            join(tmpdir(), "coredoc-workflow-explicit-flags-partial-"),
          ),
          COREDOC_CAPTURE_ENDPOINT: "",
          COREDOC_CAPTURE_HEADERS: "",
          OTEL_EXPORTER_OTLP_ENDPOINT: "",
          OTEL_EXPORTER_OTLP_HEADERS: "",
        },
      },
    ),
  );
  assert.equal(inferred.intent, "change");
  assert.equal(inferred.risk, "high");
});

test("CLI rejects an invalid task ID before creating run state or a capture outbox", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-workflow-invalid-task-"));
  const stateDir = join(root, "state");
  const captureDir = join(root, "capture");
  const result = spawnSync(
    process.execPath,
    [
      new URL("./route-task.mjs", import.meta.url).pathname,
      "--task-id",
      "JIRA-42",
      "--intent",
      "change",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        COREDOC_WORKFLOWS_SESSION_ID: "session-invalid-task-link",
        COREDOC_WORKFLOWS_STATE_DIR: stateDir,
        COREDOC_WORKFLOWS_CAPTURE_DIR: captureDir,
        COREDOC_CAPTURE_ENDPOINT:
          "https://capture.invalid/api/v1/workspaces/ws/capture/v1/events",
        COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
      },
    },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /task ID is invalid/);
  assert.equal(existsSync(stateDir), false);
  assert.equal(existsSync(captureDir), false);
});

test("CLI route no longer consumes or reports legacy OTLP delivery state", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coredoc-workflow-route-telemetry-"));
  writeFileSync(
    join(stateDir, "last-emission.json"),
    `${JSON.stringify({
      status: "failed",
      at: "2026-07-30T09:00:00.000Z",
      eventName: "coredoc-workflows.workflow_finished",
      reason: "endpoint refused connection",
    })}\n`,
    "utf8",
  );
  writeFileSync(
    join(stateDir, "pruned-pending-count.json"),
    `${JSON.stringify({ count: 2 })}\n`,
    "utf8",
  );
  const baseEnv = {
    ...process.env,
    COREDOC_WORKFLOWS_STATE_DIR: stateDir,
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [new URL("./route-task.mjs", import.meta.url).pathname, "--intent", "direct"],
      {
        encoding: "utf8",
        env: { ...baseEnv, COREDOC_WORKFLOWS_SESSION_ID: "session-telemetry-1" },
      },
    ),
  );
  assert.equal(Object.hasOwn(output, "telemetry"), false);
  assert.match(readFileSync(join(stateDir, "last-emission.json"), "utf8"), /endpoint refused connection/);
  assert.match(readFileSync(join(stateDir, "pruned-pending-count.json"), "utf8"), /"count":2/);
});

test("CLI reports when host session attribution is unavailable", () => {
  const env = {
    ...process.env,
    COREDOC_WORKFLOWS_SESSION_ID: "",
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
  const output = execFileSync(
    process.execPath,
    [
      new URL("./route-task.mjs", import.meta.url).pathname,
      "--intent",
      "change",
      "--scale",
      "large",
    ],
    { encoding: "utf8", env },
  );

  assert.equal(JSON.parse(output).runStateStatus, "unattributed");
});

test("CLI attributes a routed run to the native Codex session", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "coredoc-codex-route-state-"));
  const codexSessionId = "11111111-1111-4111-8111-111111111111";
  const env = {
    ...process.env,
    CODEX_SESSION_ID: codexSessionId,
    CODEX_THREAD_ID: codexSessionId,
    COREDOC_WORKFLOWS_STATE_DIR: stateDir,
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
  };
  delete env.COREDOC_WORKFLOWS_SESSION_ID;

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      [new URL("./route-task.mjs", import.meta.url).pathname, "--intent", "direct"],
      { encoding: "utf8", env },
    ),
  );

  assert.equal(output.runStateStatus, "started");
  assert.equal(readWorkflowRun(codexSessionId, { env }).runId, output.runId);
});

test("routes a simple request directly without context ceremony", () => {
  assert.deepEqual(routeTask({ intent: "direct" }), {
    workflowId: "direct",
    intent: "direct",
    risk: "normal",
    scale: "normal",
    stages: [],
    contextProviders: [],
  });
});

test("routes a large change through specification, approval, TDD, and review", () => {
  const route = routeTask({ intent: "change", scale: "large" });

  assert.equal(route.workflowId, "change:large:normal");
  assert.equal(route.scale, "large");
  assert.deepEqual(
    route.stages.map(({ id, skill, after, gate }) => ({
      id,
      skill,
      after,
      ...(gate === undefined ? {} : { gate }),
    })),
    [
      { id: "spec", skill: "coredoc-spec", after: [] },
      { id: "design", skill: "coredoc-plan-review", after: ["spec"] },
      {
        id: "tdd",
        skill: "coredoc-tdd",
        after: ["design"],
        gate: "user-approval",
      },
      { id: "review", skill: "coredoc-review", after: ["tdd"] },
    ],
  );
});

test("keeps large change dependencies stable across risk and investigation", () => {
  const high = routeTask({ intent: "change", scale: "large", risk: "high" });
  assert.equal(high.workflowId, "change:large:high");
  assert.deepEqual(
    high.stages.map(({ id }) => id),
    ["spec", "design", "tdd", "review"],
  );

  const bug = routeTask({ intent: "change", scale: "large", bugLike: true });
  assert.equal(bug.workflowId, "change:root-cause:large:normal");
  assert.deepEqual(
    bug.stages.map(({ id, after }) => ({ id, after })),
    [
      { id: "investigate", after: [] },
      { id: "spec", after: ["investigate"] },
      { id: "design", after: ["spec"] },
      { id: "tdd", after: ["design"] },
      { id: "review", after: ["tdd"] },
    ],
  );
});

test("preserves explicit large scale for review routes", () => {
  const route = routeTask({ intent: "review", scale: "large" });

  assert.equal(route.workflowId, "review:large:normal");
  assert.equal(route.scale, "large");
  assert.deepEqual(
    route.stages.map(({ id }) => id),
    ["review"],
  );
});

test("keeps scale inert for routes without large-scale behavior", () => {
  assert.deepEqual(
    routeTask({ intent: "diagnose", scale: "large" }),
    routeTask({ intent: "diagnose" }),
  );
});

test("routes a bug fix through investigation and ordinary TDD", () => {
  const route = routeTask({
    intent: "change",
    bugLike: true,
    runtimeSensitive: true,
  });

  assert.deepEqual(
    route.stages.map(({ id, skill, after }) => ({ id, skill, after })),
    [
      { id: "investigate", skill: "coredoc-investigate", after: [] },
      { id: "tdd", skill: "coredoc-tdd", after: ["investigate"] },
    ],
  );
  assert.equal(
    route.contextProviders.some(({ id }) => id === "runtime-observability"),
    true,
  );
});

test("adds the bundled review skill only for a high-risk change", () => {
  const normal = routeTask({ intent: "change" });
  const high = routeTask({ intent: "change", risk: "high" });

  assert.deepEqual(
    normal.stages.map(({ id }) => id),
    ["tdd"],
  );
  assert.deepEqual(
    high.stages.map(({ id }) => id),
    ["tdd", "review"],
  );
});

test("does not add approval gates to normal changes", () => {
  const route = routeTask({ intent: "change" });

  assert.equal(route.scale, "normal");
  assert.equal(route.stages.every(({ gate }) => gate === undefined), true);
});

test("all routed stages are self-contained plugin capabilities", () => {
  for (const intent of [
    "diagnose",
    "design",
    "change",
    "review",
    "spec",
    "qa",
    "qa-report",
    "benchmark",
    "security",
    "browse",
    "learn",
    "retro",
  ]) {
    const route = routeTask({ intent });
    assert.equal(
      route.stages.every(
        ({ provider }) => provider === "coredoc-workflows",
      ),
      true,
    );
  }
});

test("UI workflows select surface-aware control and runtime context", () => {
  const route = routeTask({ intent: "qa-report" });

  assert.equal(route.workflowId, "qa-report:normal");
  assert.deepEqual(
    route.stages.map(({ skill }) => skill),
    ["coredoc-runtime-qa-report"],
  );
  assert.equal(
    route.contextProviders.some(({ id }) => id === "ui-control"),
    true,
  );
  assert.equal(
    route.contextProviders.some(({ id }) => id === "runtime-observability"),
    true,
  );
});

test("selects database context only for data-sensitive tasks", () => {
  const route = routeTask({ intent: "diagnose", dataSensitive: true });

  assert.equal(
    route.contextProviders.some(({ id }) => id === "database-read-only"),
    true,
  );
  assert.equal(
    route.contextProviders
      .filter(({ id }) => id !== "ui-control")
      .every(({ access }) => access === "read-only"),
    true,
  );
});

test("infers Ukrainian workflows", () => {
  assert.equal(inferTaskSignals("зроби перенос workflow plugin").intent, "change");
  assert.equal(inferTaskSignals("напиши спеку для імпорту").intent, "spec");
  assert.equal(inferTaskSignals("протестуй сайт, але не виправляй").intent, "qa-report");
  assert.equal(inferTaskSignals("протестуй десктоп застосунок").intent, "qa");
  assert.equal(inferTaskSignals("зроби аудит безпеки auth").intent, "security");
  assert.equal(inferTaskSignals("зроби скрін сторінки в браузері").intent, "browse");
  assert.equal(inferTaskSignals("зроби ретро за цей тиждень").intent, "retro");
  assert.equal(
    inferTaskSignals("збережи висновок з цієї помилки").intent,
    "learn",
  );

  const fix = inferTaskSignals("виправ помилку таймауту в production DB");
  assert.equal(fix.intent, "change");
  assert.equal(fix.bugLike, true);
  assert.equal(fix.risk, "high");
  assert.equal(fix.dataSensitive, true);
  assert.equal(fix.runtimeSensitive, true);
  assert.equal(fix.scale, "normal");
});

test("infers large changes only for substantive change requests", () => {
  const incident = inferTaskSignals(
    "create a go parser substrate similar to the py and rust ones",
  );
  assert.equal(incident.intent, "change");
  assert.equal(incident.scale, "large");

  const ukrainian = inferTaskSignals("створи новий go парсер з нуля");
  assert.equal(ukrainian.intent, "change");
  assert.equal(ukrainian.scale, "large");

  const rewrite = inferTaskSignals("rewrite the parser substrate");
  assert.equal(rewrite.intent, "change");
  assert.equal(rewrite.scale, "large");

  const ukrainianRewrite = inferTaskSignals("перепиши весь парсер");
  assert.equal(ukrainianRewrite.intent, "change");
  assert.equal(ukrainianRewrite.scale, "large");

  for (const task of [
    "fix the whole login button alignment",
    "rewrite this comment more clearly",
    "перепиши цей коментар зрозуміліше",
  ]) {
    assert.equal(inferTaskSignals(task).scale, "normal", task);
  }

  assert.equal(
    inferTaskSignals("overhaul the authentication subsystem").scale,
    "large",
  );
  assert.equal(
    inferTaskSignals("перепиши всю підсистему авторизації").scale,
    "large",
  );

  assert.equal(inferTaskSignals("diagnose the whole parser").scale, "normal");
});

test("routes learning and retrospectives without persistence providers", () => {
  assert.equal(inferTaskSignals("what did we ship this week?").intent, "retro");
  assert.equal(
    inferTaskSignals("remember this lesson for the next migration").intent,
    "learn",
  );

  for (const intent of ["learn", "retro"]) {
    const route = routeTask({ intent });

    assert.deepEqual(
      route.stages.map(({ skill }) => skill),
      [`coredoc-${intent}`],
    );
    assert.equal(
      route.contextProviders.every(({ access }) => access === "read-only"),
      true,
    );
    assert.equal(
      route.contextProviders.some(({ id }) => id === "runtime-observability"),
      false,
    );
  }
});

test("rejects unknown routing values", () => {
  assert.throws(
    () => routeTask({ intent: "ship-everything" }),
    /Unsupported intent "ship-everything"/,
  );
  assert.throws(
    () => routeTask({ intent: "change", scale: "epic" }),
    /Unsupported scale "epic"/,
  );
});
