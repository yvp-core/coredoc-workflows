import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "../test/test-api.mjs";
import { SKILLS_ROOT } from "./build-skills.mjs";
import { frontmatterYamlProblems, unclosedFenceLine, skillFootprint, validateSkillCorpus } from "./lib/skill-validation.mjs";

const sample = "---\nname: demo\ndescription: A bounded skill.\n---\n\nFollow the user.\n";
const budget = {
  catalogMaxBytes: 50,
  perSkillCatalogMaxBytes: 40,
  skillMaxBytes: { demo: 120 },
};

test("fence validation respects marker, length, indentation, and info strings", () => {
  for (const body of [
    "```js\ncode\n```\n",
    "~~~~md\n```js\n```\n~~~~\n",
    "````md\n```js\n```\n````\n",
    "   ```js\ncode\n   ```\n",
    "    ```indented code is not a fence\n",
  ]) assert.equal(unclosedFenceLine(body), null, body);
  assert.equal(unclosedFenceLine("text\n```js\ncode\n"), 2);
  assert.equal(unclosedFenceLine("```js\n```bash\n"), 1);
  assert.equal(unclosedFenceLine("~~~~md\n~~~\n"), 1);
  assert.equal(unclosedFenceLine("```js\n~~~\n"), 1);
  assert.equal(unclosedFenceLine("``` `inline` ```\ntext\n"), null);
});

test("frontmatter scalars must be nonempty single lines", () => {
  assert.throws(() => skillFootprint("---\nname: demo\ndescription: >\n  folded\n---\n"), /single-line/);
  assert.throws(() => skillFootprint("---\nname: demo\ndescription: |\n  literal\n---\n"), /single-line/);
  assert.throws(() => skillFootprint("---\nname: demo\ndescription:\n---\n"), /nonempty/);
  assert.throws(() => skillFootprint("---\ndescription: only\n---\n"), /name must be/);
});

// Codex validates frontmatter with PyYAML's safe_load and js-yaml rejects the
// same input: the router once shipped "…not on the agent's report: intent…".
test("frontmatter must parse as strict YAML, not just match a line regex", () => {
  const problems = (value) => frontmatterYamlProblems(`---\nname: demo\ndescription: ${value}\n---\n`);
  for (const value of [
    "Route work. Use when asked to route.",
    "Read a URL like https://example.com/a:b or C# code.",
    '"Quoted: a colon is fine here, and so is \\"this\\"."',
    "'Single quoted: it''s fine.'",
    "-dash and ?question marks may start a plain scalar",
  ]) assert.deepEqual(problems(value), [], value);

  for (const [value, reason] of [
    ["stages close on evidence, not on the agent's report: intent reads are checked", /mapping indicator/],
    ["Ends with a colon:", /mapping indicator/],
    ["Truncated #by a comment", /comment/],
    ["*alias", /indicator "\*"/],
    ["[a, flow, sequence]", /indicator "\["/],
    ["- a sequence entry", /indicator "-"/],
    ['"unterminated', /unterminated double-quoted/],
    ['"bad \\q escape"', /invalid escape/],
    ['"closed" then text', /after the closing quote/],
    ["'it's unescaped'", /after the closing quote/],
  ]) assert.match(problems(value).join("\n"), reason, value);

  assert.match(frontmatterYamlProblems("---\nname: a\nname: b\n---\n").join("\n"), /duplicated/);
  assert.match(frontmatterYamlProblems("---\nname: a\nmetadata:\n  nested: true\n---\n").join("\n"), /line 4 is not a flat/);
  assert.deepEqual(frontmatterYamlProblems("---\nname: a\n# comment\n\ndisable-model-invocation: false\n---\n"), []);
});

test("budgets measure UTF-8 bytes and reject growth, omissions and empty corpora", () => {
  const skills = new Map([["demo", sample]]);
  assert.deepEqual(validateSkillCorpus(skills, budget), []);
  assert.equal(skillFootprint(sample).bodyBytes, Buffer.byteLength(sample));
  assert.ok(validateSkillCorpus(new Map([["demo", sample + "я".repeat(40)]]), budget).some((p) => p.includes("body")));
  assert.ok(validateSkillCorpus(skills, { ...budget, catalogMaxBytes: 1 }).some((p) => p.includes("Catalog")));
  assert.ok(validateSkillCorpus(skills, { ...budget, perSkillCatalogMaxBytes: 1 }).some((p) => p.includes("description")));
  assert.ok(validateSkillCorpus(skills, { ...budget, skillMaxBytes: {} }).some((p) => p.includes("missing")));
  assert.ok(validateSkillCorpus(new Map(), budget).some((p) => p.includes("No skills")));
  assert.ok(validateSkillCorpus(new Map(), budget).some((p) => p.includes("stale")));
  assert.ok(validateSkillCorpus(new Map([["demo", "name: outside frontmatter"]]), budget).some((p) => p.includes("frontmatter")));
  assert.ok(validateSkillCorpus(new Map([["demo", sample + "```sh\n"]]), budget).some((p) => p.includes("unclosed")));
  assert.ok(validateSkillCorpus(new Map([["demo", sample.replace("A bounded skill.", "Bounded: yes.")]]), budget).some((p) => p.includes("strict YAML")));
});

test("every shipped skill parses as strict YAML, closes its fences, and stays inside measured budgets", async () => {
  const names = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const skills = new Map(await Promise.all(names.map(async (name) =>
    [name, await readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8")],
  )));
  const budgets = JSON.parse(await readFile(new URL("../test/skill-budgets.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSkillCorpus(skills, budgets), [],
    "Measure before adjusting a budget; preserve behavior and record the reason in the PR.");
});

// Hosts register a skill under its frontmatter name, while Pointers and the
// router reach it by directory, so both must be the same identifier.
test("every shipped skill's frontmatter name is its directory name", async () => {
  const names = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  assert.ok(names.length > 0);
  for (const name of names) {
    const body = await readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8");
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(body)?.[1] ?? "";
    assert.equal(/^name:\s*(.+?)\s*$/m.exec(frontmatter)?.[1], name, name);
  }
});
