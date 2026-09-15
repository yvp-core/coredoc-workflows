/**
 * BR-4 — implement and review close on an observed Coredoc read.
 *
 * The observations are built by feeding the real host fixtures under
 * `hosts/fixtures/gates/` through `hookObservation`, so what the gate judges is
 * what the hook actually records, not a hand-written shape.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { finishWorkflowRun } from "./finish-run.mjs";
import { finishWorkflowSession } from "./session-end.mjs";
import { runWorkflowStage } from "./stage-run.mjs";
import { workflowRunContext, workflowRunStatus } from "./run-status.mjs";
import {
  evaluateMcpGate,
  hasCoredocRead,
  lastRunHistory,
  unresolvedGates,
} from "./workflow-gates.mjs";
import { hookObservation } from "./workflow-observer.mjs";
import {
  appendWorkflowObservation,
  readWorkflowRun,
  startWorkflowRun,
  workflowRunGates,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-mcp-gate";
const RUN_ID = "cdr-20260915-ac0de1";
const PROJECT_KEY = "mcp-gate-fixture";
const DISABLED = { status: "disabled", durable: true, pending: 0 };
const FIXTURES = new URL("./hosts/fixtures/gates/", import.meta.url);
let occurrence = 0;
const idFactory = () => {
  occurrence += 1;
  return `${occurrence.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`;
};

function fixtureEvent(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")).payload;
}

/** One observation exactly as the PostToolUse hook would have recorded it. */
function observed(event, at) {
  const observation = hookObservation(event, at);
  assert.ok(observation, `fixture produced no observation at ${at}`);
  return observation;
}

function fixtureObservation(name, at) {
  return observed(fixtureEvent(name), at);
}

/** A Coredoc call no fixture covers, written in the host's envelope shape. */
function coredocEvent(tool, toolInput, text) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: `mcp__coredoc-cloud__${tool}`,
    tool_input: toolInput,
    tool_response: [{ type: "text", text }],
  };
}

const SEARCH_FIXTURES = [
  "claude-2.1.272-grep.json",
  "claude-2.1.272-glob.json",
  "claude-2.1.272-read.json",
  "claude-2.1.272-bash-rg-version.json",
];

function harness({ gates = "enforce", bound = true } = {}) {
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(join(tmpdir(), "coredoc-mcp-gate-")),
    COREDOC_WORKFLOW_GATES: gates,
  };
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      // Independent stages: each test opens exactly the one stage it gates.
      declaredStages: [
        { stageId: "spec", after: [] },
        { stageId: "implement", after: [] },
        { stageId: "review", after: [] },
      ],
      repositoryKey: PROJECT_KEY,
      bound,
      projectKey: PROJECT_KEY,
      at: "2026-09-15T10:00:00.000Z",
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
  return env;
}

function observe(env, observation) {
  return appendWorkflowObservation(SESSION_ID, observation, { env });
}

function stage(action, stageId, { env, ...options }) {
  return runWorkflowStage(
    { action, stageId, sessionId: SESSION_ID, ...options },
    { env, idFactory, deliver: async () => DISABLED },
  );
}

/** Open `stageId`, record `observations`, close it `success`. */
async function closeWith(env, stageId, observations, options = {}) {
  await stage("start", stageId, { env, at: "2026-09-15T11:00:00.000Z" });
  observations.forEach((observation) => observe(env, observation));
  return stage("finish", stageId, {
    env,
    outcome: "success",
    at: "2026-09-15T11:30:00.000Z",
    ...options,
  });
}

/** The refusal BR-4 produces, asserted in full rather than by shape. */
function refusalMessage(searches, writes, stage) {
  return (
    `${searches} repository searches (Grep/Glob/Read/rg), ${writes} Coredoc writes, ` +
    `0 Coredoc reads in stage ${stage}; read with search_symbols / explain / ` +
    'find_callers / get_intent_context, or close with --skip-mcp "<reason>"'
  );
}

/** `assert.rejects` with the whole message compared, not matched. */
function rejectsWith(message) {
  return (error) => {
    assert.equal(error.message, message);
    return true;
  };
}

