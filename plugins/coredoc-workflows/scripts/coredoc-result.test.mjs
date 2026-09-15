import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "../test/test-api.mjs";

import {
  OVERLAY_STATUS_RESULTS,
  POSITIVE_MARKERS,
  RESULT_TABLE,
  STATUS_RESULTS,
  isIntentTool,
  normalizeCoredocResult,
} from "./coredoc-result.mjs";

const FIXTURES = new URL("./hosts/fixtures/gates/", import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8"));
}

function normalizeFixture(name) {
  const { payload } = fixture(name);
  return normalizeCoredocResult({
    hookName: payload.hook_event_name,
    tool: payload.tool_name.slice(payload.tool_name.indexOf("__", 5) + 2),
    toolResponse: payload.tool_response,
    action: payload.tool_input?.action,
  });
}

// One test per row of the issue-01 normalisation table, driven from the table
// the module exports: a row that stops being covered stops being asserted.
for (const { row, sample, result } of RESULT_TABLE) {
  test(`coredoc-result: ${row} -> ${result}`, () => {
    assert.equal(normalizeCoredocResult(sample), result);
  });
}

test("coredoc-result: the table covers every documented status and marker", () => {
  const rows = RESULT_TABLE.map((entry) => entry.result);
  for (const result of Object.values(STATUS_RESULTS)) {
    assert.equal(rows.includes(result), true, `no table row answers ${result}`);
  }
  for (const result of Object.values(OVERLAY_STATUS_RESULTS)) {
    assert.equal(rows.includes(result), true, `no table row answers ${result}`);
  }
  assert.deepEqual(
    Object.keys(POSITIVE_MARKERS).filter((tool) => !isIntentTool(tool)),
    [],
    "positive markers only exist for intent tools",
  );
});

test("coredoc-result: every intent tool with a marker reaches ok, and only with it", () => {
  const positives = {
    get_intent_context: { items: [] },
    intent_propose: { items: [{ outcome: "created_candidate" }] },
    intent_review: { decisions: [] },
    intent_release: { contentHash: "abc" },
    intent_anchor: { anchors: [] },
    intent_tree: { id: "dom-workflow" },
  };
  for (const [tool, body] of Object.entries(positives)) {
    const toolResponse = [{ type: "text", text: JSON.stringify(body) }];
    assert.equal(
      normalizeCoredocResult({ hookName: "PostToolUse", tool, toolResponse }),
      "ok",
      tool,
    );
    assert.equal(
      normalizeCoredocResult({
        hookName: "PostToolUse",
        tool,
        toolResponse: [{ type: "text", text: '{"unexpected":true}' }],
      }),
      "unknown",
      tool,
    );
  }
  // intent_handoff's marker depends on the action it was called with.
  for (const [action, body] of [
    ["get", { id: "h1", version: 1 }],
    ["list", { operations: [] }],
    ["save", { id: "h1", version: 2, mapping: {}, delivery: {} }],
  ]) {
    const toolResponse = [{ type: "text", text: JSON.stringify(body) }];
    assert.equal(
      normalizeCoredocResult({
        hookName: "PostToolUse",
        tool: "intent_handoff",
        toolResponse,
        action,
      }),
      "ok",
      action,
    );
    // The same body under no action cannot be recognised.
    assert.equal(
      normalizeCoredocResult({
        hookName: "PostToolUse",
        tool: "intent_handoff",
        toolResponse,
      }),
      "unknown",
      action,
    );
  }
});

test("coredoc-result: an intent tool without a marker row never answers ok", () => {
  assert.equal(
    normalizeCoredocResult({
      hookName: "PostToolUse",
      tool: "intent_future_tool",
      toolResponse: [{ type: "text", text: '{"anything":true}' }],
    }),
    "unknown",
  );
});

test("coredoc-result: both host wrapper shapes are read the same way", () => {
  const claude = fixture("claude-2.1.272-mcp-get-intent-context-ok.json");
  const codex = fixture("codex-0.150.1-mcp-get-intent-context-ok.json");
  assert.equal(Array.isArray(claude.payload.tool_response), true);
  assert.equal(Array.isArray(codex.payload.tool_response.content), true);
  assert.equal(normalizeFixture("claude-2.1.272-mcp-get-intent-context-ok.json"), "ok");
  assert.equal(normalizeFixture("codex-0.150.1-mcp-get-intent-context-ok.json"), "ok");
});

test("coredoc-result: real and synthetic fixtures normalise as documented", () => {
  for (const [name, expected] of [
    ["claude-2.1.272-mcp-get-intent-context-invalid-limit.json", "error"],
    ["codex-0.150.1-mcp-get-intent-context-invalid-limit.json", "error"],
    ["claude-2.1.272-mcp-search-symbols-ok.json", "ok"],
    ["codex-0.150.1-mcp-search-symbols-ok.json", "ok"],
    ["claude-2.1.272-mcp-search-symbols-bad-scope-failure.json", "error"],
    ["synthetic-cloud-intent-propose-created.json", "ok"],
    ["synthetic-cloud-permission-denied.json", "denied"],
    ["synthetic-cloud-not-configured.json", "not_configured"],
    ["synthetic-local-overlay-invalid.json", "invalid"],
    ["synthetic-local-overlay-not-configured.json", "not_configured"],
    ["synthetic-cloud-intent-handoff-get.json", "ok"],
    ["synthetic-cloud-intent-handoff-list-empty.json", "ok"],
    ["synthetic-cloud-intent-handoff-save.json", "ok"],
    ["synthetic-mcp-is-error-envelope.json", "error"],
  ]) {
    assert.equal(normalizeFixture(name), expected, name);
  }
});

test("coredoc-result: every synthetic fixture names the source it was derived from", () => {
  const names = readdirSync(FIXTURES).filter((name) =>
    name.startsWith("synthetic-"),
  );
  assert.equal(names.length > 0, true);
  for (const name of names) {
    const { provenance } = fixture(name);
    assert.equal(provenance.capture, "synthetic-from-server-source", name);
    assert.match(provenance.source, /\.ts:\d+/, name);
  }
});
