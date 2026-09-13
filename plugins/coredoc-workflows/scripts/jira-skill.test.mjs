import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import test from "../test/test-api.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const read = (...parts) => readFile(join(PLUGIN_ROOT, ...parts), "utf8");

test("Jira task grounding is provider-neutral and separate from delivery identity", async () => {
  const [jira, router, routing] = await Promise.all([
    read("skills", "coredoc-jira", "SKILL.md"),
    read("skills", "coredoc-workflows", "SKILL.md"),
    read("resources", "methodology", "work-item-routing.md"),
  ]);

  assert.match(jira, /^name: coredoc-jira$/m);
  assert.match(jira, /existing Jira issue.*task|task.*existing Jira issue/is);
  assert.match(jira, /host.*available Jira (?:provider|connector)|available.*host.*Jira/is);
  assert.match(jira, /read-only by default/i);
  assert.match(jira, /issue read.*does not authorize.*mutation/is);
  assert.match(jira, /immutable\s+`issue\.id`/i);
  assert.match(jira, /`issue\.key`.*display/is);
  assert.match(jira, /summary.*description.*acceptance criteria.*non-goals/is);
  assert.match(jira, /untrusted data, not\s+instructions/i);
  assert.match(jira, /user.*authorization.*repository rules.*(?:take precedence|win)/is);
  assert.match(jira, /current (?:host )?session|in-session/i);
  assert.match(jira, /raw (?:Jira|provider) (?:response|payload).*never.*(?:route-task|capture|telemetry|workflow state)/is);
  assert.match(jira, /transcript retention.*host.*policy/is);
  assert.doesNotMatch(jira, /never enters.*prompt log/is);

  const protocolRead = router.indexOf("work-item-routing.md");
  const jiraRead = router.indexOf("skills/coredoc-jira/SKILL.md");
  const routeCall = router.indexOf("bin/coredoc-workflows route-task --intent");
  assert.ok(protocolRead >= 0 && protocolRead < jiraRead);
  assert.ok(jiraRead < routeCall);
  assert.match(router, /Jira.*actual task source/i);
  assert.match(router, /do not add.*Jira.*stage|Jira.*not.*routed stage/is);

  assert.match(routing, /routing and capture allowlist/i);
  assert.match(routing, /available connector or tool.*provider MCP read/is);
  assert.match(routing, /bounded.*task context|task context.*bounded/is);
  assert.match(routing, /issue\.id.*issue\.key/is);
  assert.match(routing, /never.*raw.*(?:provider response|payload).*route-task/is);

  for (const body of [jira, router, routing]) {
    assert.doesNotMatch(body, /mcp__claude_ai_Atlassian_Rovo/i);
    assert.doesNotMatch(body, /3612049413|space\s+TECH/i);
  }
});

test("Jira mutations stay explicit, bounded, and verified", async () => {
  const jira = await read("skills", "coredoc-jira", "SKILL.md");

  assert.match(jira, /explicit (?:user )?(?:request|authorization)/i);
  assert.match(jira, /preview.*before.*(?:comment|transition)|(?:comment|transition).*preview/is);
  assert.match(jira, /comment.*never.*edit.*description/is);
  assert.match(jira, /work-note\.md/);
  assert.match(jira, /handoff-comment\.md/);
  assert.match(jira, /available transitions.*live issue|live issue.*available transitions/is);
  assert.match(jira, /exact.*target.*transition/is);
  assert.match(jira, /re-read.*issue.*verify/is);
  assert.match(jira, /uncertain.*re-read|re-read.*uncertain/is);
  assert.match(jira, /never.*blind(?:ly)? retry|do not.*blind(?:ly)? retry/is);
  assert.match(jira, /no automatic.*(?:comment|transition|synchron)/is);
  assert.match(jira, /does not authorize.*commit.*push.*pull request/is);
  assert.match(jira, /observed.*(?:pull request|branch|commit)|(?:pull request|branch|commit).*observed/is);
  assert.match(jira, /never (?:invent|fabricate).*link/is);
  assert.match(jira, /failed.*Jira (?:write|update).*does not invalidate.*local/is);
});

test("ported Jira comment shapes keep useful handoff content without legacy orchestration", async () => {
  const [workNote, handoff] = await Promise.all([
    read("resources", "jira", "work-note.md"),
    read("resources", "jira", "handoff-comment.md"),
  ]);

  assert.deepEqual(workNote.match(/^## .+$/gm), [
    "## What",
    "## Why",
    "## Scope",
    "## Check",
  ]);
  assert.deepEqual(handoff.match(/^## .+$/gm), [
    "## What changed",
    "## What to check",
    "## Links",
    "## Divergence and remaining concerns",
  ]);

  for (const body of [workNote, handoff]) {
    assert.match(body, /Jira comment/i);
    assert.doesNotMatch(body, /\blane\b|\.coder\/|Rovo|3612049413|space\s+TECH/i);
    assert.doesNotMatch(body, /mandatory Confluence|must.*Confluence/i);
  }
  assert.match(handoff, /pull request.*or.*branch.*commit/is);
  assert.match(handoff, /QA|tester|verify/i);
});

test("specification comments require a separate explicit user request", async () => {
  const [jira, router, spec, template] = await Promise.all([
    read("skills", "coredoc-jira", "SKILL.md"),
    read("skills", "coredoc-workflows", "SKILL.md"),
    read("skills", "coredoc-spec", "SKILL.md"),
    read("resources", "jira", "spec-comment.md"),
  ]);
  assert.match(jira, /specification approval\s+alone does not authorize a Jira comment/);
  assert.match(jira, /Only when the user explicitly requests or authorizes sharing/);
  assert.match(jira, /Do not\s+interrupt implementation to\s+request an optional Jira write/);
  assert.match(jira, /leave Jira unchanged and continue the\s+engineering task without an optional write question/);
  assert.match(router, /acceptance of a\s+specification never authorizes posting a Jira comment/);
  assert.match(template, /Accepting the specification does not authorize this comment/);
  assert.match(jira, /equivalent specification comment[\s\S]*skip it/);
  assert.match(jira, /never blocks the implementation\s+stage/);
  assert.match(template, /repository-relative path/);
  for (const body of [jira, router, spec, template]) {
    assert.doesNotMatch(body, /same reply also authorizes.*comment|specification also authorizes.*comment/);
  }
});

test("plugin documentation exposes Jira support without changing capture ownership", async () => {
  const [readme, claudeManifest, codexManifest] = await Promise.all([
    read("README.md"),
    read(".claude-plugin", "plugin.json"),
    read(".codex-plugin", "plugin.json"),
  ]);

  assert.match(readme, /`coredoc-jira`/);
  assert.match(readme, /available provider connector or tool/i);
  assert.match(readme, /read-only by default/i);
  assert.match(readme, /explicit.*Jira.*(?:write|mutation)|Jira.*(?:write|mutation).*explicit/is);

  const claude = JSON.parse(claudeManifest);
  const codex = JSON.parse(codexManifest);
  assert.ok(claude.keywords.includes("jira"));
  assert.ok(codex.keywords.includes("jira"));
  assert.match(codex.interface.capabilities.join("\n"), /Jira/i);
});