test("searches are not reads: four repository searches refuse the implement close", async () => {
  const env = harness();
  const searches = SEARCH_FIXTURES.map((name, index) =>
    fixtureObservation(name, `2026-09-15T11:0${index}:00.000Z`),
  );
  assert.deepEqual(
    searches.map(({ type, tool }) => [type, tool]),
    [
      ["search", "Grep"],
      ["search", "Glob"],
      ["search", "Read"],
      ["search", "Bash"],
    ],
  );
  await assert.rejects(
    () => closeWith(env, "implement", searches),
    (error) => {
      assert.equal(
        error.message,
        '4 repository searches (Grep/Glob/Read/rg), 0 Coredoc writes, 0 Coredoc reads in stage implement; read with search_symbols / explain / find_callers / get_intent_context, or close with --skip-mcp "<reason>"',
      );
      return true;
    },
  );
  // The stage stays open for the remedy and nothing was recorded.
  assert.equal(
    readWorkflowRun(SESSION_ID, { env }).stageProgress.implement.finishedAt,
    undefined,
  );
  assert.deepEqual(workflowRunGates(readWorkflowRun(SESSION_ID, { env })), []);
});

test("writes are not reads: a propose and a handoff save refuse the implement close", async () => {
  const env = harness();
  const writes = [
    fixtureObservation("synthetic-cloud-intent-propose-created.json", "2026-09-15T11:01:00.000Z"),
    fixtureObservation("synthetic-cloud-intent-handoff-save.json", "2026-09-15T11:02:00.000Z"),
  ];
  assert.deepEqual(
    writes.map(({ tool, access, result }) => [tool, access, result]),
    [
      ["intent_propose", "write", "ok"],
      ["intent_handoff", "write", "ok"],
    ],
  );
  await assert.rejects(
    () => closeWith(env, "implement", writes),
    (error) => {
      assert.equal(
        error.message,
        '0 repository searches (Grep/Glob/Read/rg), 2 Coredoc writes, 0 Coredoc reads in stage implement; read with search_symbols / explain / find_callers / get_intent_context, or close with --skip-mcp "<reason>"',
      );
      return true;
    },
  );
});

test("each read that answered ok satisfies the gate on its own", async () => {
  const reads = [
    ["claude-2.1.272-mcp-search-symbols-ok.json", "search_symbols"],
    ["synthetic-cloud-intent-handoff-get.json", "intent_handoff"],
    // An empty `operations` array is still a read that answered.
    ["synthetic-cloud-intent-handoff-list-empty.json", "intent_handoff"],
  ];
  for (const [name, tool] of reads) {
    const env = harness();
    const observation = fixtureObservation(name, "2026-09-15T11:01:00.000Z");
    assert.deepEqual(
      [observation.tool, observation.access, observation.result],
      [tool, "read", "ok"],
      name,
    );
    const closed = await closeWith(env, "implement", [observation]);
    assert.equal(closed.status, "finished", name);
    assert.deepEqual(
      closed.gates.find(({ gate }) => gate === "mcp"),
      { stage: "implement", gate: "mcp", result: "passed", searches: 0, writes: 0 },
      name,
    );
  }

  // `intent_anchor` is classified by its action; no captured fixture covers it.
  const env = harness();
  const preview = observed(
    coredocEvent(
      "intent_anchor",
      { action: "preview", repoKey: PROJECT_KEY },
      '{"anchors":[]}',
    ),
    "2026-09-15T11:01:00.000Z",
  );
  assert.deepEqual(
    [preview.tool, preview.access, preview.result],
    ["intent_anchor", "read", "ok"],
  );
  assert.equal((await closeWith(env, "implement", [preview])).status, "finished");
});

test("a mixed stage passes on its one read and still counts what else it did", async () => {
  const env = harness();
  const closed = await closeWith(env, "implement", [
    fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"),
    fixtureObservation("claude-2.1.272-mcp-search-symbols-ok.json", "2026-09-15T11:02:00.000Z"),
    fixtureObservation("synthetic-cloud-intent-propose-created.json", "2026-09-15T11:03:00.000Z"),
  ]);
  assert.deepEqual(closed.gates.find(({ gate }) => gate === "mcp"), {
    stage: "implement",
    gate: "mcp",
    result: "passed",
    searches: 1,
    writes: 1,
  });
});

test("a read that answered denied is an answer, not a read", async () => {
  const env = harness();
  const denied = observed(
    coredocEvent(
      "get_intent_context",
      { repoKey: PROJECT_KEY },
      '{"status":"permission_denied","requires":{"permission":"intent:read"}}',
    ),
    "2026-09-15T11:01:00.000Z",
  );
  assert.deepEqual(
    [denied.access, denied.result],
    ["read", "denied"],
  );
  assert.equal(hasCoredocRead([denied]), false);
  await assert.rejects(
    () => closeWith(env, "implement", [denied]),
    rejectsWith(refusalMessage(0, 0, "implement")),
  );
});

