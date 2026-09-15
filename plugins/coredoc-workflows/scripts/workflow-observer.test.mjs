import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "../test/test-api.mjs";
import { pathToFileURL } from "node:url";

import {
  captureSchemaVersionAccepted,
  firstCommandToken,
  hookObservation,
  observeHookEvent,
  proposeSpecMatch,
  verificationKind,
} from "./workflow-observer.mjs";
import {
  readWorkflowObservations,
  readWorkflowRun,
  startWorkflowRun,
  startWorkflowStage,
  suspendWorkflowRun,
} from "./workflow-run-state.mjs";

const AT = "2026-07-31T10:00:00.000Z";
const RUN_ID = "cdr-20260731-a1b2c3";
const TARGET =
  "https://capture.invalid/api/v1/workspaces/ws-1/capture/v1/events";

function testEnvironment(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    captureDirectory: join(root, "capture"),
    env: {
      COREDOC_CAPTURE_ENDPOINT: TARGET,
      COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
      COREDOC_WORKFLOWS_CAPTURE_DIR: join(root, "capture"),
      COREDOC_WORKFLOWS_REPO_KEY: "coredoc/coredoc-parser",
      COREDOC_WORKFLOWS_STATE_DIR: join(root, "runs"),
    },
  };
}

function storedCaptureEvents(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".event.json"))
    .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")).event);
}

test("supported plugin hooks cover skills, failures, agents, and session lifecycle", () => {
  const pluginManifest = JSON.parse(
    readFileSync(
      new URL("../.claude-plugin/plugin.json", import.meta.url),
      "utf8",
    ),
  );
  const hookManifest = JSON.parse(
    readFileSync(new URL("../hooks/hooks.json", import.meta.url), "utf8"),
  );
  assert.equal(pluginManifest.hooks, undefined);
  const hooks = hookManifest.hooks;
  assert.match(hooks.PostToolUse[0].matcher, /(?:^|\|)Skill(?:\||$)/);
  assert.match(
    hooks.PostToolUseFailure[0].matcher,
    /(?:^|\|)Skill(?:\||$)/,
  );
  // An answered question is observed; a failed or cancelled one has no answer to record.
  assert.match(hooks.PostToolUse[0].matcher, /(?:^|\|)AskUserQuestion(?:\||$)/);
  // Repository searches are observed so an MCP gate can report what was used
  // instead; a failed search has nothing to report.
  for (const tool of ["Grep", "Glob", "Read"]) {
    assert.match(
      hooks.PostToolUse[0].matcher,
      new RegExp(`(?:^|\\|)${tool}(?:\\||$)`),
    );
    assert.doesNotMatch(hooks.PostToolUseFailure[0].matcher, new RegExp(tool));
  }
  assert.doesNotMatch(hooks.PostToolUseFailure[0].matcher, /AskUserQuestion/);
  for (const hookName of ["PostToolUse", "PostToolUseFailure"]) {
    const matcher = new RegExp(`^(?:${hooks[hookName][0].matcher})$`);
    for (const searchTool of ["Grep", "Glob", "Read"]) {
      assert.equal(
        matcher.test(searchTool),
        hookName === "PostToolUse",
        `${searchTool} on ${hookName}`,
      );
    }
    assert.equal(matcher.test("mcp__coredoc__find_callers"), true);
    assert.equal(matcher.test("mcp__coredoc-local__describe_repository"), true);
    assert.equal(matcher.test("mcp__claude_ai_Coredoc__find_callers"), true);
    assert.equal(
      matcher.test("mcp__plugin_coredoc_cloud__describe_repository"),
      true,
    );
    assert.equal(matcher.test("mcp__coredocument__find_callers"), false);
  }
  assert.equal(hooks.UserPromptExpansion.length, 1);
  assert.equal(hooks.SubagentStart.length, 1);
  // Environment, relay, and pending flush run for every start; the run summary
  // only for a session that may have lost its memory of an open run.
  assert.equal(hooks.SessionStart.length, 2);
  assert.equal(hooks.SessionStart[1].matcher, "resume|compact");
  assert.deepEqual(hooks.SessionStart[1].hooks, [
    {
      type: "command",
      command: '"${CLAUDE_PLUGIN_ROOT}/bin/coredoc-workflows" session-start',
    },
  ]);
  assert.equal(hooks.SessionEnd.length, 1);
  // No real Claude fixture currently proves that Skill Pre/Post hooks share a
  // stable tool-use identity, so stage intervals remain deliberately unavailable.
  assert.equal(hooks.PreToolUse, undefined);

  for (const hookName of [
    "PostToolUse",
    "PostToolUseFailure",
    "UserPromptExpansion",
    "SubagentStart",
  ]) {
    assert.deepEqual(hooks[hookName][0].hooks, [
      {
        type: "command",
        command:
          '"${CLAUDE_PLUGIN_ROOT}/bin/coredoc-workflows" workflow-observer',
      },
    ]);
  }
  assert.doesNotMatch(JSON.stringify(hookManifest), /additionalContext/);
});

