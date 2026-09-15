import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { finishWorkflowRun } from "./finish-run.mjs";
import { finishWorkflowSession } from "./session-end.mjs";
import { parseStageArgs, runWorkflowStage } from "./stage-run.mjs";
import { lastRunHistory } from "./workflow-gates.mjs";
import { readSpecArtifact, writeSpecArtifactKey } from "./spec-artifact.mjs";
import {
  appendWorkflowObservation,
  readWorkflowRun,
  startWorkflowRun,
  workflowRunGates,
} from "./workflow-run-state.mjs";

const SESSION_ID = "session-stage-gates";
const RUN_ID = "cdr-20260915-c3d4e5";
const PROJECT_KEY = "gates-fixture";
const SPEC_PATH = "docs/spec.md";
const SPEC_REF = `${PROJECT_KEY}:${SPEC_PATH}`;
const DISABLED = { status: "disabled", durable: true, pending: 0 };
const deliver = async () => DISABLED;
let occurrence = 0;
const idFactory = () => {
  occurrence += 1;
  return `${occurrence.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
};

function harness({
  gates = "enforce",
  bound = true,
  repositoryKey = PROJECT_KEY,
  specRef = SPEC_REF,
  status = "draft",
} = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "coredoc-stage-gates-repo-"));
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(
    join(repoRoot, SPEC_PATH),
    `---\nsize: m\nstatus: ${status}\n---\n\n# Spec\n`,
  );
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(join(tmpdir(), "coredoc-stage-gates-")),
    COREDOC_WORKFLOW_GATES: gates,
  };
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: "change:large",
      intent: "change",
      risk: "normal",
      declaredStages: [
        { stageId: "spec", after: [] },
        { stageId: "design", after: ["spec"] },
        { stageId: "implement", after: ["design"] },
      ],
      repositoryKey,
      bound,
      projectKey: PROJECT_KEY,
      ...(specRef === undefined ? {} : { specRef }),
      at: "2026-09-15T10:00:00.000Z",
      cwd: repoRoot,
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot,
        head: "",
        fingerprint: "",
        filesChanged: 0,
        trackedLinesAdded: 0,
        trackedLinesRemoved: 0,
      }),
    },
  );
  return { env, repoRoot, specFile: join(repoRoot, SPEC_PATH) };
}

function observe(env, event) {
  return appendWorkflowObservation(SESSION_ID, event, { env });
}

const intentRead = (at, result = "ok") => ({
  type: "coredoc",
  at,
  success: result !== "error",
  tool: "get_intent_context",
  access: "read",
  result,
});

const propose = (at, extra = {}) => ({
  type: "coredoc",
  at,
  success: true,
  tool: "intent_propose",
  access: "write",
  result: "ok",
  specMatch: true,
  created: 1,
  ...extra,
});

const grep = (at) => ({ type: "search", at, tool: "Grep" });

// BR-4's evidence: a Coredoc read that answered, which every successful
// implement or review close now needs alongside its own gate.
const mcpRead = (at) => ({
  type: "coredoc",
  at,
  success: true,
  tool: "search_symbols",
  access: "read",
  result: "ok",
});

function stage(action, stageId, options = {}) {
  return runWorkflowStage(
    {
      action,
      stageId,
      sessionId: SESSION_ID,
      ...options,
    },
    { env: options.env, idFactory, deliver },
  );
}

async function openSpecStage(env, at = "2026-09-15T10:00:01.000Z") {
  return stage("start", "spec", { env, at });
}

test("--spec-path, --skip-intent and --skip-mcp parse only on a finish", () => {
  assert.deepEqual(
    parseStageArgs([
      "finish",
      "--stage-id",
      "spec",
      "--outcome",
      "success",
      "--spec-path",
      "docs/spec.md",
      "--skip-intent",
      "overlay offline",
    ]),
    {
      action: "finish",
      stageId: "spec",
      outcome: "success",
      specPath: "docs/spec.md",
      skipIntentReason: "overlay offline",
    },
  );
  assert.deepEqual(
    parseStageArgs([
      "finish",
      "--stage-id",
      "implement",
      "--outcome",
      "success",
      "--skip-mcp",
      "graph not indexed",
    ]),
    {
      action: "finish",
      stageId: "implement",
      outcome: "success",
      skipMcpReason: "graph not indexed",
    },
  );
  assert.throws(
    () =>
      parseStageArgs([
        "finish",
        "--stage-id",
        "implement",
        "--outcome",
        "success",
        "--spec-path",
        "docs/spec.md",
      ]),
    /--spec-path is supported only on the spec stage/,
  );
  assert.throws(
    () => parseStageArgs(["start", "--stage-id", "spec", "--skip-intent", "x"]),
    /--skip-intent is supported only for finish/,
  );
  assert.throws(
    () =>
      parseStageArgs([
        "finish",
        "--stage-id",
        "spec",
        "--outcome",
        "success",
        "--skip-intent",
        "   ",
      ]),
    /--skip-intent requires a reason/,
  );
});

