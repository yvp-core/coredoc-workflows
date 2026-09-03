#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  inferTaskSignals,
  routeTask,
} from "../plugins/coredoc-workflows/scripts/route-task.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = join(ROOT, "plugins", "coredoc-workflows");
const FIXTURE_ROOT = join(
  ROOT,
  "benchmarks",
  "workflow-change-baseline",
  "fixture",
);
const ROUTER_SKILL = "coredoc-workflows";
const DEFAULT_MODEL = "gpt-5.6-sol";
const DEFAULT_EFFORT = "low";
const DEFAULT_REPETITIONS = 3;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const LIVE_TIMEOUT_MS = 15 * 60 * 1000;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export const SCENARIOS = Object.freeze([
  {
    id: "new-behavior",
    task: "Add a platinum membership tier with a 25% discount and cover the new observable behavior.",
  },
  {
    id: "bug-fix",
    task: "Fix the silver membership discount regression so it is 10% again.",
    setup: "silver-regression",
  },
  {
    id: "deletion",
    task: "Remove the obsolete and unused legacyDiscount export. Do not replace it.",
  },
  {
    id: "refactor",
    task: "Refactor checkoutTotal and renewalTotal to share discount application without changing public behavior.",
  },
  {
    id: "config-docs",
    task: "Update the maximum promotion configuration from 30% to 25% and document the new limit.",
  },
  {
    id: "large-shared-contract",
    task: [
      "Create an in-process pricing-rules subsystem that owns membership-tier discount lookup.",
      "Keep discountFor(tier) as the backward-compatible public API and keep checkoutTotal and renewalTotal as its consumers.",
      "Preserve the current tier percentages and unknown-tier fallback of 0.",
      "Keep lookup synchronous and in memory; add no persistence, network service, configuration migration, promotion changes, or API removal.",
      "Release it as one backward-compatible change; rollback is a revert of the module and consumer changes.",
    ].join(" "),
    stopAtApprovalGate: true,
  },
]);

function words(text) {
  const trimmed = text.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/u).length;
}

