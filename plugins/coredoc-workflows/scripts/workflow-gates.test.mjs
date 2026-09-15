import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";

import {
  normalizedSpecPath,
  readSpecArtifact,
  removeSpecArtifactKey,
  specAbsolutePath,
  specRefFor,
  writeSpecArtifactKey,
} from "./spec-artifact.mjs";
import {
  appendRunHistory,
  applyGates,
  evaluateCandidatesGate,
  evaluateFinishGate,
  evaluateIntentGate,
  evaluateStageGates,
  gateEvidence,
  gateMode,
  historyPath,
  lastRunHistory,
  readRunHistory,
  resolveCoredocStatus,
  runIsBound,
  skipReason,
  STAGE_GATES,
  unresolvedGates,
} from "./workflow-gates.mjs";

const SPEC_REF = "coredoc/parser:.scratch/gates/spec.md";

function testEnv() {
  return {
    COREDOC_WORKFLOWS_STATE_DIR: mkdtempSync(
      join(tmpdir(), "coredoc-workflow-gates-"),
    ),
  };
}

function coredoc(tool, result, extra = {}) {
  return {
    type: "coredoc",
    at: "2026-09-15T10:00:00.000Z",
    success: result !== "error",
    tool,
    access: tool === "intent_propose" ? "write" : "read",
    result,
    ...extra,
  };
}

const SEARCH = { type: "search", at: "2026-09-15T10:00:00.000Z", tool: "Grep" };

test("the gate mode defaults to warn and refuses anything but warn or enforce", () => {
  assert.equal(gateMode({}), "warn");
  assert.equal(gateMode({ COREDOC_WORKFLOW_GATES: "warn" }), "warn");
  assert.equal(gateMode({ COREDOC_WORKFLOW_GATES: "enforce" }), "enforce");
  assert.throws(
    () => gateMode({ COREDOC_WORKFLOW_GATES: "off" }),
    /COREDOC_WORKFLOW_GATES must be one of: warn, enforce/,
  );
  assert.equal(runIsBound({ bound: true }), true);
  assert.equal(runIsBound({ bound: false }), false);
  assert.equal(runIsBound({}), false);
  assert.equal(runIsBound(null), false);
});

test("a skip reason is mandatory and bounded", () => {
  assert.equal(skipReason("skip-intent", " overlay is empty "), "overlay is empty");
  assert.throws(
    () => skipReason("skip-intent", "   "),
    /--skip-intent requires a reason of 1-200 characters/,
  );
  assert.throws(
    () => skipReason("skip-mcp", "x".repeat(201)),
    /--skip-mcp requires a reason of 1-200 characters/,
  );
});

test("BR-1 passes only on an intent read that answered ok", () => {
  const context = { bound: true, stage: "spec" };
  assert.equal(
    evaluateIntentGate([coredoc("get_intent_context", "ok")], context).result,
    "passed",
  );
  for (const result of ["denied", "error", "invalid", "unknown"]) {
    const gate = evaluateIntentGate(
      [coredoc("get_intent_context", result)],
      context,
    );
    assert.equal(gate.result, "unmet", result);
    assert.match(gate.reason, new RegExp(result));
    assert.match(gate.message, /run get_intent_context/);
    assert.match(gate.message, /--skip-intent "<reason>"/);
  }
});

test("BR-1 tells not-configured, not-observed and a plain miss apart", () => {
  const context = { bound: true, stage: "spec" };
  assert.equal(
    evaluateIntentGate([coredoc("get_intent_context", "not_configured")], context)
      .result,
    "not-configured",
  );
  // Zero observations of any type: the host saw nothing, which is not the same
  // as seeing work without an intent read (LIM-1).
  const blind = evaluateIntentGate([], context);
  assert.equal(blind.result, "not-observed");
  assert.match(blind.message, /no observed tool calls at all/);
  // A stage that did other work and skipped the read is an ordinary miss.
  assert.equal(evaluateIntentGate([SEARCH], context).result, "unmet");
  // A read by another tool is not an intent read.
  assert.equal(
    evaluateIntentGate([coredoc("search_symbols", "ok")], context).result,
    "unmet",
  );
});

test("BR-1 records not-bound on an unenrolled checkout and skipped with a reason", () => {
  assert.deepEqual(evaluateIntentGate([], { bound: false, stage: "spec" }), {
    stage: "spec",
    gate: "intent",
    result: "not-bound",
    message: "",
  });
  const skipped = evaluateIntentGate([], {
    bound: true,
    stage: "spec",
    reason: "overlay not provisioned yet",
  });
  assert.equal(skipped.result, "skipped");
  assert.equal(skipped.reason, "overlay not provisioned yet");
});