test("classifies ordinary repository verification without retaining its command", () => {
  for (const [command, expected] of [
    ["pnpm test", "test"],
    ["pnpm --filter @coredoc/server typecheck", "typecheck"],
    ["pnpm check:fix", "check"],
    ["pnpm build", "build"],
    ["git status --short", null],
  ]) {
    assert.equal(verificationKind(command), expected);
  }

  const observation = hookObservation(
    {
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "pnpm test --token private" },
      error: "full tool output must not be copied",
    },
    AT,
  );
  assert.deepEqual(observation, {
    type: "verify",
    at: AT,
    kind: "test",
    success: false,
  });
  assert.doesNotMatch(JSON.stringify(observation), /pnpm|private|tool output/);
});

test("records successful edits but not failed edit attempts", () => {
  assert.deepEqual(
    hookObservation(
      { hook_event_name: "PostToolUse", tool_name: "Edit" },
      AT,
    ),
    { type: "edit", at: AT },
  );
  assert.equal(
    hookObservation(
      { hook_event_name: "PostToolUseFailure", tool_name: "Edit" },
      AT,
    ),
    null,
  );
});

test("counts exact Coredoc MCP tool outcomes without retaining responses", () => {
  for (const [toolName, tool] of [
    ["mcp__coredoc__find_callers", "find_callers"],
    ["mcp__coredoc-local__describe_repository", "describe_repository"],
    ["mcp__claude_ai_Coredoc__find_callers", "find_callers"],
    ["mcp__plugin_coredoc_cloud__describe_repository", "describe_repository"],
  ]) {
    assert.deepEqual(
      hookObservation(
        {
          hook_event_name: "PostToolUse",
          tool_name: toolName,
          tool_response: { content: "source-like response" },
        },
        AT,
      ),
      { type: "coredoc", at: AT, success: true, tool, access: "read", result: "ok" },
    );
  }
  for (const toolName of [
    "mcp__coredocument__find_callers",
    "mcp__other__find_callers",
  ]) {
    assert.equal(
      hookObservation(
        { hook_event_name: "PostToolUse", tool_name: toolName },
        AT,
      ),
      null,
    );
  }
});

test("records every valid Skill tool invocation without retaining arguments or output", () => {
  const observation = hookObservation(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: {
        skill: "foreign-plugin:review",
        args: "private task arguments",
      },
      tool_response: { content: "expanded private skill prompt" },
    },
    AT,
  );

  assert.deepEqual(observation, {
    type: "skill",
    at: AT,
    skillId: "foreign-plugin:review",
  });
  assert.doesNotMatch(JSON.stringify(observation), /private|expanded|args/);
});

test("records direct slash skill expansion and rejects unsafe identifiers", () => {
  assert.deepEqual(
    hookObservation(
      {
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "project-skill",
        command_args: "private arguments",
        prompt: "/project-skill private arguments",
      },
      AT,
    ),
    { type: "skill", at: AT, skillId: "project-skill" },
  );
  assert.equal(
    hookObservation(
      {
        hook_event_name: "UserPromptExpansion",
        expansion_type: "mcp_prompt",
        command_name: "foreign-prompt",
      },
      AT,
    ),
    null,
  );
  assert.equal(
    hookObservation(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: { skill: `bad\n${"x".repeat(80)}` },
      },
      AT,
    ),
    null,
  );
});

test("records a direct synthetic skill capability without fabricating a workflow run", () => {
  const { captureDirectory, env } = testEnvironment(
    "coredoc-claude-direct-capability-",
  );
  const privateValues = [
    "PROMPT_SENTINEL",
    "ARGS_SENTINEL",
    "RESULT_SENTINEL",
    "COMMAND_SENTINEL",
    "PATH_SENTINEL",
    "SOURCE_SENTINEL",
    "DIFF_SENTINEL",
    "TRANSCRIPT_SENTINEL",
    "SUMMARY_SENTINEL",
  ];

  const result = observeHookEvent(
    {
      hook_event_name: "UserPromptExpansion",
      expansion_type: "slash_command",
      command_name: "project-skill",
      command_args: privateValues[1],
      tool_input: { command: privateValues[3] },
      tool_response: { content: privateValues[2] },
      prompt: privateValues[0],
      cwd: `/private/${privateValues[4]}`,
      source: privateValues[5],
      diff: privateValues[6],
      transcript_path: `/private/${privateValues[7]}`,
      summary: privateValues[8],
      session_id: "session-direct",
    },
    { env, at: AT },
  );

  assert.deepEqual(result, { status: "inactive" });
  assert.equal(readWorkflowRun("session-direct", { env }), null);
  const events = storedCaptureEvents(captureDirectory);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    schemaVersion: 1,
    eventId: events[0].eventId,
    occurredAt: AT,
    host: "claude-code",
    sessionId: "session-direct",
    repositoryKey: "coredoc/coredoc-parser",
    type: "capability.used",
    data: {
      kind: "skill",
      capabilityId: "project-skill",
      outcome: "unknown",
    },
  });
  for (const value of privateValues) {
    assert.doesNotMatch(
      readFileSync(
        join(captureDirectory, `${events[0].eventId}.event.json`),
        "utf8",
      ),
      new RegExp(value),
    );
  }
});

