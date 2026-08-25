import { randomBytes } from "node:crypto";

export const RUN_ID_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
export const WORKFLOW_OUTCOMES = Object.freeze([
  "success",
  "failed",
  "blocked",
  "abandoned",
]);
export const FINDINGS_MEASUREMENTS = Object.freeze([
  "measured",
  "not-measured",
  "not-applicable",
]);
export const COREDOC_STATUSES = Object.freeze([
  "complete",
  "partial",
  "unavailable",
  "not-assessed",
  "not-used",
]);
export const COREDOC_GAP_CODES = Object.freeze([
  "repo-not-indexed",
  "symbol-missing",
  "callers-incomplete",
  "dependents-incomplete",
  "entity-usage-incomplete",
  "cross-repo-incomplete",
  "stale-graph",
  "tool-error",
  "empty-result-inconclusive",
  "capability-missing",
]);

const EVENT_TYPES = new Set(["route.selected", "workflow.finished"]);
const INTENTS = new Set([
  "direct",
  "diagnose",
  "design",
  "change",
  "review",
  "spec",
  "qa",
  "qa-report",
  "benchmark",
  "security",
  "browse",
  "learn",
  "retro",
]);
const RISKS = new Set(["low", "normal", "high"]);
const OUTCOMES = new Set(WORKFLOW_OUTCOMES);
const FINDINGS = new Set(FINDINGS_MEASUREMENTS);
const COREDOC = new Set(COREDOC_STATUSES);
const GAPS = new Set(COREDOC_GAP_CODES);
const FORBIDDEN_FIELDS = new Set([
  "task",
  "prompt",
  "command",
  "source",
  "diff",
  "specimen",
  "content",
  "path",
]);
const EVENT_FIELDS = new Set([
  "schemaVersion",
  "at",
  "runId",
  "workflowId",
  "type",
  "intent",
  "risk",
  "summary",
]);
const SUMMARY_FIELDS = new Set([
  "outcome",
  "durationMs",
  "changed",
  "headChanged",
  "editCalls",
  "editVerifyRounds",
  "verificationRuns",
  "verificationFailures",
  "verificationPasses",
  "filesChangedAtFinish",
  "trackedLinesAddedAtFinish",
  "trackedLinesRemovedAtFinish",
  "findingsMeasurement",
  "findingsInitial",
  "findingsResolved",
  "findingsRemaining",
  "findingsIntroduced",
  "coredocStatus",
  "coredocCalls",
  "coredocFailures",
  "coredocGapCodes",
  "skillsUsed",
]);
const MAX_COUNT = 1_000_000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1_000;
// Keep the final event within the server's bounded usage projection after its
// lifecycle and route keys are added.
const MAX_SKILLS_USED = 190;
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;

function requireIdentifier(name, value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._:-]{1,64}$/.test(value)) {
    throw new Error(`${name} must be a compact identifier`);
  }
}

function requireMember(name, value, values) {
  if (!values.has(value)) {
    throw new Error(`Unsupported ${name}: ${value}`);
  }
}

function rejectUnknownFields(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (FORBIDDEN_FIELDS.has(field)) {
      throw new Error(`Workflow events must not persist ${field}`);
    }
    if (!allowed.has(field)) {
      throw new Error(`Unsupported ${label} field: ${field}`);
    }
  }
}

