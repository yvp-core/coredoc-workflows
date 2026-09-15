#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  MANAGED_CAPTURE_ENDPOINT,
  captureHostForHookSession,
  createConfiguredCaptureRecorder,
} from "./capture-client.mjs";
import { normalizeCoredocResult } from "./coredoc-result.mjs";
import { classifyCoredocTool } from "./coredoc-tool-classes.mjs";
import { translateClaudeCapability, translateClaudeQuestions } from "./hosts/claude.mjs";
import {
  appendWorkflowObservation,
  liveWorkflowRun,
  openStageId,
} from "./workflow-run-state.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COREDOC_TOOL_RE =
  /^mcp__(?:[a-z0-9]+[-_])*coredoc(?:[-_][a-z0-9]+)*__/i;
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const COREDOC_TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
// Claude answers a search with its own tool; Codex has none and shells out.
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Read"]);
const SEARCH_COMMANDS = new Set(["rg", "grep", "ag", "ack", "find"]);
const MAX_REFS = 2;
const MAX_REF_CHARS = 120;
const PROPOSE_CREATED_OUTCOMES = new Set([
  "created_candidate",
  "updated_candidate",
]);

function skillObservation(skillId, at) {
  return typeof skillId === "string" && SKILL_ID_RE.test(skillId)
    ? { type: "skill", at, skillId }
    : null;
}

export function verificationKind(command) {
  if (typeof command !== "string" || command.length > 100_000) return null;
  if (
    /\b(vitest|jest|pytest|phpunit|rspec|go\s+test|cargo\s+test|test(?::[\w-]+)?)\b/i.test(
      command,
    )
  ) {
    return "test";
  }
  if (/\b(typecheck|tsc(?:\s|$)|mypy|pyright)\b/i.test(command)) {
    return "typecheck";
  }
  if (
    /\b(lint|eslint|biome|ruff\s+check|check(?::(?:fix|ci))?)\b/i.test(command)
  ) {
    return "check";
  }
  if (/\b(build|compile)\b/i.test(command)) return "build";
  return null;
}

/** The first command token, past leading `cd … &&`, `env` and `VAR=value`. */
export function firstCommandToken(command) {
  if (typeof command !== "string" || command.length > 100_000) return "";
  let rest = command.trim();
  for (;;) {
    const prefix = /^cd\s+[^&|;]*&&\s*/.exec(rest);
    if (!prefix) break;
    rest = rest.slice(prefix[0].length);
  }
  const tokens = rest.split(/\s+/);
  let index = 0;
  while (
    index < tokens.length &&
    (tokens[index] === "env" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))
  ) {
    index += 1;
  }
  return tokens[index] ?? "";
}

function coredocToolName(toolName) {
  const suffix = toolName.slice(toolName.indexOf("__", 5) + 2);
  return COREDOC_TOOL_NAME_RE.test(suffix) ? suffix : "unknown";
}

/** The cited refs of an `intent_propose` call: at most two, distinct, truncated. */
function citedRefs(toolInput) {
  const items = Array.isArray(toolInput?.items) ? toolInput.items : [];
  const refs = [];
  for (const item of items) {
    for (const source of Array.isArray(item?.sources) ? item.sources : []) {
      if (typeof source?.ref !== "string") continue;
      const ref = source.ref.slice(0, MAX_REF_CHARS);
      if (!refs.includes(ref)) refs.push(ref);
      if (refs.length === MAX_REFS) return refs;
    }
  }
  return refs;
}

function createdCandidates(toolResponse) {
  const blocks = Array.isArray(toolResponse)
    ? toolResponse
    : Array.isArray(toolResponse?.content)
      ? toolResponse.content
      : [];
  const block = blocks.find((entry) => entry?.type === "text");
  if (typeof block?.text !== "string") return 0;
  let body;
  try {
    body = JSON.parse(block.text);
  } catch {
    return 0;
  }
  const items = Array.isArray(body?.items) ? body.items : [];
  return items.filter((item) => PROPOSE_CREATED_OUTCOMES.has(item?.outcome))
    .length;
}

