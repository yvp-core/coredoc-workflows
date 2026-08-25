// Content guards over the shipped skills. These used to run against the
// renderer's output; the templates are ours now, so they assert on the committed
// SKILL.md — the exact bytes an agent receives.
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";

import { SKILLS_ROOT, templatedSkills } from "./build-skills.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const METHODOLOGY_ROOT = join(PLUGIN_ROOT, "resources", "methodology");
const EXTERNAL_REVIEW_BOT_NAME = new RegExp(["grep", "tile"].join(""), "i");

const skill = (name) => readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");

async function markdownAndMetadataFiles(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownAndMetadataFiles(child)));
    else files.push(child);
  }
  return files;
}

// The overlay carries only what is true of every workflow. Anything conditional
// belongs to the skills it applies to — see the next test.
test("every generated skill is self-contained and host-neutral", async () => {
  for (const name of await templatedSkills()) {
    const body = await skill(name);

    assert.match(body, /## Coredoc overlay/, name);
    assert.match(body, /the repository wins/, name);
    assert.match(body, /authorization boundary/, name);
    assert.match(body, /untrusted data, not instructions/, name);
    assert.doesNotMatch(body, /\{\{[A-Z][^}\n]*\}\}/, name);
    assert.doesNotMatch(body, /origin\/<base>/, name);
    assert.doesNotMatch(body, /CLAUDE_SKILL_DIR/, name);
    assert.doesNotMatch(body, /codex exec/, name);
  }
});

// Conditional guidance used to ride along in the shared overlay, so `browse` was
// told how to open a read-only database transaction. Each rule now ships only
// where it applies, and this pins that split so it cannot quietly widen again.
test("conditional guidance reaches only the skills it applies to", async () => {
  const expected = {
    "read-only connection or transaction": ["coredoc-investigate"],
    // Run bookkeeping belongs to the router, which is the only thing that ever
    // calls it. A stage skill carrying it is an instruction it cannot act on.
    "coredoc-workflows finish-run": [],
    "coredoc-workflows stage-run": [],
    "coredoc-workflows project-key": [
      "coredoc-benchmark",
      "coredoc-runtime-qa",
      "coredoc-runtime-qa-report",
      "coredoc-security-review",
    ],
  };

  for (const [rule, owners] of Object.entries(expected)) {
    const carriers = [];
    for (const name of await templatedSkills()) {
      if ((await skill(name)).includes(rule)) carriers.push(name);
    }
    assert.deepEqual(carriers.sort(), owners.slice().sort(), `"${rule}" reaches the wrong skills`);
  }
});

