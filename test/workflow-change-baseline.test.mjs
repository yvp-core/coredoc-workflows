import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "../plugins/coredoc-workflows/test/test-api.mjs";

import {
  SCENARIOS,
  aggregateRuns,
  assertSourceFreeResult,
  buildStaticBaseline,
  baselineObservations,
  baselineOutcome,
  EXIT_FAILED,
  EXIT_INCONCLUSIVE,
  EXIT_PASSED,
  evidencePolicyPassed,
  liveExitCode,
  intentLayerSpecPassed,
  parseCodexJsonl,
  routeForScenario,
  repositoryContentDigest,
} from "../scripts/workflow-change-baseline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("read-only evidence detects content, new files, symlinks and permission changes", async () => {
  const repo = await mkdtemp(join(tmpdir(), "baseline-read-only-"));
  try {
    await writeFile(join(repo, "pricing.mjs"), "original");
    const original = await repositoryContentDigest(repo);
    // Two files must never hash like one file whose content embeds the
    // second entry's name, mode and content around NUL bytes.
    await writeFile(join(repo, "second"), "y");
    const twoFiles = await repositoryContentDigest(repo);
    const { mode } = await lstat(join(repo, "second"));
    await rm(join(repo, "second"));
    await writeFile(join(repo, "pricing.mjs"), `original\0second\0${mode}\0y`);
    assert.notEqual(await repositoryContentDigest(repo), twoFiles);
    await writeFile(join(repo, "pricing.mjs"), "original");
    assert.equal(await repositoryContentDigest(repo), original);
    await mkdir(join(repo, ".git"));
    await writeFile(join(repo, ".git", "index"), "metadata");
    assert.equal(await repositoryContentDigest(repo), original);
    const repaired = await repositoryContentDigest(repo, new Map([["pricing.mjs", "repair"]]));
    await writeFile(join(repo, "pricing.mjs"), "repair");
    assert.notEqual(await repositoryContentDigest(repo), original);
    assert.equal(await repositoryContentDigest(repo), repaired);
    await writeFile(join(repo, "pricing.mjs"), "original");
    await writeFile(join(repo, "untracked"), "extra");
    assert.notEqual(await repositoryContentDigest(repo), original);
    await rm(join(repo, "untracked"));
    await symlink("pricing.mjs", join(repo, "extra-link"));
    assert.notEqual(await repositoryContentDigest(repo), original);
    await rm(join(repo, "extra-link"));
    await chmod(join(repo, "pricing.mjs"), 0o755);
    assert.notEqual(await repositoryContentDigest(repo), original);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("covers the representative change types with the expected routes", () => {
  const routes = Object.fromEntries(
    SCENARIOS.map((scenario) => [
      scenario.id,
      routeForScenario(scenario),
    ]),
  );

  assert.deepEqual(
    routes["new-behavior"].stages.map((stage) => stage.id),
    ["implement"],
  );
  assert.deepEqual(
    routes["bug-fix"].stages.map((stage) => stage.id),
    ["investigate", "implement"],
  );
  for (const id of ["deletion", "refactor", "config-docs"]) {
    assert.deepEqual(
      routes[id].stages.map((stage) => stage.id),
      ["implement"],
    );
  }
  assert.equal(routes["large-shared-contract"].scale, "large");
  assert.equal(routes["large-shared-contract"].risk, "high");
  assert.deepEqual(
    routes["large-shared-contract"].stages.map((stage) => stage.id),
    ["spec", "design", "implement", "review"],
  );
  assert.equal(routes["large-shared-contract"].stages[2].gate, "user-approval");
  assert.equal(routes["review-read-only"].intent, "review");
  assert.deepEqual(routes["review-read-only"].stages.map((stage) => stage.id), ["review"]);
  assert.equal(routes["worker-decision"].workflowId, "worker-decision-contract");
  assert.deepEqual(routes["worker-decision"].stages, []);
});

test("worker-decision measures the dispatch contract instead of a skill route", async () => {
  const [worker] = await buildStaticBaseline([
    SCENARIOS.find((scenario) => scenario.id === "worker-decision"),
  ]);
  assert.deepEqual(worker.declared.components.map((component) => component.skill), ["subagent-dispatch"]);
  assert.equal(worker.declared.totalUtf8Bytes > worker.declared.totalWords, true);
  assert.deepEqual(worker.preApproval, worker.declared);
});

test("extracts numeric Codex usage without retaining event content", () => {
  const secret = "SOURCE-CONTENT-MUST-NOT-SURVIVE";
  const parsed = parseCodexJsonl(
    [
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: secret },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: secret },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 70,
          cache_write_input_tokens: 3,
          output_tokens: 20,
          reasoning_output_tokens: 8,
        },
      }),
    ].join("\n"),
  );

  assert.equal(parsed.inputTokens, 120);
  assert.equal(parsed.uncachedInputTokens, 50);
  assert.equal(parsed.outputTokens, 20);
  assert.equal(parsed.items.completed, 2);
  assert.equal(parsed.items.agentMessages, 1);
  assert.equal(parsed.items.commandExecutions, 1);
  assert.doesNotMatch(JSON.stringify(parsed), new RegExp(secret));
});

