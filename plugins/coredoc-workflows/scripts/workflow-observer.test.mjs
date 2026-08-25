import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  hookObservation,
  observeHookEvent,
  verificationKind,
} from "./workflow-observer.mjs";
import {
  readWorkflowObservations,
  readWorkflowRun,
  startWorkflowRun,
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
  for (const hookName of ["PostToolUse", "PostToolUseFailure"]) {
    const matcher = new RegExp(`^(?:${hooks[hookName][0].matcher})$`);
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
  assert.equal(hooks.SessionStart.length, 1);
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

test("counts exact Coredoc MCP tool outcomes without inspecting responses", () => {
  for (const toolName of [
    "mcp__coredoc__find_callers",
    "mcp__coredoc-local__describe_repository",
    "mcp__claude_ai_Coredoc__find_callers",
    "mcp__plugin_coredoc_cloud__describe_repository",
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
      { type: "coredoc", at: AT, success: true },
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
