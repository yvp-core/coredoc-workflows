import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "../../test/test-api.mjs";

import { translateClaudeCapability, translateClaudeQuestions } from "./claude.mjs";

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

const ASK_ID = "71111111-1111-4111-8111-111111111111";
const TOKEN = `ghp_${"a1b2c3d4".repeat(4)}Z9y8`;

function askPayload(overrides = {}) {
  return hostile({
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    tool_input: {
      questions: [
        {
          question: "Should the migration backfill existing rows?",
          header: "Migration",
          multiSelect: false,
          options: [
            { label: "Backfill", description: "Rewrite existing rows" },
            { label: "Leave null", description: "Existing rows keep null" },
          ],
        },
        {
          question: "Which checks to run?",
          header: "Checks",
          multiSelect: true,
          options: [{ label: "typecheck" }, { label: "lint" }, { label: "tests" }],
        },
      ],
    },
    tool_response: {
      questions: [],
      answers: {
        "Should the migration backfill existing rows?": `Leave null, token ${TOKEN}`,
        "Which checks to run?": "typecheck, tests",
      },
      annotations: {},
      content: PRIVATE[3],
    },
    ...overrides,
  });
}

test("translates an answered AskUserQuestion into bounded, masked schema-4 events", () => {
  const translated = translateClaudeQuestions(askPayload(), {
    at: AT,
    runId: RUN_ID,
    stageId: "spec",
    askId: ASK_ID,
  });
  assert.equal(translated.sessionId, "session-42");
  assert.equal(translated.events.length, 2);
  const [first, second] = translated.events;
  assert.deepEqual(first, {
    occurredAt: AT,
    schemaVersion: 4,
    type: "workflow.question.answered",
    runId: RUN_ID,
    data: {
      askId: ASK_ID,
      questionIndex: 1,
      questionCount: 2,
      header: "Migration",
      question: "Should the migration backfill existing rows?",
      options: [
        { label: "Backfill", description: "Rewrite existing rows" },
        { label: "Leave null", description: "Existing rows keep null" },
      ],
      multiSelect: false,
      answer: first.data.answer,
      answerKind: "typed",
      stageId: "spec",
    },
  });
  assert.match(first.data.answer, /^Leave null, token ghp_\*+y8$/);
  assert.equal(second.data.questionIndex, 2);
  assert.equal(second.data.multiSelect, true);
  assert.equal(second.data.answer, "typecheck, tests");
  assert.equal(second.data.answerKind, "option");
  assert.deepEqual(second.data.options, [
    { label: "typecheck" },
    { label: "lint" },
    { label: "tests" },
  ]);
  const serialized = JSON.stringify(translated);
  assert.doesNotMatch(serialized, /ghp_a1b2c3d4a1b2/);
  for (const sentinel of PRIVATE) {
    assert.doesNotMatch(serialized, new RegExp(sentinel));
  }
});

test("keeps questions session-scoped and skips what carries no answer", () => {
  const sessionOnly = translateClaudeQuestions(askPayload(), { at: AT, askId: ASK_ID });
  assert.equal(sessionOnly.events[0].runId, undefined);
  assert.equal(sessionOnly.events[0].data.stageId, undefined);

  const partial = translateClaudeQuestions(
    askPayload({
      tool_response: { answers: { "Which checks to run?": "lint" } },
    }),
    { at: AT, askId: ASK_ID },
  );
  assert.equal(partial.events.length, 1);
  assert.equal(partial.events[0].data.questionIndex, 2);
  assert.equal(partial.events[0].data.answerKind, "option");

  assert.equal(
    translateClaudeQuestions(askPayload({ tool_response: { answers: {} } }), { at: AT }),
    null,
  );
  assert.equal(
    translateClaudeQuestions(askPayload({ hook_event_name: "PostToolUseFailure" }), { at: AT }),
    null,
  );
  assert.equal(
    translateClaudeQuestions(askPayload({ tool_name: "Skill" }), { at: AT }),
    null,
  );
  assert.equal(
    translateClaudeQuestions(
      askPayload({
        tool_input: {
          questions: Array.from({ length: 5 }, (_, index) => ({
            question: `q${index}`,
            options: [],
          })),
        },
      }),
      { at: AT },
    ),
    null,
  );
  assert.equal(
    translateClaudeQuestions(askPayload({ session_id: "../escape" }), { at: AT }),
    null,
  );
});

test("bounds oversized question text and options before they reach the contract", () => {
  const translated = translateClaudeQuestions(
    askPayload({
      tool_input: {
        questions: [
          {
            question: "q".repeat(900),
            header: "h".repeat(50),
            options: Array.from({ length: 14 }, (_, index) => ({
              label: `option ${index}`,
              description: "d".repeat(400),
            })),
          },
        ],
      },
      tool_response: { answers: { ["q".repeat(900)]: "a".repeat(900) } },
    }),
    { at: AT, askId: ASK_ID },
  );
  const { data } = translated.events[0];
  assert.equal(data.question.length, 500);
  assert.equal(data.header.length, 32);
  assert.equal(data.answer.length, 500);
  assert.equal(data.options.length, 10);
  assert.equal(data.options[0].description.length, 300);
  assert.equal(data.answerKind, "typed");
});