test("BR-1 refuses a successful spec close with no observed intent read", async () => {
  const { env } = harness();
  await openSpecStage(env);
  observe(env, grep("2026-09-15T10:00:02.000Z"));
  await assert.rejects(
    () =>
      stage("finish", "spec", {
        env,
        outcome: "success",
        at: "2026-09-15T10:00:03.000Z",
      }),
    /closed without an observed get_intent_context read/,
  );
  // The stage stays open for the remedy and nothing was recorded.
  assert.equal(
    readWorkflowRun(SESSION_ID, { env }).stageProgress.spec.finishedAt,
    undefined,
  );
  assert.deepEqual(workflowRunGates(readWorkflowRun(SESSION_ID, { env })), []);

  observe(env, intentRead("2026-09-15T10:00:04.000Z"));
  const closed = await stage("finish", "spec", {
    env,
    outcome: "success",
    at: "2026-09-15T10:00:05.000Z",
  });
  assert.equal(closed.status, "finished");
  assert.deepEqual(closed.gates, [
    { stage: "spec", gate: "intent", result: "passed" },
  ]);
  // The run carries the same result with the attempt and the time it closed.
  assert.deepEqual(workflowRunGates(readWorkflowRun(SESSION_ID, { env })), [
    {
      stage: "spec",
      gate: "intent",
      result: "passed",
      attempt: 1,
      at: "2026-09-15T10:00:05.000Z",
    },
  ]);
});

test("BR-1 counts only the current attempt's observations", async () => {
  const { env } = harness();
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  const blocked = await stage("finish", "spec", {
    env,
    outcome: "blocked",
    at: "2026-09-15T10:00:03.000Z",
  });
  assert.equal(blocked.status, "finished");

  await stage("start", "spec", { env, at: "2026-09-15T10:01:00.000Z" });
  observe(env, grep("2026-09-15T10:01:01.000Z"));
  await assert.rejects(
    () =>
      stage("finish", "spec", {
        env,
        outcome: "success",
        at: "2026-09-15T10:01:02.000Z",
      }),
    /closed without an observed get_intent_context read/,
  );
});