test("BR-2 checks an accepted specification and leaves a draft alone", () => {
  const context = { bound: true, stage: "implement", specRef: SPEC_REF };
  assert.equal(
    evaluateCandidatesGate([], { ...context, spec: { status: "draft" } }).result,
    "not-applicable",
  );
  assert.equal(
    evaluateCandidatesGate([], {
      ...context,
      spec: { status: "accepted", intentChanges: "none" },
    }).result,
    "passed",
  );
  const missing = evaluateCandidatesGate([SEARCH], {
    ...context,
    spec: { status: "accepted" },
  });
  assert.equal(missing.result, "unmet");
  assert.match(missing.message, new RegExp(SPEC_REF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(
    evaluateCandidatesGate([], { ...context, spec: { status: "accepted" } })
      .result,
    "not-observed",
  );
});

test("BR-2 passes on a propose that cited this spec and created a candidate", () => {
  const context = {
    bound: true,
    stage: "implement",
    specRef: SPEC_REF,
    spec: { status: "accepted" },
  };
  assert.equal(
    evaluateCandidatesGate(
      [coredoc("intent_propose", "ok", { specMatch: true, created: 2 })],
      context,
    ).result,
    "passed",
  );
  // A propose that created nothing, or failed, is not the batch.
  assert.equal(
    evaluateCandidatesGate(
      [coredoc("intent_propose", "ok", { specMatch: true, created: 0 })],
      context,
    ).result,
    "unmet",
  );
  assert.equal(
    evaluateCandidatesGate(
      [coredoc("intent_propose", "denied", { specMatch: true, created: 1 })],
      context,
    ).result,
    "unmet",
  );
});

test("BR-2 names both refs when the propose cited another repository's identical path", () => {
  const otherRef = "other/repo:.scratch/gates/spec.md";
  const gate = evaluateCandidatesGate(
    [
      coredoc("intent_propose", "ok", {
        specMatch: false,
        created: 1,
        refs: [otherRef],
      }),
    ],
    {
      bound: true,
      stage: "implement",
      specRef: SPEC_REF,
      spec: { status: "accepted" },
    },
  );
  assert.equal(gate.result, "unmet");
  assert.ok(gate.message.includes(otherRef), gate.message);
  assert.ok(gate.message.includes(SPEC_REF), gate.message);
  assert.equal(gate.reason, `propose cited ${otherRef}`);
});

test("BR-2 is forced by `required` and reports an unreadable or absent spec", () => {
  // `spec accept --finish` applies the check as the precondition of the
  // draft → accepted transition, so a draft is still checked there.
  assert.equal(
    evaluateCandidatesGate([SEARCH], {
      bound: true,
      stage: "accept",
      specRef: SPEC_REF,
      spec: { status: "draft" },
      required: true,
    }).result,
    "unmet",
  );
  assert.equal(
    evaluateCandidatesGate([SEARCH], {
      bound: true,
      stage: "implement",
      specRef: SPEC_REF,
      required: true,
    }).result,
    "not-applicable",
  );
  assert.equal(
    evaluateCandidatesGate([SEARCH], { bound: false, stage: "implement" }).result,
    "not-bound",
  );
});

test("BR-3 resolves the Coredoc status from local facts only", () => {
  assert.equal(
    resolveCoredocStatus({ explicit: "partial", bound: true, coredocCalls: 3 }),
    "partial",
  );
  assert.equal(resolveCoredocStatus({ bound: false, coredocCalls: 3 }), "not-bound");
  assert.equal(resolveCoredocStatus({ bound: true, coredocCalls: 0 }), "not-used");
  assert.equal(
    resolveCoredocStatus({
      bound: true,
      coredocCalls: 2,
      observations: [
        coredoc("get_intent_context", "not_configured"),
        coredoc("intent_propose", "not_configured"),
      ],
    }),
    "not-configured",
  );
  assert.equal(
    resolveCoredocStatus({
      bound: true,
      coredocCalls: 2,
      observations: [
        coredoc("get_intent_context", "not_configured"),
        coredoc("search_symbols", "ok"),
      ],
    }),
    "not-assessed",
  );
  // A run routed before the binding was recorded keeps the original resolution.
  assert.equal(resolveCoredocStatus({ coredocCalls: 1 }), "not-assessed");
  assert.equal(resolveCoredocStatus({ coredocCalls: 0 }), "not-used");
});

test("BR-3 refuses not-assessed and names both remedies", () => {
  const unmet = evaluateFinishGate({ coredocStatus: "not-assessed", bound: true });
  assert.equal(unmet.result, "unmet");
  assert.match(unmet.message, /--coredoc-status complete\|partial\|unavailable/);
  assert.match(unmet.message, /--skip-intent "<reason>"/);
  assert.equal(
    evaluateFinishGate({
      coredocStatus: "not-assessed",
      bound: true,
      reason: "graph offline",
    }).result,
    "skipped",
  );
  assert.equal(
    evaluateFinishGate({ coredocStatus: "not-configured", bound: true }).result,
    "passed",
  );
  assert.equal(
    evaluateFinishGate({ coredocStatus: "not-assessed", bound: false }).result,
    "not-bound",
  );
});

test("enforce refuses, warn prints the same text and closes, non-success records unmet", () => {
  const unmet = [
    evaluateIntentGate([SEARCH], { bound: true, stage: "spec" }),
    evaluateIntentGate([], { bound: true, stage: "spec" }),
  ];
  const enforced = applyGates(unmet, {
    outcome: "success",
    bound: true,
    mode: "enforce",
  });
  assert.ok(enforced.refusal.includes("run get_intent_context"));
  assert.equal(enforced.warned, undefined);
  assert.deepEqual(
    enforced.results.map(({ result }) => result),
    ["unmet", "not-observed"],
  );
  // Nothing recorded to history ever carries the refusal prose.
  assert.ok(enforced.results.every((entry) => entry.message === undefined));

  const printed = [];
  const warned = applyGates(unmet, {
    outcome: "success",
    bound: true,
    mode: "warn",
    stderr: { write: (text) => printed.push(text) },
  });
  assert.equal(warned.refusal, undefined);
  assert.equal(warned.warned, enforced.refusal);
  assert.deepEqual(printed, [`${enforced.refusal}\n`]);

  // DEC-3: a non-success close never refuses and records `unmet`.
  for (const outcome of ["failed", "blocked", "abandoned"]) {
    const recorded = applyGates(unmet, { outcome, bound: true, mode: "enforce" });
    assert.equal(recorded.refusal, undefined, outcome);
    assert.deepEqual(
      recorded.results.map(({ result }) => result),
      ["unmet", "unmet"],
      outcome,
    );
  }
  // DEC-2: an unbound checkout never refuses.
  assert.equal(
    applyGates(unmet, { outcome: "success", bound: false, mode: "enforce" })
      .refusal,
    undefined,
  );
});

test("the stage gate table evaluates spec, implement and review", () => {
  assert.deepEqual(STAGE_GATES.spec, ["intent"]);
  assert.deepEqual(STAGE_GATES.implement, ["candidates", "mcp"]);
  assert.deepEqual(STAGE_GATES.review, ["mcp"]);
  // BR-2 is never checked at the spec close: the spec is still a draft there.
  assert.deepEqual(
    evaluateStageGates("spec", [coredoc("get_intent_context", "ok")], {
      bound: true,
      specRef: SPEC_REF,
      spec: { status: "accepted" },
    }).map(({ gate, result }) => [gate, result]),
    [["intent", "passed"]],
  );
  // BR-4: the review stage is gated on the read alone.
  assert.deepEqual(
    evaluateStageGates("review", [coredoc("explain", "ok")], {
      bound: true,
    }).map(({ gate, result }) => [gate, result]),
    [["mcp", "passed"]],
  );
  // The signed skip is what implement's own mcp gate answers with.
  assert.deepEqual(
    evaluateStageGates("implement", [SEARCH], {
      bound: true,
      specRef: SPEC_REF,
      spec: { status: "draft" },
      skipMcpReason: "graph not indexed",
    }).map(({ gate, result, reason }) => [gate, result, reason]),
    [
      ["candidates", "not-applicable", "specification is draft, not accepted"],
      ["mcp", "skipped", "graph not indexed"],
    ],
  );
});

test("gate evidence reports what the observations already satisfy", () => {
  assert.deepEqual(gateEvidence([]), {
    intent: "pending",
    candidates: "not-applicable",
    mcp: "pending",
  });
  assert.deepEqual(
    gateEvidence([coredoc("search_symbols", "ok")], {
      spec: { status: "draft" },
    }),
    { intent: "pending", candidates: "not-applicable", mcp: "satisfied" },
  );
  assert.deepEqual(
    gateEvidence(
      [
        coredoc("get_intent_context", "ok"),
        coredoc("intent_propose", "ok", { specMatch: true, created: 1 }),
      ],
      { spec: { status: "accepted" } },
    ),
    { intent: "satisfied", candidates: "satisfied", mcp: "satisfied" },
  );
  assert.equal(
    gateEvidence([coredoc("get_intent_context", "not_configured")]).intent,
    "not-configured",
  );
  // A write is never a read.
  assert.equal(
    gateEvidence([coredoc("intent_propose", "ok", { specMatch: true, created: 1 })])
      .mcp,
    "pending",
  );
});

test("the durable history appends, trims to 200 lines, and reads back its last line", () => {
  const env = testEnv();
  for (let index = 0; index < 205; index += 1) {
    appendRunHistory(
      "project-a",
      {
        runId: `cdr-20260915-0000${index}`,
        outcome: "success",
        gates: [{ stage: "spec", gate: "intent", result: "passed" }],
      },
      { env },
    );
  }
  const history = readRunHistory("project-a", { env });
  assert.equal(history.length, 200);
  assert.equal(history[0].runId, "cdr-20260915-00005");
  assert.equal(lastRunHistory("project-a", { env }).runId, "cdr-20260915-0000204");
  assert.equal(readRunHistory("project-b", { env }).length, 0);
  assert.equal(lastRunHistory("project-b", { env }), undefined);
  assert.ok(historyPath("project-a", env).endsWith("project-a/history.jsonl"));
  // Unparsable lines are skipped rather than poisoning the read.
  writeFileSync(
    historyPath("project-b", env).replace("project-b", "project-a"),
    'not json\n{"runId":"cdr-20260915-aaaaaa","outcome":"failed"}\n',
  );
  assert.equal(lastRunHistory("project-a", { env }).outcome, "failed");
});

test("route-task shows the previous run's unmet and skipped gates only", () => {
  assert.deepEqual(
    unresolvedGates({
      gates: [
        { stage: "spec", gate: "intent", result: "passed" },
        { stage: "implement", gate: "candidates", result: "unmet" },
        { stage: "implement", gate: "mcp", result: "skipped", reason: "offline" },
        { stage: "finish", gate: "intent", result: "not-bound" },
      ],
    }),
    [
      { stage: "implement", gate: "candidates", result: "unmet" },
      { stage: "implement", gate: "mcp", result: "skipped", reason: "offline" },
    ],
  );
  assert.deepEqual(unresolvedGates(undefined), []);
});

test("the specification artifact reader takes three keys and nothing else", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-spec-artifact-"));
  const path = join(directory, "spec.md");
  writeFileSync(
    path,
    "---\nsize: m\nstatus: draft\nintentChanges: none\nrun: cdr-20260915-a1b2c3\n---\n\n# Title\n\nstatus: accepted\n",
  );
  assert.deepEqual(readSpecArtifact(path), {
    status: "draft",
    intentChanges: "none",
    run: "cdr-20260915-a1b2c3",
  });
  assert.equal(readSpecArtifact(join(directory, "absent.md")), undefined);
  writeFileSync(join(directory, "plain.md"), "# No frontmatter\n");
  assert.deepEqual(readSpecArtifact(join(directory, "plain.md")), {});

  // A write replaces the key in place and leaves the body untouched.
  assert.equal(writeSpecArtifactKey(path, "status", "accepted"), true);
  assert.equal(readSpecArtifact(path).status, "accepted");
  assert.match(readFileSync(path, "utf8"), /# Title\n\nstatus: accepted\n$/);
  assert.equal(readSpecArtifact(path).intentChanges, "none");
  // A key the document lacks is inserted.
  writeFileSync(join(directory, "bare.md"), "---\nsize: s\n---\n\nbody\n");
  writeSpecArtifactKey(join(directory, "bare.md"), "run", "cdr-20260915-a1b2c3");
  assert.equal(
    readSpecArtifact(join(directory, "bare.md")).run,
    "cdr-20260915-a1b2c3",
  );
  assert.equal(writeSpecArtifactKey(join(directory, "plain.md"), "status", "x"), false);
});

test("a frontmatter rewrite keeps the document's own line separator", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-spec-crlf-"));
  const path = join(directory, "spec.md");
  const before = "---\r\nsize: m\r\nstatus: draft\r\n---\r\n\r\n# Title\r\n\r\nbody\r\n";
  writeFileSync(path, before);
  assert.deepEqual(readSpecArtifact(path), { status: "draft" });
  assert.equal(writeSpecArtifactKey(path, "status", "accepted"), true);
  // Byte for byte identical outside the one key that changed.
  assert.equal(
    readFileSync(path, "utf8"),
    before.replace("status: draft", "status: accepted"),
  );
  writeSpecArtifactKey(path, "run", "cdr-20260915-a1b2c3");
  assert.equal(
    readFileSync(path, "utf8"),
    before
      .replace("status: draft", "status: accepted")
      .replace("---\r\n\r\n# Title", "run: cdr-20260915-a1b2c3\r\n---\r\n\r\n# Title"),
  );
  assert.equal(removeSpecArtifactKey(path, "run"), true);
  assert.equal(
    readFileSync(path, "utf8"),
    before.replace("status: draft", "status: accepted"),
  );
});

test("an empty frontmatter block declares nothing and is still writable", () => {
  const directory = mkdtempSync(join(tmpdir(), "coredoc-spec-empty-"));
  const path = join(directory, "spec.md");
  writeFileSync(path, "---\n---\n\nbody\n");
  assert.deepEqual(readSpecArtifact(path), {});
  assert.equal(writeSpecArtifactKey(path, "run", "cdr-20260915-a1b2c3"), true);
  assert.equal(
    readFileSync(path, "utf8"),
    "---\nrun: cdr-20260915-a1b2c3\n---\n\nbody\n",
  );
  assert.equal(removeSpecArtifactKey(path, "run"), true);
  assert.equal(readFileSync(path, "utf8"), "---\n---\n\nbody\n");
  // A document with no block at all is still readable and declares nothing,
  // but there is nothing to write into.
  writeFileSync(join(directory, "plain.md"), "# No frontmatter\n");
  assert.deepEqual(readSpecArtifact(join(directory, "plain.md")), {});
  assert.equal(
    writeSpecArtifactKey(join(directory, "plain.md"), "status", "accepted"),
    false,
  );
});

test("specification paths stay repository-relative", () => {
  assert.equal(normalizedSpecPath("./.scratch/a/spec.md", "/repo"), ".scratch/a/spec.md");
  assert.equal(normalizedSpecPath("/repo/docs/spec.md", "/repo"), "docs/spec.md");
  assert.throws(() => normalizedSpecPath("", "/repo"), /repository-relative path/);
  assert.throws(
    () => normalizedSpecPath("../outside/spec.md", "/repo"),
    /inside the repository/,
  );
  assert.throws(
    () => normalizedSpecPath("/elsewhere/spec.md", "/repo"),
    /inside the repository/,
  );
  // A `..` in the middle escapes just as surely as a leading one, and only the
  // resolved path shows it.
  assert.throws(
    () => normalizedSpecPath("docs/../../other/spec.md", "/repo"),
    /inside the repository/,
  );
  assert.throws(
    () => normalizedSpecPath("./docs/../../../etc/spec.md", "/repo"),
    /inside the repository/,
  );
  // Interior `..` that stays inside is normalised, not refused.
  assert.equal(normalizedSpecPath("docs/../docs/spec.md", "/repo"), "docs/spec.md");
  assert.equal(normalizedSpecPath("./docs/spec.md", "/repo"), "docs/spec.md");
  assert.equal(specRefFor("owner/repo", "docs/spec.md"), "owner/repo:docs/spec.md");
  assert.equal(specRefFor(undefined, "docs/spec.md"), "unmapped:docs/spec.md");
  assert.equal(
    specAbsolutePath("owner/repo:docs/spec.md", { repoRoot: "/repo" }),
    "/repo/docs/spec.md",
  );
});

test("a spec path through a symlinked directory cannot leave the repository", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "coredoc-spec-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "coredoc-spec-outside-"));
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  writeFileSync(join(outside, "spec.md"), "---\nstatus: draft\n---\n");
  symlinkSync(outside, join(repoRoot, "escape"), "dir");

  assert.throws(
    () => normalizedSpecPath("escape/spec.md", repoRoot),
    /inside the repository/,
  );
  // The repository's own directories still resolve, symlinked root and all.
  assert.equal(normalizedSpecPath("docs/spec.md", repoRoot), "docs/spec.md");
});
