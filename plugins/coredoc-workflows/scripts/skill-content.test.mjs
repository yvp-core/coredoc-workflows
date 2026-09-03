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
  const reviewFullDiff = body.indexOf("## Step 2: Inspect the change");
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
  const [body, searchBeforeBuilding] = await Promise.all([
    skill("coredoc-review"),
    readFile(join(METHODOLOGY_ROOT, "search-before-building.md"), "utf8"),
  ]);

  assert.match(body, /## Step 6: Fix offer/);
  assert.match(body, /resources\/methodology\/search-before-building\.md/);
  assert.match(searchBeforeBuilding, /reviewed work or recommended fix/i);
  assert.match(searchBeforeBuilding, /version-sensitive claim unverified/i);
  assert.match(body, /multiSelect: true/);
  assert.match(body, /batches of at most three findings/);
  assert.match(body, /A ticked finding is the explicit request to address it/);
  assert.match(body, /An unticked finding is declined/);
  assert.match(body, /Do not bundle\s+adjacent cleanup, reformatting, or a separate finding/is);
  assert.match(body, /\[FIXED\].*\[FAILED\].*\[SKIPPED\]/s);
  assert.match(body, /Do not commit\./);
  // gstack's Step 5b applied informational fixes without asking.
  assert.doesNotMatch(body, /Apply each fix directly/);
  assert.doesNotMatch(body, /Auto-fix all/);
});

