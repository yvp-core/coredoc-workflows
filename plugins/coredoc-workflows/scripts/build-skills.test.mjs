import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "../test/test-api.mjs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  PARTIALS,
  SKILLS_ROOT,
  buildAll,
  expand,
  templatedSkills,
} from "./build-skills.mjs";

const run = promisify(execFile);

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILDER = join(PLUGIN_ROOT, "scripts", "build-skills.mjs");
const RUNTIME_ROOT = join(PLUGIN_ROOT, "runtime", "browse");

const templatePath = (skill) => join(SKILLS_ROOT, skill, "SKILL.md.tmpl");
const builtPath = (skill) => join(SKILLS_ROOT, skill, "SKILL.md");

// The filesystem is the registry: a skill is generated iff it has a template.
// Pinning the count keeps a template from being added or dropped unnoticed.
test("eleven skills are generated and each has a committed output", async () => {
  const generated = await templatedSkills();

  assert.equal(generated.length, 11);
  for (const skill of generated) {
    assert.ok((await stat(builtPath(skill))).isFile(), `${skill} has no SKILL.md`);
  }
});

// Counted by predicate, not by a pinned total: adding a hand-written skill is a
// routine act that must not fail this gate, while a template added or dropped is
// still caught by the generated-count assertion above.
test("hand-written skills carry no template and are left alone", async () => {
  const generated = new Set(await templatedSkills());
  const all = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const handWritten = all.filter((s) => !generated.has(s));
  assert.ok(handWritten.length > 0, "no hand-written skills left to protect");
  for (const skill of handWritten) {
    await assert.rejects(stat(templatePath(skill)), `${skill} is generated but not in the build set`);
    assert.ok((await stat(builtPath(skill))).isFile(), `${skill} has no SKILL.md`);
  }
});

// The host discovers and triggers skills by these fields; they must survive the
// build untouched, and the directory name must match what the host will call.
test("frontmatter is carried through byte-for-byte", async () => {
  for (const skill of await templatedSkills()) {
    const template = await readFile(templatePath(skill), "utf8");
    const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(template)[0];
    const built = await readFile(builtPath(skill), "utf8");

    assert.ok(built.startsWith(frontmatter), `${skill} frontmatter not preserved`);
    assert.match(frontmatter, new RegExp(`^name: ${skill}$`, "m"));
    assert.match(frontmatter, /^description: \S/m);
  }
});

// The generated files carry no in-file banner, on purpose: it would spend the
// agent's attention warning a human. That trade only holds while the warning
// actually exists where the human is — so this asserts the compensating
// controls rather than a comment in the prompt.
test("the generated set is flagged where a human will see it", async () => {
  const generated = await templatedSkills();

  const readme = await readFile(join(PLUGIN_ROOT, "README.md"), "utf8");
  assert.match(readme, /SKILL\.md\.tmpl/);
  assert.match(readme, /npm run build:skills/);
  assert.match(readme, /never the generated/i);

  const attributes = await readFile(join(PLUGIN_ROOT, ".gitattributes"), "utf8");
  for (const skill of generated) {
    assert.match(
      attributes,
      new RegExp(`^skills/${skill}/SKILL\\.md linguist-generated=true$`, "m"),
      `${skill} is generated but not flagged in .gitattributes`,
    );
  }
  // And nothing hand-written is flagged as generated.
  const flagged = [...attributes.matchAll(/^skills\/(\S+)\/SKILL\.md /gm)].map((m) => m[1]);
  assert.deepEqual(flagged.sort(), generated.slice().sort());
});

test("no generated file carries a do-not-edit banner in its prompt text", async () => {
  for (const skill of await templatedSkills()) {
    const built = await readFile(builtPath(skill), "utf8");
    assert.doesNotMatch(built, /GENERATED FILE/, `${skill} reintroduced the banner`);
  }
});

// The whole point of generating: no skill may tell the agent to shell out for
// its own instructions. Covers every skill, generated and hand-written alike.
test("no skill instructs the agent to run a script to obtain its method", async () => {
  // Read the directory rather than the index: a skill added but not yet staged
  // would otherwise escape this check entirely.
  const files = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => join(SKILLS_ROOT, e.name, "SKILL.md"));

  assert.ok(files.length > 0, "no skills found to check");
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    // Skills may still invoke tooling — retro-evidence, redact-scan. What none
    // may do is send the agent to a script to fetch its own instructions.
    assert.ok(!/render-skill\.mjs/.test(contents), `${file} shells out for its method`);
    assert.ok(
      !/Read the complete rendered/.test(contents),
      `${file} still defers its method to script output`,
    );
  }
});

// An unresolved token would ship `{{SOMETHING}}` into a live prompt.
test("an unresolved placeholder fails the build", () => {
  assert.throws(
    () => expand("intro {{NO_SUCH_PARTIAL}} outro", {}, "coredoc-spec"),
    /unresolved placeholder \{\{NO_SUCH_PARTIAL\}\}/,
  );
});

test("partials expand recursively", () => {
  const partials = { OUTER: "before {{INNER}} after", INNER: "middle" };
  assert.equal(expand("{{OUTER}}", partials, "x"), "before middle after");
});

test("every declared partial resolves to a file that carries content", async () => {
  for (const [token, file] of Object.entries(PARTIALS)) {
    const body = await readFile(
      join(PLUGIN_ROOT, "resources", "methodology", file),
      "utf8",
    );
    assert.ok(body.trim().length > 50, `${token} -> ${file} is empty or a stub`);
  }
});

// Generated files that can silently diverge from their source are worse than no
// generation. Proves the gate fails on a stale file, not only that it passes.
test("--check passes on the committed tree and fails on a stale file", async () => {
  await run(process.execPath, [BUILDER, "--check"], { cwd: PLUGIN_ROOT });

  const scratch = await mkdtemp(join(tmpdir(), "coredoc-skills-"));
  await cp(SKILLS_ROOT, scratch, { recursive: true });
  await run(process.execPath, [BUILDER, "--check", "--skills-root", scratch]);

  const victim = join(scratch, "coredoc-spec", "SKILL.md");
  await writeFile(victim, `${await readFile(victim, "utf8")}\nstale drift\n`);

  await assert.rejects(
    run(process.execPath, [BUILDER, "--check", "--skills-root", scratch]),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /Generated skills are stale/);
      assert.match(error.stderr, /coredoc-spec\/SKILL\.md/);
      return true;
    },
  );
});

test("a template that reintroduces upstream product coupling fails the build", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "coredoc-skills-"));
  await cp(SKILLS_ROOT, scratch, { recursive: true });

  const victim = join(scratch, "coredoc-spec", "SKILL.md.tmpl");
  await writeFile(victim, `${await readFile(victim, "utf8")}\nRun ~/.gstack/bin/thing\n`);

  await assert.rejects(buildAll(scratch), /contains upstream product coupling/);
});

// The bundled browser server is 91 MB of opaque compiled output. Its hash is the
// only thing standing between a swapped binary and a shipped plugin.
test("the bundled browser server matches its recorded digest and size", async () => {
  const provenance = JSON.parse(
    await readFile(join(RUNTIME_ROOT, "provenance.json"), "utf8"),
  );
  const binary = join(RUNTIME_ROOT, provenance.binary);
  const [contents, info] = await Promise.all([readFile(binary), stat(binary)]);

  assert.equal(createHash("sha256").update(contents).digest("hex"), provenance.sha256);
  assert.equal(info.size, provenance.sizeBytes);
});