function normalizedRef(value) {
  const trimmed = String(value).trim().replace(/\\/g, "/");
  const separator = trimmed.indexOf(":");
  const path = (rest) => rest.replace(/^\.\//, "");
  return separator === -1
    ? { path: path(trimmed) }
    : {
        repoKey: trimmed.slice(0, separator).toLowerCase(),
        path: path(trimmed.slice(separator + 1)),
      };
}

/**
 * Whether an `intent_propose` call cites the run's own specification. A ref
 * without a `<repoKey>:` prefix binds to the run's repository, so it counts
 * only when the run knows which repository it is in.
 */
export function proposeSpecMatch(toolInput, { specRef, repositoryKey } = {}) {
  if (typeof specRef !== "string" || specRef.trim() === "") return false;
  const expected = normalizedRef(specRef);
  // The stored spec is `<repositoryKey>:<path>`; the key may come from the ref
  // itself or, for a bare stored path, from the run.
  const knownRepoKey =
    typeof repositoryKey === "string" && repositoryKey !== "unmapped"
      ? repositoryKey.toLowerCase()
      : undefined;
  const expectedRepoKey = expected.repoKey ?? knownRepoKey;
  const items = Array.isArray(toolInput?.items) ? toolInput.items : [];
  for (const item of items) {
    for (const source of Array.isArray(item?.sources) ? item.sources : []) {
      if (typeof source?.ref !== "string") continue;
      const cited = normalizedRef(source.ref);
      if (cited.path !== expected.path) continue;
      // A prefixed ref must name the run's own repository; a bare path binds to
      // the run's repository only when the run knows which one that is.
      if (cited.repoKey === undefined) {
        if (knownRepoKey !== undefined) return true;
        continue;
      }
      if (expectedRepoKey !== undefined && cited.repoKey === expectedRepoKey) {
        return true;
      }
    }
  }
  return false;
}

export function hookObservation(event, at = new Date().toISOString()) {
  const hookName = event?.hook_event_name;
  if (hookName === "UserPromptExpansion") {
    return event?.expansion_type === "slash_command"
      ? skillObservation(event?.command_name, at)
      : null;
  }

  const success = hookName === "PostToolUse";
  if (!success && hookName !== "PostToolUseFailure") return null;

  const toolName = String(event?.tool_name ?? "");
  if (COREDOC_TOOL_RE.test(toolName)) {
    const tool = coredocToolName(toolName);
    const toolInput = event?.tool_input;
    const { access, unclassified } = classifyCoredocTool(tool, toolInput);
    const result =
      tool === "unknown"
        ? "unknown"
        : normalizeCoredocResult({
            hookName,
            tool,
            toolResponse: event?.tool_response,
            action: toolInput?.action,
          });
    return {
      type: "coredoc",
      at,
      success,
      tool,
      access,
      result,
      ...(unclassified ? { unclassified: true } : {}),
      // Only the propose call carries evidence a gate can read; everything else
      // from inputs and responses is deliberately dropped.
      ...(tool === "intent_propose"
        ? {
            created: createdCandidates(event?.tool_response),
            refs: citedRefs(toolInput),
          }
        : {}),
    };
  }
  if (success && EDIT_TOOLS.has(toolName)) {
    return { type: "edit", at };
  }
  if (success && toolName === "Skill") {
    return skillObservation(event?.tool_input?.skill, at);
  }
  if (toolName === "Bash") {
    const command = event?.tool_input?.command;
    // A command that STARTS with a search binary is a repository search, never a
    // test runner, however its pattern reads (`rg -F 'needle-test' .`). For every
    // other first token the established verification classification wins
    // (`pnpm test | grep FAIL` is a verification).
    // A failed search has nothing to report, and it is still not a verification.
    if (SEARCH_COMMANDS.has(firstCommandToken(command))) {
      return success ? { type: "search", at, tool: "Bash" } : null;
    }
    const kind = verificationKind(command);
    return kind ? { type: "verify", at, kind, success } : null;
  }
  if (success && SEARCH_TOOLS.has(toolName)) {
    return { type: "search", at, tool: toolName };
  }
  return null;
}

/**
 * Whether the configured capture target accepts a schema version. The frequent
 * observer never performs HTTP, so for the managed relay it relies on the list
 * `ensure-managed-relay` exported at SessionStart from the relay's own health;
 * a direct cloud endpoint has no local preflight and decides server-side.
 */
export function captureSchemaVersionAccepted(env, schemaVersion) {
  if (env.COREDOC_CAPTURE_ENDPOINT !== MANAGED_CAPTURE_ENDPOINT) return true;
  return String(env.COREDOC_CAPTURE_ACCEPTED_SCHEMA_VERSIONS ?? "")
    .split(",")
    .map((entry) => Number(entry.trim()))
    .includes(schemaVersion);
}

function recordQuestions(event, { env, cwd, at, createRecorder }) {
  // Question/answer prose needs its own opt-in; ordinary capture remains
  // identifiers and measurements even when a compatible relay is configured.
  if (env.COREDOC_CAPTURE_QUESTIONS !== "1" || !captureSchemaVersionAccepted(env, 4)) return;
  let translated = translateClaudeQuestions(event, { at });
  if (!translated) return;
  try {
    const activeRun = liveWorkflowRun(translated.sessionId, { env });
    if (activeRun) {
      const stageId = openStageId(activeRun);
      translated = translateClaudeQuestions(event, {
        at,
        runId: activeRun.runId,
        ...(stageId === undefined ? {} : { stageId }),
      });
    }
  } catch {
    // A question without readable run state is still a session-scoped fact.
  }
  try {
    const recorder = createConfiguredCaptureRecorder({
      env,
      cwd,
      host: captureHostForHookSession(env, translated.sessionId),
      sessionId: translated.sessionId,
      ...(createRecorder === undefined ? {} : { createRecorder }),
    });
    // Frequent hooks only persist locally. Route, finish, and SessionStart own flushes.
    for (const questionEvent of translated.events) recorder.record(questionEvent);
  } catch {
    // Capture is fail-open and must never break established workflow observation.
  }
}

export function observeHookEvent(
  event,
  {
    env = process.env,
    cwd = process.cwd(),
    at = new Date().toISOString(),
    createRecorder,
  } = {},
) {
  const observation = hookObservation(event, at);
  let observationResult = { status: "ignored" };
  let observationError;
  if (observation?.type === "coredoc" && observation.tool === "intent_propose") {
    // The run holds the specification this propose has to cite; `hookObservation`
    // stays pure, so the comparison happens here. No stored spec means no match.
    let run;
    try {
      run = liveWorkflowRun(event?.session_id, { env });
    } catch {
      // A propose without readable run state is still an observed write.
    }
    observation.specMatch = proposeSpecMatch(event?.tool_input, run ?? {});
  }
  if (observation) {
    try {
      observationResult = appendWorkflowObservation(event?.session_id, observation, {
        env,
      });
    } catch (error) {
      // Capture remains independent from the existing completion evidence path.
      observationError = error;
    }
  }

  let translated = translateClaudeCapability(event, { at });
  if (translated) {
    let activeRun;
    try {
      activeRun = liveWorkflowRun(translated.sessionId, { env });
    } catch {
      // A capability without readable run state is still a session-scoped fact.
    }
    if (activeRun) {
      translated = translateClaudeCapability(event, {
        at,
        runId: activeRun.runId,
      });
    }
    try {
      const recorder = createConfiguredCaptureRecorder({
        env,
        cwd,
        // Codex runs these same plugin hooks: a payload whose session is the ambient Codex
        // thread must be stamped codex, or it permanently contradicts the codex-provider
        // session the telemetry path establishes for the same id.
        host: captureHostForHookSession(env, translated.sessionId),
        sessionId: translated.sessionId,
        ...(createRecorder === undefined ? {} : { createRecorder }),
      });
      // Frequent hooks only persist locally. Route, finish, and SessionStart own flushes.
      recorder.record(translated.event);
    } catch {
      // Capture is fail-open and must never break established workflow observation.
    }
  }

  recordQuestions(event, { env, cwd, at, createRecorder });

  if (observationError) throw observationError;
  return observationResult;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  observeHookEvent(JSON.parse(input || "{}"));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    /* Observation is deliberately fail-open. */
  });
}