// The cross-model pass sends approved content to another provider and spends
// that provider's budget. Detection is never permission; the adapter is chosen
// by host so a model family does not review itself.
test("cross-model pass asks before egress and never reviews with its own family", async () => {
  const [body, method] = await Promise.all([
    skill("coredoc-review"),
    readFile(join(METHODOLOGY_ROOT, "cross-model-pass.md"), "utf8"),
  ]);

  assert.match(body, /## Step 4\.7: Cross-model pass \(conditional\)/);
  assert.match(body, /cross-model-pass\.md/);
  assert.match(method, /opt-in per review/);
  assert.match(method, /installed CLI detection is never permission/);
  assert.match(method, /The preflight passing is not permission/);
  assert.match(method, /Ask once with `AskUserQuestion`/);
  assert.match(method, /Never call the provider family already\s+running the review/);
  assert.match(method, /make exactly one call/);
  assert.match(method, /Cross-model pass skipped/);
  assert.match(method, /never fan out to a third provider/);
  assert.match(method, /Do not add a reviewer merely to compensate for\s+the failed provider pass/i);
  // Skipping is a real answer, not a prompt to re-ask until the user relents.
  assert.match(method, /A skip\s+is complete/);
  assert.match(method, /bin\/coredoc-workflows codex-peer/);
  assert.match(method, /bin\/coredoc-workflows claude-peer/);
  assert.match(method, /artifact-only boundary/);
  assert.match(method, /refuses a base review when non-ignored untracked files/);
  assert.doesNotMatch(`${body}\n${method}`, /snapshot MCP|PreToolUse guard/i);
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

test("router and implementation skills preserve the large-change approval lifecycle", async () => {
  const [router, implementation, tdd, dispatch] = await Promise.all([
    skill("coredoc-workflows"),
    skill("coredoc-implement"),
    skill("coredoc-tdd"),
    readFile(join(METHODOLOGY_ROOT, "subagent-dispatch.md"), "utf8"),
  ]);

  assert.match(router, /--scale large/);
  assert.match(router, /gate: user-approval/);
  assert.match(
    router,
    /Do not run `coredoc-workflows finish-run` while\s+paused/,
  );
  assert.match(
    router,
    /ask one explicit \*\*Accept and implement \/ Revise\*\* decision[\s\S]*fresh affirmative user reply to that decision counts[\s\S]*both\s+accepts the reviewed specification and authorizes the gated implementation/i,
  );
  assert.match(
    router,
    /acknowledgement, a partial answer, or an acceptance with a requested\s+change is a revision request/i,
  );
  assert.match(
    router,
    /structured input tool when available; otherwise ask the same concise two-option\s+question in prose and wait/i,
  );
  assert.match(
    router,
    /read-only preflight[\s\S]*announce its proof plan[\s\S]*still `status: draft`[\s\S]*`status: accepted` as the first repository\s+write[\s\S]*preserve an unchanged accepted status/i,
  );
  assert.match(
    router,
    /initial\s+change\s+request,\s+pre-spec\s+alignment\s+approval,\s+spec\s+existence,\s+an\s+already\s+accepted\s+status,\s+or\s+a\s+successful\s+review\s+verdict\s+does\s+not\s+count/i,
  );
  assert.match(router, /obtain fresh\s+approval regardless of its existing status/i);
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
  assert.match(implementation, /acceptance criteria/i);
  assert.match(
    implementation,
    /fresh approval[\s\S]*reviewed direction and material deltas through the\s+explicit Accept and implement \/ Revise decision/i,
  );
  assert.match(implementation, /same affirmative reply\s+authorizes implementation/i);
  assert.match(
    implementation,
    /finish the read-only preflight[\s\S]*state\s+the proof plan before changing any file[\s\S]*frontmatter is\s+`status: draft`[\s\S]*`status: accepted` as the implementation stage's\s+first repository write[\s\S]*already accepted from a prior session, preserve that status[\s\S]*fresh\s+post-review approval is still required/i,
  );
  assert.match(implementation, /start from the reviewed specification/i);
  assert.match(
    implementation,
    /reveal a mismatch, stop with\s+the specification still `status: draft`/i,
  );
  assert.match(
    implementation,
    /original\s+change[\s\S]*pre-spec\s+alignment\s+approval[\s\S]*an\s+already\s+accepted\s+status[\s\S]*positive\s+review[\s\S]*not\s+implementation\s+authorization/i,
  );
  assert.match(
    implementation,
    /Routed:.*repository evidence already available.*Do not repeat\s+completed discovery/is,
  );
  assert.match(implementation, /context was compacted/i);
  assert.match(
    implementation,
    /Direct:.*inspect only the\s+runtime path, existing validation, and nearest consumers/is,
  );
  assert.match(
    implementation,
    /stop and raise the mismatch instead of\s+silently implementing or skipping it/is,
  );
  assert.match(implementation, /over-scope gate/i);
  assert.match(implementation, /Deletion or deprecation/i);
  assert.match(implementation, /absence test only when absence is itself/i);
  assert.match(implementation, /Documentation or content/i);
  assert.match(
    implementation,
    /Never add a test merely to assert that deleted\s+private code stays deleted/i,
  );
  assert.match(implementation, /subagent-dispatch\.md/);
  assert.match(tdd, /strict test-first method/i);
  assert.match(tdd, /use `coredoc-implement` unless/i);
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
    /immediately before.*actual\s+routed stage work.*coredoc-workflows stage-run start --stage-id <stage-id>/is,
  );
  assert.match(
    router,
    /coredoc-workflows stage-run finish --stage-id <stage-id> --outcome <success\|failed\|blocked>/i,
  );
  assert.match(router, /Only one\s+stage occurrence may be open/i);
  assert.match(router, /DONE.*DONE_WITH_CONCERNS.*success.*BLOCKED.*blocked/is);
  assert.match(
    router,
    /NEEDS_CONTEXT.*finish.*blocked.*keep the run open.*restart the\s+same stage.*next attempt/is,
  );
  assert.match(
    router,
    /close the design stage.*before pausing.*fresh affirmative user reply[\s\S]*accepts the reviewed specification[\s\S]*authorizes the gated implementation/is,
  );
  assert.match(
    router,
    /runStateStatus`.*`unattributed`.*completion gate.*skip.*coredoc-workflows stage-run/is,
  );
  assert.match(router, /successful finish.*every routed stage.*closed\s+successfully/is);
  assert.match(router, /SessionEnd.*only.*actually open stage.*abandoned/is);
  assert.match(router, /Never infer stage boundaries\s+from `PreToolUse` or\s+`PostToolUse`/i);
  assert.match(
    router,
    /parent coordinator exclusively owns.*`route-task`.*`stage-run`.*`finish-run`/is,
  );
  assert.match(
    router,
    /status: inactive.*stop.*do not continue the stage method.*route-task.*again/is,
  );

  const dispatch = await readFile(
    join(METHODOLOGY_ROOT, "subagent-dispatch.md"),
    "utf8",
  );
  assert.match(
    dispatch,
    /parent exclusively owns.*route-task.*stage-run.*finish-run.*every dispatch prompt/is,
  );

  assert.match(readme, /explicit router boundary commands/i);
  assert.match(readme, /exact task-owning context/i);
  assert.match(readme, /packaged skill does not\s+instruct an agent to supply `--task-id`/i);
  assert.match(readme, /self-reported bookkeeping/i);
  assert.doesNotMatch(readme, /Neither host emits stage intervals/i);
  assert.doesNotMatch(readme, /does not currently synthesize those fragments/i);
});

test("router verifies provider work items structurally before one safe route call", async () => {
  const [router, protocol, readme] = await Promise.all([
    skill("coredoc-workflows"),
    readFile(join(METHODOLOGY_ROOT, "work-item-routing.md"), "utf8"),
    readFile(join(PLUGIN_ROOT, "README.md"), "utf8"),
  ]);
  const providerRead = router.indexOf("work-item-routing.md");
  const routeCall = router.indexOf("bin/coredoc-workflows route-task --intent");

  assert.ok(providerRead >= 0 && providerRead < routeCall);
  assert.match(protocol, /provider MCP read/i);
  assert.match(protocol, /ignore.*instructions/is);
  assert.match(protocol, /provider=jira.*externalId=String\(issue\.id\).*externalKey=issue\.key/is);
  assert.match(protocol, /Never infer[\s\S]*(?:URL|locator|visible key)/i);
  assert.match(protocol, /1–8 verified work items/i);
  assert.match(protocol, /--work-item-provider.*--work-item-external-id.*--work-item-external-key/is);
  assert.match(protocol, /whitespace.*quotes.*backticks.*shell operators.*redirection.*glob/is);
  assert.match(protocol, /unavailable or denied.*ambiguous\/not found.*stable ID/is);
  assert.match(protocol, /explicit user intent.*unlinked/is);
  assert.match(protocol, /GitHub Issue.*work item.*(?:PR|pull request).*CodeChange/is);
  assert.match(protocol, /Notion database task.*work item.*plain Notion.*context/is);
  assert.match(protocol, /Figma.*Confluence.*context/is);
  assert.match(protocol, /Discard the raw locator and\s+provider payload/i);

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
  const [body, antiShortcut, completionGate] = await Promise.all([
    skill("coredoc-plan-review"),
    readFile(join(METHODOLOGY_ROOT, "anti-shortcut.md"), "utf8"),
    readFile(join(METHODOLOGY_ROOT, "plan-review-gate.md"), "utf8"),
  ]);

  assert.match(body, /resources\/methodology\/review-policy\.md/);
  assert.match(body, /resources\/methodology\/finding-contract\.md/);
  assert.match(body, /resources\/methodology\/test-coverage-plan\.md/);
  assert.match(body, /resources\/methodology\/plan-review-gate\.md/);
  assert.match(body, /resources\/methodology\/anti-shortcut\.md/);
  assert.match(antiShortcut, /writing a\s+decision into the artifact is not a substitute for asking/i);
  assert.match(antiShortcut, /HYPOTHESIS.*never becomes plan work/is);
  assert.match(body, /Test Framework Detection/);
  assert.match(body, /Trace accepted runtime paths/);
  assert.match(body, /Choose the smallest meaningful layer/);
  assert.match(body, /Outcome \/ risk \| Observer \| Decisive check \| Gap/);
  assert.match(body, /single small Mermaid diagram only for a non-trivial/);
  assert.match(body, /Implementation Tasks/);
  assert.match(body, /Plan review completion gate/);
  assert.match(body, /reachable/i);
  assert.match(body, /accepted scenarios and invariants/i);
  assert.match(body, /Do not prescribe one new test per edit or acceptance criterion/);
  assert.match(
    completionGate,
    /ask one explicit \*\*Accept and implement \/ Revise\*\* decision[\s\S]*unambiguous acceptance of that decision counts: it both accepts the reviewed\s+specification and authorizes implementation/i,
  );
  assert.match(
    completionGate,
    /Routed\s+plan review never marks the specification accepted[\s\S]*read-only preflight and proof-plan\s+announcement[\s\S]*frontmatter is `status: draft`[\s\S]*`status: accepted` as its first repository write[\s\S]*unchanged accepted status from a prior session is preserved/i,
  );
  assert.match(body, /routed review remains read-only[\s\S]*new specification attempt/i);
  assert.match(body, /standalone\s+review may update the artifact only when the user explicitly authorized/i);
  assert.match(body, /missing record is a requested spec revision rather\s+than a design-stage edit/i);
  assert.match(
    completionGate,
    /original\s+change\s+request,\s+pre-spec\s+alignment\s+approval,\s+spec\s+existence,\s+or\s+a\s+positive\s+review\s+verdict\s+is\s+not\s+that\s+approval/i,
  );
  assert.match(body, /as\s+an\s+ADR\s+only\s+when\s+the\s+choice\s+meets\s+the\s+spec\s+skill's\s+ADR\s+threshold/i);
  assert.match(body, /rollout and\s+rollback where release or data context requires them/i);
  assert.doesNotMatch(body, /Record accepted decisions in the spec's ADR\/decision section/);
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

test("spec aligns one grounded domain and solution model before elaboration", async () => {
  const [body, alignment, router] = await Promise.all([
    skill("coredoc-spec"),
    readFile(join(METHODOLOGY_ROOT, "pre-spec-alignment.md"), "utf8"),
    skill("coredoc-workflows"),
  ]);

  const ground = body.indexOf("### 1. Ground current state");
  const align = body.indexOf("### 3. Align the domain and solution before elaborating");
  const model = body.indexOf("### 4. Model intent, not implementation noise");
  assert.ok(ground >= 0 && ground < align && align < model);
  assert.ok(body.includes(alignment), "generated spec lost the shared alignment method");

  assert.match(alignment, /Decision dependencies:[\s\S]*Domain model:/i);
  assert.match(alignment, /concurrent lenses, not separate interviews or competing artifacts/i);
  assert.match(alignment, /Resolve repository-verifiable facts yourself/i);
  assert.match(alignment, /choices that can be\s+answered from the evidence and decisions already settled/i);
  assert.match(alignment, /recompute the answerable set/i);
  assert.match(
    alignment,
    /one decision, 2–3 real options[\s\S]*recommended option with a concrete reason[\s\S]*trade-off that could\s+change the answer/i,
  );
  assert.match(
    alignment,
    /compact contract overrides any generic decision-brief\s+format elsewhere in the plugin/i,
  );
  assert.match(
    alignment,
    /Do not add ELI10 sections,\s+completeness scores, effort estimates, or separate stakes\/pros\/cons blocks/i,
  );
  assert.match(alignment, /user-provided mature PRD[\s\S]*may[\s\S]*without a question/i);
  assert.match(alignment, /Length and formatting alone\s+do not make input mature/i);
  assert.match(alignment, /canonical terms, actors\/entities, ownership, relationships, and invariants/i);
  assert.match(alignment, /concrete scenarios/i);
  assert.match(alignment, /Cross-check every claimed current behavior against code/i);
  assert.match(alignment, /Before any required question, present a concise alignment brief/i);
  assert.match(
    alignment,
    /no interactive decisions remain[\s\S]*complete updated brief[\s\S]*Proceed with this understanding \/ Revise it/i,
  );
  assert.match(
    alignment,
    /answering the last\s+design question does not implicitly approve the assembled picture/i,
  );
  assert.match(alignment, /final confirmation is not required[\s\S]*mature-input path/i);
  assert.match(
    alignment,
    /decision remains unanswered[\s\S]*do not write the spec artifact[\s\S]*start plan\s+review, or begin implementation/i,
  );
  assert.match(
    alignment,
    /routed workflow\s+always returns `NEEDS_CONTEXT` before asking[\s\S]*closes the current spec attempt as\s+blocked[\s\S]*restarts the same stage after the answer/i,
  );
  assert.match(
    alignment,
    /Each question—including every\s+decision in a round and the final confirmation below—is its own blocked attempt[\s\S]*ask exactly one question, stop, and restart the\s+same stage after the answer/i,
  );
  assert.match(
    alignment,
    /Stop and wait for that confirmation; in a routed\s+workflow it follows the same `NEEDS_CONTEXT` blocked-attempt lifecycle/i,
  );
  assert.match(
    alignment,
    /authorizes only elaborating[\s\S]*does not[\s\S]*satisfy a\s+post-review implementation gate/i,
  );
  assert.match(router, /spec stage must align the user's intent[\s\S]*before writing the specification/i);
  assert.match(
    router,
    /unresolved user-owned decision[\s\S]*do not write the\s+spec or finish the stage as successful[\s\S]*Return `NEEDS_CONTEXT`[\s\S]*close that attempt as blocked[\s\S]*restart the spec stage/i,
  );
  assert.match(router, /mature user-provided PRD may pass without a ceremonial question/i);
  assert.match(
    router,
    /interactive frontier[\s\S]*requires confirmation of the assembled\s+alignment brief[\s\S]*last design answer is not that\s+confirmation/i,
  );
});

test("spec preserves an observable intent graph without test-per-criterion ceremony", async () => {
  const body = await skill("coredoc-spec");

  for (const id of ["UC-n", "BR-n", "LIM-n", "AC-n", "ADR-n"]) {
    assert.match(body, new RegExp("`" + id + "`"), id);
  }
  assert.match(body, /UC-1 -> BR-2 -> AC-3/);
  assert.match(body, /semantic kinds are tools, not quotas/i);
  assert.match(body, /Omit an inapplicable kind instead of\s+inventing a row/i);
  assert.match(body, /Omit empty headings and tables/i);
  assert.match(body, /Otherwise omit it entirely/i);
  assert.match(
    body,
    /Create an ADR only when the\s+choice would be costly to change later[\s\S]*rationale would not be obvious[\s\S]*credible alternatives were actually evaluated/i,
  );
  assert.match(body, /rule needs a current source[\s\S]*named observer/i);
  assert.match(body, /Acceptance criteria\s+are outcomes, not an automatic request for one new test each/i);
  assert.doesNotMatch(body, /resources\/methodology\/estimate-buckets\.md/);
  assert.match(body, /acceptance names observable behaviors and predicates, not test counts or\s+invented percentage targets/i);
  assert.match(body, /three or more branches\/states\/interactions/);
  assert.match(body, /Do not duplicate the same flow in bullets and a diagram/);
  assert.match(body, /every in-scope outcome maps to at least one use case\/rule and observable `AC`/);
  assert.match(
    body,
    /Keep `status: draft` through plan review[\s\S]*fresh\s+affirmative post-review reply[\s\S]*both accepts the reviewed\s+specification and authorizes implementation[\s\S]*read-only preflight and\s+proof-plan announcement[\s\S]*changes a draft frontmatter to\s+`status: accepted` as its first repository write[\s\S]*preserves an unchanged accepted status from a prior session/i,
  );
  assert.match(
    body,
    /standalone\s+specification\s+delivery[\s\S]*deliver\s+the\s+draft\s+as\s+the\s+handoff[\s\S]*do\s+not\s+add\s+a\s+confirmation\s+round\s+to\s+obtain\s+it/i,
  );
  assert.match(
    body,
    /elaboration exposes a new user-owned decision[\s\S]*return to the alignment checkpoint[\s\S]*do not add a generic mid-spec approval/i,
  );
  assert.match(
    body,
    /When release or data context requires[\s\S]*Rollout\/rollback:[\s\S]*Otherwise omit it/i,
  );
});

test("spec challenges proposal scope and verifies model contracts before elaboration", async () => {
  const body = await skill("coredoc-spec");

  assert.match(body, /Treat every supplied design[\s\S]*as proposal input/i);
  assert.match(body, /Citations inside a proposal are leads, not evidence/i);
  assert.match(body, /Preserve explicitly accepted outcomes and[\s\S]*without silently widening them/i);
  assert.match(body, /smallest reversible slice that can prove value/i);
  assert.match(body, /new store, service,[\s\S]*needs a current consumer and observable requirement/i);
  assert.match(body, /every requested semantic kind and user flow a durable representation or an[\s\S]*explicit deferral/i);
  assert.match(body, /Merge synonymous labels only when their payload, authority, lifecycle, and[\s\S]*consumers are equivalent/i);
  assert.match(body, /proposed possibility from[\s\S]*accepted capability[\s\S]*do not[\s\S]*silently discard/i);
  assert.match(body, /unsupported field or node kind as unknown[\s\S]*never infer a contract/i);
  assert.match(body, /in-scope named consumer needs an executable adoption path in the same slice/i);
  assert.match(body, /workflow merely \*may\* use does not[\s\S]*satisfy an outcome/i);
  assert.match(body, /static prompt,[\s\S]*content assertions may guard structure but cannot alone[\s\S]*prove adoption or behavior/i);
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