export function intentLayerSpecPassed(content) {
  const required = [
    /\bUC-\d+\b/u,
    /\bAC-\d+\b/u,
    /acceptance/iu,
    /observer/iu,
    /(?:traces? to|->)/iu,
    /non-goals/iu,
    /(?:release|rollout)/iu,
    /rollback/iu,
  ];
  // A BR/LIM/ADR heading followed by nothing, a bare placeholder, or a table row
  // whose ID cell is followed by a placeholder cell (`...`, `TBD`, `N/A`) in any
  // column. Placeholders are delimited by `|` or line end, never by `\b`, because
  // `...` has no word boundary against the next space.
  const inventedEmptySection =
    /(?:Business rules?|Limitations?|Decisions \(ADR\))[^\S\n]*\n(?:[^\S\n]*\n)*(?:[^\S\n]*(?=#{1,6}\s)|[^\S\n]*(?![\s\S])|\s*(?:\|[^\n]*\|[^\S\n]*\n\s*\|[- :|]+\|[^\S\n]*\n)?\s*(?:\|\s*(?:BR|LIM|ADR)-\d+\s*\|(?:[^\n|]*\|)*?\s*(?:\.\.\.|TBD|N\/A)\s*\||(?:\.\.\.|TBD)[^\S\n]*(?:\n|$)))/imu;
  return required.every((pattern) => pattern.test(content)) && !inventedEmptySection.test(content);
}

function routeSummary(route) {
  return {
    workflowId: route.workflowId,
    intent: route.intent,
    risk: route.risk,
    scale: route.scale,
    stages: route.stages.map((stage) => ({
      id: stage.id,
      ...(stage.gate === undefined ? {} : { gate: stage.gate }),
    })),
  };
}

export function routeForScenario(scenario) {
  return routeTask(inferTaskSignals(scenario.task));
}

function preApprovalStages(route) {
  const firstGate = route.stages.findIndex((stage) => stage.gate !== undefined);
  return firstGate === -1 ? route.stages : route.stages.slice(0, firstGate);
}

function declaredSkills(route, { preApprovalOnly = false } = {}) {
  const stages = preApprovalOnly ? preApprovalStages(route) : route.stages;
  return [ROUTER_SKILL, ...stages.map((stage) => stage.skill)];
}

function skillFile(skill) {
  return join(PLUGIN_ROOT, "skills", skill, "SKILL.md");
}

async function readSkill(skill, workflowRef) {
  if (workflowRef === undefined) return readFile(skillFile(skill), "utf8");
  const repositoryPath = relative(ROOT, skillFile(skill));
  return mustRun("git", ["show", `${workflowRef}:${repositoryPath}`], { cwd: ROOT });
}

async function skillFootprint(skills, workflowRef) {
  const components = [];
  for (const skill of skills) {
    const content = await readSkill(skill, workflowRef);
    components.push({
      skill,
      utf8Bytes: Buffer.byteLength(content, "utf8"),
      words: words(content),
    });
  }
  return {
    components,
    totalUtf8Bytes: components.reduce((total, item) => total + item.utf8Bytes, 0),
    totalWords: components.reduce((total, item) => total + item.words, 0),
  };
}

export async function buildStaticBaseline(
  scenarios = SCENARIOS,
  { workflowRef } = {},
) {
  const measurements = [];
  for (const scenario of scenarios) {
    const route = routeForScenario(scenario);
    measurements.push({
      scenario: scenario.id,
      route: routeSummary(route),
      declared: await skillFootprint(declaredSkills(route), workflowRef),
      preApproval: await skillFootprint(
        declaredSkills(route, { preApprovalOnly: true }),
        workflowRef,
      ),
    });
  }
  return measurements;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addUsage(total, usage) {
  total.inputTokens += usage.input_tokens ?? 0;
  total.cachedInputTokens += usage.cached_input_tokens ?? 0;
  total.cacheWriteInputTokens += usage.cache_write_input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.reasoningOutputTokens += usage.reasoning_output_tokens ?? 0;
}

export function parseCodexJsonl(jsonl) {
  const usage = emptyUsage();
  const items = {
    completed: 0,
    agentMessages: 0,
    commandExecutions: 0,
    fileChanges: 0,
    toolCalls: 0,
    other: 0,
  };
  let turns = 0;

  for (const line of jsonl.split(/\r?\n/u)) {
    if (line.trim() === "") continue;
    const event = JSON.parse(line);
    if (event.type === "turn.completed" && event.usage !== undefined) {
      turns += 1;
      addUsage(usage, event.usage);
      continue;
    }
    if (event.type !== "item.completed" || event.item === undefined) continue;
    items.completed += 1;
    if (event.item.type === "agent_message") items.agentMessages += 1;
    else if (event.item.type === "command_execution") items.commandExecutions += 1;
    else if (event.item.type === "file_change") items.fileChanges += 1;
    else if (
      event.item.type === "mcp_tool_call" ||
      event.item.type === "collab_tool_call" ||
      event.item.type === "web_search"
    ) {
      items.toolCalls += 1;
    } else items.other += 1;
  }

  if (turns === 0) {
    throw new Error("Codex JSONL did not contain a completed turn with usage");
  }
  return {
    ...usage,
    uncachedInputTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
    turns,
    items,
  };
}

function metric(values) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle];
  return {
    min: sorted[0],
    median,
    max: sorted[sorted.length - 1],
  };
}

export function aggregateRuns(runs) {
  const summaries = [];
  for (const scenario of SCENARIOS) {
    const matching = runs.filter((run) => run.scenario === scenario.id);
    if (matching.length === 0) continue;
    summaries.push({
      scenario: scenario.id,
      runs: matching.length,
      passedRuns: matching.filter((run) => run.passed).length,
      inputTokens: metric(matching.map((run) => run.usage.inputTokens)),
      uncachedInputTokens: metric(
        matching.map((run) => run.usage.uncachedInputTokens),
      ),
      outputTokens: metric(matching.map((run) => run.usage.outputTokens)),
      reasoningOutputTokens: metric(
        matching.map((run) => run.usage.reasoningOutputTokens),
      ),
      workflowWallMs: metric(matching.map((run) => run.workflowWallMs)),
    });
  }
  return summaries;
}

const FORBIDDEN_RESULT_KEYS = new Set([
  "prompt",
  "prompts",
  "message",
  "messages",
  "command",
  "commands",
  "source",
  "diff",
  "path",
  "paths",
  "threadId",
  "rawEvents",
  "modelOutput",
  "agentMessage",
  "stdout",
  "stderr",
]);

export function assertSourceFreeResult(value, key = "result") {
  if (Array.isArray(value)) {
    for (const item of value) assertSourceFreeResult(item, key);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (FORBIDDEN_RESULT_KEYS.has(childKey)) {
      throw new Error(`Source-free result may not contain ${childKey} at ${key}`);
    }
    assertSourceFreeResult(childValue, `${key}.${childKey}`);
  }
}

function collectProcess(command, args, options = {}) {
  const {
    cwd,
    env = process.env,
    timeoutMs = 60_000,
    maxCaptureBytes = 4 * 1024 * 1024,
  } = options;
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxCaptureBytes) {
        overflow = true;
        child.kill("SIGTERM");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxCaptureBytes) {
        overflow = true;
        child.kill("SIGTERM");
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveProcess({
        code,
        signal,
        timedOut,
        overflow,
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}

async function mustRun(command, args, options) {
  const result = await collectProcess(command, args, options);
  if (result.code !== 0 || result.timedOut || result.overflow) {
    throw new Error(`${command} failed while preparing or validating the fixture`);
  }
  return result.stdout;
}

async function applyScenarioSetup(repo, scenario) {
  if (scenario.setup !== "silver-regression") return;
  const pricingFile = join(repo, "src", "pricing.mjs");
  const pricing = await readFile(pricingFile, "utf8");
  const changed = pricing.replace("silver: 10", "silver: 15");
  if (changed === pricing) throw new Error("Bug setup anchor was not found");
  await writeFile(pricingFile, changed);
}

async function prepareFixture(scenario) {
  const tempRoot = await mkdtemp(join(tmpdir(), "coredoc-workflow-baseline-"));
  const repo = join(tempRoot, "fixture");
  await cp(FIXTURE_ROOT, repo, { recursive: true });
  await applyScenarioSetup(repo, scenario);
  await mustRun("git", ["init", "-q"], { cwd: repo });
  await mustRun("git", ["config", "user.email", "baseline@invalid.local"], {
    cwd: repo,
  });
  await mustRun("git", ["config", "user.name", "Workflow Baseline"], {
    cwd: repo,
  });
  await mustRun("git", ["add", "."], { cwd: repo });
  await mustRun("git", ["commit", "-q", "-m", "baseline fixture"], {
    cwd: repo,
  });
  const revision = (await mustRun("git", ["rev-parse", "HEAD"], { cwd: repo })).trim();
  return { tempRoot, repo, revision };
}

async function prepareSkillSnapshot(tempRoot, scenario, workflowRef) {
  const pluginRoot = join(tempRoot, "workflow", "plugins", "coredoc-workflows");
  const skills = declaredSkills(routeForScenario(scenario), {
    preApprovalOnly: scenario.stopAtApprovalGate === true,
  });
  for (const skill of skills) {
    const directory = join(pluginRoot, "skills", skill);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), await readSkill(skill, workflowRef));
  }
  if (workflowRef === undefined) {
    await cp(join(PLUGIN_ROOT, "resources"), join(pluginRoot, "resources"), {
      recursive: true,
    });
  } else {
    const resourcePrefix = relative(ROOT, join(PLUGIN_ROOT, "resources"));
    const resources = (
      await mustRun(
        "git",
        ["ls-tree", "-r", "--name-only", workflowRef, "--", resourcePrefix],
        { cwd: ROOT },
      )
    )
      .split(/\r?\n/u)
      .filter(Boolean);
    for (const repositoryPath of resources) {
      const target = join(tempRoot, "workflow", repositoryPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(
        target,
        await mustRun("git", ["show", `${workflowRef}:${repositoryPath}`], {
          cwd: ROOT,
        }),
      );
    }
  }
  return pluginRoot;
}

function snapshotSkillFile(pluginRoot, skill) {
  return join(pluginRoot, "skills", skill, "SKILL.md");
}

function livePrompt(scenario, pluginRoot) {
  return [
    "This is an explicit local workflow benchmark in a synthetic repository.",
    `Requested change: ${scenario.task}`,
    `Read and follow the workflow router at ${snapshotSkillFile(pluginRoot, ROUTER_SKILL)}.`,
    `For each routed stage, read its SKILL.md below ${join(pluginRoot, "skills")}.`,
    "Complete the routed workflow only as far as its own authorization gates permit.",
    "Do not use ambient skills, Coredoc MCP, external context, network tools, delegation, or subagents.",
    "The user declines optional skill suggestions. Make reasonable fixture-local assumptions instead of asking optional questions.",
    "Do not run route-task, stage-run, finish-run, capture, telemetry, or feedback commands; the harness owns timing and telemetry.",
    "Do not commit. Work only in the current synthetic repository.",
  ].join("\n");
}

function liveEnvironment(tempRoot) {
  return {
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    COREDOC_CAPTURE_ENDPOINT: "",
    COREDOC_CAPTURE_HEADERS: "",
    COREDOC_WORKFLOWS_STATE_HOME: join(tempRoot, "state"),
    COREDOC_WORKFLOWS_STATE_DIR: join(tempRoot, "state", "runs"),
    OTEL_EXPORTER_OTLP_ENDPOINT: "",
    OTEL_EXPORTER_OTLP_HEADERS: "",
  };
}

async function runCodex({ repo, tempRoot, scenario, model, effort, pluginRoot }) {
  const started = performance.now();
  const result = await collectProcess(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--json",
      "--ignore-user-config",
      "-m",
      model,
      "-c",
      `model_reasoning_effort=${JSON.stringify(effort)}`,
      "--approve-for-me",
      "-C",
      repo,
      livePrompt(scenario, pluginRoot),
    ],
    {
      cwd: repo,
      env: liveEnvironment(tempRoot),
      timeoutMs: LIVE_TIMEOUT_MS,
      maxCaptureBytes: MAX_CAPTURE_BYTES,
    },
  );
  return { ...result, wallMs: Math.round(performance.now() - started) };
}

async function importPricing(repo) {
  return import(`${pathToFileURL(join(repo, "src", "pricing.mjs")).href}?baseline=${Date.now()}`);
}

async function listFiles(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)));
    else if (entry.isFile()) files.push(relative(root, absolute));
  }
  return files;
}