test("uses the active run for capability correlation and preserves local skill evidence", () => {
  const { captureDirectory, env } = testEnvironment(
    "coredoc-claude-active-capability-",
  );
  startWorkflowRun(
    {
      sessionId: "session-active",
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: AT,
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );

  assert.deepEqual(
    observeHookEvent(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Skill",
        tool_input: { skill: "coredoc-tdd", args: "ARGS_SENTINEL" },
        tool_response: { content: "RESULT_SENTINEL" },
        session_id: "session-active",
      },
      { env, at: AT },
    ),
    {
      status: "recorded",
      event: { type: "skill", at: AT, skillId: "coredoc-tdd" },
    },
  );
  assert.deepEqual(readWorkflowObservations("session-active", { env }), [
    { type: "skill", at: AT, skillId: "coredoc-tdd" },
  ]);
  assert.equal(readWorkflowRun("session-active", { env }).runId, RUN_ID);
  const [captured] = storedCaptureEvents(captureDirectory);
  assert.equal(captured.runId, RUN_ID);
  assert.deepEqual(captured.data, {
    kind: "skill",
    capabilityId: "coredoc-tdd",
    outcome: "success",
  });
  assert.doesNotMatch(JSON.stringify(captured), /ARGS_SENTINEL|RESULT_SENTINEL/);
});

test("frequent capability observation records locally without flushing", () => {
  let flushCalls = 0;
  const recorded = [];
  const stateDirectory = mkdtempSync(
    join(tmpdir(), "coredoc-claude-agent-state-"),
  );
  const env = {
    COREDOC_CAPTURE_ENDPOINT: TARGET,
    COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
    COREDOC_WORKFLOWS_CAPTURE_DIR: "/tmp/not-used",
    COREDOC_WORKFLOWS_STATE_DIR: stateDirectory,
  };
  const result = observeHookEvent(
    {
      hook_event_name: "SubagentStart",
      agent_type: "Explore",
      agent_id: "private-agent-id",
      transcript_path: "/private/transcript",
      session_id: "session-agent",
    },
    {
      env,
      at: AT,
      createRecorder: () => ({
        record: (event) => {
          recorded.push(event);
          return { status: "queued", eventId: "event-1", pending: 1 };
        },
        flush: () => {
          flushCalls += 1;
        },
      }),
    },
  );

  assert.deepEqual(result, { status: "ignored" });
  assert.equal(flushCalls, 0);
  assert.equal(readWorkflowRun("session-agent", { env }), null);
  assert.deepEqual(recorded, [
    {
      occurredAt: AT,
      type: "capability.used",
      data: { kind: "agent", capabilityId: "Explore", outcome: "unknown" },
    },
  ]);
});

test("capture configuration failure does not suppress active local skill evidence", () => {
  const { env } = testEnvironment("coredoc-claude-capture-failure-");
  env.COREDOC_CAPTURE_HEADERS = "";
  startWorkflowRun(
    {
      sessionId: "session-capture-failure",
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: AT,
    },
    {
      env,
      snapshot: () => ({
        available: false,
        repoRoot: "",
        head: "",
        fingerprint: "",
      }),
    },
  );

  const result = observeHookEvent(
    {
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "coredoc-tdd" },
      session_id: "session-capture-failure",
    },
    { env, at: AT },
  );

  assert.equal(result.status, "recorded");
  assert.deepEqual(
    readWorkflowObservations("session-capture-failure", { env }),
    [{ type: "skill", at: AT, skillId: "coredoc-tdd" }],
  );
});