test("aggregates repeated runs as median and min/max", () => {
  const usage = (inputTokens, outputTokens) => ({
    inputTokens,
    uncachedInputTokens: inputTokens - 10,
    outputTokens,
    reasoningOutputTokens: 2,
  });
  const runs = [
    {
      scenario: "deletion",
      passed: true,
      usage: usage(100, 20),
      workflowWallMs: 1_000,
    },
    {
      scenario: "deletion",
      passed: false,
      usage: usage(300, 60),
      workflowWallMs: 3_000,
    },
    {
      scenario: "deletion",
      passed: true,
      usage: usage(200, 40),
      workflowWallMs: 2_000,
    },
  ];

  const [summary] = aggregateRuns(runs);
  assert.equal(summary.runs, 3);
  assert.equal(summary.passedRuns, 2);
  assert.deepEqual(summary.inputTokens, { min: 100, median: 200, max: 300 });
  assert.deepEqual(summary.outputTokens, { min: 20, median: 40, max: 60 });
  assert.deepEqual(summary.workflowWallMs, {
    min: 1_000,
    median: 2_000,
    max: 3_000,
  });
});

test("counts inconclusive runs without averaging their empty usage", () => {
  const usage = (tokens, extra = {}) => ({
    inputTokens: tokens,
    uncachedInputTokens: tokens,
    outputTokens: tokens,
    reasoningOutputTokens: tokens,
    ...extra,
  });
  const [summary] = aggregateRuns([
    { scenario: "deletion", passed: true, outcome: "passed", usage: usage(100, { available: true }), workflowWallMs: 1_000 },
    { scenario: "deletion", passed: false, outcome: "inconclusive", usage: usage(0, { available: false }), workflowWallMs: 900_000 },
    { scenario: "deletion", passed: false, outcome: "inconclusive", usage: usage(0, { available: false }), workflowWallMs: 0 },
  ]);
  assert.equal(summary.runs, 3);
  assert.equal(summary.passedRuns, 1);
  assert.equal(summary.inconclusiveRuns, 2);
  assert.equal("skippedRuns" in summary, false);
  assert.deepEqual(summary.inputTokens, { min: 100, median: 100, max: 100 });
  assert.deepEqual(summary.workflowWallMs, { min: 1_000, median: 1_000, max: 1_000 });
});

test("failed or missing model turns never become successful measurements", () => {
  assert.throws(() => parseCodexJsonl(""), /completed turn/);
  assert.throws(() => parseCodexJsonl([
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
    JSON.stringify({ type: "turn.failed", error: { message: "provider failure" } }),
  ].join("\n")), /failed turn/);
  assert.throws(() => parseCodexJsonl([
    JSON.stringify({ type: "error", message: "provider down" }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } }),
  ].join("\n")), /failed turn/);
  assert.equal(parseCodexJsonl(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1 } })).available, true);
  assert.equal(baselineOutcome({ runnerPassed: false, checksPassed: true }), "inconclusive");
  assert.equal(baselineOutcome({ runnerPassed: true, checksPassed: false }), "failed");
  assert.equal(baselineOutcome({ runnerPassed: true, checksPassed: true }), "passed");
  assert.equal(liveExitCode([{ outcome: "passed" }, { outcome: "passed" }]), EXIT_PASSED);
  assert.equal(liveExitCode([{ outcome: "passed" }, { outcome: "inconclusive" }]), EXIT_INCONCLUSIVE);
  assert.equal(liveExitCode([{ outcome: "inconclusive" }, { outcome: "failed" }]), EXIT_FAILED);
  assert.notEqual(EXIT_FAILED, 1);
  assert.notEqual(EXIT_INCONCLUSIVE, 1);
});

test("behavioral observations require a final answer and retain no text", () => {
  const event = (type, text) => JSON.stringify({ type: "item.completed", item: { type, text } });
  assert.deepEqual(baselineObservations(event("command_execution", "silver 15 should be 10 NEEDS_CONTEXT?")), {
    reportedDiscountRegression: false, needsContext: false,
  });
  const found = baselineObservations(event("agent_message", "Silver changed to 15%, but the contract requires 10%."));
  assert.equal(found.reportedDiscountRegression, true);
  const decision = baselineObservations(event("agent_message", "NEEDS_CONTEXT: should silver receive 12% or 15%?"));
  assert.equal(decision.needsContext, true);
  assert.equal(baselineObservations(event("agent_message", "NEEDS_CONTEXT")).needsContext, false);
  assertSourceFreeResult(decision);
});