async function verifyScenario(repo, revision, scenario) {
  if (scenario.id === "new-behavior") {
    const pricing = await importPricing(repo);
    return pricing.discountFor("platinum") === 25;
  }
  if (scenario.id === "bug-fix") {
    const pricing = await importPricing(repo);
    return pricing.discountFor("silver") === 10;
  }
  if (scenario.id === "deletion") {
    const pricing = await importPricing(repo);
    return !("legacyDiscount" in pricing);
  }
  if (scenario.id === "refactor") {
    const pricing = await importPricing(repo);
    const source = await readFile(join(repo, "src", "pricing.mjs"), "utf8");
    const duplicatedFormula = source.match(
      /subtotal\s*\*\s*\(\s*1\s*-\s*discountFor\(tier\)\s*\/\s*100\s*\)/gu,
    );
    return (
      pricing.checkoutTotal(100, "gold") === 80 &&
      pricing.renewalTotal(100, "silver") === 90 &&
      (duplicatedFormula?.length ?? 0) <= 1
    );
  }
  if (scenario.id === "config-docs") {
    const config = JSON.parse(
      await readFile(join(repo, "config", "pricing.json"), "utf8"),
    );
    const readme = await readFile(join(repo, "README.md"), "utf8");
    return config.maximumPromotionPercent === 25 && /25%/u.test(readme);
  }
  if (scenario.id === "large-shared-contract") {
    const specRoot = join(repo, ".scratch", "specs");
    const specs = await listFiles(specRoot);
    const specBodies = await Promise.all(
      specs
        .filter((file) => file.endsWith(".md"))
        .map((file) => readFile(join(specRoot, file), "utf8")),
    );
    const productionDiff = await collectProcess(
      "git",
      ["diff", "--quiet", revision, "--", "src", "test", "config", "package.json"],
      { cwd: repo },
    );
    const productionUntracked = await mustRun(
      "git",
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "src",
        "test",
        "config",
        "package.json",
      ],
      { cwd: repo },
    );
    return (
      specBodies.some(intentLayerSpecPassed) &&
      productionDiff.code === 0 &&
      productionUntracked.trim() === ""
    );
  }
  return false;
}