test("frequent hook CLI is silent and never executes Git", () => {
  const root = mkdtempSync(join(tmpdir(), "coredoc-claude-hook-silent-"));
  const gitSentinel = join(root, "git-called");
  const fetchSentinel = join(root, "fetch-called");
  const fetchGuard = join(root, "fetch-guard.mjs");
  const executableRoot = mkdtempSync(
    join(tmpdir(), "coredoc-claude-hook-path-"),
  );
  const fakeGit = join(executableRoot, "git");
  writeFileSync(fakeGit, '#!/bin/sh\n: > "$GIT_SENTINEL"\n', "utf8");
  chmodSync(fakeGit, 0o700);
  writeFileSync(
    fetchGuard,
    [
      'import { writeFileSync } from "node:fs";',
      "globalThis.fetch = async () => {",
      '  writeFileSync(process.env.FETCH_SENTINEL, "called\\n");',
      '  throw new Error("frequent hook attempted network");',
      "};",
    ].join("\n"),
    "utf8",
  );

  const child = spawnSync(
    process.execPath,
    [new URL("./workflow-observer.mjs", import.meta.url).pathname],
    {
      encoding: "utf8",
      input: JSON.stringify({
        hook_event_name: "UserPromptExpansion",
        expansion_type: "slash_command",
        command_name: "project-skill",
        prompt: "PROMPT_SENTINEL",
        session_id: "session-silent",
      }),
      env: {
        ...process.env,
        PATH: executableRoot,
        NODE_OPTIONS: `--import=${pathToFileURL(fetchGuard).href}`,
        GIT_SENTINEL: gitSentinel,
        FETCH_SENTINEL: fetchSentinel,
        COREDOC_CAPTURE_ENDPOINT: TARGET,
        COREDOC_CAPTURE_HEADERS: "Authorization=Bearer capture-token",
        COREDOC_WORKFLOWS_CAPTURE_DIR: join(root, "capture"),
        COREDOC_WORKFLOWS_STATE_DIR: join(root, "runs"),
      },
    },
  );

  assert.equal(child.status, 0);
  assert.equal(child.stdout, "");
  assert.equal(child.stderr, "");
  assert.equal(existsSync(gitSentinel), false);
  assert.equal(existsSync(fetchSentinel), false);
  assert.equal(storedCaptureEvents(join(root, "capture")).length, 1);
});

const MANAGED_TARGET = "http://127.0.0.1:43181/capture/v1/events";

function askUserQuestionHook(sessionId) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "AskUserQuestion",
    session_id: sessionId,
    cwd: "/private/PATH_SENTINEL",
    transcript_path: "/private/TRANSCRIPT_SENTINEL",
    tool_input: {
      questions: [
        {
          question: "Backfill existing rows?",
          header: "Migration",
          multiSelect: false,
          options: [{ label: "Yes" }, { label: "No", description: "Leave null" }],
        },
      ],
    },
    tool_response: {
      questions: [],
      answers: { "Backfill existing rows?": "No" },
      annotations: {},
      content: "RESULT_SENTINEL",
    },
  };
}

test("records an answered question locally as a schema-4 event without flushing", () => {
  const { captureDirectory, env } = testEnvironment("coredoc-claude-question-");
  env.COREDOC_CAPTURE_QUESTIONS = "1";
  const result = observeHookEvent(askUserQuestionHook("session-ask"), { env, at: AT });

  // The question is capture evidence, not a local completion observation.
  assert.deepEqual(result, { status: "ignored" });
  assert.equal(readWorkflowRun("session-ask", { env }), null);
  const [captured] = storedCaptureEvents(captureDirectory);
  assert.equal(captured.schemaVersion, 4);
  assert.equal(captured.type, "workflow.question.answered");
  assert.equal(captured.sessionId, "session-ask");
  assert.equal(captured.runId, undefined);
  assert.equal(captured.data.question, "Backfill existing rows?");
  assert.equal(captured.data.answer, "No");
  assert.equal(captured.data.answerKind, "option");
  assert.equal(captured.data.stageId, undefined);
  assert.doesNotMatch(
    JSON.stringify(captured),
    /PATH_SENTINEL|TRANSCRIPT_SENTINEL|RESULT_SENTINEL/,
  );
});

test("correlates a question with the active run and its open stage", () => {
  const { captureDirectory, env } = testEnvironment("coredoc-claude-question-run-");
  env.COREDOC_CAPTURE_QUESTIONS = "1";
  const snapshot = () => ({ available: false, repoRoot: "", head: "", fingerprint: "" });
  startWorkflowRun(
    {
      sessionId: "session-ask-run",
      runId: RUN_ID,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "spec", after: [] }],
      at: AT,
    },
    { env, snapshot },
  );
  startWorkflowStage("session-ask-run", "spec", { at: AT }, { env });

  observeHookEvent(askUserQuestionHook("session-ask-run"), { env, at: AT });
  const captured = storedCaptureEvents(captureDirectory).find(
    (event) => event.type === "workflow.question.answered",
  );
  assert.equal(captured.runId, RUN_ID);
  assert.equal(captured.data.stageId, "spec");
});