test("requires a focused test only for new observable behavior", () => {
  const scenario = (id) => SCENARIOS.find((candidate) => candidate.id === id);

  assert.equal(
    evidencePolicyPassed(scenario("new-behavior"), { testFilesChanged: 1 }),
    true,
  );
  assert.equal(
    evidencePolicyPassed(scenario("new-behavior"), { testFilesChanged: 0 }),
    false,
  );
  for (const id of [
    "bug-fix",
    "deletion",
    "refactor",
    "config-docs",
    "review-read-only",
    "bounded-bug-fix",
    "worker-decision",
  ]) {
    assert.equal(
      evidencePolicyPassed(scenario(id), { testFilesChanged: 0 }),
      true,
    );
    assert.equal(
      evidencePolicyPassed(scenario(id), { testFilesChanged: 1 }),
      false,
    );
  }
});

test("requires observable intent traceability without forcing limitations or ADRs", () => {
  const complete = `
## Use cases
UC-1 traces to AC-1.
## Acceptance
AC-1 names an observer and decisive check.
## Scope
Non-goals are explicit.
## Release
Rollout is staged and rollback restores the previous API.
`;

  assert.equal(intentLayerSpecPassed(complete), true);
  assert.equal(intentLayerSpecPassed(complete.replace(/observer/u, "check")), false);
  assert.equal(
    intentLayerSpecPassed(
      complete.replace(
        "## Release\nRollout is staged and rollback restores the previous API.",
        "Rollback restores the previous API.",
      ),
    ),
    false,
  );
  assert.equal(
    intentLayerSpecPassed(
      complete.replace(
        "## Release\nRollout is staged and rollback restores the previous API.",
        "## Release\nRollout is staged.",
      ),
    ),
    false,
  );

  const invented = [
    "## Decisions (ADR)\n| ID | Decision |\n| --- | --- |\n| ADR-1 | TBD |",
    "## Business rules\n| ID | Condition | Outcome |\n| --- | --- | --- |\n| BR-1 | ... | ... |",
    "## Decisions (ADR)\n| ID | Status | Context | Decision |\n| --- | --- | --- | --- |\n| ADR-1 | proposed/accepted/superseded | ... | ... |",
    "## Decisions (ADR)\n| ID | Status | Decision |\n| --- | --- | --- |\n| ADR-1 | proposed | TBD |",
    "## Limitations\n| ID | Constraint |\n| --- | --- |\n| LIM-1 | N/A |",
    "## Limitations\nTBD",
    "## Limitations\n...",
    "## Decisions (ADR)\n\n## Notes\nnothing decided",
    "## Limitations\n",
  ];
  for (const section of invented) {
    assert.equal(intentLayerSpecPassed(`${complete}\n${section}\n`), false, section);
  }

  const genuine = [
    "## Business rules\n| ID | Condition | Outcome |\n| --- | --- | --- |\n| BR-1 | unknown tier | discount 0 |",
    "## Decisions (ADR)\n| ID | Status | Decision |\n| --- | --- | --- |\n| ADR-1 | accepted | keep lookup synchronous |",
    "## Decisions (ADR)\nNone.",
    "The limitations of this approach are TBD in a later slice.",
  ];
  for (const section of genuine) {
    assert.equal(intentLayerSpecPassed(`${complete}\n${section}\n`), true, section);
  }
});

test("rejects content-bearing fields from persisted results", () => {
  assert.doesNotThrow(() =>
    assertSourceFreeResult({
      usage: { inputTokens: 10, outputTokens: 2 },
      rawEventsRetained: false,
    }),
  );
  assert.throws(
    () => assertSourceFreeResult({ prompt: "do something" }),
    /may not contain prompt/,
  );
  assert.throws(
    () => assertSourceFreeResult({ nested: { path: "/private/repo" } }),
    /may not contain path/,
  );
});

test("reports deterministic router and stage skill footprints", async () => {
  const [deletion] = await buildStaticBaseline([
    SCENARIOS.find((scenario) => scenario.id === "deletion"),
  ]);

  assert.equal(deletion.scenario, "deletion");
  assert.deepEqual(
    deletion.declared.components.map((component) => component.skill),
    ["coredoc-workflows", "coredoc-implement"],
  );
  assert.equal(deletion.declared.totalWords > 0, true);
  assert.equal(deletion.declared.totalUtf8Bytes > deletion.declared.totalWords, true);
  assert.deepEqual(deletion.preApproval, deletion.declared);
});

test("keeps the benchmark fixture dependency-free and self-validating", async () => {
  const fixture = join(root, "benchmarks", "workflow-change-baseline", "fixture");
  const pkg = JSON.parse(await readFile(join(fixture, "package.json"), "utf8"));
  const rules = await readFile(join(fixture, "AGENTS.md"), "utf8");

  assert.equal(pkg.private, true);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts.test, "node --test");
  assert.match(rules, /Add or change tests only when existing tests do not provide evidence/);
});