test("an unclassified Coredoc tool counts as a write and is named in the refusal", async () => {
  const env = harness();
  const unknownTool = observed(
    coredocEvent("intent_teleport", { anything: "x" }, '{"ok":true}'),
    "2026-09-15T11:01:00.000Z",
  );
  assert.deepEqual(
    [unknownTool.access, unknownTool.unclassified],
    ["write", true],
  );
  await assert.rejects(
    () => closeWith(env, "implement", [unknownTool]),
    (error) => {
      assert.equal(
        error.message,
        '0 repository searches (Grep/Glob/Read/rg), 1 Coredoc writes, 0 Coredoc reads in stage implement; read with search_symbols / explain / find_callers / get_intent_context, or close with --skip-mcp "<reason>" (unclassified tools: intent_teleport)',
      );
      return true;
    },
  );
});

test("--skip-mcp closes with the reason and the counts it was signed against", async () => {
  const env = harness();
  const closed = await closeWith(
    env,
    "implement",
    SEARCH_FIXTURES.map((name, index) =>
      fixtureObservation(name, `2026-09-15T11:0${index}:00.000Z`),
    ),
    { skipMcpReason: "graph not indexed for this repository" },
  );
  assert.equal(closed.status, "finished");
  assert.deepEqual(closed.gates.find(({ gate }) => gate === "mcp"), {
    stage: "implement",
    gate: "mcp",
    result: "skipped",
    reason: "graph not indexed for this repository",
    searches: 4,
    writes: 0,
  });
  assert.deepEqual(
    workflowRunGates(readWorkflowRun(SESSION_ID, { env })).filter(
      ({ gate }) => gate === "mcp",
    ),
    [
      {
        stage: "implement",
        gate: "mcp",
        result: "skipped",
        reason: "graph not indexed for this repository",
        searches: 4,
        writes: 0,
        attempt: 1,
        at: "2026-09-15T11:30:00.000Z",
      },
    ],
  );
});

test("LIM-1: a stage nobody observed at all answers not-observed", async () => {
  const env = harness();
  await assert.rejects(
    () => closeWith(env, "implement", []),
    rejectsWith(refusalMessage(0, 0, "implement")),
  );
  assert.deepEqual(
    evaluateMcpGate([], { bound: true, stage: "implement" }),
    {
      stage: "implement",
      gate: "mcp",
      result: "not-observed",
      searches: 0,
      writes: 0,
      message:
        '0 repository searches (Grep/Glob/Read/rg), 0 Coredoc writes, 0 Coredoc reads in stage implement; read with search_symbols / explain / find_callers / get_intent_context, or close with --skip-mcp "<reason>"',
    },
  );
});

test("DEC-2: an unbound checkout records not-bound and refuses nothing", async () => {
  const env = harness({ bound: false });
  const closed = await closeWith(env, "implement", [
    fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"),
  ]);
  assert.equal(closed.status, "finished");
  assert.deepEqual(closed.gates.find(({ gate }) => gate === "mcp"), {
    stage: "implement",
    gate: "mcp",
    result: "not-bound",
    searches: 1,
    writes: 0,
  });
});