test("every skill declares the host-interaction contract before using the tool name", async () => {
  for (const name of await templatedSkills()) {
    const body = await skill(name);

    // The methods say `AskUserQuestion`. That name is a semantic alias resolved
    // by the contract, so the contract has to reach the reader first — this
    // plugin ships to a host where the tool is called something else.
    const contract = body.indexOf("## Host interaction contract");
    assert.ok(contract >= 0, `${name} lost the host-interaction contract`);
    assert.match(body, /request_user_input/, name);

    const firstBareUse = body.indexOf("AskUserQuestion", contract + 1);
    if (firstBareUse >= 0) {
      assert.ok(contract < firstBareUse, `${name} uses the tool name before defining it`);
    }
    assert.doesNotMatch(body, /Claude Code's user-input tool/, name);
  }
});

test("prompt-facing files carry no upstream product coupling", async () => {
  const paths = [
    ...(await markdownAndMetadataFiles(join(PLUGIN_ROOT, "skills"))),
    ...(await markdownAndMetadataFiles(join(PLUGIN_ROOT, "resources"))),
    ...(await markdownAndMetadataFiles(join(PLUGIN_ROOT, "agents"))),
    join(PLUGIN_ROOT, "README.md"),
    join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"),
    join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"),
  ];

  for (const path of paths) {
    const contents = await readFile(path, "utf8");
    assert.doesNotMatch(contents, /gstack|gbrain/i, path);
    assert.doesNotMatch(contents, /~\/\.gstack/, path);
  }
});

test("distribution manifests share one release version with an optional Codex cachebuster", async () => {
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
});

// A skill that tells the agent to read a file which does not exist burns a turn
// and then proceeds without the content. The plan-review method shipped exactly
// that for a while: it pointed at `sections/review-sections.md`, a build-time
// input that is inlined into the output and has never existed as a shipped path.
test("every plugin path a skill tells the agent to read actually exists", async () => {
  const skills = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const missing = [];
  for (const name of skills) {
    const body = await readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");

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

test("investigation keeps root-cause discipline", async () => {
  assert.match(
    await skill("coredoc-investigate"),
    /NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST/,
  );
});

test("review preserves evidence gates and independent passes while staying read-only", async () => {
  const body = await skill("coredoc-review");

  assert.match(body, /Review is read-only/);
  assert.match(body, /<plugin-root>\/resources\/review-checklist\.md/);
  assert.match(body, /Every finding MUST include a confidence score \(1-10\)/);
  assert.match(body, /Pre-emit verification gate/);
  assert.match(body, /Framework-meta nudge/);
  assert.match(body, /PLAN COMPLETION AUDIT/);
  assert.match(body, /Review Army — targeted specialist dispatch/);
  assert.match(body, /Review-history preflight and cross-review convergence/);
  assert.match(body, /Independent adversarial subagent/);
  assert.match(body, /subagent-dispatch\.md/);
  assert.match(body, /coredoc-workflows:coredoc-reviewer/);
  assert.doesNotMatch(body, /AUTO-FIX items are applied directly/);
  assert.doesNotMatch(body, /Fix-First/);
  assert.doesNotMatch(body, /git fetch origin/);
  assert.doesNotMatch(body, EXTERNAL_REVIEW_BOT_NAME);
});

test("review resolves repository assurance policy before applying its fallback", async () => {
  const [body, planBody, policy, contract, specialists, adversarial, dedup, dispatch, coverage] = await Promise.all([
    skill("coredoc-review"),
    skill("coredoc-plan-review"),
    readFile(join(METHODOLOGY_ROOT, "review-policy.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "finding-contract.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "review-specialists.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "adversarial-review.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "cross-review-dedup.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "subagent-dispatch.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "test-coverage-plan.md"), "utf8"),
  ]);

  assert.match(policy, /exact heading\s+`## Review policy`/i);
  assert.match(policy, /repository instructions/i);
  assert.match(policy, /task-scoped maintainer decision/i);
  assert.match(policy, /every materially affected risk domain/i);
  assert.match(policy, /NEEDS_CONTEXT/);
  assert.match(policy, /main findings/i);
  assert.match(policy, /one concrete question/i);
  assert.match(policy, /including making every P2\s+blocking/i);
  assert.doesNotMatch(policy, /startup|enterprise/i);

  assert.match(contract, /P0.*P1.*P2.*P3.*HYPOTHESIS/s);
  assert.match(contract, /reachable supported runtime path/i);
  assert.match(contract, /release context/i);
  assert.match(body, /Finding contract/);
  for (const [name, generated] of [
    ["coredoc-review", body],
    ["coredoc-plan-review", planBody],
  ]) {
    const policyIndex = generated.indexOf("## Review policy");
    const contractIndex = generated.indexOf("## Finding contract");
    assert.ok(policyIndex >= 0, `${name} lost review-policy resolution`);
    assert.ok(policyIndex < contractIndex, `${name} applies the finding contract before resolving policy`);
  }

  assert.match(specialists, /every materially\s+affected risk domain/i);
  assert.doesNotMatch(specialists, /at most two specialists/i);
  assert.match(specialists, /finding contract content/i);
  assert.doesNotMatch(specialists, /PR Quality Score/);
  assert.doesNotMatch(specialists, /Boost confidence by/);
  assert.match(adversarial, /resolved review policy/i);
  assert.match(adversarial, /diff size alone (?:never activates|does not activate)/i);
  assert.match(adversarial, /concrete adversarial\s+signals.*Generic fallback/is);
  assert.match(coverage, /declared numeric\s+or compliance coverage gate/i);
  assert.match(dedup, /targeted evidence verification is always permitted/i);
  assert.match(dedup, /recorded evidence is disproved|disproves recorded evidence/i);
  assert.match(dedup, /only after a maintainer explicitly accepts that handoff/i);
  assert.match(dedup, /retain it in\s+the handoff and final-verdict accounting/i);
  assert.match(dedup, /accepted-risk.*unblocks\s+only when the maintainer/is);
  assert.match(dedup, /deferred.*never unblocks a blocking finding/is);
  assert.match(dedup, /explicitly requested independent review or re-review/i);
  assert.match(dedup, /look for the PR\s+description or named review report/i);
  assert.match(dedup, /review history (?:as )?unknown/i);
  assert.doesNotMatch(dedup, /ask for that existing\s+handoff and stop/i);
  assert.match(
    dedup,
    /before the scope audit, full-diff review, specialist dispatch/i,
  );
  assert.match(dedup, /clean\/dirty state/i);
  assert.match(dedup, /deterministic\s+fingerprint of the\s+reviewed tracked patch/i);
  assert.match(dedup, /Matching base\/head is insufficient when either tree is dirty/i);
  const reviewPreflight = body.indexOf("### Review-history preflight");
  const reviewScopeAudit = body.indexOf("## Step 1.5: Scope Drift Detection");
  const reviewFullDiff = body.indexOf("## Step 3: Get the diff");
  assert.ok(reviewPreflight >= 0);
  assert.ok(reviewPreflight < reviewScopeAudit);
  assert.ok(reviewPreflight < reviewFullDiff);
  assert.doesNotMatch(dispatch, /At most 3 review subagents total/i);
  assert.match(dispatch, /resolved review policy/i);
  assert.doesNotMatch(body, /quality_score/);
});

test("missing release policy never hides a source-proven candidate", async () => {
  const [body, policy, contract] = await Promise.all([
    skill("coredoc-review"),
    readFile(join(METHODOLOGY_ROOT, "review-policy.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "finding-contract.md"), "utf8"),
  ]);

  assert.match(policy, /NEEDS_CONTEXT/);
  assert.match(policy, /main findings/i);
  assert.match(policy, /one concrete question/i);
  assert.match(
    contract,
    /missing\s+(?:release context|release-policy fact).*?(?:does not make|do not demote).*?HYPOTHESIS/is,
  );
  assert.match(body, /NEEDS_CONTEXT/);
  assert.doesNotMatch(contract, /release relevance is unknown, classify the candidate\s+as HYPOTHESIS/i);
});

test("generated skills do not mix incompatible severity vocabularies", async () => {
  for (const name of await templatedSkills()) {
    const body = await skill(name);
    const calibrationStart = body.indexOf("## Confidence calibration");
    if (calibrationStart < 0) continue;
    const nextHeading = body.indexOf("\n## ", calibrationStart + 1);
    const calibration = body.slice(
      calibrationStart,
      nextHeading < 0 ? body.length : nextHeading,
    );

    if (/\*\*Severity:\*\* CRITICAL \| HIGH \| MEDIUM/.test(body)) {
      assert.doesNotMatch(calibration, /\bP0\b|\bP1\b|\bP2\b|\bP3\b|HYPOTHESIS/, name);
    } else if (/\bP0\b|\bP1\b|\bP2\b|\bP3\b/.test(body)) {
      assert.doesNotMatch(calibration, /CRITICAL|HIGH|MEDIUM|VERIFIED|UNVERIFIED|TENTATIVE/, name);
    }
  }
});

test("security review resolves policy without per-finding verifier fan-out", async () => {
  const body = await skill("coredoc-security-review");
  const policyRead = body.indexOf(
    "<plugin-root>/resources/methodology/review-policy.md",
  );
  const verification = body.indexOf("**Parallel Finding Verification:**");
  const phase12 = body.slice(body.indexOf("### Phase 12"), body.indexOf("### Phase 13"));
  const importantRules = body.slice(body.indexOf("## Important Rules"));
  const findingsTable = body.slice(
    body.indexOf("**Findings table:**"),
    body.indexOf("## Confidence calibration"),
  );

  assert.ok(policyRead >= 0, "security review lost its policy seam");
  assert.ok(policyRead < verification, "security review dispatches before resolving policy");
  assert.match(body, /deduplicate candidates by root cause/i);
  assert.match(body, /group related candidates by trust\s+boundary/i);
  assert.match(body, /Concurrency only batches work; it never increases\s+reviewer count/i);
  assert.doesNotMatch(body, /For each candidate finding, launch/i);
  assert.doesNotMatch(body, /Launch all verifiers in parallel/i);
  assert.doesNotMatch(body, /9\/10\s+UNVERIFIED/i);
  assert.doesNotMatch(body, /Below 8: Do not report/i);
  assert.doesNotMatch(body, /Confidence gate is absolute/i);
  assert.match(phase12, /ordinary findings at confidence 8-10/i);
  assert.match(phase12, /NEEDS_CONTEXT.*confidence 7-10.*main\s+findings/is);
  assert.match(phase12, /VERIFIED.*7-10.*does not itself pass the daily report gate/is);
  assert.match(phase12, /UNVERIFIED.*5-6.*comprehensive mode only/is);
  assert.match(phase12, /TENTATIVE.*2-4/is);
  assert.match(phase12, /do not provide the initial title, severity,\s*confidence, exploit narrative, or scanner rationale/is);
  assert.match(phase12, /reconstruct any claim from code rather than rubber-stamp/is);
  assert.match(phase12, /daily ordinary findings require 8\+.*NEEDS_CONTEXT.*requires 7\+.*comprehensive findings require 2\+/is);
  assert.doesNotMatch(phase12, /Discard findings where the verifier scores below 8/i);
  assert.doesNotMatch(importantRules, /Confidence gate is absolute|below 8\/10 = do not report\. Period/i);
  assert.match(findingsTable, /Audit phase/i);
  assert.doesNotMatch(findingsTable, /\bP\d+\b/);
  assert.match(body, /\* \*\*Status:\*\* NEEDS_CONTEXT/);
  assert.match(body, /\* \*\*Question:\*\* \[exactly one concrete question/i);
  assert.match(body, /main findings/i);
});

// The fix offer is the one authorized edit path. It has to stay an offer: a
// re-harvest that reintroduces unattended fixing would look like a convenience
// win and would silently drop the read-only guarantee the rest of this file
// pins down.
test("review offers fixes by explicit selection and never applies them unasked", async () => {
  const body = await skill("coredoc-review");

  assert.match(body, /## Step 6: Fix offer/);
  assert.match(body, /multiSelect: true/);
  assert.match(body, /batches of at most three findings/);
  assert.match(body, /A ticked finding is the explicit request to address it/);
  assert.match(body, /An unticked finding is declined/);
  assert.match(body, /Do not commit\./);
  // gstack's Step 5b applied informational fixes without asking.
  assert.doesNotMatch(body, /Apply each fix directly/);
  assert.doesNotMatch(body, /Auto-fix all/);
});

// The cross-model pass sends approved content to another provider and spends
// that provider's budget. Detection is never permission; the adapter is chosen
// by host so a model family does not review itself.
test("cross-model pass asks before egress and never reviews with its own family", async () => {
  const body = await skill("coredoc-review");

  assert.match(body, /## Step 4\.7: Cross-model pass \(conditional\)/);
  assert.match(body, /opt-in per review/);
  assert.match(body, /installed CLI detection is never permission/);
  assert.match(body, /The preflight passing is not permission/);
  assert.match(body, /Ask once with `AskUserQuestion`/);
  assert.match(body, /Never call the provider family already\s+running the review/);
  assert.match(body, /make exactly one call/);
  assert.match(body, /Cross-model pass skipped/);
  assert.match(body, /never fan out to a third provider/);
  assert.match(body, /Do not add a reviewer merely to compensate for\s+the failed provider pass/i);
  // Skipping is a real answer, not a prompt to re-ask until the user relents.
  assert.match(body, /A skip\s+is complete/);
  assert.match(body, /bin\/coredoc-workflows codex-peer/);
  assert.match(body, /bin\/coredoc-workflows claude-peer/);
  assert.match(body, /artifact-only boundary/);
  assert.match(body, /refuses a base review when non-ignored untracked files/);
  assert.doesNotMatch(body, /snapshot MCP|PreToolUse guard/i);
});

test("specialist leaves defer selection and blocking to repository policy", async () => {
  const names = ["testing", "performance", "security", "api-contract", "data-migration"];
  for (const name of names) {
    const body = await readFile(
      join(PLUGIN_ROOT, "resources", "review-specialists", `${name}.md`),
      "utf8",
    );
    assert.match(body, /resolved Review policy decides both/i, name);
    assert.match(body, /evidence guidance, not a policy override/i, name);
    assert.doesNotMatch(body, /Selection: only when/i, name);
  }

  const testing = await readFile(
    join(PLUGIN_ROOT, "resources", "review-specialists", "testing.md"),
    "utf8",
  );
  assert.match(testing, /declared numeric or compliance coverage gate/i);
});

test("provider adapters are explicit-only, bounded, and resumable", async () => {
  const expected = {
    "coredoc-claude": {
      peer: /Claude/,
      boundary: /Built-in tools are disabled/,
      runner: /bin\/coredoc-workflows claude-peer/,
    },
    "coredoc-codex": {
      peer: /Codex/,
      boundary: /disables execution, browser, app, plugin, skill, and delegation features/,
      runner: /bin\/coredoc-workflows codex-peer/,
    },
  };

  for (const [name, checks] of Object.entries(expected)) {
    const body = await skill(name);
    const metadata = await readFile(join(SKILLS_ROOT, name, "agents", "openai.yaml"), "utf8");
    assert.match(body, /only after an explicit user request/, name);
    assert.match(body, checks.peer, name);
    assert.match(body, checks.boundary, name);
    assert.match(body, checks.runner, name);
    assert.match(body, /--action review/, name);
    assert.match(body, /--action new/, name);
    assert.match(body, /--action continue/, name);
    assert.match(body, /--action status/, name);
    assert.match(body, /--action reset/, name);
    assert.match(body, /~\/\.coredoc\/<project-key>\/state\/cross-model\/v2\//, name);
    assert.match(body, /Artifact grounding is the only supported boundary/, name);
    assert.doesNotMatch(body, /--grounding repo/, name);
    assert.match(metadata, /allow_implicit_invocation: false/, name);
  }
});

test("review delivery contains no external review-bot integration", async () => {
  const paths = [
    join(SKILLS_ROOT, "coredoc-review", "SKILL.md.tmpl"),
    join(PLUGIN_ROOT, "resources", "review-checklist.md"),
    ...(await markdownAndMetadataFiles(join(PLUGIN_ROOT, "resources", "review-specialists"))),
    join(PLUGIN_ROOT, "scripts", "build-skills.mjs"),
  ];

  for (const path of paths) {
    assert.doesNotMatch(await readFile(path, "utf8"), EXTERNAL_REVIEW_BOT_NAME, path);
  }
});

test("plugin agents right-size models and keep review output dispatch-defined", async () => {
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
    assert.match(definition, /Do not (?:spawn|delegate to) subagents/i, name);
  }

  for (const name of ["coredoc-implementer.md", "coredoc-implementer-light.md"]) {
    const definition = await readFile(join(PLUGIN_ROOT, "agents", name), "utf8");
    assert.match(definition, /^tools: Read, Write, Edit, Glob, Grep, Bash$/m);
    assert.doesNotMatch(definition, /^tools:.*\bAgent\b/m);
  }

  const reviewer = await readFile(join(PLUGIN_ROOT, "agents", "coredoc-reviewer.md"), "utf8");
  assert.match(reviewer, /dispatch prompt defines the output format/i);
});

test("router and TDD skills preserve the large-change approval lifecycle", async () => {
  const [router, tdd, dispatch] = await Promise.all([
    skill("coredoc-workflows"),
    skill("coredoc-tdd"),
    readFile(join(METHODOLOGY_ROOT, "subagent-dispatch.md"), "utf8"),
  ]);

  assert.match(router, /--scale large/);
  assert.match(router, /gate: `user-approval`/);
  assert.match(router, /Do not run `coredoc-workflows finish-run` while paused/);
  assert.match(router, /runStateStatus/);
  assert.match(router, /fails closed/);
  assert.match(router, /same host session/i);
  assert.match(router, /new session/i);
  assert.match(router, /abandoned/i);
  assert.match(router, /up to three/i);
  assert.match(router, /capability-missing/);
  // Qualitative feedback leaves a run through the tool contract, never through a
  // skill this plugin does not own: a host may have the graph MCP server without
  // the plugin that ships that skill, or the plugin without the server.
  assert.doesNotMatch(router, /coredoc-feedback/);
  assert.match(router, /feedbackOwed/);
  assert.match(router, /submit_session_feedback/);
  assert.match(router, /never by a skill name/);
  assert.match(tdd, /acceptance criteria/i);
  assert.match(tdd, /Over-scope gate/);
  assert.match(tdd, /existing implementation/i);
  assert.match(tdd, /subagent-dispatch\.md/);
  assert.match(dispatch, /fan-out cap/i);
  assert.match(dispatch, /At most 5 concurrent non-review subagents/i);
  assert.match(dispatch, /At most 4 read-only scouts/i);
  assert.match(dispatch, /host(?:'s)? lower concurrency\s+limit/i);
  assert.match(dispatch, /independent tool calls/i);
  assert.match(dispatch, /parallel/i);
  assert.match(dispatch, /disjoint file ownership/i);
});

test("router owns exact task attribution and explicit stage capture boundaries", async () => {
  const [router, readme] = await Promise.all([
    skill("coredoc-workflows"),
    readFile(join(PLUGIN_ROOT, "README.md"), "utf8"),
  ]);

  // The flag stays in the CLI and wire contract for programmatic task-owning
  // callers, but an LLM composing a canonical ID is a fabrication surface: the
  // packaged skill prohibits the flag instead of teaching it.
  assert.match(router, /Never pass\s+`--task-id`/i);
  assert.match(router, /programmatic task-owning invokers/i);
  assert.match(router, /must never be forwarded/i);
  assert.doesNotMatch(router, /Add the optional\s+`--task-id/i);
  assert.match(
    router,
    /Run stage boundary commands sequentially: never batch\s+them in parallel/i,
  );
  assert.match(
    router,
    /coredoc-workflows stage-run start --stage-id <stage-id>.*immediately before.*actual routed stage work/is,
  );
  assert.match(
    router,
    /coredoc-workflows stage-run finish --stage-id <stage-id> --outcome <success\|failed\|blocked>/i,
  );
  assert.match(router, /Only one stage occurrence may be open/i);
  assert.match(router, /DONE.*DONE_WITH_CONCERNS.*success.*BLOCKED.*blocked/is);
  assert.match(
    router,
    /NEEDS_CONTEXT.*finish.*blocked.*keep the run open.*restart the same stage.*next attempt/is,
  );
  assert.match(
    router,
    /close the design stage.*before pausing.*start the gated TDD stage only after\s+approval/is,
  );
  assert.match(
    router,
    /runStateStatus`.*`unattributed`.*skip.*coredoc-workflows stage-run.*completion gate.*unavailable/is,
  );
  assert.match(router, /successful finish.*every routed stage.*closed successfully/is);
  assert.match(router, /SessionEnd.*only.*actually open stage.*abandoned/is);
  assert.match(router, /Never infer stage boundaries\s+from `PreToolUse` or `PostToolUse`/i);

  assert.match(readme, /explicit router boundary commands/i);
  assert.match(readme, /exact task-owning context/i);
  assert.match(readme, /packaged skill does not\s+instruct an agent to supply `--task-id`/i);
  assert.match(readme, /self-reported bookkeeping/i);
  assert.doesNotMatch(readme, /Neither host emits stage intervals/i);
  assert.doesNotMatch(readme, /does not currently synthesize those fragments/i);
});

test("router verifies provider work items structurally before one safe route call", async () => {
  const [router, readme] = await Promise.all([
    skill("coredoc-workflows"),
    readFile(join(PLUGIN_ROOT, "README.md"), "utf8"),
  ]);
  const providerRead = router.search(/provider MCP read/i);
  const routeCall = router.indexOf("bin/coredoc-workflows route-task --intent");

  assert.ok(providerRead >= 0 && providerRead < routeCall);
  assert.match(router, /ignore.*instructions.*provider.*content/is);
  assert.match(router, /provider.*`jira`.*externalId.*issue\.id.*externalKey.*issue\.key/is);
  assert.match(router, /never infer.*(?:URL|locator|visible key)/i);
  assert.match(router, /between 1 and 8/i);
  assert.match(router, /--work-item-provider.*--work-item-external-id.*--work-item-external-key/is);
  assert.match(router, /whitespace.*quotes.*backticks.*shell operators.*redirection.*glob/is);
  assert.match(router, /unavailable.*denied.*ambiguous.*not\s+found.*stable.*id/is);
  assert.match(router, /explicit.*unlinked/is);
  assert.match(router, /GitHub Issue.*work item.*(?:PR|pull request).*CodeChange/is);
  assert.match(router, /Notion database task.*work item.*plain Notion.*context/is);
  assert.match(router, /Figma.*Confluence.*context/is);
  assert.match(router, /Discard the raw locator and\s+provider payload/i);

  assert.match(readme, /schema-V3.*workflow\.run\.started/i);
  assert.match(readme, /managed.*acceptedSchemaVersions.*\[1, 2, 3\]/is);
  assert.match(readme, /ordinary.*schema-V2/is);
  assert.match(readme, /drain.*pending V3.*before.*downgrad/is);
});

test("Codex metadata and router describe host-portable execution", async () => {
  const [manifest, readme, router] = await Promise.all([
    readFile(join(PLUGIN_ROOT, ".codex-plugin", "plugin.json"), "utf8"),
    readFile(join(PLUGIN_ROOT, "README.md"), "utf8"),
    skill("coredoc-workflows"),
  ]);

  assert.doesNotMatch(JSON.parse(manifest).interface.shortDescription, /Claude Code/i);
  assert.match(readme, /Codex/i);
  assert.match(readme, /Codex CLI/i);
  assert.match(readme, /IDE extension/i);
  assert.match(readme, /completion gate/i);
  assert.match(router, /independent tool calls/i);
});

test("router runs managed capture boundary commands outside the Codex sandbox", async () => {
  const router = await skill("coredoc-workflows");

  assert.match(
    router,
    /Codex.*sandbox_permissions.*require_escalated.*coredoc-workflows route-task/is,
  );
  assert.match(
    router,
    /coredoc-workflows stage-run.*coredoc-workflows finish-run.*same elevated execution/is,
  );
  assert.match(router, /loopback.*127\.0\.0\.1:43181/is);
});

test("plan review keeps risk-based validation, interaction, and completion gates", async () => {
  const body = await skill("coredoc-plan-review");

  assert.match(body, /Anti-shortcut clause/);
  assert.match(body, /Test Framework Detection/);
  assert.match(body, /Trace accepted runtime paths/);
  assert.match(body, /Choose the smallest meaningful layer/);
  assert.match(body, /Implementation Tasks/);
  assert.match(body, /Plan review completion gate/);
  assert.match(body, /reachable/i);
  assert.match(body, /accepted scenarios and invariants/i);
  assert.doesNotMatch(body, /100% coverage is the goal/);
  assert.doesNotMatch(body, /DRY violations—be aggressive/);
  assert.doesNotMatch(body, /Build it now in this PR/);
});

test("spec defaults to a local final artifact without spawning or remote filing", async () => {
  const body = await skill("coredoc-spec");

  assert.match(body, /Deliver the specification/);
  assert.match(body, /requires explicit user authorization/);
  assert.doesNotMatch(body, /gh issue create/);
  assert.doesNotMatch(body, /Spawn the agent/);
});

test("browser workflows retain the bundled macOS ARM fallback", async () => {
  for (const name of [
    "coredoc-runtime-qa",
    "coredoc-runtime-qa-report",
    "coredoc-benchmark",
    "coredoc-browse",
  ]) {
    const body = await skill(name);
    assert.match(body, /bin\/coredoc-workflows browse/, name);
    assert.match(body, /macOS ARM/, name);
  }
});

test("QA selects the real Electron surface without reading credentials", async () => {
  for (const name of ["coredoc-runtime-qa", "coredoc-runtime-qa-report"]) {
    const body = await skill(name);
    assert.match(body, /bin\/coredoc-workflows coredoc-desktop/, name);
    assert.match(body, /generic `electron-qa` workflow/, name);
    assert.match(body, /COREDOC_DESKTOP_QA_PORT=9333/, name);
    assert.match(body, /Opening its renderer URL in Chrome is not a\s+valid substitute/, name);
    assert.match(body, /Never inspect,[\s\S]*decrypt, copy, or print credential files/, name);
  }
});

test("QA keeps the full exploration model without default report persistence", async () => {
  for (const name of ["coredoc-runtime-qa", "coredoc-runtime-qa-report"]) {
    const body = await skill(name);

    assert.match(body, /\| Output \| Conversation \|/, name);
    assert.match(body, /Use a temporary evidence directory/, name);
    assert.match(body, /Per-page exploration checklist/i, name);
    assert.match(body, /qa-issue-taxonomy\.md/, name);
    assert.match(body, /qa-report-template\.md/, name);
    assert.match(body, /Health Score Rubric/, name);
    assert.doesNotMatch(body, /REPORT_DIR="\$COREDOC_WORKFLOW_CACHE\/qa-reports"/, name);
  }

  const fixCapable = await skill("coredoc-runtime-qa");
  assert.match(fixCapable, /Authorized bootstrap implementation/);
  assert.match(fixCapable, /Regression-test quality/);
});

test("browser snapshot guidance preserves ref semantics and invalidation", async () => {
  const body = await skill("coredoc-browse");

  assert.match(body, /`@e` and `@c` references use separate numbering/);
  assert.match(body, /References are invalidated by navigation/);
  assert.match(body, /snapshot -D/);
});