test("BR-1 answers not-configured, not-observed and a signed skip without refusing", async () => {
  const notConfigured = harness();
  await openSpecStage(notConfigured.env);
  observe(
    notConfigured.env,
    intentRead("2026-09-15T10:00:02.000Z", "not_configured"),
  );
  const closed = await stage("finish", "spec", {
    env: notConfigured.env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  assert.equal(closed.gates[0].result, "not-configured");

  const blind = harness();
  await openSpecStage(blind.env);
  await assert.rejects(
    () =>
      stage("finish", "spec", {
        env: blind.env,
        outcome: "success",
        at: "2026-09-15T10:00:03.000Z",
      }),
    /no observed tool calls at all/,
  );

  const skipped = harness();
  await openSpecStage(skipped.env);
  observe(skipped.env, grep("2026-09-15T10:00:02.000Z"));
  const signed = await stage("finish", "spec", {
    env: skipped.env,
    outcome: "success",
    skipIntentReason: "no intent capability on this workspace",
    at: "2026-09-15T10:00:03.000Z",
  });
  assert.equal(signed.gates[0].result, "skipped");
  assert.equal(signed.gates[0].reason, "no intent capability on this workspace");
});

test("DEC-3: a failed or blocked close records unmet and never refuses", async () => {
  for (const outcome of ["failed", "blocked"]) {
    const { env } = harness();
    await openSpecStage(env);
    observe(env, grep("2026-09-15T10:00:02.000Z"));
    const closed = await stage("finish", "spec", {
      env,
      outcome,
      at: "2026-09-15T10:00:03.000Z",
    });
    assert.equal(closed.status, "finished", outcome);
    assert.equal(closed.gates[0].result, "unmet", outcome);
  }
  // Zero observations on a non-success close is recorded as unmet too.
  const { env } = harness();
  await openSpecStage(env);
  const closed = await stage("finish", "spec", {
    env,
    outcome: "failed",
    at: "2026-09-15T10:00:03.000Z",
  });
  assert.equal(closed.gates[0].result, "unmet");
});

test("DEC-2: an unbound checkout records not-bound and refuses nothing", async () => {
  const { env } = harness({ bound: false });
  await openSpecStage(env);
  const closed = await stage("finish", "spec", {
    env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  assert.equal(closed.status, "finished");
  assert.deepEqual(
    closed.gates.map(({ gate, result }) => [gate, result]),
    [["intent", "not-bound"]],
  );
});

test("warn prints the refusal, closes the stage, and records the would-be result", async () => {
  const { env } = harness({ gates: "warn" });
  await openSpecStage(env);
  observe(env, grep("2026-09-15T10:00:02.000Z"));
  const stderr = process.stderr.write;
  const printed = [];
  process.stderr.write = (text) => printed.push(text);
  let closed;
  try {
    closed = await stage("finish", "spec", {
      env,
      outcome: "success",
      at: "2026-09-15T10:00:03.000Z",
    });
  } finally {
    process.stderr.write = stderr;
  }
  assert.equal(closed.status, "finished");
  assert.equal(closed.gatesWarned, true);
  assert.equal(closed.gates[0].result, "unmet");
  assert.equal(printed.length, 1);
  assert.match(printed[0], /closed without an observed get_intent_context read/);
});

test("--spec-path records the artifact on the run at the spec close", async () => {
  const { env, repoRoot } = harness({ specRef: undefined, repositoryKey: "owner/repo" });
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    specPath: SPEC_PATH,
    at: "2026-09-15T10:00:03.000Z",
  });
  assert.equal(readWorkflowRun(SESSION_ID, { env }).specRef, `owner/repo:${SPEC_PATH}`);
  // Stored repository-relative, never as the absolute path the caller typed.
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  assert.ok(!readWorkflowRun(SESSION_ID, { env }).specRef.includes(repoRoot));
});

test("AC-3: the change-large lifecycle gates the implement close on the candidate batch", async () => {
  const { env, specFile } = harness();
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    specPath: SPEC_PATH,
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  // The specification is reviewed as a draft: BR-2 does not apply yet.
  const design = await stage("finish", "design", {
    env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  assert.equal(design.status, "finished");

  await stage("start", "implement", { env, at: "2026-09-15T10:03:00.000Z" });
  // The implementation stage's first repository write is the acceptance.
  writeSpecArtifactKey(specFile, "status", "accepted");
  assert.equal(readSpecArtifact(specFile).status, "accepted");
  observe(env, grep("2026-09-15T10:03:30.000Z"));
  await assert.rejects(
    () =>
      stage("finish", "implement", {
        env,
        outcome: "success",
        at: "2026-09-15T10:04:00.000Z",
      }),
    new RegExp(`accepted specification ${SPEC_REF} has no candidate batch`),
  );

  observe(env, propose("2026-09-15T10:04:30.000Z"));
  observe(env, mcpRead("2026-09-15T10:04:40.000Z"));
  const closed = await stage("finish", "implement", {
    env,
    outcome: "success",
    at: "2026-09-15T10:05:00.000Z",
  });
  assert.equal(closed.status, "finished");
  assert.deepEqual(
    closed.gates.map(({ gate, result }) => [gate, result]),
    [
      ["candidates", "passed"],
      ["mcp", "passed"],
    ],
  );
  assert.deepEqual(
    workflowRunGates(readWorkflowRun(SESSION_ID, { env })).map(
      ({ stage: stageId, gate, result }) => [stageId, gate, result],
    ),
    [
      ["spec", "intent", "passed"],
      ["implement", "candidates", "passed"],
      ["implement", "mcp", "passed"],
    ],
  );
});

test("AC-3: intentChanges none passes and a propose citing another repository does not", async () => {
  const declared = harness({ status: "accepted" });
  writeSpecArtifactKey(declared.specFile, "intentChanges", "none");
  await openSpecStage(declared.env);
  observe(declared.env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env: declared.env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env: declared.env, at: "2026-09-15T10:01:00.000Z" });
  await stage("finish", "design", {
    env: declared.env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  await stage("start", "implement", { env: declared.env, at: "2026-09-15T10:03:00.000Z" });
  observe(declared.env, mcpRead("2026-09-15T10:03:30.000Z"));
  const closed = await stage("finish", "implement", {
    env: declared.env,
    outcome: "success",
    at: "2026-09-15T10:04:00.000Z",
  });
  assert.equal(closed.gates[0].result, "passed");
  assert.equal(closed.gates[0].reason, "frontmatter declares intentChanges: none");

  const foreign = harness({ status: "accepted" });
  await openSpecStage(foreign.env);
  observe(foreign.env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env: foreign.env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env: foreign.env, at: "2026-09-15T10:01:00.000Z" });
  await stage("finish", "design", {
    env: foreign.env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  await stage("start", "implement", { env: foreign.env, at: "2026-09-15T10:03:00.000Z" });
  observe(
    foreign.env,
    propose("2026-09-15T10:03:30.000Z", {
      specMatch: false,
      refs: [`other/repo:${SPEC_PATH}`],
    }),
  );
  await assert.rejects(
    () =>
      stage("finish", "implement", {
        env: foreign.env,
        outcome: "success",
        at: "2026-09-15T10:04:00.000Z",
      }),
    new RegExp(`cited other/repo:${SPEC_PATH}, not ${SPEC_REF}`),
  );
});

test("an unmapped repository cannot satisfy BR-2 and needs a declaration or a signed skip", async () => {
  const { env } = harness({
    repositoryKey: "unmapped",
    specRef: `unmapped:${SPEC_PATH}`,
    status: "accepted",
  });
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  await stage("finish", "design", {
    env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  await stage("start", "implement", { env, at: "2026-09-15T10:03:00.000Z" });
  // The observer cannot bind a bare cited path to an unknown repository, so the
  // propose never matches and the refusal stands.
  observe(env, propose("2026-09-15T10:03:30.000Z", { specMatch: false, refs: [SPEC_PATH] }));
  observe(env, mcpRead("2026-09-15T10:03:40.000Z"));
  await assert.rejects(
    () =>
      stage("finish", "implement", {
        env,
        outcome: "success",
        at: "2026-09-15T10:04:00.000Z",
      }),
    /has no candidate batch/,
  );
  const signed = await stage("finish", "implement", {
    env,
    outcome: "success",
    skipIntentReason: "repository is not mapped to a workspace repository",
    at: "2026-09-15T10:05:00.000Z",
  });
  assert.equal(signed.gates[0].result, "skipped");
});

test("BR-2 counts a propose made at any point from the specification stage onward", async () => {
  const { env, specFile } = harness();
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    specPath: SPEC_PATH,
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  // The user accepts during design; the candidate batch goes out there.
  writeSpecArtifactKey(specFile, "status", "accepted");
  observe(env, propose("2026-09-15T10:01:30.000Z"));
  await stage("finish", "design", {
    env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  await stage("start", "implement", { env, at: "2026-09-15T10:03:00.000Z" });
  observe(env, grep("2026-09-15T10:03:30.000Z"));
  // BR-4's read is judged on this attempt alone, so the implement stage needs
  // its own; BR-2's propose from the design stage still counts.
  observe(env, mcpRead("2026-09-15T10:03:40.000Z"));
  const closed = await stage("finish", "implement", {
    env,
    outcome: "success",
    at: "2026-09-15T10:04:00.000Z",
  });
  assert.equal(closed.status, "finished");
  assert.deepEqual(closed.gates, [
    { stage: "implement", gate: "candidates", result: "passed" },
    { stage: "implement", gate: "mcp", result: "passed", searches: 1, writes: 0 },
  ]);
});

test("a --skip-intent on a stage with no intent gate is still recorded", async () => {
  const { env } = harness();
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  const closed = await stage("finish", "design", {
    env,
    outcome: "success",
    skipIntentReason: "no intent capability on this workspace",
    at: "2026-09-15T10:02:00.000Z",
  });
  assert.deepEqual(closed.gates, [
    {
      stage: "design",
      gate: "intent",
      result: "skipped",
      reason: "no intent capability on this workspace",
    },
  ]);
});

test("a signed --skip-mcp is recorded today so issue 03 only adds the evaluation", async () => {
  const { env } = harness();
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  await stage("finish", "design", {
    env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  await stage("start", "implement", { env, at: "2026-09-15T10:03:00.000Z" });
  const closed = await stage("finish", "implement", {
    env,
    outcome: "success",
    skipMcpReason: "graph not indexed for this repository",
    at: "2026-09-15T10:04:00.000Z",
  });
  assert.deepEqual(
    closed.gates.map(({ gate, result, reason }) => [gate, result, reason]),
    [
      ["candidates", "not-applicable", "specification is draft, not accepted"],
      ["mcp", "skipped", "graph not indexed for this repository"],
    ],
  );
});

const NO_ARTIFACTS = async () => ({
  status: "disabled",
  queued: 0,
  sent: 0,
  pending: 0,
});

function teardownFinish(delivered) {
  return (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver: async (event) => {
        delivered.push(event);
        return DISABLED;
      },
      checkpointArtifacts: NO_ARTIFACTS,
    });
}

test("AC-7: a terminal SessionEnd records the abandoned stage's unmet gates", async () => {
  const { env } = harness();
  await openSpecStage(env);
  observe(env, grep("2026-09-15T10:00:02.000Z"));
  const delivered = [];
  const ended = await finishWorkflowSession(
    { sessionId: SESSION_ID, at: "2026-09-15T10:10:00.000Z", reason: "clear" },
    { env, finishRun: teardownFinish(delivered) },
  );
  assert.equal(ended.run.status, "finished");
  const line = lastRunHistory(PROJECT_KEY, { env });
  assert.equal(line.outcome, "abandoned");
  // The stage nobody closed still says what it was missing, and nothing refused.
  assert.deepEqual(
    line.gates.map(({ stage: stageId, gate, result }) => [stageId, gate, result]),
    [
      ["spec", "intent", "unmet"],
      // The run used no Coredoc tool at all, which BR-3 resolves as not-used.
      ["finish", "intent", "passed"],
    ],
  );
  assert.equal(line.gates[0].attempt, 1);
  assert.equal(line.coredocStatus, "not-used");
});

test("AC-7: a non-success finish records the open stage's gates as unmet", async () => {
  const { env, specFile } = harness();
  await openSpecStage(env);
  observe(env, intentRead("2026-09-15T10:00:02.000Z"));
  await stage("finish", "spec", {
    env,
    outcome: "success",
    specPath: SPEC_PATH,
    at: "2026-09-15T10:00:03.000Z",
  });
  await stage("start", "design", { env, at: "2026-09-15T10:01:00.000Z" });
  await stage("finish", "design", {
    env,
    outcome: "success",
    at: "2026-09-15T10:02:00.000Z",
  });
  await stage("start", "implement", { env, at: "2026-09-15T10:03:00.000Z" });
  writeSpecArtifactKey(specFile, "status", "accepted");
  observe(env, grep("2026-09-15T10:03:30.000Z"));

  const delivered = [];
  const finished = await teardownFinish(delivered)(
    {
      sessionId: SESSION_ID,
      outcome: "failed",
      at: "2026-09-15T10:04:00.000Z",
    },
    { env },
  );
  assert.equal(finished.status, "finished");
  const line = lastRunHistory(PROJECT_KEY, { env });
  assert.equal(line.outcome, "failed");
  assert.deepEqual(
    line.gates.map(({ stage: stageId, gate, result }) => [stageId, gate, result]),
    [
      ["spec", "intent", "passed"],
      // The abandoned implement occurrence, judged and never refused: the Grep
      // it did instead of a Coredoc read is recorded as unmet too (BR-4).
      ["implement", "candidates", "unmet"],
      ["implement", "mcp", "unmet"],
      ["finish", "intent", "unmet"],
    ],
  );
});

test("AC-7 on an unbound checkout records not-bound and still never refuses", async () => {
  const { env } = harness({ bound: false });
  await openSpecStage(env);
  const delivered = [];
  await finishWorkflowSession(
    { sessionId: SESSION_ID, at: "2026-09-15T10:10:00.000Z", reason: "clear" },
    { env, finishRun: teardownFinish(delivered) },
  );
  assert.deepEqual(
    lastRunHistory(PROJECT_KEY, { env }).gates.map(({ gate, result }) => [gate, result]),
    [
      ["intent", "not-bound"],
      ["intent", "not-bound"],
    ],
  );
});
