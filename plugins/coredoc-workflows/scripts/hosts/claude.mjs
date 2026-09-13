import { randomUUID } from "node:crypto";

import { QUESTION_LIMITS } from "../../runtime/capture/contract.mjs";
import { sanitizeCaptureText } from "../lib/redact-text.mjs";

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CAPABILITY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;

function capabilityId(value) {
  return typeof value === "string" && CAPABILITY_ID_RE.test(value) ? value : "";
}

function capabilityData(payload) {
  if (
    payload?.hook_event_name === "UserPromptExpansion" &&
    payload?.expansion_type === "slash_command"
  ) {
    const id = capabilityId(payload.command_name);
    return id ? { kind: "skill", capabilityId: id, outcome: "unknown" } : null;
  }

  if (
    (payload?.hook_event_name === "PostToolUse" ||
      payload?.hook_event_name === "PostToolUseFailure") &&
    payload?.tool_name === "Skill"
  ) {
    const id = capabilityId(payload?.tool_input?.skill);
    if (!id) return null;
    return {
      kind: "skill",
      capabilityId: id,
      outcome: payload.hook_event_name === "PostToolUse" ? "success" : "failed",
    };
  }

  if (payload?.hook_event_name === "SubagentStart") {
    const id = capabilityId(payload.agent_type);
    return id ? { kind: "agent", capabilityId: id, outcome: "unknown" } : null;
  }
  return null;
}

/** Translate only the allowlisted Claude identity/status fields into C1. */
export function translateClaudeCapability(
  payload,
  { at = new Date().toISOString(), runId } = {},
) {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  const data = capabilityData(payload);
  if (!data) return null;
  return {
    sessionId,
    event: {
      occurredAt: at,
      type: "capability.used",
      ...(runId === undefined ? {} : { runId }),
      data,
    },
  };
}

function answerKind(rawAnswer, options, multiSelect) {
  const labels = new Set(
    options.flatMap((option) =>
      typeof option?.label === "string" ? [option.label] : [],
    ),
  );
  const parts = multiSelect ? rawAnswer.split(", ") : [rawAnswer];
  return parts.every((part) => labels.has(part)) ? "option" : "typed";
}

function questionOptions(entry) {
  const raw = Array.isArray(entry.options) ? entry.options : [];
  return raw.slice(0, QUESTION_LIMITS.options).flatMap((option) => {
    const label = sanitizeCaptureText(option?.label, QUESTION_LIMITS.optionLabelChars);
    if (!label) return [];
    const description = sanitizeCaptureText(
      option?.description,
      QUESTION_LIMITS.optionDescriptionChars,
    );
    return [{ label, ...(description ? { description } : {}) }];
  });
}

/**
 * Translate one answered `AskUserQuestion` call into schema-4 question events,
 * one per question that carries an answer. Only the question, header, option
 * labels and descriptions, and the answer are read; each passes through
 * `sanitizeCaptureText` so the recorded text is masked and bounded. Every other
 * hook field is ignored. Returns null when the payload is not an answered
 * question call.
 */
export function translateClaudeQuestions(
  payload,
  { at = new Date().toISOString(), runId, stageId, askId = randomUUID() } = {},
) {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) return null;
  if (
    payload?.hook_event_name !== "PostToolUse" ||
    payload?.tool_name !== "AskUserQuestion"
  ) {
    return null;
  }
  const questions = payload?.tool_input?.questions;
  const answers = payload?.tool_response?.answers;
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > QUESTION_LIMITS.questionsPerAsk ||
    !answers ||
    typeof answers !== "object" ||
    Array.isArray(answers)
  ) {
    return null;
  }

  const events = [];
  questions.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const rawAnswer =
      typeof entry.question === "string" ? answers[entry.question] : undefined;
    if (typeof rawAnswer !== "string") return;
    const question = sanitizeCaptureText(entry.question, QUESTION_LIMITS.questionChars);
    const answer = sanitizeCaptureText(rawAnswer, QUESTION_LIMITS.answerChars);
    if (!question || !answer) return;
    const header = sanitizeCaptureText(entry.header, QUESTION_LIMITS.headerChars);
    const multiSelect = entry.multiSelect === true;
    const options = Array.isArray(entry.options) ? entry.options : [];
    events.push({
      occurredAt: at,
      schemaVersion: 4,
      type: "workflow.question.answered",
      ...(runId === undefined ? {} : { runId }),
      data: {
        askId,
        questionIndex: index + 1,
        questionCount: questions.length,
        ...(header ? { header } : {}),
        question,
        options: questionOptions(entry),
        multiSelect,
        answer,
        answerKind: answerKind(rawAnswer, options, multiSelect),
        ...(stageId === undefined ? {} : { stageId }),
      },
    });
  });
  return events.length === 0 ? null : { sessionId, events };
}
