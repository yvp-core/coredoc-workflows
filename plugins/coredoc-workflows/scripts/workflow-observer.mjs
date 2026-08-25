#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { captureHostForHookSession, createConfiguredCaptureRecorder } from "./capture-client.mjs";
import { translateClaudeCapability } from "./hosts/claude.mjs";
import {
  appendWorkflowObservation,
  readWorkflowRun,
} from "./workflow-run-state.mjs";

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const COREDOC_TOOL_RE =
  /^mcp__(?:[a-z0-9]+[-_])*coredoc(?:[-_][a-z0-9]+)*__/i;
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;

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
    return { type: "coredoc", at, success };
  }
  if (success && EDIT_TOOLS.has(toolName)) {
    return { type: "edit", at };
  }
  if (success && toolName === "Skill") {
    return skillObservation(event?.tool_input?.skill, at);
  }
  if (toolName === "Bash") {
    const kind = verificationKind(event?.tool_input?.command);
    return kind ? { type: "verify", at, kind, success } : null;
  }
  return null;
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
      activeRun = readWorkflowRun(translated.sessionId, { env });
    } catch {
      // A capability without readable run state is still a session-scoped fact.
    }
    if (activeRun?.status === "active") {
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
