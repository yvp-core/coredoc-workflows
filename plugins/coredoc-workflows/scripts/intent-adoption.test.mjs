// Structure guards over the optional product-intent adoption (intent-layer spec
// issue 05).
//
// These assert that the shared methodology exists, says the load-bearing things,
// and that exactly the four consumer adapters point at it on a conditional. They
// do NOT prove adoption: a skill can carry perfect text and the model can still
// ignore it. Observed-run evidence (AC-10, AC-12) is issue 06's blind eval, not
// this file.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";

import { SKILLS_ROOT } from "./build-skills.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const METHODOLOGY_PATH = join(
  PLUGIN_ROOT,
  "resources",
  "methodology",
  "intent-context.md",
);
const RESOURCE_REF = "<plugin-root>/resources/methodology/intent-context.md";

/** The only skills allowed to mention intent context. */
const ADAPTERS = [
  "coredoc-plan-review",
  "coredoc-implement",
  "coredoc-review",
  "coredoc-investigate",
];

/**
 * One sentence, byte-identical in every adapter, so absence stays silent
 * everywhere instead of drifting into "say so once" in one skill and a reported
 * gap in the next.
 */
const ABSENT_CAPABILITY_SENTENCE =
  "When no intent capability is present, proceed from repository evidence alone and do not mention intent context in the output.";

const skill = (name) => readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");

/** Markdown wraps lines, so a load-bearing phrase may span a newline. */
const phrase = (text, flags = "i") =>
  new RegExp(
    text
      .split(" ")
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
    flags,
  );

/** Line-wrapped prose, rejoined, split into sentences. */
const sentences = (body) =>
  body
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

test("intent-context methodology states the exact-ID-first protocol", async () => {
  const body = await readFile(METHODOLOGY_PATH, "utf8");

  // Applies only when the capability is there; its absence is normal (BR-9, AC-9).
  assert.match(body, /get_intent_context/);
  assert.match(body, phrase("coredoc intent context"));
  assert.match(body, /optional/i);
  assert.match(body, phrase("never blocks"));

  // BR-8: reuse routed IDs, fetch only absent payload, one bounded lookup.
  assert.match(body, /exact[- ]ID[- ]first/i);
  assert.match(body, phrase("at most one broad lookup per stage"));
  assert.match(body, phrase("Never reload the whole overlay"));

  // BR-4 / UC-5 / UC-7: honest interpretation of independent dimensions.
  assert.match(body, /candidate[^.]*never[^.]*blocking/i);
  assert.match(body, phrase("touchpoints, not conformance proof"));
  assert.match(body, /rejected/i);
  assert.match(body, /superseded/i);

  // BR-9: four distinct unavailable states, never collapsed to "no rule".
  for (const state of [
    phrase("absent file"),
    phrase("invalid file"),
    phrase("no match"),
    phrase("unavailable local graph"),
  ]) {
    assert.match(body, state);
  }
  assert.match(body, phrase("no applicable rule"));

  // The artifact must carry the IDs, cited like file:line evidence.
  assert.match(body, /cite/i);
  assert.match(body, /file:line/);
});

// A meaning-inverted rewrite ("matched against a stale snapshot is unaffected")
// must fail, so the assertion is anchored inside the one sentence that carries
// the claim rather than to tokens scattered across the file.
test("methodology keeps matched-on-stale from reading as 'unaffected'", async () => {
  const body = await readFile(METHODOLOGY_PATH, "utf8");
  const claims = sentences(body).filter(
    (sentence) => /matched/i.test(sentence) && /unaffected/i.test(sentence),
  );

  assert.equal(
    claims.length,
    1,
    "exactly one sentence may relate `matched` to `unaffected`",
  );
  assert.match(claims[0], /\bis\s+\*{0,2}not\b[^.]{0,40}unaffected/i, claims[0]);
  assert.match(claims[0], /stale/i, claims[0]);
});