test("records a managed-relay question only when SessionStart exported schema 4", () => {
  assert.equal(captureSchemaVersionAccepted({ COREDOC_CAPTURE_ENDPOINT: TARGET }, 4), true);
  assert.equal(captureSchemaVersionAccepted({ COREDOC_CAPTURE_ENDPOINT: MANAGED_TARGET }, 4), false);
  assert.equal(
    captureSchemaVersionAccepted(
      { COREDOC_CAPTURE_ENDPOINT: MANAGED_TARGET, COREDOC_CAPTURE_ACCEPTED_SCHEMA_VERSIONS: "1,2,3" },
      4,
    ),
    false,
  );
  assert.equal(
    captureSchemaVersionAccepted(
      { COREDOC_CAPTURE_ENDPOINT: MANAGED_TARGET, COREDOC_CAPTURE_ACCEPTED_SCHEMA_VERSIONS: "1,2,3,4" },
      4,
    ),
    true,
  );

  const recorded = [];
  const stateDirectory = mkdtempSync(join(tmpdir(), "coredoc-claude-question-gate-"));
  const managedEnv = {
    COREDOC_CAPTURE_QUESTIONS: "1",
    COREDOC_CAPTURE_ENDPOINT: MANAGED_TARGET,
    COREDOC_CAPTURE_HEADERS:
      "X-Coredoc-Relay-Binding=local_binding_abcdefghijklmnopqrstuvwxyz012345",
    COREDOC_CAPTURE_WORKSPACE_ID: "ws-1",
    COREDOC_WORKFLOWS_REPO_KEY: "coredoc/coredoc-parser",
    COREDOC_WORKFLOWS_STATE_DIR: stateDirectory,
  };
  const createRecorder = () => ({
    record: (event) => {
      recorded.push(event);
      return { status: "queued", eventId: "event-1", pending: 1 };
    },
    flush: () => {
      throw new Error("frequent hooks must not flush");
    },
  });
  observeHookEvent(askUserQuestionHook("session-gated"), { env: managedEnv, at: AT, createRecorder });
  assert.deepEqual(recorded, []);

  observeHookEvent(askUserQuestionHook("session-gated"), {
    env: { ...managedEnv, COREDOC_CAPTURE_ACCEPTED_SCHEMA_VERSIONS: "1,2,3,4" },
    at: AT,
    createRecorder,
  });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].schemaVersion, 4);
  assert.equal(recorded[0].data.answer, "No");
});

test("question prose stays disabled unless explicitly enabled, even with capture configured", () => {
  for (const value of [undefined, "", "0", "true"]) {
    const { captureDirectory, env } = testEnvironment("coredoc-question-off-");
    if (value !== undefined) env.COREDOC_CAPTURE_QUESTIONS = value;
    observeHookEvent(askUserQuestionHook("session-private"), { env, at: AT });
    assert.equal(existsSync(captureDirectory), false, String(value));
  }
});

test("an observation in a resumed session reactivates its suspended run", () => {
  const { env } = testEnvironment("coredoc-claude-suspended-observation-");
  startWorkflowRun(
    {
      sessionId: "session-resumed",
      runId: RUN_ID,
      workflowId: "change:normal",
      intent: "change",
      risk: "normal",
      at: AT,
    },
    {
      env,
      snapshot: () => ({ available: false, repoRoot: "", head: "", fingerprint: "" }),
    },
  );
  suspendWorkflowRun(
    "session-resumed",
    { at: "2026-07-31T10:05:00.000Z" },
    {
      env,
      snapshot: () => ({ available: false, repoRoot: "", head: "", fingerprint: "" }),
    },
  );
  const result = observeHookEvent(
    {
      hook_event_name: "PostToolUse",
      session_id: "session-resumed",
      tool_name: "Edit",
    },
    { env, at: "2026-07-31T11:00:00.000Z" },
  );
  assert.equal(result.status, "recorded");
  assert.equal(readWorkflowRun("session-resumed", { env }).status, "active");
  assert.deepEqual(readWorkflowObservations("session-resumed", { env }), [
    { type: "edit", at: "2026-07-31T11:00:00.000Z" },
  ]);
});

/* --------------------------------------------- issue 01: gate evidence --- */

const GATE_FIXTURES = new URL("./hosts/fixtures/gates/", import.meta.url);

function gateFixture(name) {
  return JSON.parse(readFileSync(new URL(name, GATE_FIXTURES), "utf8")).payload;
}

function startedRun(sessionId, env, extra = {}) {
  startWorkflowRun(
    {
      sessionId,
      runId: RUN_ID,
      workflowId: "change:large:normal",
      intent: "change",
      risk: "normal",
      declaredStages: [{ stageId: "spec", after: [] }],
      at: AT,
    },
    {
      env,
      snapshot: () => ({ available: false, repoRoot: "", head: "", fingerprint: "" }),
    },
  );
  if (Object.keys(extra).length === 0) return;
  // `route-task` stores repositoryKey/specRef on the run in issue 02; until then
  // the test writes what that issue will write.
  const file = join(
    env.COREDOC_WORKFLOWS_STATE_DIR,
    `${createHash("sha256").update(sessionId).digest("hex")}.json`,
  );
  writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...extra }),
  );
}

