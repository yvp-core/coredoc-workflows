// Contract checks over the shipped skills (ADR 0004). They read the committed
// SKILL.md, the exact bytes an agent receives, and the References it is pointed
// at. Each assertion matches a path, an invocation, or a vocabulary that code, a
// host, the router or an eval grader parses, never a sentence, so any rewrite
// that keeps the meaning keeps them green.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";

import { SKILLS_ROOT } from "./build-skills.mjs";
import { parseBridgeArgs } from "./cross-model-runtime.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const METHODOLOGY_ROOT = join(PLUGIN_ROOT, "resources", "methodology");

const skill = (name) => readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
const method = (file) => readFile(join(METHODOLOGY_ROOT, file), "utf8");

async function allSkills() {
  return (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

// Every skill ships to both hosts. An unexpanded token or a one-host identifier is
// an instruction the other host cannot follow.
test("no skill ships an unexpanded partial token or a host-specific identifier", async () => {
  for (const name of await allSkills()) {
    const body = await skill(name);

    assert.doesNotMatch(body, /\{\{[A-Z][^}\n]*\}\}/, name);
    assert.doesNotMatch(body, /CLAUDE_SKILL_DIR/, name);
    assert.doesNotMatch(body, /codex\s+exec/, name);
    // `AskUserQuestion` is Claude Code's tool name. A skill may use it only as the
    // alias its host contract maps to Codex's `request_user_input`.
    if (body.includes("AskUserQuestion")) assert.match(body, /request_user_input/, name);
  }
});

// Each plugin CLI subcommand and exactly the skills that run it. A skill outside
// its list carries an instruction it cannot act on (run bookkeeping belongs to the
// router, the only thing that ever calls it); an owner missing from the carriers
// has lost the invocation it needs.
const CLI_CARRIERS = {
  "route-task": ["coredoc-workflows"],
  "stage-run": ["coredoc-workflows"],
  "finish-run": ["coredoc-workflows"],
  "run-status": ["coredoc-workflows"],
  spec: ["coredoc-workflows"],
  "project-key": [
    "coredoc-benchmark",
    "coredoc-runtime-qa",
    "coredoc-runtime-qa-report",
    "coredoc-security-review",
  ],
  browse: [
    "coredoc-benchmark",
    "coredoc-browse",
    "coredoc-runtime-qa",
    "coredoc-runtime-qa-report",
  ],
  "coredoc-desktop": ["coredoc-desktop", "coredoc-runtime-qa", "coredoc-runtime-qa-report"],
  "electron-qa": ["electron-qa"],
  "claude-peer": ["coredoc-claude"],
  "codex-peer": ["coredoc-codex"],
  "git-delivery-preflight": ["coredoc-git-delivery"],
  "redact-scan": ["coredoc-security-review"],
  "retro-evidence": ["coredoc-retro"],
  capture: ["coredoc-capture"],
};

test("plugin CLI commands appear in exactly the skills that run them", async () => {
  const dispatcher = await readFile(join(PLUGIN_ROOT, "bin", "coredoc-workflows"), "utf8");
  const names = await allSkills();
  const bodies = new Map(await Promise.all(names.map(async (name) => [name, await skill(name)])));

  for (const [name, body] of bodies) {
    for (const [, subcommand] of body.matchAll(/bin\/coredoc-workflows\s+([a-z][a-z-]*)/g)) {
      assert.ok(Object.hasOwn(CLI_CARRIERS, subcommand), `${name} runs unplaced "${subcommand}"`);
    }
  }
  for (const [subcommand, owners] of Object.entries(CLI_CARRIERS)) {
    assert.match(dispatcher, new RegExp(`^\\s+${subcommand}\\)`, "m"), `no "${subcommand}" command`);
    const command = new RegExp(`coredoc-workflows\\s+${subcommand}(?![\\w-])`);
    const carriers = names.filter((name) => command.test(bodies.get(name)));
    assert.deepEqual(carriers.sort(), owners.slice().sort(), `"${subcommand}" reaches the wrong skills`);
  }
});

// Run bookkeeping is the router's in any spelling, with or without the CLI
// prefix. The spec body only points at spec-lifecycle.md, which carries the
// closing and acceptance commands, the redaction scan among them.
test("lifecycle commands appear only in the router, in any form", async () => {
  const lifecycle = /stage-run\s+(?:start|finish)|finish-run\s+--outcome|spec\s+(?:accept|abandon)\s+--/;
  for (const name of await allSkills()) {
    if (name === "coredoc-workflows") continue;
    assert.doesNotMatch(await skill(name), lifecycle, name);
  }
  assert.doesNotMatch(await skill("coredoc-spec"), /redact-scan/);
});

// branch-start runs git fetch, pull, merge and switch. Review, investigation,
// security review and retro must not move the checkout (ADR 0003 for
// investigate), and delivery publishes exactly the commit it scanned.
test("skills that must not move the checkout never point at branch-start", async () => {
  for (const name of [
    "coredoc-review",
    "coredoc-investigate",
    "coredoc-security-review",
    "coredoc-retro",
    "coredoc-git-delivery",
  ]) {
    assert.doesNotMatch(await skill(name), /branch-start\.md/, name);
  }
});

test("distribution manifests share one release version and a host-neutral Codex description", async () => {
  const [packageJson, claudeManifest, codexManifest] = await Promise.all([
    readFile(join(PLUGIN_ROOT, "package.json"), "utf8"),
    readFile(join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"),
    readFile(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"),
  ]);

  const versions = [packageJson, claudeManifest, codexManifest].map(
    (contents) => JSON.parse(contents).version,
  );
  const [packageVersion, claudeVersion, codexVersion] = versions;
  assert.ok(packageVersion, "package.json must declare a version");
  assert.equal(claudeVersion, packageVersion);
  assert.ok(
    codexVersion === packageVersion ||
      codexVersion.startsWith(`${packageVersion}+codex.`),
    "Codex manifest must use the release version or its installer cachebuster",
  );
  assert.doesNotMatch(JSON.parse(codexManifest).interface.shortDescription, /Claude Code/i);
});

// A skill that tells the agent to read a file which does not exist burns a turn
// and then proceeds without the content. The plan-review method shipped exactly
// that for a while: it pointed at `sections/review-sections.md`, a build-time
// input that is inlined into the output and has never existed as a shipped path.
test("every plugin path a skill tells the agent to read actually exists", async () => {
  const missing = [];
  for (const name of await allSkills()) {
    const body = await skill(name);

    for (const match of body.matchAll(/<plugin-root>\/([A-Za-z0-9/._-]+)/g)) {
      const target = join(PLUGIN_ROOT, match[1]);
      if (!(await stat(target).then(() => true, () => false))) {
        missing.push(`${name}: ${match[0]}`);
      }
    }
    // Section partials are inlined at build time; a surviving path reference to
    // one means an instruction to read a file that was never shipped.
    assert.doesNotMatch(body, /sections\/[a-z-]+\.md/, `${name} points at an inlined section file`);
  }
  assert.deepEqual(missing, []);
});

// Codex reads this invocation policy; it is metadata, not prose.
test("provider adapters stay explicit-only in their Codex metadata", async () => {
  for (const name of ["coredoc-claude", "coredoc-codex"]) {
    const metadata = await readFile(join(SKILLS_ROOT, name, "agents", "openai.yaml"), "utf8");
    assert.match(metadata, /allow_implicit_invocation: false/, name);
  }
});

// The peer runner validates `--action` against its own enum; review's cross-model
// pass calls the same two runners.
test("peer skills run their provider's runner with the actions it accepts", async () => {
  const rejected = (action) => {
    try {
      parseBridgeArgs(["--action", action]);
      return false;
    } catch (error) {
      return /--action must be one of/.test(error.message);
    }
  };
  assert.ok(rejected("unknown-action"), "the runner no longer validates --action");

  for (const [name, runner] of [["coredoc-claude", "claude-peer"], ["coredoc-codex", "codex-peer"]]) {
    const body = await skill(name);
    assert.match(body, new RegExp(`bin/coredoc-workflows\\s+${runner}`), name);
    for (const action of ["review", "new", "continue", "status", "reset"]) {
      assert.match(body, new RegExp(`--action\\s+${action}\\b`), `${name}: ${action}`);
    }
    for (const [, action] of body.matchAll(/--action\s+([^\s\\`]+)/g)) {
      assert.ok(!rejected(action), `${name}: the runner rejects --action ${action}`);
    }
  }

  const pass = await method("cross-model-pass.md");
  assert.match(pass, /bin\/coredoc-workflows\s+codex-peer/);
  assert.match(pass, /bin\/coredoc-workflows\s+claude-peer/);
});

// Claude Code reads the agent frontmatter.
test("plugin agents right-size models and deny the tools their role excludes", async () => {
  const expected = {
    "coredoc-scout.md": { model: "haiku", effort: "low" },
    "coredoc-implementer.md": { model: "inherit", effort: "medium" },
    "coredoc-implementer-light.md": { model: "sonnet", effort: "low" },
    // Review quality tracks the reviewing model closely: pinning the reviewer to
    // a cheaper tier than the session measurably weakened findings against a
    // default-model run on the same diff. Reviewers inherit; only the agents
    // whose work is mechanical stay pinned down-tier.
    "coredoc-reviewer.md": { model: "inherit", effort: "medium" },
  };

  for (const [name, { model, effort }] of Object.entries(expected)) {
    const definition = await readFile(join(PLUGIN_ROOT, "agents", name), "utf8");
    assert.match(definition, new RegExp(`^model: ${model}$`, "m"), name);
    assert.match(definition, new RegExp(`^effort: ${effort}$`, "m"), name);
    assert.doesNotMatch(definition, /^maxTurns:/m, name);
  }

  for (const name of ["coredoc-implementer.md", "coredoc-implementer-light.md"]) {
    const definition = await readFile(join(PLUGIN_ROOT, "agents", name), "utf8");
    assert.match(definition, /^disallowedTools: Agent$/m);
    assert.doesNotMatch(definition, /^tools:/m, name);
  }

  // Every subagent inherits the host's tools, MCP servers included (the Coredoc
  // graph among them): a file-only allowlist made delegated grounding
  // structurally grep-only, and a `tools:` wildcard for MCP is not portable.
  // Read-only agents deny the write tools instead.
  for (const name of ["coredoc-scout.md", "coredoc-reviewer.md"]) {
    const definition = await readFile(join(PLUGIN_ROOT, "agents", name), "utf8");
    assert.match(definition, /^disallowedTools: Write, Edit, NotebookEdit, Agent$/m, name);
    assert.doesNotMatch(definition, /^tools:/m, name);
  }
});

// route-task and the stage CLI parse these invocations and the outcome enum; the
// router maps each stage's status token onto that enum. Codex has to run the
// boundary commands outside its sandbox, which denies the loopback capture relay.
test("router uses the route and stage CLI invocations and the stage status vocabulary", async () => {
  const router = await skill("coredoc-workflows");

  assert.match(
    router,
    /coredoc-workflows\s+route-task\s+--intent\s+<intent>\s+--risk\s+<risk>\s+--scale\s+<normal\|large>/,
  );
  assert.match(router, /coredoc-workflows\s+stage-run\s+start\s+--stage-id\s+<stage-id>/);
  assert.match(
    router,
    /coredoc-workflows\s+stage-run\s+finish\s+--stage-id\s+<stage-id>\s+--outcome\s+<success\|failed\|blocked>/,
  );
  for (const status of ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"]) {
    assert.match(router, new RegExp("`" + status + "`"), status);
  }
  assert.match(router, /sandbox_permissions:\s+"require_escalated"/);
});

// route-task records these values as the work item's identity and accepts any
// value, so this mapping is what keeps a visible key from being recorded as the id.
test("work-item routing maps provider identity onto the route-task flags", async () => {
  const protocol = await method("work-item-routing.md");

  assert.match(protocol, /provider=jira.*externalId=String\(issue\.id\).*externalKey=issue\.key/is);
  assert.match(protocol, /--work-item-provider.*--work-item-external-id.*--work-item-external-key/is);
});

test("spec lifecycle names the CLI invocations that close and accept a specification", async () => {
  const lifecycle = await method("spec-lifecycle.md");

  for (const invocation of [
    /stage-run\s+finish\s+--stage-id\s+spec/,
    /finish-run\s+--outcome\s+delivered-draft/,
    /spec\s+accept\s+--finish/,
    /redact-scan\s+<spec-path>/,
  ]) {
    assert.match(lifecycle, invocation);
  }
});

// The spec and PRD eval graders match these ids, the `[unverified]` marker, the
// claim verdicts and NEEDS_CONTEXT; the workflow gates read the spec's status
// frontmatter.
test("spec and PRD keep the vocabularies that graders and gates parse", async () => {
  const [spec, prd] = await Promise.all([skill("coredoc-spec"), skill("coredoc-prd")]);

  for (const id of ["UC-n", "BR-n", "LIM-n", "AC-n", "ADR-n"]) {
    assert.match(spec, new RegExp("`" + id + "`"), id);
  }
  assert.match(spec, /`status:\s+draft`/);
  assert.match(spec, /`NEEDS_CONTEXT`/);
  for (const verdict of [/\bverified\b/, /\bcontradicted\b/, /\bnot\s+verifiable\b/]) {
    assert.match(spec, verdict);
  }

  for (const id of ["G-n", "D-n", "US-n", "EC-n", "NG-n", "OQ-n"]) {
    assert.match(prd, new RegExp("`" + id + "`"), id);
  }
  assert.match(prd, /`\[unverified\]`/);
});

// The bundled browser binary parses `snapshot -D` and numbers `@e` and `@c`
// element refs separately; the desktop launcher reads COREDOC_DESKTOP_QA_PORT,
// and 9333 is the CDP port the QA surface attaches to.
test("browser and QA skills use the runtime's snapshot flag, refs and desktop port", async () => {
  const browse = await skill("coredoc-browse");
  assert.match(browse, /snapshot\s+-D\b/);
  assert.match(browse, /@e(?:\d+)?\b/);
  assert.match(browse, /@c(?:\d+)?\b/);

  for (const name of ["coredoc-runtime-qa", "coredoc-runtime-qa-report"]) {
    assert.match(await skill(name), /COREDOC_DESKTOP_QA_PORT=9333\b/, name);
  }
});

// Claude Code's Agent and AskUserQuestion tools parse these parameters: a
// background dispatch returns before the result exists, and the fix offer lets
// the user tick several findings at once.
test("host tool parameters keep the names and values the host parses", async () => {
  assert.match(await method("subagent-dispatch.md"), /run_in_background:\s*false\b/);
  assert.match(await skill("coredoc-review"), /multiSelect:\s*true\b/);
});
