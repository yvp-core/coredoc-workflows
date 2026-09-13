import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "../test/test-api.mjs";
import { SKILLS_ROOT } from "./build-skills.mjs";
import { unclosedFenceLine, skillFootprint, validateSkillCorpus } from "./lib/skill-validation.mjs";

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
});

test("every shipped skill closes its fences and stays inside measured budgets", async () => {
  const names = (await readdir(SKILLS_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const skills = new Map(await Promise.all(names.map(async (name) =>
    [name, await readFile(join(SKILLS_ROOT, name, "SKILL.md"), "utf8")],
  )));
  const budgets = JSON.parse(await readFile(new URL("../test/skill-budgets.json", import.meta.url), "utf8"));
  assert.deepEqual(validateSkillCorpus(skills, budgets), [],
    "Measure before adjusting a budget; preserve behavior and record the reason in the PR.");
});
