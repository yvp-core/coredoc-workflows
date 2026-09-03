import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "../plugins/coredoc-workflows/test/test-api.mjs";

import {
  SCENARIOS,
  aggregateRuns,
  assertSourceFreeResult,
  buildStaticBaseline,
  evidencePolicyPassed,
  intentLayerSpecPassed,
  parseCodexJsonl,
  routeForScenario,
} from "../scripts/workflow-change-baseline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  for (const id of ["bug-fix", "deletion", "refactor", "config-docs"]) {
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
