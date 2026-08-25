#!/usr/bin/env node
// build-skills.mjs — expand each skill template into the SKILL.md that ships.
//
// Why the generated file exists: a SKILL.md that says "run this script and read
// the output" produces no method at all when Bash is unavailable, denied, or
// sandboxed. The agent reads the pointer, cannot follow it, and proceeds with no
// instructions — it does not degrade, it silently loses the workflow.
//
// The model is one level deep:
//
//   skills/<skill>/SKILL.md.tmpl   our text, hand-edited, with {{PARTIAL}} tokens
//   resources/methodology/*.md     the partials, shared across skills
//   skills/<skill>/SKILL.md        generated, committed, never hand-edited
//
// A skill is generated if and only if it has a SKILL.md.tmpl beside it. The
// other skills are hand-written and this script does not touch them, so the
// filesystem is the registry — there is no map to keep in sync.
//
// `--check` builds to memory and exits non-zero when a committed file differs,
// naming the stale ones. That clause runs inside the repository's `test` script,
// so editing a template without rebuilding fails the normal gate.
//
// `--skills-root <dir>` points the read/write side at a copy of skills/. Its
// caller is the stale-detection test, which needs a tree it can dirty without
// touching the repository.

import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const SKILLS_ROOT = join(PLUGIN_ROOT, "skills");
const METHODOLOGY_ROOT = join(PLUGIN_ROOT, "resources", "methodology");

const BUILD_COMMAND = "npm run build:skills";

// {{TOKEN}} -> the partial that replaces it. Partials may themselves contain
// tokens; expansion runs to a fixed point.
export const PARTIALS = Object.freeze({
  PREAMBLE: "coredoc-overlay.md",
  REVIEW_POLICY: "review-policy.md",
  BROWSE_SETUP: "browser-setup.md",
  QA_SURFACE_SETUP: "qa-surface-setup.md",
  COMMAND_REFERENCE: "browser-command-reference.md",
  ADVERSARIAL_STEP: "adversarial-review.md",
  ANTI_SHORTCUT_CLAUSE: "anti-shortcut.md",
  BASE_BRANCH_DETECT: "base-branch.md",
  CACHE_WRITE: "cache-write.md",
  COMPLETION_STATUS: "completion-status.md",
  CONFIDENCE_CALIBRATION: "confidence-calibration.md",
  CONFUSION_PROTOCOL: "confusion-protocol.md",
  CROSS_MODEL_PASS: "cross-model-pass.md",
  CROSS_REVIEW_DEDUP: "cross-review-dedup.md",
  DECISION_BRIEF: "decision-brief.md",
  ESTIMATE_BUCKETS: "estimate-buckets.md",
  FINDING_CONTRACT: "finding-contract.md",
  EXIT_PLAN_MODE_GATE: "plan-review-gate.md",
  PLAN_COMPLETION_AUDIT_REVIEW: "plan-completion-audit.md",
  QA_METHODOLOGY: "qa-methodology.md",
  REVIEW_ARMY: "review-specialists.md",
  SCOPE_DRIFT: "scope-drift.md",
  SEARCH_BEFORE_BUILDING: "search-before-building.md",
  SNAPSHOT_FLAGS: "browser-snapshot.md",
  TASKS_SECTION_EMIT: "implementation-tasks.md",
  TEST_BOOTSTRAP: "test-framework.md",
  TEST_COVERAGE_AUDIT_PLAN: "test-coverage-plan.md",
});

const FORBIDDEN_IN_OUTPUT = [
  ["upstream product coupling", /gstack|gbrain/i],
  ["a pointer to the removed renderer", /render-skill\.mjs/],
];

const FRONTMATTER = /^(---\r?\n[\s\S]*?\r?\n---\r?\n)([\s\S]*)$/;
const ANY_TOKEN = /\{\{[A-Z_][A-Z0-9_]*(?::[^}\n]+)?\}\}/;
const MAX_EXPANSIONS = 5;

/** Skills that carry a template, in stable order. */
export async function templatedSkills(skillsRoot = SKILLS_ROOT) {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const template = join(skillsRoot, entry.name, "SKILL.md.tmpl");
    if (await stat(template).then((s) => s.isFile(), () => false)) found.push(entry.name);
  }
  return found.sort();
}

