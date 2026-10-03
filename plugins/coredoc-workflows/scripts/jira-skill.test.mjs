import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import test from "../test/test-api.mjs";

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const read = (...parts) => readFile(join(PLUGIN_ROOT, ...parts), "utf8");

// The Jira support was ported from one deployment. Its connector tool name only
// exists on one host, and its space, page and repository paths identify that
// deployment in a public repository.
test("Jira skill and resources carry no host- or deployment-specific identifiers", async () => {
  const files = [
    ["skills", "coredoc-jira", "SKILL.md"],
    ["skills", "coredoc-workflows", "SKILL.md"],
    ["resources", "methodology", "work-item-routing.md"],
    ["resources", "jira", "work-note.md"],
    ["resources", "jira", "handoff-comment.md"],
  ];

  for (const parts of files) {
    const body = await read(...parts);
    assert.doesNotMatch(body, /mcp__claude_ai_Atlassian_Rovo|\bRovo\b/i, parts.join("/"));
    assert.doesNotMatch(body, /3612049413|space\s+TECH|\.coder\//i, parts.join("/"));
  }
});

test("plugin manifests advertise Jira support", async () => {
  const [claudeManifest, codexManifest] = await Promise.all([
    read(".claude-plugin", "plugin.json"),
    read(".codex-plugin", "plugin.json"),
  ]);

  const claude = JSON.parse(claudeManifest);
  const codex = JSON.parse(codexManifest);
  assert.ok(claude.keywords.includes("jira"));
  assert.ok(codex.keywords.includes("jira"));
  assert.match(codex.interface.capabilities.join("\n"), /Jira/i);
});