test("records the tool, its access class, and the normalised result on both hosts", () => {
  for (const [name, expected] of [
    [
      "claude-2.1.272-mcp-get-intent-context-ok.json",
      { type: "coredoc", at: AT, success: true, tool: "get_intent_context", access: "read", result: "ok" },
    ],
    [
      "claude-2.1.272-mcp-get-intent-context-invalid-limit.json",
      { type: "coredoc", at: AT, success: true, tool: "get_intent_context", access: "read", result: "error" },
    ],
    [
      "claude-2.1.272-mcp-search-symbols-bad-scope-failure.json",
      { type: "coredoc", at: AT, success: false, tool: "search_symbols", access: "read", result: "error" },
    ],
    // Codex spells the same server with an underscore and wraps the content blocks
    // in the raw MCP result object; neither may change what is recorded.
    [
      "codex-0.150.1-mcp-get-intent-context-ok.json",
      { type: "coredoc", at: AT, success: true, tool: "get_intent_context", access: "read", result: "ok" },
    ],
    [
      "codex-0.150.1-mcp-search-symbols-ok.json",
      { type: "coredoc", at: AT, success: true, tool: "search_symbols", access: "read", result: "ok" },
    ],
  ]) {
    assert.deepEqual(hookObservation(gateFixture(name), AT), expected, name);
  }
});

test("COREDOC_TOOL_RE matches both hosts' spellings of the same server", () => {
  for (const name of [
    "claude-2.1.272-mcp-search-symbols-ok.json",
    "codex-0.150.1-mcp-search-symbols-ok.json",
  ]) {
    const observation = hookObservation(gateFixture(name), AT);
    assert.equal(observation.type, "coredoc", name);
    assert.equal(observation.tool, "search_symbols", name);
  }
});

test("classifies an unknown Coredoc tool as a write and flags it", () => {
  assert.deepEqual(
    hookObservation(
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__coredoc__intent_teleport",
        tool_input: { anything: "PRIVATE_SENTINEL" },
        tool_response: [{ type: "text", text: '{"ok":true}' }],
      },
      AT,
    ),
    {
      type: "coredoc",
      at: AT,
      success: true,
      tool: "intent_teleport",
      access: "write",
      result: "unknown",
      unclassified: true,
    },
  );
  // A tool name the recorder cannot vouch for is never guessed at.
  assert.deepEqual(
    hookObservation(
      {
        hook_event_name: "PostToolUse",
        tool_name: "mcp__coredoc__Not A Tool",
        tool_response: [{ type: "text", text: "{}" }],
      },
      AT,
    ),
    {
      type: "coredoc",
      at: AT,
      success: true,
      tool: "unknown",
      access: "write",
      result: "unknown",
      unclassified: true,
    },
  );
});

test("intent_handoff access follows the action it was called with", () => {
  for (const [name, access] of [
    ["synthetic-cloud-intent-handoff-get.json", "read"],
    ["synthetic-cloud-intent-handoff-list-empty.json", "read"],
    ["synthetic-cloud-intent-handoff-save.json", "write"],
  ]) {
    const observation = hookObservation(gateFixture(name), AT);
    assert.equal(observation.tool, "intent_handoff", name);
    assert.equal(observation.access, access, name);
    assert.equal(observation.result, "ok", name);
    assert.equal(observation.unclassified, undefined, name);
  }
});

test("records repository searches from both hosts without their queries", () => {
  for (const [name, tool] of [
    ["claude-2.1.272-grep.json", "Grep"],
    ["claude-2.1.272-glob.json", "Glob"],
    ["claude-2.1.272-read.json", "Read"],
    ["claude-2.1.272-bash-rg-version.json", "Bash"],
    // Codex has no Grep/Glob tool: a search is a shell command. Its pattern may
    // contain the word "test" (this real capture's needle does) without turning
    // the search into a verification run.
    ["codex-0.150.1-grep.json", "Bash"],
    ["codex-0.150.1-glob.json", "Bash"],
    ["codex-0.150.1-bash-rg-version.json", "Bash"],
  ]) {
    const observation = hookObservation(gateFixture(name), AT);
    assert.deepEqual(observation, { type: "search", at: AT, tool }, name);
    assert.doesNotMatch(JSON.stringify(observation), /needle|sample|ripgrep/);
  }
  // Codex answers "read this file" with `cat`, which is not a repository search.
  assert.equal(hookObservation(gateFixture("codex-0.150.1-read.json"), AT), null);
  // `apply_patch` (Codex's Write/Edit) is not translated by the Claude host
  // adapter today, so it is neither an edit observation nor a capability.
  for (const name of ["codex-0.150.1-write.json", "codex-0.150.1-edit.json"]) {
    assert.equal(hookObservation(gateFixture(name), AT), null, name);
  }
});

