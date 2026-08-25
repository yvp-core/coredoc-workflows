import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "../../test/test-api.mjs";

import { translateClaudeCapability } from "./claude.mjs";

const REAL_USER_PROMPT_EXPANSION = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/claude-2.1.232-user-prompt-expansion.redacted.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

const AT = "2026-08-16T10:00:00.000Z";
const RUN_ID = "cdr-20260816-a1b2c3";
const PRIVATE = [
  "PROMPT_SENTINEL",
  "ARGS_SENTINEL",
  "COMMAND_SENTINEL",
  "RESULT_SENTINEL",
  "PATH_SENTINEL",
  "SOURCE_SENTINEL",
  "DIFF_SENTINEL",
  "TRANSCRIPT_SENTINEL",
  "SUMMARY_SENTINEL",
];

function hostile(overrides) {
  return {
    session_id: "session-42",
    prompt: PRIVATE[0],
    command_args: PRIVATE[1],
    tool_response: { content: PRIVATE[3] },
    cwd: `/private/${PRIVATE[4]}`,
    source: PRIVATE[5],
    diff: PRIVATE[6],
    transcript: PRIVATE[7],
    summary: PRIVATE[8],
    ...overrides,
  };
}

test("translates synthetic official-shape Claude capability hooks through an exact allowlist", () => {
  const fixtures = [
    [
      hostile({
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "coredoc-spec",
      }),
      { kind: "skill", capabilityId: "coredoc-spec", outcome: "unknown" },
    ],
    [
      hostile({
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: {
          skill: "foreign-plugin:review",
          args: PRIVATE[1],
          command: PRIVATE[2],
        },
      }),
      { kind: "skill", capabilityId: "foreign-plugin:review", outcome: "success" },
    ],
    [
      hostile({
        hook_event_name: "PostToolUseFailure",
        tool_name: "Skill",
        tool_input: {
          skill: "coredoc-tdd",
          args: PRIVATE[1],
          command: PRIVATE[2],
        },
      }),
      { kind: "skill", capabilityId: "coredoc-tdd", outcome: "failed" },
    ],
    [
      hostile({ hook_event_name: "SubagentStart", agent_type: "Explore" }),
      { kind: "agent", capabilityId: "Explore", outcome: "unknown" },
    ],
  ];

  for (const [payload, data] of fixtures) {
    const translated = translateClaudeCapability(payload, { at: AT, runId: RUN_ID });
    assert.deepEqual(translated, {
      sessionId: "session-42",
      event: {
        occurredAt: AT,
        type: "capability.used",
        runId: RUN_ID,
        data,
      },
    });
    for (const sentinel of PRIVATE) {
      assert.doesNotMatch(JSON.stringify(translated), new RegExp(sentinel));
    }
  }
});

test("translates the redacted genuine Claude 2.1.232 prompt-expansion fixture", () => {
  assert.deepEqual(REAL_USER_PROMPT_EXPANSION.provenance, {
    host: "claude-code",
    hostVersion: "2.1.232",
    capture: "real-cli-structurally-redacted",
  });

  const translated = translateClaudeCapability(REAL_USER_PROMPT_EXPANSION.payload, {
    at: AT,
  });
  assert.deepEqual(translated, {
    sessionId: "11111111-1111-4111-8111-111111111111",
    event: {
      occurredAt: AT,
      type: "capability.used",
      data: {
        kind: "skill",
        capabilityId: "coredoc-fixture:fixture-capability",
        outcome: "unknown",
      },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(translated),
    /PROMPT_SENTINEL|ARGS_SENTINEL|PATH_SENTINEL|TRANSCRIPT_SENTINEL/,
  );
});

test("keeps direct capabilities session-scoped and ignores unsafe or unrelated hooks", () => {
  assert.deepEqual(
    translateClaudeCapability(
      {
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "project-skill",
        session_id: "session-42",
      },
      { at: AT },
    ),
    {
      sessionId: "session-42",
      event: {
        occurredAt: AT,
        type: "capability.used",
        data: { kind: "skill", capabilityId: "project-skill", outcome: "unknown" },
      },
    },
  );

  for (const payload of [
    { hook_event_name: "SubagentStop", session_id: "session-42", agent_type: "Explore" },
    { hook_event_name: "PostToolUse", session_id: "session-42", tool_name: "Bash" },
    {
      hook_event_name: "PostToolUse",
      session_id: "session-42",
      tool_name: "Skill",
      tool_input: { skill: "bad skill name" },
    },
    {
      hook_event_name: "SubagentStart",
      session_id: "bad session id",
      agent_type: "Explore",
    },
  ]) {
    assert.equal(translateClaudeCapability(payload, { at: AT }), null);
  }
});
