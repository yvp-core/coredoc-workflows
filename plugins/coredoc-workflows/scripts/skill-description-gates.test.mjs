/**
 * DEC-4 — a description that promises a check the CLI does not perform is a
 * lie the agent reads in every session. One test per sentence: the skill says
 * it (for the four skills that live here) and the CLI does it.
 *
 * Two of the six sentences belong to skills shipped from coredoc-parser
 * (`coredoc-mcp`, `intent-capture`). Their text is pinned here as a constant
 * anyway, because the behaviour they promise is this plugin's: the gates that
 * count reads and the candidate precondition of the acceptance transition.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import { SKILLS_ROOT } from "./build-skills.mjs";
import { finishWorkflowRun } from "./finish-run.mjs";
import { executeRoutedTask } from "./route-task.mjs";
import { readSpecArtifact } from "./spec-artifact.mjs";
import {
  acceptSpecification,
  finishAcceptedSpecification,
} from "./spec-acceptance.mjs";
import { runWorkflowStage } from "./stage-run.mjs";
import { lastRunHistory } from "./workflow-gates.mjs";
import {
  appendWorkflowObservation,
  startWorkflowRun,
} from "./workflow-run-state.mjs";

/** The sentence each skill's description ends with, verbatim (issue 04). */
const SENTENCES = Object.freeze({
  "coredoc-spec":
    "Closing the spec stage successfully requires an observed intent context read; when the specification becomes accepted, run the `intent-capture` skill so the candidates it introduces exist before the implement stage (or `spec accept`) closes.",
  "coredoc-implement":
    "A successful close of the implement stage requires an observed Coredoc MCP read during implementation and, for an accepted specification, its proposed candidates; a run without them needs a signed skip.",
  "coredoc-review":
    "A successful close of the review stage requires an observed Coredoc MCP read during review; a run without one needs a signed skip.",
  "coredoc-workflows":
    "On a checkout bound to a Coredoc workspace, stages close on observed evidence, not on the agent's report: intent reads, candidates and Coredoc MCP reads are checked, and skips are signed with a reason that the next route shows.",
  // Shipped from coredoc-parser (`skills/`, mirrored into `plugins/coredoc`).
  "coredoc-mcp":
    "Grep, Glob and Read do not satisfy a code question this workspace's MCP can answer; the implement and review stage closes count Coredoc reads, not writes.",
  "intent-capture":
    "Invoked by `coredoc-spec` when a specification becomes accepted (the implement stage's first write, or `spec accept` for a standalone spec); run it standalone only for an already-accepted document.",
});

/** The skills whose SKILL.md is in this repository. */
const LOCAL_SKILLS = ["coredoc-spec", "coredoc-implement", "coredoc-review", "coredoc-workflows"];

function description(name) {
  const body = readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
  const value = /^description: ([^\r\n]+)$/m.exec(body)?.[1];
  assert.ok(value, `${name} has no single-line description`);
  return value.trim();
}

const SESSION_ID = "session-description-gates";
const RUN_ID = "cdr-20260915-de5c01";
const PROJECT_KEY = "description-gates-fixture";
const SPEC_PATH = "docs/spec.md";
const SPEC_REF = `${PROJECT_KEY}:${SPEC_PATH}`;
const DISABLED = { status: "disabled", durable: true, pending: 0 };
const NO_ARTIFACTS = async () => ({ status: "disabled", queued: 0, sent: 0, pending: 0 });
let occurrence = 0;
const idFactory = () => {
  occurrence += 1;
  return `${occurrence.toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`;
};

function noGit(repoRoot) {
  return () => ({
    available: false,
    repoRoot,
    head: "",
    fingerprint: "",
    filesChanged: 0,
    trackedLinesAdded: 0,
    trackedLinesRemoved: 0,
  });
}

/** A bound `enforce` run with a draft specification on disk, unless told otherwise. */
function harness({
  bound = true,
  status = "draft",
  intent = "change",
  // Independent stages: each test declares exactly the stages its sentence names.
  stages = ["spec", "implement", "review"],
} = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), "coredoc-desc-gates-repo-"));
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(join(repoRoot, SPEC_PATH), `---\nsize: m\nstatus: ${status}\n---\n\n# Spec\n`);
  const env = {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(join(tmpdir(), "coredoc-desc-gates-")),
    COREDOC_WORKFLOWS_REPO_KEY: PROJECT_KEY,
    COREDOC_CAPTURE_WORKSPACE_ID: "ws-fixture",
    COREDOC_WORKFLOW_GATES: "enforce",
  };
  startWorkflowRun(
    {
      sessionId: SESSION_ID,
      runId: RUN_ID,
      workflowId: `${intent}:normal`,
      intent,
      risk: "normal",
      declaredStages: stages.map((stageId) => ({ stageId, after: [] })),
      repositoryKey: PROJECT_KEY,
      bound,
      projectKey: PROJECT_KEY,
      specRef: SPEC_REF,
      at: "2026-09-15T10:00:00.000Z",
      cwd: repoRoot,
    },
    { env, snapshot: noGit(repoRoot) },
  );
  return { env, repoRoot, specFile: join(repoRoot, SPEC_PATH) };
}