// The CLI half is only usable if it is runnable: `--project` is a required
// option on every `coredoc intent` subcommand, and the id has to come from
// somewhere the agent can read rather than from a guess.
test("methodology shows a runnable CLI and an accurate MCP surface", async () => {
  const body = await readFile(METHODOLOGY_PATH, "utf8");

  const invocations = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("coredoc intent "));
  assert.ok(invocations.length >= 2, "show more than one CLI invocation");
  for (const invocation of invocations) {
    assert.match(invocation, /--project /, invocation);
  }

  // Where the project id comes from, and the prohibition on inventing one.
  assert.match(body, phrase("coredoc.config.json"));
  assert.match(body, /projects\[\]\.id|projects\[\]/);
  assert.match(body, /never guess|do not guess/i);

  // MCP parameter names, exactly as the tool declares them.
  for (const parameter of [
    "intentIds",
    "query",
    "nodeIds",
    "includeCandidates",
    "limit",
    "detailLevel",
  ]) {
    assert.match(body, new RegExp(`\`${parameter}\``), parameter);
  }
});

// A missing capability and a `not_configured` overlay are different facts, and
// neither one is a finding.
test("methodology separates a missing capability from an empty overlay", async () => {
  const body = await readFile(METHODOLOGY_PATH, "utf8");

  assert.ok(
    body.replace(/\s+/g, " ").includes(ABSENT_CAPABILITY_SENTENCE),
    "methodology must carry the shared absent-capability sentence verbatim",
  );
  assert.match(body, /not_configured/);
  const distinction = sentences(body).find(
    (sentence) => /capability/i.test(sentence) && /not_configured/.test(sentence),
  );
  assert.ok(distinction, "state the capability-vs-overlay distinction in one sentence");
  assert.match(distinction, /not the same|different|is not/i, distinction);
});

test("each consumer adapter carries a conditional intent hook", async () => {
  const expectations = {
    "coredoc-plan-review": /accepted intent/i,
    "coredoc-implement": /limitations|non-goals/i,
    "coredoc-review": phrase("stale anchors"),
    "coredoc-investigate": /hypothes/i,
  };

  for (const name of ADAPTERS) {
    const body = await skill(name);
    assert.ok(body.includes(RESOURCE_REF), `${name} must point at the methodology`);
    // Conditional, never a dependency.
    assert.match(body, /If [\s\S]{0,80}intent/i, name);
    assert.match(body, expectations[name], name);
    // A hook, not a second copy of the method.
    assert.doesNotMatch(body, phrase("at most one broad lookup per stage"), name);
  }
});

// Optionality is the property most likely to erode, so it is pinned on every
// hook: the same sentence verbatim, and no wording that turns the optional
// capability into a step that must run or an absence that must be reported.
test("every adapter hook keeps the capability optional in the same words", async () => {
  for (const name of ADAPTERS) {
    const body = await skill(name);
    const hook = body
      .split(/\n\s*\n/)
      .filter((block) => block.includes(RESOURCE_REF) || /intent capability/i.test(block))
      .join("\n\n");
    assert.ok(hook, `${name} must contain an intent hook block`);

    assert.ok(
      hook.replace(/\s+/g, " ").includes(ABSENT_CAPABILITY_SENTENCE),
      `${name} must use the shared absent-capability sentence verbatim`,
    );
    assert.doesNotMatch(
      hook,
      /report.*(missing|absent).*intent.*(gap|finding)/i,
      `${name} must not turn an absent capability into a reportable gap`,
    );
    assert.doesNotMatch(hook, /always fetch/i, name);
    assert.doesNotMatch(hook, /\brequired step\b|\bmust fetch\b/i, name);
  }
});

test("intent context stays out of the router and every other skill", async () => {
  const names = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const leaked = [];
  for (const name of names) {
    if (ADAPTERS.includes(name)) continue;
    const body = await skill(name);
    if (
      body.includes(RESOURCE_REF) ||
      /get_intent_context|coredoc intent context/.test(body)
    ) {
      leaked.push(name);
    }
  }
  assert.deepEqual(leaked, [], "only the four adapters may reference intent context");
});