test("DEC-3: a failed close records unmet and never refuses", async () => {
  const env = harness();
  await stage("start", "implement", { env, at: "2026-09-15T11:00:00.000Z" });
  observe(env, fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"));
  const closed = await stage("finish", "implement", {
    env,
    outcome: "failed",
    at: "2026-09-15T11:30:00.000Z",
  });
  assert.equal(closed.status, "finished");
  assert.deepEqual(closed.gates.find(({ gate }) => gate === "mcp"), {
    stage: "implement",
    gate: "mcp",
    result: "unmet",
    searches: 1,
    writes: 0,
  });
});

test("the review stage is gated exactly as implement is", async () => {
  const refused = harness();
  await assert.rejects(
    () =>
      closeWith(refused, "review", [
        fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"),
      ]),
    (error) => {
      assert.equal(
        error.message,
        '1 repository searches (Grep/Glob/Read/rg), 0 Coredoc writes, 0 Coredoc reads in stage review; read with search_symbols / explain / find_callers / get_intent_context, or close with --skip-mcp "<reason>"',
      );
      return true;
    },
  );

  const env = harness();
  const closed = await closeWith(env, "review", [
    fixtureObservation("codex-0.150.1-mcp-search-symbols-ok.json", "2026-09-15T11:01:00.000Z"),
  ]);
  assert.deepEqual(closed.gates, [
    { stage: "review", gate: "mcp", result: "passed", searches: 0, writes: 0 },
  ]);
});

test("the spec stage is not gated on a Coredoc read", async () => {
  const env = harness();
  const closed = await closeWith(env, "spec", [
    fixtureObservation("claude-2.1.272-mcp-get-intent-context-ok.json", "2026-09-15T11:01:00.000Z"),
  ]);
  assert.deepEqual(
    closed.gates.map(({ gate, result }) => [gate, result]),
    [["intent", "passed"]],
  );
});

test("warn prints the refusal and closes the stage anyway", async () => {
  const env = harness({ gates: "warn" });
  const stderr = process.stderr.write;
  const printed = [];
  process.stderr.write = (text) => printed.push(text);
  let closed;
  try {
    closed = await closeWith(env, "implement", [
      fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"),
    ]);
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(closed.status, "finished");
  assert.equal(closed.gatesWarned, true);
  assert.equal(closed.gates.find(({ gate }) => gate === "mcp").result, "unmet");
  assert.equal(printed.length, 1);
  assert.equal(printed[0], `${refusalMessage(1, 0, "implement")}\n`);
});

test("run-status reports the same predicate the close is judged on", async () => {
  const env = harness();
  await stage("start", "implement", { env, at: "2026-09-15T11:00:00.000Z" });
  observe(env, fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"));
  assert.equal(workflowRunStatus(SESSION_ID, { env }).gates.mcp, "pending");
  observe(
    env,
    fixtureObservation("claude-2.1.272-mcp-search-symbols-ok.json", "2026-09-15T11:02:00.000Z"),
  );
  assert.equal(workflowRunStatus(SESSION_ID, { env }).gates.mcp, "satisfied");
});

test("--skip-mcp on a stage with no read gate waives nothing and is not recorded", async () => {
  const env = harness();
  const stderr = process.stderr.write;
  const printed = [];
  process.stderr.write = (text) => printed.push(text);
  let closed;
  try {
    closed = await closeWith(
      env,
      "spec",
      [fixtureObservation("claude-2.1.272-mcp-get-intent-context-ok.json", "2026-09-15T11:01:00.000Z")],
      { skipMcpReason: "not my stage" },
    );
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(closed.status, "finished");
  assert.deepEqual(
    closed.gates.map(({ gate, result }) => [gate, result]),
    [["intent", "passed"]],
  );
  assert.deepEqual(printed, [
    "--skip-mcp ignored: stage spec has no Coredoc read gate\n",
  ]);
  // Nothing for the next route to chase: an ignored flag is not an open decision.
  assert.deepEqual(
    unresolvedGates({ gates: workflowRunGates(readWorkflowRun(SESSION_ID, { env })) }),
    [],
  );
});

test("run-status says whether the evidence is the open attempt's or the whole run's", async () => {
  const env = harness();
  await closeWith(env, "implement", [
    fixtureObservation("claude-2.1.272-mcp-search-symbols-ok.json", "2026-09-15T11:01:00.000Z"),
  ]);
  // No stage open: the satisfied read is the finished stage's, not the next close's.
  const between = workflowRunStatus(SESSION_ID, { env });
  assert.equal(between.gates.scope, "run");
  assert.equal(between.gates.mcp, "satisfied");
  assert.match(
    workflowRunContext(between),
    /Gate evidence across the run so far \(no stage is open, so the next close is judged on its own attempt\)/,
  );

  await stage("start", "review", { env, at: "2026-09-15T12:00:00.000Z" });
  const open = workflowRunStatus(SESSION_ID, { env });
  assert.equal(open.gates.scope, "stage");
  assert.equal(open.gates.mcp, "pending");
});

test("AC-7: a terminal SessionEnd records the abandoned implement stage's unmet mcp gate", async () => {
  const env = harness();
  await stage("start", "implement", { env, at: "2026-09-15T11:00:00.000Z" });
  observe(env, fixtureObservation("claude-2.1.272-grep.json", "2026-09-15T11:01:00.000Z"));
  const ended = await finishWorkflowSession(
    { sessionId: SESSION_ID, at: "2026-09-15T11:10:00.000Z", reason: "clear" },
    {
      env,
      finishRun: (input, options) =>
        finishWorkflowRun(input, {
          ...options,
          deliver: async () => DISABLED,
          checkpointArtifacts: async () => ({
            status: "disabled",
            queued: 0,
            sent: 0,
            pending: 0,
          }),
        }),
    },
  );
  assert.equal(ended.run.status, "finished");
  const line = lastRunHistory(PROJECT_KEY, { env });
  assert.equal(line.outcome, "abandoned");
  // Nothing refused on the teardown path; the Grep-only stage says what it missed.
  assert.deepEqual(
    line.gates
      .filter(({ gate }) => gate === "mcp")
      .map(({ stage: stageId, gate, result, searches, writes }) => [
        stageId,
        gate,
        result,
        searches,
        writes,
      ]),
    [["implement", "mcp", "unmet", 1, 0]],
  );
});