function requireInteger(name, value, max = MAX_COUNT) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function requireBoolean(name, value) {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be boolean`);
  }
  return value;
}

function compactDate(at) {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) {
    throw new Error("run ID time must be a valid date");
  }
  return date.toISOString().slice(0, 10).replaceAll("-", "");
}

export function mintRunId({
  at = new Date(),
  entropy = randomBytes(3),
} = {}) {
  const suffix = Buffer.from(entropy).toString("hex");
  if (!/^[0-9a-f]{6}$/.test(suffix)) {
    throw new Error("run ID entropy must contain exactly 3 bytes");
  }
  return `cdr-${compactDate(at)}-${suffix}`;
}

function normalizedFindings(summary) {
  requireMember(
    "findings measurement",
    summary.findingsMeasurement,
    FINDINGS,
  );
  const keys = [
    "findingsInitial",
    "findingsResolved",
    "findingsRemaining",
    "findingsIntroduced",
  ];
  if (summary.findingsMeasurement !== "measured") {
    for (const key of keys) {
      if (summary[key] !== undefined && summary[key] !== null) {
        throw new Error(`${key} requires measured findings`);
      }
    }
    return Object.fromEntries(keys.map((key) => [key, null]));
  }

  const values = Object.fromEntries(
    keys.map((key) => [key, requireInteger(key, summary[key])]),
  );
  if (
    values.findingsRemaining !==
    values.findingsInitial -
      values.findingsResolved +
      values.findingsIntroduced
  ) {
    throw new Error("measured finding counts must balance");
  }
  return values;
}

function normalizedSkillsUsed(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SKILLS_USED) {
    throw new Error(`skillsUsed must contain at most ${MAX_SKILLS_USED} entries`);
  }

  const seen = new Set();
  return value.map((entry) => {
    rejectUnknownFields(entry, new Set(["name", "count"]), "skill usage");
    if (typeof entry.name !== "string" || !SKILL_ID_RE.test(entry.name)) {
      throw new Error("skill usage name must be a compact identifier");
    }
    if (seen.has(entry.name)) {
      throw new Error("skillsUsed must not contain duplicate names");
    }
    seen.add(entry.name);
    const count = requireInteger("skill usage count", entry.count);
    if (count === 0) {
      throw new Error("skill usage count must be positive");
    }
    return {
      name: entry.name,
      count,
    };
  });
}

function normalizedSummary(summary) {
  rejectUnknownFields(summary, SUMMARY_FIELDS, "summary");
  requireMember("workflow outcome", summary.outcome, OUTCOMES);
  requireMember("Coredoc status", summary.coredocStatus, COREDOC);
  const coredocGapCodes = Array.isArray(summary.coredocGapCodes)
    ? [...new Set(summary.coredocGapCodes)]
    : [];
  if (
    coredocGapCodes.length > 10 ||
    coredocGapCodes.some((code) => !GAPS.has(code))
  ) {
    throw new Error("coredocGapCodes must use the closed gap vocabulary");
  }

  const result = {
    outcome: summary.outcome,
    durationMs: requireInteger(
      "durationMs",
      summary.durationMs,
      MAX_DURATION_MS,
    ),
    changed: requireBoolean("changed", summary.changed),
    headChanged: requireBoolean("headChanged", summary.headChanged),
    editCalls: requireInteger("editCalls", summary.editCalls),
    editVerifyRounds: requireInteger(
      "editVerifyRounds",
      summary.editVerifyRounds,
    ),
    verificationRuns: requireInteger(
      "verificationRuns",
      summary.verificationRuns,
    ),
    verificationFailures: requireInteger(
      "verificationFailures",
      summary.verificationFailures,
    ),
    verificationPasses: requireInteger(
      "verificationPasses",
      summary.verificationPasses,
    ),
    filesChangedAtFinish: requireInteger(
      "filesChangedAtFinish",
      summary.filesChangedAtFinish,
    ),
    trackedLinesAddedAtFinish: requireInteger(
      "trackedLinesAddedAtFinish",
      summary.trackedLinesAddedAtFinish,
    ),
    trackedLinesRemovedAtFinish: requireInteger(
      "trackedLinesRemovedAtFinish",
      summary.trackedLinesRemovedAtFinish,
    ),
    ...normalizedFindings(summary),
    findingsMeasurement: summary.findingsMeasurement,
    coredocStatus: summary.coredocStatus,
    coredocCalls: requireInteger("coredocCalls", summary.coredocCalls),
    coredocFailures: requireInteger(
      "coredocFailures",
      summary.coredocFailures,
    ),
    coredocGapCodes,
    skillsUsed: normalizedSkillsUsed(summary.skillsUsed),
  };

  if (result.headChanged && !result.changed) {
    throw new Error("headChanged requires changed");
  }
  if (result.editVerifyRounds > result.editCalls) {
    throw new Error("editVerifyRounds cannot exceed editCalls");
  }
  if (
    result.verificationPasses + result.verificationFailures !==
    result.verificationRuns
  ) {
    throw new Error("verification outcomes must equal verificationRuns");
  }
  if (result.coredocFailures > result.coredocCalls) {
    throw new Error("coredocFailures cannot exceed coredocCalls");
  }
  if (result.coredocStatus === "not-used" && result.coredocCalls !== 0) {
    throw new Error("not-used Coredoc status requires zero calls");
  }
  return result;
}

export function workflowEvent(input) {
  rejectUnknownFields(input, EVENT_FIELDS, "event");
  if (
    input.schemaVersion !== undefined &&
    input.schemaVersion !== 1
  ) {
    throw new Error("Unsupported workflow event schemaVersion");
  }
  if (typeof input.runId !== "string" || !RUN_ID_RE.test(input.runId)) {
    throw new Error("runId must use the canonical cdr-YYYYMMDD-xxxxxx format");
  }
  requireIdentifier("workflowId", input.workflowId);
  if (!EVENT_TYPES.has(input.type)) {
    throw new Error(`Unsupported event type: ${input.type}`);
  }
  requireMember("intent", input.intent, INTENTS);
  requireMember("risk", input.risk, RISKS);
  if (typeof input.at !== "string" || Number.isNaN(Date.parse(input.at))) {
    throw new Error("at must be an ISO-8601 timestamp");
  }
  if (input.type === "route.selected" && input.summary !== undefined) {
    throw new Error("route.selected must not include a summary");
  }
  if (input.type === "workflow.finished" && input.summary === undefined) {
    throw new Error("workflow.finished requires a summary");
  }

  return {
    schemaVersion: 1,
    at: input.at,
    runId: input.runId,
    workflowId: input.workflowId,
    type: input.type,
    intent: input.intent,
    risk: input.risk,
    ...(input.type === "workflow.finished"
      ? { summary: normalizedSummary(input.summary) }
      : {}),
  };
}