async function changeStats(repo, revision) {
  const numstat = await mustRun("git", ["diff", "--numstat", revision, "--"], {
    cwd: repo,
  });
  const changed = new Map();
  for (const line of numstat.split(/\r?\n/u)) {
    if (line === "") continue;
    const [added, deleted, file] = line.split("\t");
    changed.set(file, {
      added: added === "-" ? 0 : Number(added),
      deleted: deleted === "-" ? 0 : Number(deleted),
    });
  }
  const untrackedRaw = await mustRun(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: repo },
  );
  for (const file of untrackedRaw.split("\0").filter(Boolean)) {
    const content = await readFile(join(repo, file), "utf8").catch(() => "");
    changed.set(file, {
      added: content === "" ? 0 : content.split(/\r?\n/u).length,
      deleted: 0,
    });
  }
  const files = [...changed.keys()];
  return {
    filesChanged: files.length,
    linesAdded: [...changed.values()].reduce((total, item) => total + item.added, 0),
    linesDeleted: [...changed.values()].reduce((total, item) => total + item.deleted, 0),
    testFilesChanged: files.filter((file) => /(^|\/)(?:test|tests)\//u.test(file)).length,
    specFilesChanged: files.filter((file) => /(^|\/)\.scratch\/specs\//u.test(file)).length,
  };
}

async function validateFixture(repo) {
  const started = performance.now();
  const tests = await collectProcess("npm", ["test", "--silent"], {
    cwd: repo,
    timeoutMs: 60_000,
  });
  const config = await collectProcess("npm", ["run", "validate:config", "--silent"], {
    cwd: repo,
    timeoutMs: 60_000,
  });
  return {
    passed: tests.code === 0 && config.code === 0,
    wallMs: Math.round(performance.now() - started),
  };
}

export function evidencePolicyPassed(scenario, changes) {
  if (scenario.id === "new-behavior") return changes.testFilesChanged === 1;
  return changes.testFilesChanged === 0;
}

async function runOne({ scenario, repetition, model, effort, workflowRef }) {
  const prepared = await prepareFixture(scenario);
  try {
    const pluginRoot = await prepareSkillSnapshot(
      prepared.tempRoot,
      scenario,
      workflowRef,
    );
    const codex = await runCodex({
      ...prepared,
      scenario,
      model,
      effort,
      pluginRoot,
    });
    let usage;
    try {
      usage = parseCodexJsonl(codex.stdout);
    } catch {
      usage = { ...emptyUsage(), uncachedInputTokens: 0, turns: 0, items: {} };
    }
    const validation = await validateFixture(prepared.repo);
    const scenarioVerified = await verifyScenario(
      prepared.repo,
      prepared.revision,
      scenario,
    ).catch(() => false);
    const currentRevision = (
      await mustRun("git", ["rev-parse", "HEAD"], { cwd: prepared.repo })
    ).trim();
    const changes = await changeStats(prepared.repo, prepared.revision);
    const noCommit = currentRevision === prepared.revision;
    const evidencePolicy = evidencePolicyPassed(scenario, changes);
    const runnerPassed =
      codex.code === 0 && !codex.timedOut && !codex.overflow && usage.turns > 0;
    return {
      scenario: scenario.id,
      repetition,
      route: routeSummary(routeForScenario(scenario)),
      usage,
      workflowWallMs: codex.wallMs,
      verificationWallMs: validation.wallMs,
      runnerPassed,
      repositoryValidationPassed: validation.passed,
      scenarioVerified,
      evidencePolicyPassed: evidencePolicy,
      noCommit,
      changes,
      passed:
        runnerPassed &&
        validation.passed &&
        scenarioVerified &&
        evidencePolicy &&
        noCommit,
    };
  } finally {
    await rm(prepared.tempRoot, { recursive: true, force: true });
  }
}

async function fixtureDigest() {
  const hash = createHash("sha256");
  const files = (await listFiles(FIXTURE_ROOT)).sort();
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    hash.update(await readFile(join(FIXTURE_ROOT, file)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function safeVersion(command, args, cwd = ROOT) {
  const result = await collectProcess(command, args, { cwd });
  if (result.code !== 0) return "unavailable";
  return result.stdout.trim().replace(/[^a-zA-Z0-9.+_-]/gu, "-").slice(0, 80);
}

function formatMetric(item) {
  if (item === null) return "—";
  return `${Math.round(item.median)} (${Math.round(item.min)}–${Math.round(item.max)})`;
}

export function renderMarkdown(result) {
  const lines = [
    "# Workflow change baseline",
    "",
    `Generated: ${result.generatedAt}`,
    "",
    `Model: \`${result.environment.model}\`; effort: \`${result.environment.effort}\`; repetitions: ${result.environment.repetitions}.`,
    "",
    "Live values are median (min–max). Input tokens include the Codex host prompt. The large",
    "shared-contract scenario stops before the user-approval implementation gate.",
    "",
    "| Scenario | Passed | Input tokens | Uncached input | Output | Reasoning | Workflow ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const row of result.summary) {
    lines.push(
      `| ${row.scenario} | ${row.passedRuns}/${row.runs} | ${formatMetric(row.inputTokens)} | ${formatMetric(row.uncachedInputTokens)} | ${formatMetric(row.outputTokens)} | ${formatMetric(row.reasoningOutputTokens)} | ${formatMetric(row.workflowWallMs)} |`,
    );
  }
  lines.push(
    "",
    "## Static footprint",
    "",
    "These are deterministic bytes and words, not estimated tokens.",
    "",
    "| Scenario | Declared words | Declared bytes | Pre-approval words | Pre-approval bytes |",
    "| --- | ---: | ---: | ---: | ---: |",
  );
  for (const row of result.static) {
    lines.push(
      `| ${row.scenario} | ${row.declared.totalWords} | ${row.declared.totalUtf8Bytes} | ${row.preApproval.totalWords} | ${row.preApproval.totalUtf8Bytes} |`,
    );
  }
  lines.push(
    "",
    "Raw events, prompts, model messages, commands, source, diffs, paths, and thread identifiers",
    "were not retained. Use the JSON artifact for per-run numeric results and validation flags.",
    "",
  );
  return lines.join("\n");
}

function selectedScenarios(ids) {
  if (ids.length === 0) return [...SCENARIOS];
  const selected = ids.map((id) => SCENARIOS.find((scenario) => scenario.id === id));
  const missing = ids.filter((_, index) => selected[index] === undefined);
  if (missing.length > 0) throw new Error(`Unknown scenario: ${missing.join(", ")}`);
  return selected;
}

function parseCli(args) {
  const command = args[0] ?? "help";
  const options = {
    command,
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
    repetitions: DEFAULT_REPETITIONS,
    scenarios: [],
  };
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (
      [
        "--model",
        "--effort",
        "--repetitions",
        "--output",
        "--scenario",
        "--workflow-ref",
      ].includes(arg)
    ) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--scenario") options.scenarios.push(value);
      else if (arg === "--repetitions") options.repetitions = Number(value);
      else if (arg === "--workflow-ref") options.workflowRef = value;
      else options[arg.slice(2)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  if (!EFFORTS.has(options.effort)) throw new Error(`Unsupported effort: ${options.effort}`);
  return options;
}

function help() {
  return [
    "Usage:",
    "  node scripts/workflow-change-baseline.mjs static [--output FILE] [--scenario ID]",
    "  node scripts/workflow-change-baseline.mjs run --output FILE [options]",
    "",
    "Live options:",
    `  --model MODEL          Default: ${DEFAULT_MODEL}`,
    `  --effort EFFORT        Default: ${DEFAULT_EFFORT}`,
    `  --repetitions N        Default: ${DEFAULT_REPETITIONS}`,
    "  --scenario ID          Repeat to select scenarios",
    "  --workflow-ref REF     Read committed skills from REF; default: working tree",
    "  --output FILE          Required for live runs; JSON plus adjacent Markdown",
    "",
    `Scenario IDs: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}`,
  ].join("\n");
}

async function writeResult(output, result, { markdown = false } = {}) {
  const absolute = resolve(output);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, `${JSON.stringify(result, null, 2)}\n`);
  if (markdown) {
    const markdownPath = absolute.endsWith(".json")
      ? `${absolute.slice(0, -5)}.md`
      : `${absolute}.md`;
    await writeFile(markdownPath, renderMarkdown(result));
  }
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  if (options.help || options.command === "help") {
    console.log(help());
    return;
  }
  const scenarios = selectedScenarios(options.scenarios);
  if (options.command === "static") {
    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      workflowSource: options.workflowRef ?? "working-tree",
      static: await buildStaticBaseline(scenarios, {
        workflowRef: options.workflowRef,
      }),
    };
    assertSourceFreeResult(result);
    if (options.output === undefined) console.log(JSON.stringify(result, null, 2));
    else await writeResult(options.output, result);
    return;
  }
  if (options.command !== "run") throw new Error(`Unknown command: ${options.command}`);
  if (options.output === undefined) throw new Error("Live runs require --output FILE");

  const runs = [];
  for (const scenario of scenarios) {
    for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
      console.error(
        `[baseline] ${scenario.id} ${repetition}/${options.repetitions}`,
      );
      runs.push(
        await runOne({
          scenario,
          repetition,
          model: options.model,
          effort: options.effort,
          workflowRef: options.workflowRef,
        }),
      );
    }
  }
  const result = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: {
      model: options.model,
      effort: options.effort,
      repetitions: options.repetitions,
      codexVersion: await safeVersion("codex", ["--version"]),
      workflowRevision: await safeVersion("git", [
        "rev-parse",
        options.workflowRef ?? "HEAD",
      ]),
      workflowSource: options.workflowRef ?? "working-tree",
      fixtureSha256: await fixtureDigest(),
      rawEventsRetained: false,
      largeScenarioMode: "pre-approval",
    },
    static: await buildStaticBaseline(scenarios, {
      workflowRef: options.workflowRef,
    }),
    runs,
    summary: aggregateRuns(runs),
  };
  assertSourceFreeResult(result);
  await writeResult(options.output, result, { markdown: true });
  console.log(resolve(options.output));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