async function loadPartials() {
  const loaded = {};
  for (const [token, file] of Object.entries(PARTIALS)) {
    loaded[token] = (await readFile(join(METHODOLOGY_ROOT, file), "utf8")).trim();
  }
  return loaded;
}

export function expand(body, partials, skill) {
  let out = body;
  for (let pass = 0; pass < MAX_EXPANSIONS; pass++) {
    if (!ANY_TOKEN.test(out)) break;
    for (const [token, contents] of Object.entries(partials)) {
      out = out.replace(new RegExp(`\\{\\{${token}(?::[^}\\n]+)?\\}\\}`, "g"), contents);
    }
  }
  const leftover = ANY_TOKEN.exec(out);
  if (leftover) {
    throw new Error(`${skill}: unresolved placeholder ${leftover[0]}`);
  }
  return out;
}

async function buildSkill(skill, partials, skillsRoot = SKILLS_ROOT) {
  const template = await readFile(join(skillsRoot, skill, "SKILL.md.tmpl"), "utf8");
  const match = FRONTMATTER.exec(template);
  if (!match) {
    throw new Error(`${skill}/SKILL.md.tmpl must open with a frontmatter block`);
  }
  const [, frontmatter, body] = match;
  if (!/^name:\s*\S/m.test(frontmatter) || !/^description:\s*\S/m.test(frontmatter)) {
    throw new Error(`${skill}/SKILL.md.tmpl frontmatter needs name and description`);
  }

  // No generated-file banner in the output. It would sit in the highest-attention
  // position of every prompt — right after the frontmatter — to warn a human who
  // is not reading. The warning lives in the README and in .gitattributes, where
  // the human is; the agent gets the method and nothing else.
  const expanded = expand(body, partials, skill).replace(/\n{3,}/g, "\n\n").trim();
  const built = `${frontmatter}\n${expanded}\n`;

  // These skills are self-contained by design: no upstream product coupling, and
  // nothing that tells the agent to shell out for its own instructions.
  for (const [what, pattern] of FORBIDDEN_IN_OUTPUT) {
    if (pattern.test(built)) throw new Error(`${skill}: generated skill contains ${what}`);
  }
  return built;
}

export async function buildAll(skillsRoot = SKILLS_ROOT) {
  const partials = await loadPartials();
  const built = new Map();
  for (const skill of await templatedSkills(skillsRoot)) {
    built.set(skill, await buildSkill(skill, partials, skillsRoot));
  }
  if (built.size === 0) throw new Error("no skill templates found");
  return built;
}

async function main() {
  const args = argv.slice(2);
  const check = args.includes("--check");
  const rootIndex = args.indexOf("--skills-root");
  const skillsRoot = rootIndex === -1 ? SKILLS_ROOT : args[rootIndex + 1];
  if (rootIndex !== -1 && !skillsRoot) {
    throw new Error("--skills-root requires a directory argument");
  }
  const unknown = args.filter((a, i) => {
    if (a === "--check") return false;
    if (rootIndex !== -1 && (i === rootIndex || i === rootIndex + 1)) return false;
    return true;
  });
  if (unknown.length > 0) throw new Error(`Unknown argument: ${unknown.join(", ")}`);

  const built = await buildAll(skillsRoot);
  const stale = [];

  for (const [skill, contents] of built) {
    const path = join(skillsRoot, skill, "SKILL.md");
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === contents) continue;
    if (check) {
      stale.push(`skills/${skill}/SKILL.md`);
      continue;
    }
    await writeFile(path, contents);
    process.stdout.write(`built ${skill}/SKILL.md (${contents.length} B)\n`);
  }

  if (check) {
    if (stale.length > 0) {
      throw new Error(
        `Generated skills are stale:\n  ${stale.join("\n  ")}\n` +
          `Run \`${BUILD_COMMAND}\` and commit the result.`,
      );
    }
    process.stdout.write(`OK: ${built.size} generated skills match a fresh build\n`);
    return;
  }
  process.stdout.write(`OK: ${built.size} skills built\n`);
}

if (import.meta.url === pathToFileURL(argv[1]).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