test("verification keeps precedence over the search classification", () => {
  // `echo pnpm test` is what `verificationKind` calls a test run: the classifier
  // reads the command string, not what the shell would actually do. Both hosts
  // therefore record a verify observation, never a search.
  for (const name of [
    "claude-2.1.272-bash-echo-pnpm-test.json",
    "codex-0.150.1-bash-echo-pnpm-test.json",
  ]) {
    assert.deepEqual(
      hookObservation(gateFixture(name), AT),
      { type: "verify", at: AT, kind: "test", success: true },
      name,
    );
  }
  // A command whose FIRST token is a search binary is a search whatever its
  // pattern says; anything else keeps the verification classification.
  const bash = (command) =>
    hookObservation(
      { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command } },
      AT,
    );
  assert.deepEqual(bash("rg 'test' src/"), { type: "search", at: AT, tool: "Bash" });
  assert.deepEqual(bash("pnpm test | grep FAIL"), {
    type: "verify",
    at: AT,
    kind: "test",
    success: true,
  });
  // A failed search is neither reported nor mistaken for a failed verification.
  assert.equal(
    hookObservation(
      {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "rg 'test' src/" },
      },
      AT,
    ),
    null,
  );
  assert.equal(firstCommandToken("cd /tmp/x && env FOO=1 rg --files"), "rg");
  assert.equal(firstCommandToken("FOO=1 pnpm test"), "pnpm");
});

test("intent_propose records whether it cites the run's own specification", () => {
  const { env } = testEnvironment("coredoc-observer-propose-");
  startedRun("session-propose", env, {
    repositoryKey: "coredoc-parser",
    specRef: ".scratch/workflow-gates-intent-and-mcp/spec.md",
  });
  const payload = {
    ...gateFixture("synthetic-cloud-intent-propose-created.json"),
    session_id: "session-propose",
  };

  observeHookEvent(payload, { env, at: AT });
  const [recorded] = readWorkflowObservations("session-propose", { env });
  assert.deepEqual(recorded, {
    type: "coredoc",
    at: AT,
    success: true,
    tool: "intent_propose",
    access: "write",
    result: "ok",
    created: 1,
    refs: ["coredoc-parser:.scratch/workflow-gates-intent-and-mcp/spec.md"],
    specMatch: true,
  });
  // The proposal's statement is tool input and must not survive the observation.
  assert.doesNotMatch(JSON.stringify(recorded), /STATEMENT_SENTINEL/);
});

test("an intent_propose citing another repository's identical path does not match", () => {
  const { env } = testEnvironment("coredoc-observer-propose-other-");
  startedRun("session-other-repo", env, {
    repositoryKey: "coredoc-parser",
    specRef: ".scratch/workflow-gates-intent-and-mcp/spec.md",
  });
  const fixturePayload = gateFixture("synthetic-cloud-intent-propose-created.json");
  const payload = {
    ...fixturePayload,
    session_id: "session-other-repo",
    tool_input: {
      items: [
        {
          ...fixturePayload.tool_input.items[0],
          sources: [
            { ref: "other-repo:.scratch/workflow-gates-intent-and-mcp/spec.md", localId: "BR-1" },
            { ref: "other-repo:docs/second.md", localId: "BR-2" },
          ],
        },
      ],
    },
  };

  observeHookEvent(payload, { env, at: AT });
  const [recorded] = readWorkflowObservations("session-other-repo", { env });
  assert.equal(recorded.specMatch, false);
  assert.deepEqual(recorded.refs, [
    "other-repo:.scratch/workflow-gates-intent-and-mcp/spec.md",
    "other-repo:docs/second.md",
  ]);
});

test("a run with no stored specification never reports a spec match", () => {
  const { env } = testEnvironment("coredoc-observer-propose-nospec-");
  startedRun("session-no-spec", env);
  observeHookEvent(
    {
      ...gateFixture("synthetic-cloud-intent-propose-created.json"),
      session_id: "session-no-spec",
    },
    { env, at: AT },
  );
  const [recorded] = readWorkflowObservations("session-no-spec", { env });
  assert.equal(recorded.specMatch, false);
  assert.equal(recorded.created, 1);
});

