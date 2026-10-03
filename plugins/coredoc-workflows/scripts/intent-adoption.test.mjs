// Contract checks over the optional product-intent adoption (ADR 0004). They do
// NOT prove adoption: a skill can carry perfect text and the model can still
// ignore it. Observed-run evidence is the blind eval's job, not this file's.
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

/** The only skills allowed to run an intent read. */
const ADAPTERS = [
  "coredoc-prd",
  "coredoc-spec",
  "coredoc-plan-review",
  "coredoc-implement",
  "coredoc-review",
  "coredoc-investigate",
];

const skill = (name) => readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");

// `--project` is a required option on every `coredoc intent` subcommand, and the
// hosts truncate the MCP tool descriptions, so this methodology is the agent's
// only complete copy of the parameter names the tools declare.
test("methodology shows runnable CLI invocations and the MCP parameter names", async () => {
  const body = await readFile(METHODOLOGY_PATH, "utf8");

  const invocations = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("coredoc intent "));
  assert.ok(invocations.length >= 2, "show more than one CLI invocation");
  for (const invocation of invocations) {
    assert.match(invocation, /--project /, invocation);
  }

  for (const parameter of [
    "intentIds",
    "query",
    "nodeIds",
    "domain",
    "feature",
    "includeCandidates",
    "effectivity",
    "observed",
    "limit",
    // Local-only: the cloud tool refuses both.
    "detailLevel",
    "format",
  ]) {
    assert.match(body, new RegExp(`\`${parameter}\``), parameter);
  }
});

test("intent reads stay out of the router and every other skill", async () => {
  const names = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  const leaked = [];
  for (const name of names) {
    if (ADAPTERS.includes(name)) continue;
    if (/get_intent_context|coredoc\s+intent\s+context/.test(await skill(name))) leaked.push(name);
  }
  assert.deepEqual(leaked, [], "only the six lifecycle adapters may run an intent read");
});

// The hosted write tools parse these names: `intent_handoff` saves mapping state
// under optimistic concurrency (`headSha`, `expectedVersion`), and an approval-time
// `intent_review accept` must cite the approved document as `authorizingSource`.
test("intent write carriers name the hosted tools and the fields they parse", async () => {
  const body = await readFile(METHODOLOGY_PATH, "utf8");
  for (const token of [
    /\bintent_handoff\b/,
    /\bheadSha\b/,
    /\bexpectedVersion\b/,
    /\bintent_review\s+accept\b/,
    /\bauthorizingSource\b/,
  ]) {
    assert.match(body, token);
  }

  for (const [name, fields] of [
    ["coredoc-implement", [/\bheadSha\b/]],
    ["coredoc-review", [/\bheadSha\b/]],
    ["coredoc-git-delivery", [/\bexpectedVersion\b/]],
  ]) {
    const carrier = await skill(name);
    assert.match(carrier, /\bintent_handoff\b/, name);
    for (const field of fields) assert.match(carrier, field, name);
  }
});