function observe(env, event) {
  return appendWorkflowObservation(SESSION_ID, event, { env });
}

const coredoc = (tool, at, extra = {}) => ({
  type: "coredoc",
  at,
  success: true,
  tool,
  access: "read",
  result: "ok",
  ...extra,
});
const intentRead = (at) => coredoc("get_intent_context", at);
const mcpRead = (at) => coredoc("search_symbols", at);
const propose = (at) =>
  coredoc("intent_propose", at, { access: "write", specMatch: true, created: 1 });
const search = (tool, at) => ({ type: "search", at, tool });

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

test("every description carries its sentence verbatim, once, at the end", () => {
  for (const name of LOCAL_SKILLS) {
    const value = description(name);
    const sentence = SENTENCES[name];
    assert.ok(value.endsWith(sentence), `${name} does not end with its gate sentence`);
    assert.equal(value.split(sentence).length, 2, `${name} repeats its gate sentence`);
    // Appended, not replacing: the triggering half of the description survives.
    assert.ok(value.length > sentence.length + 1, `${name} lost its triggering text`);
  }
});

test("coredoc-spec: the spec stage refuses a successful close with no intent read", async () => {
  const { env } = harness();
  await assert.rejects(
    () => closeWith(env, "spec", [search("Grep", "2026-09-15T11:01:00.000Z")]),
    /closed without an observed get_intent_context read/,
  );
  // And the same close passes on the read the sentence names.
  const { env: withRead } = harness();
  const closed = await closeWith(withRead, "spec", [intentRead("2026-09-15T11:02:00.000Z")]);
  assert.deepEqual(closed.gates, [{ stage: "spec", gate: "intent", result: "passed" }]);
});

test("coredoc-implement: the implement stage refuses without a read, and without candidates", async () => {
  const noRead = harness();
  await assert.rejects(
    () => closeWith(noRead.env, "implement", [search("Grep", "2026-09-15T11:01:00.000Z")]),
    /0 Coredoc reads in stage implement/,
  );

  // An accepted specification with a read but no candidate batch is refused too.
  const accepted = harness({ status: "accepted" });
  await assert.rejects(
    () => closeWith(accepted.env, "implement", [mcpRead("2026-09-15T11:01:00.000Z")]),
    new RegExp(`accepted specification ${SPEC_REF} has no candidate batch`),
  );
  const closed = await closeWith(accepted.env, "implement", [
    mcpRead("2026-09-15T11:02:00.000Z"),
    propose("2026-09-15T11:03:00.000Z"),
  ]);
  assert.deepEqual(
    closed.gates.map(({ gate, result }) => [gate, result]),
    [
      ["candidates", "passed"],
      ["mcp", "passed"],
    ],
  );

  // "a signed skip" — the run without them closes only with a reason on record.
  const signed = harness();
  const waived = await closeWith(
    signed.env,
    "implement",
    [search("Grep", "2026-09-15T11:01:00.000Z")],
    { skipMcpReason: "graph not indexed for this repository" },
  );
  assert.deepEqual(waived.gates.find(({ gate }) => gate === "mcp"), {
    stage: "implement",
    gate: "mcp",
    result: "skipped",
    reason: "graph not indexed for this repository",
    searches: 1,
    writes: 0,
  });
});

test("coredoc-review: the review stage refuses a successful close with no Coredoc read", async () => {
  const { env } = harness();
  await assert.rejects(
    () => closeWith(env, "review", [search("Read", "2026-09-15T11:01:00.000Z")]),
    /0 Coredoc reads in stage review/,
  );
  const { env: withRead } = harness();
  const closed = await closeWith(withRead, "review", [mcpRead("2026-09-15T11:02:00.000Z")]);
  assert.deepEqual(closed.gates, [
    { stage: "review", gate: "mcp", result: "passed", searches: 0, writes: 0 },
  ]);
});

test("coredoc-workflows: an unbound checkout never refuses and records not-bound", async () => {
  const { env } = harness({ bound: false, status: "accepted" });
  for (const stageId of ["spec", "implement", "review"]) {
    const closed = await closeWith(env, stageId, [search("Grep", "2026-09-15T11:01:00.000Z")]);
    assert.equal(closed.status, "finished", stageId);
    assert.ok(
      closed.gates.every(({ result }) => result === "not-bound"),
      `${stageId} judged an unbound checkout`,
    );
  }
});