test("even a worst-case propose observation stays well inside the ledger line budget", () => {
  const { env } = testEnvironment("coredoc-observer-budget-");
  startedRun("session-budget", env, {
    repositoryKey: "coredoc-parser",
    specRef: ".scratch/workflow-gates-intent-and-mcp/spec.md",
  });
  const longRef = (index) =>
    `repo-${index}:${"d".repeat(480)}/file-${index}.md`.slice(0, 500);
  const sources = Array.from({ length: 10 }, (_, index) => ({
    ref: longRef(index),
    localId: `BR-${index}`,
  }));
  // The ninth ref is the run's own spec: specMatch must see past the two stored.
  sources[8] = {
    ref: "coredoc-parser:.scratch/workflow-gates-intent-and-mcp/spec.md",
    localId: "BR-9",
  };

  observeHookEvent(
    {
      hook_event_name: "PostToolUse",
      session_id: "session-budget",
      tool_name: `mcp__coredoc-cloud__${"i".repeat(64)}`,
      tool_input: { items: [{ statement: "STATEMENT_SENTINEL", sources }] },
      tool_response: [
        {
          type: "text",
          text: JSON.stringify({ items: [{ outcome: "created_candidate" }] }),
        },
      ],
    },
    { env, at: AT },
  );
  observeHookEvent(
    {
      hook_event_name: "PostToolUse",
      session_id: "session-budget",
      tool_name: "mcp__coredoc-cloud__intent_propose",
      tool_input: { items: [{ statement: "STATEMENT_SENTINEL", sources }] },
      tool_response: [
        {
          type: "text",
          text: JSON.stringify({ items: [{ outcome: "created_candidate" }] }),
        },
      ],
    },
    { env, at: AT },
  );

  const recorded = readWorkflowObservations("session-budget", { env });
  assert.equal(recorded.length, 2);
  for (const event of recorded) {
    assert.equal(Buffer.byteLength(JSON.stringify(event)) < 1024, true);
    assert.doesNotMatch(JSON.stringify(event), /STATEMENT_SENTINEL/);
  }
  assert.equal(recorded[0].tool.length, 64);
  assert.equal(recorded[1].refs.length, 2);
  for (const ref of recorded[1].refs) assert.equal(ref.length <= 120, true);
  assert.equal(recorded[1].specMatch, true);
});

test("a real host payload reaches the ledger with every recorded field intact", () => {
  const { env } = testEnvironment("coredoc-observer-end-to-end-");
  startedRun("session-end-to-end", env);

  for (const [name, expected] of [
    [
      "claude-2.1.272-mcp-search-symbols-bad-scope-failure.json",
      {
        type: "coredoc",
        at: AT,
        success: false,
        tool: "search_symbols",
        access: "read",
        result: "error",
      },
    ],
    [
      "codex-0.150.1-mcp-get-intent-context-ok.json",
      {
        type: "coredoc",
        at: "2026-07-31T10:00:01.000Z",
        success: true,
        tool: "get_intent_context",
        access: "read",
        result: "ok",
      },
    ],
  ]) {
    const result = observeHookEvent(
      { ...gateFixture(name), session_id: "session-end-to-end" },
      { env, at: expected.at },
    );
    assert.equal(result.status, "recorded", name);
  }

  assert.deepEqual(readWorkflowObservations("session-end-to-end", { env }), [
    {
      type: "coredoc",
      at: AT,
      success: false,
      tool: "search_symbols",
      access: "read",
      result: "error",
    },
    {
      type: "coredoc",
      at: "2026-07-31T10:00:01.000Z",
      success: true,
      tool: "get_intent_context",
      access: "read",
      result: "ok",
    },
  ]);
});

test("the maximal coredoc observation fits the ledger line budget", () => {
  // No single call can hold all of these at once today (only intent_propose
  // carries refs, and its name is 14 chars), so the worst case is built by hand.
  const event = {
    type: "coredoc",
    at: AT,
    success: true,
    tool: "i".repeat(64),
    access: "write",
    result: "not_configured",
    unclassified: true,
    specMatch: true,
    created: 1_000_000,
    refs: ["\u00fc\u00e9\u2014".repeat(40), "\u00fc\u00e9\u2014".repeat(40)],
  };
  for (const ref of event.refs) assert.equal(ref.length, 120);
  assert.equal(Buffer.byteLength(JSON.stringify(event)) < 1024, true);
});

test("a cited ref matches the run's specification only for the run's own repository", () => {
  const specRef = "coredoc-parser:.scratch/x/spec.md";
  const cite = (ref) => ({ items: [{ sources: [{ ref }] }] });
  for (const [ref, repositoryKey, expected] of [
    ["coredoc-parser:.scratch/x/spec.md", "coredoc-parser", true],
    ["Coredoc-Parser:./.scratch/x/spec.md", "coredoc-parser", true],
    ["Other-Repo:.scratch/x/spec.md", "coredoc-parser", false],
    [".scratch/x/spec.md", "coredoc-parser", true],
    // The run does not know its repository, so a bare path binds to nothing.
    [".scratch/x/spec.md", "unmapped", false],
    ["Other-Repo:.scratch/x/spec.md", "unmapped", false],
  ]) {
    assert.equal(
      proposeSpecMatch(cite(ref), { specRef, repositoryKey }),
      expected,
      `${ref} @ ${repositoryKey}`,
    );
  }
  assert.equal(proposeSpecMatch(cite(specRef), {}), false);
});