test("coredoc-workflows: the next route shows the previous run's signed skip and its reason", async () => {
  const { env, repoRoot } = harness({ stages: ["review"] });
  await closeWith(env, "review", [search("Grep", "2026-09-15T11:01:00.000Z")], {
    skipMcpReason: "graph not indexed for this repository",
  });
  await finishWorkflowRun(
    { sessionId: SESSION_ID, outcome: "success", coredocStatus: "partial", at: "2026-09-15T12:00:00.000Z" },
    { env, cwd: repoRoot, deliver: async () => DISABLED, checkpointArtifacts: NO_ARTIFACTS },
  );
  assert.ok(
    lastRunHistory(PROJECT_KEY, { env }).gates.some(
      ({ gate, result }) => gate === "mcp" && result === "skipped",
    ),
  );

  const routed = await executeRoutedTask(
    { intent: "change" },
    {
      env: { ...env, COREDOC_WORKFLOWS_SESSION_ID: SESSION_ID },
      cwd: repoRoot,
      preflight: async () => {},
      recordCapture: async () => DISABLED,
      expireRuns: async () => [],
    },
  );
  assert.deepEqual(
    routed.previousRunGates.map(({ gate, result, reason }) => [gate, result, reason]),
    [["mcp", "skipped", "graph not indexed for this repository"]],
  );
});

test("coredoc-mcp: searches and writes do not satisfy the implement gate; one read does", async () => {
  const searches = harness();
  await assert.rejects(
    () =>
      closeWith(searches.env, "implement", [
        search("Grep", "2026-09-15T11:01:00.000Z"),
        search("Glob", "2026-09-15T11:02:00.000Z"),
        search("Read", "2026-09-15T11:03:00.000Z"),
        search("Bash", "2026-09-15T11:04:00.000Z"),
      ]),
    /4 repository searches \(Grep\/Glob\/Read\/rg\), 0 Coredoc writes, 0 Coredoc reads/,
  );

  // A write is a Coredoc call and still not a read.
  const writes = harness();
  await assert.rejects(
    () => closeWith(writes.env, "implement", [propose("2026-09-15T11:01:00.000Z")]),
    /0 repository searches \(Grep\/Glob\/Read\/rg\), 1 Coredoc writes, 0 Coredoc reads/,
  );

  const read = harness();
  const closed = await closeWith(read.env, "implement", [
    search("Grep", "2026-09-15T11:01:00.000Z"),
    mcpRead("2026-09-15T11:02:00.000Z"),
  ]);
  assert.deepEqual(closed.gates.find(({ gate }) => gate === "mcp"), {
    stage: "implement",
    gate: "mcp",
    result: "passed",
    searches: 1,
    writes: 0,
  });
});

test("intent-capture: the candidate batch is the precondition of `spec accept --finish`", async () => {
  const { env, repoRoot, specFile } = harness({ intent: "spec", stages: ["spec"] });
  await closeWith(env, "spec", [intentRead("2026-09-15T11:01:00.000Z")]);
  const delivered = [];
  const finishRun = (input, options) =>
    finishWorkflowRun(input, {
      ...options,
      deliver: async (event) => {
        delivered.push(event);
        return DISABLED;
      },
      checkpointArtifacts: NO_ARTIFACTS,
    });
  await finishRun(
    { sessionId: SESSION_ID, outcome: "delivered-draft", specPath: SPEC_PATH, at: "2026-09-15T12:00:00.000Z" },
    { env, cwd: repoRoot },
  );
  acceptSpecification(
    { sessionId: SESSION_ID, path: SPEC_PATH, at: "2026-09-16T09:00:00.000Z" },
    { env, cwd: repoRoot },
  );

  // Without the candidates the acceptance does not happen at all.
  await assert.rejects(
    () =>
      finishAcceptedSpecification(
        { sessionId: SESSION_ID, at: "2026-09-16T09:01:00.000Z" },
        { env, cwd: repoRoot, finishRun },
      ),
    new RegExp(`no candidate batch[\\s\\S]*${SPEC_REF}`),
  );
  assert.equal(readSpecArtifact(specFile).status, "draft");

  observe(env, propose("2026-09-16T09:02:00.000Z"));
  const accepted = await finishAcceptedSpecification(
    { sessionId: SESSION_ID, at: "2026-09-16T09:03:00.000Z" },
    { env, cwd: repoRoot, finishRun },
  );
  assert.equal(accepted.status, "accepted");
  assert.equal(readSpecArtifact(specFile).status, "accepted");
});

test("the two parser-repo sentences are pinned here even though their skills ship elsewhere", () => {
  // Nothing in this repository can assert their frontmatter; the promise they
  // make is asserted above against this repository's gates.
  for (const name of ["coredoc-mcp", "intent-capture"]) {
    assert.ok(SENTENCES[name].length > 0, name);
    assert.throws(() => description(name));
  }
});
