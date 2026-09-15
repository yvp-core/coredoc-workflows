/**
 * Workflow gates: what a successful close is checked against, and what the
 * check leaves behind.
 *
 * A gate turns evidence the host already observed locally into one result:
 *
 *   passed | skipped | unmet | not-configured | not-observed | not-bound
 *
 * `not-configured` comes only from a tool that answered `not_configured`,
 * `not-bound` only from the checkout's capture binding, `not-observed` only
 * from a stage attempt with zero observations of any type. None is ever
 * inferred from silence (spec BR-1..BR-3, LIM-1).
 *
 * Only a `success` close of a bound run can be refused, and only in `enforce`
 * (DEC-2, DEC-3). `warn` prints the same refusal to stderr, closes anyway, and
 * records what it would have refused. Reasons stay local: the capture contract
 * is untouched (LIM-3).
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveProjectKey } from "./project-key.mjs";
import { readSpecArtifact, specAbsolutePath } from "./spec-artifact.mjs";
import {
  openStageId,
  readWorkflowObservations,
  readWorkflowRun,
  recordWorkflowGates,
  workflowStateDirectory,
} from "./workflow-run-state.mjs";

export const GATE_MODES = Object.freeze(["warn", "enforce"]);
const MAX_SKIP_REASON_CHARS = 200;
const HISTORY_LINES = 200;
const HISTORY_FILE = "history.jsonl";
// Results that a bound successful close refuses on. Everything else — passed,
// skipped, not-configured, not-bound, not-applicable — closes.
const REFUSING_RESULTS = new Set(["unmet", "not-observed"]);

export function gateMode(env = process.env) {
  const value = env.COREDOC_WORKFLOW_GATES ?? "warn";
  if (!GATE_MODES.includes(value)) {
    throw new Error(
      `COREDOC_WORKFLOW_GATES must be one of: ${GATE_MODES.join(", ")}`,
    );
  }
  return value;
}

/** Gates are enforced only where the checkout is enrolled to a workspace. */
export function runIsBound(state) {
  return state?.bound === true;
}

export function skipReason(flag, value) {
  const reason = String(value ?? "").trim();
  if (reason === "" || reason.length > MAX_SKIP_REASON_CHARS) {
    throw new Error(
      `--${flag} requires a reason of 1-${MAX_SKIP_REASON_CHARS} characters`,
    );
  }
  return reason;
}

function gate(stage, name, result, message, extra = {}) {
  return { stage, gate: name, result, message, ...extra };
}

function coredocObservations(observations, tool) {
  return observations.filter(
    (event) => event.type === "coredoc" && (tool === undefined || event.tool === tool),
  );
}

/**
 * BR-1 — the spec stage closes on an observed intent read. Only the stage
 * attempt's own observations count; `denied`, `error`, `invalid` and `unknown`
 * are not reads.
 */
export function evaluateIntentGate(
  observations,
  { bound = false, reason, stage = "spec" } = {},
) {
  if (!bound) {
    return gate(stage, "intent", "not-bound", "");
  }
  if (reason !== undefined) {
    return gate(stage, "intent", "skipped", "", { reason });
  }
  const reads = coredocObservations(observations, "get_intent_context");
  if (reads.some((event) => event.result === "ok")) {
    return gate(stage, "intent", "passed", "");
  }
  if (reads.some((event) => event.result === "not_configured")) {
    return gate(
      stage,
      "intent",
      "not-configured",
      "",
      { reason: "get_intent_context answered not_configured" },
    );
  }
  const remedy =
    `run get_intent_context for this repository before closing stage ${stage}, ` +
    `or close with --skip-intent "<reason>"`;
  if (observations.length === 0) {
    return gate(
      stage,
      "intent",
      "not-observed",
      `stage ${stage} has no observed tool calls at all, so an intent read cannot be confirmed: ${remedy}`,
    );
  }
  return gate(
    stage,
    "intent",
    "unmet",
    `stage ${stage} closed without an observed get_intent_context read: ${remedy}`,
    reads.length === 0
      ? {}
      : { reason: `observed get_intent_context results: ${[...new Set(reads.map((event) => event.result ?? "unknown"))].join(", ")}` },
  );
}

/**
 * BR-2 — an accepted specification carries its candidates. `required` forces
 * the check independently of the document's current status: `spec accept
 * --finish` applies it as the precondition of the draft → accepted transition
 * itself (BR-5).
 */
export function evaluateCandidatesGate(
  observations,
  {
    bound = false,
    reason,
    stage = "implement",
    spec,
    specRef,
    required = false,
  } = {},
) {
  if (!bound) {
    return gate(stage, "candidates", "not-bound", "");
  }
  if (reason !== undefined) {
    return gate(stage, "candidates", "skipped", "", { reason });
  }
  if (spec === undefined) {
    return gate(stage, "candidates", "not-applicable", "", {
      reason: specRef === undefined ? "no specification artifact on the run" : `specification ${specRef} is unreadable`,
    });
  }
  if (!required && spec.status !== "accepted") {
    return gate(stage, "candidates", "not-applicable", "", {
      reason: `specification is ${spec.status ?? "unstated"}, not accepted`,
    });
  }
  if (spec.intentChanges === "none") {
    return gate(stage, "candidates", "passed", "", {
      reason: "frontmatter declares intentChanges: none",
    });
  }
  const proposals = coredocObservations(observations, "intent_propose");
  if (
    proposals.some(
      (event) =>
        event.result === "ok" && event.specMatch === true && (event.created ?? 0) >= 1,
    )
  ) {
    return gate(stage, "candidates", "passed", "");
  }
  const remedy =
    `propose the specification's candidate intent with intent_propose sourced at ${specRef}, ` +
    `declare intentChanges: none in its frontmatter, or close with --skip-intent "<reason>"`;
  if (observations.length === 0) {
    return gate(
      stage,
      "candidates",
      "not-observed",
      `no tool call was observed since the specification stage, so the candidate batch for ${specRef} cannot be confirmed: ${remedy}`,
    );
  }
  const mismatched = proposals.filter((event) => event.specMatch === false);
  const citedRefs = [
    ...new Set(mismatched.flatMap((event) => event.refs ?? [])),
  ];
  if (citedRefs.length > 0) {
    return gate(
      stage,
      "candidates",
      "unmet",
      `the accepted specification ${specRef} has no candidate batch: the observed intent_propose cited ${citedRefs.join(", ")}, not ${specRef}. ${remedy}`,
      { reason: `propose cited ${citedRefs.join(", ")}` },
    );
  }
  return gate(
    stage,
    "candidates",
    "unmet",
    `the accepted specification ${specRef} has no candidate batch: ${remedy}`,
    proposals.length === 0
      ? {}
      : { reason: `observed intent_propose results: ${[...new Set(proposals.map((event) => event.result ?? "unknown"))].join(", ")}` },
  );
}

/**
 * Whether the observations hold a Coredoc read that answered. The single
 * predicate BR-4 is judged on: `access: read` classified from the shipped tool
 * fixture, and `result: ok` — `denied`, `error`, `invalid`, `not_configured`
 * and `unknown` are answers, not reads. `run-status` shows the same evidence
 * through this helper, so the block a compacted session is re-anchored with can
 * never disagree with the close it predicts (BR-7).
 */
export function hasCoredocRead(observations) {
  return coredocObservations(observations).some(
    (event) => event.access === "read" && event.result === "ok",
  );
}

/**
 * BR-4 — implement and review close on an observed Coredoc read or a signed
 * skip. A repository search is not a read and a Coredoc write is not a read;
 * both are counted in the refusal so the agent sees what it did instead. An
 * unclassified tool counts as a write (the fixture's fail-closed default) and
 * is named, so a tool the fixture has not caught up with is visible rather than
 * silently blocking the close.
 */
export function evaluateMcpGate(
  observations,
  { bound = false, reason, stage = "implement" } = {},
) {
  const coredoc = coredocObservations(observations);
  const counts = {
    searches: observations.filter((event) => event.type === "search").length,
    writes: coredoc.filter((event) => event.access === "write").length,
  };
  if (!bound) return gate(stage, "mcp", "not-bound", "", counts);
  if (reason !== undefined) {
    return gate(stage, "mcp", "skipped", "", { reason, ...counts });
  }
  if (hasCoredocRead(observations)) {
    return gate(stage, "mcp", "passed", "", counts);
  }
  const unclassified = [
    ...new Set(
      coredoc
        .filter((event) => event.unclassified === true)
        .map((event) => event.tool ?? "unknown"),
    ),
  ];
  return gate(
    stage,
    "mcp",
    // LIM-1: a stage nobody observed at all cannot tell a skip from a blind spot.
    observations.length === 0 ? "not-observed" : "unmet",
    `${counts.searches} repository searches (Grep/Glob/Read/rg), ${counts.writes} Coredoc writes, 0 Coredoc reads in stage ${stage}; ` +
      'read with search_symbols / explain / find_callers / get_intent_context, or close with --skip-mcp "<reason>"' +
      (unclassified.length === 0
        ? ""
        : ` (unclassified tools: ${unclassified.join(", ")})`),
    counts,
  );
}

/**
 * BR-3 — a finished run names its Coredoc status. `not-configured` comes only
 * from tools that answered `not_configured`, `not-bound` only from the binding;
 * neither is ever inferred from the absence of observations.
 */
export function resolveCoredocStatus({
  explicit,
  bound,
  coredocCalls = 0,
  observations = [],
}) {
  if (explicit !== undefined) return explicit;
  // `bound` is a tri-state on purpose: a checkout known not to be enrolled says
  // `not-bound`, while a run routed before the binding was recorded keeps the
  // original resolution rather than claiming a fact nobody established.
  if (bound === false) return "not-bound";
  if (coredocCalls === 0) return "not-used";
  const coredoc = coredocObservations(observations);
  if (
    coredoc.length > 0 &&
    coredoc.every((event) => event.result === "not_configured")
  ) {
    return "not-configured";
  }
  return "not-assessed";
}

export function evaluateFinishGate({ coredocStatus, bound = false, reason }) {
  if (!bound) return gate("finish", "intent", "not-bound", "");
  if (coredocStatus !== "not-assessed") {
    return gate("finish", "intent", "passed", "", {
      reason: `coredoc-status ${coredocStatus}`,
    });
  }
  if (reason !== undefined) {
    return gate("finish", "intent", "skipped", "", { reason });
  }
  return gate(
    "finish",
    "intent",
    "unmet",
    'this run used Coredoc but its coredoc-status resolved to not-assessed: finish with --coredoc-status complete|partial|unavailable, or with --skip-intent "<reason>"',
  );
}

/**
 * The gates each stage close evaluates, by stage id. The spec stage is never
 * gated on a Coredoc read: its evidence is the intent read (BR-1).
 */
export const STAGE_GATES = Object.freeze({
  spec: Object.freeze(["intent"]),
  implement: Object.freeze(["candidates", "mcp"]),
  review: Object.freeze(["mcp"]),
});

export const GATE_EVALUATORS = Object.freeze({
  intent: evaluateIntentGate,
  candidates: evaluateCandidatesGate,
  mcp: evaluateMcpGate,
});

/**
 * The gate results for one stage close, in `STAGE_GATES` order.
 *
 * `observations` is the closing stage attempt's own (LIM-1). BR-2 is the one
 * gate with a wider window — the candidate batch may be proposed any time from
 * the specification stage onward — so it reads `candidatesObservations`.
 */
export function evaluateStageGates(
  stageId,
  observations,
  {
    bound = false,
    spec,
    specRef,
    skipIntentReason,
    skipMcpReason,
    candidatesObservations,
    stderr = process.stderr,
  } = {},
) {
  const results = [];
  for (const name of STAGE_GATES[stageId] ?? []) {
    const evaluate = GATE_EVALUATORS[name];
    if (evaluate === undefined) continue;
    results.push(
      evaluate(name === "candidates" ? candidatesObservations ?? observations : observations, {
        bound,
        stage: stageId,
        spec,
        specRef,
        ...(name === "mcp"
          ? skipMcpReason === undefined
            ? {}
            : { reason: skipMcpReason }
          : skipIntentReason === undefined
            ? {}
            : { reason: skipIntentReason }),
      }),
    );
  }
  // A skip flag that no gate of this stage consumed is still a signed decision:
  // it is recorded rather than dropped, so the history shows what was waived.
  if (
    skipIntentReason !== undefined &&
    !(STAGE_GATES[stageId] ?? []).some((name) => name !== "mcp")
  ) {
    results.push(
      gate(stageId, "intent", bound ? "skipped" : "not-bound", "", {
        ...(bound ? { reason: skipIntentReason } : {}),
      }),
    );
  }
  if (skipMcpReason !== undefined && !results.some(({ gate: name }) => name === "mcp")) {
    // A skip signed on a stage with no Coredoc read gate waives nothing, so it
    // is not recorded: an unresolved gate on the record would send the next
    // route chasing a decision nobody had to make. Fail-open, and say so once.
    stderr.write(
      `--skip-mcp ignored: stage ${stageId} has no Coredoc read gate\n`,
    );
  }
  return results;
}

/**
 * Decide what a close does with its gate results. Returns the results to
 * record (never the messages) and, when the close must be refused, the text.
 * A non-success close records `unmet` for anything that would have refused and
 * never refuses (DEC-3).
 */
export function applyGates(
  results,
  { outcome, bound = false, mode = "warn", stderr = process.stderr } = {},
) {
  const normalized = results.map(({ message: _message, ...entry }) =>
    outcome !== "success" && REFUSING_RESULTS.has(entry.result)
      ? { ...entry, result: "unmet" }
      : entry,
  );
  const failing =
    outcome === "success" && bound
      ? results.filter((entry) => REFUSING_RESULTS.has(entry.result))
      : [];
  if (failing.length === 0) return { results: normalized };
  const refusal = failing.map(({ message }) => message).join("\n");
  if (mode === "enforce") return { results: normalized, refusal };
  // `warn`: the same text, on stderr, and the close proceeds.
  stderr.write(`${refusal}\n`);
  return { results: normalized, warned: refusal };
}

/**
 * BR-2's evidence window: the candidate batch is proposed once the user accepts
 * the specification, which can happen in any stage from the specification stage
 * onward, so it is read from that occurrence's start rather than from the
 * closing attempt. A run with no specification stage is read whole.
 */
function observationsSinceSpecStage(sessionId, state, env) {
  const events = readWorkflowObservations(sessionId, { env });
  const startedAt = state.stageProgress?.spec?.startedAt;
  if (startedAt === undefined) return events;
  const from = Date.parse(startedAt);
  return events.filter((event) => Date.parse(event.at) >= from);
}

/** Every gate of one stage of one run, judged on what is on disk right now. */
export function evaluateRunStageGates(
  sessionId,
  state,
  stageId,
  { env = process.env, cwd = process.cwd(), skipIntentReason, skipMcpReason } = {},
) {
  const { specRef } = state;
  return evaluateStageGates(
    stageId,
    readWorkflowObservations(sessionId, { env, stageId }),
    {
      bound: runIsBound(state),
      specRef,
      ...(specRef === undefined
        ? {}
        : {
            spec: readSpecArtifact(
              specAbsolutePath(specRef, { repoRoot: state.repoRoot, cwd }),
            ),
          }),
      candidatesObservations: observationsSinceSpecStage(sessionId, state, env),
      ...(skipIntentReason === undefined ? {} : { skipIntentReason }),
      ...(skipMcpReason === undefined ? {} : { skipMcpReason }),
    },
  );
}

/**
 * AC-7 / DEC-3 — a stage nobody closed still says what it was missing. A
 * SessionEnd auto-close, and a non-success `finish-run` that abandons the open
 * occurrence, record the gates that would have refused as `unmet` so the
 * durable history is honest about a run that was walked away from.
 *
 * Deliberately total: this runs on the teardown path, where nothing may throw
 * and nothing may refuse.
 */
export function recordAbandonedStageGates(
  sessionId,
  { env = process.env, cwd = process.cwd(), at = new Date().toISOString() } = {},
) {
  try {
    // Abandonment is not a sign of life, so this reads without resuming.
    const state = readWorkflowRun(sessionId, { env });
    const stageId = openStageId(state);
    if (stageId === undefined) return [];
    const { results } = applyGates(
      evaluateRunStageGates(sessionId, state, stageId, { env, cwd }),
      { outcome: "abandoned", bound: runIsBound(state), mode: "warn" },
    );
    if (results.length === 0) return [];
    const attempt = state.stageProgress?.[stageId]?.attempt;
    recordWorkflowGates(
      sessionId,
      results.map((entry) => ({
        ...entry,
        at,
        ...(Number.isInteger(attempt) ? { attempt } : {}),
      })),
      { env },
    );
    return results;
  } catch {
    // Teardown stays fail-open: an unrecorded gate is never worth a lost run.
    return [];
  }
}

function projectDirectory(projectKey, env) {
  return join(workflowStateDirectory(env), projectKey);
}

export function historyPath(projectKey, env = process.env) {
  return join(projectDirectory(projectKey, env), HISTORY_FILE);
}

/** One line per finished run, bounded to the last 200; never deleted with the ledger. */
export function appendRunHistory(projectKey, line, { env = process.env } = {}) {
  const path = historyPath(projectKey, env);
  mkdirSync(projectDirectory(projectKey, env), { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(line)}\n`;
  appendFileSync(path, serialized, { encoding: "utf8", mode: 0o600 });
  const lines = readRunHistoryLines(path);
  if (lines.length > HISTORY_LINES) {
    // The trim keeps the last 200 runs AND every older run that still has an
    // event nobody has seen delivered (issue 05): forgetting those is exactly
    // the silence this history exists to end.
    const kept = new Set(lines.slice(-HISTORY_LINES));
    writeFileSync(
      path,
      `${lines
        .filter((entry) => kept.has(entry) || hasUndeliveredCapture(entry))
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return line;
}

/** A run whose delivery state is unresolved is exempt from the history trim. */
export function hasUndeliveredCapture(line) {
  return (Array.isArray(line?.capture) ? line.capture : []).some(
    (entry) =>
      entry?.state === "queued" ||
      entry?.state === "failed" ||
      entry?.state === "rejected",
  );
}

function readRunHistoryLines(path) {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        try {
          return JSON.parse(entry);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readRunHistory(projectKey, { env = process.env } = {}) {
  return readRunHistoryLines(historyPath(projectKey, env));
}

export function lastRunHistory(projectKey, { env = process.env } = {}) {
  return readRunHistory(projectKey, { env }).at(-1);
}

/**
 * BR-7 — which gates the on-disk observations already satisfy, for the block a
 * compacted or resumed session is re-anchored with. Evidence, not a verdict:
 * it never refuses anything and never writes.
 */
export function gateEvidence(observations, { spec } = {}) {
  const coredoc = coredocObservations(observations);
  const reads = coredoc.filter((event) => event.tool === "get_intent_context");
  return {
    intent: reads.some((event) => event.result === "ok")
      ? "satisfied"
      : reads.some((event) => event.result === "not_configured")
        ? "not-configured"
        : "pending",
    candidates:
      spec?.status === "accepted" && spec.intentChanges !== "none"
        ? coredoc.some(
            (event) =>
              event.tool === "intent_propose" &&
              event.result === "ok" &&
              event.specMatch === true &&
              (event.created ?? 0) >= 1,
          )
          ? "satisfied"
          : "pending"
        : "not-applicable",
    // The same predicate BR-4's gate is judged on, never re-derived here.
    mcp: hasCoredocRead(observations) ? "satisfied" : "pending",
  };
}

/**
 * `status: inactive` at close means no live run is in this session's slot — it
 * never means a delivery problem. The last history line says which run was
 * closed, and how, so the agent can report that instead of guessing.
 */
export function lastRunAddendum({
  env = process.env,
  cwd = process.cwd(),
  projectKey,
} = {}) {
  try {
    const line = lastRunHistory(projectKey ?? resolveProjectKey(cwd, env), {
      env,
    });
    return line === undefined
      ? {}
      : { lastRun: { runId: line.runId, outcome: line.outcome } };
  } catch {
    // Bookkeeping never turns an inactive close into an error.
    return {};
  }
}

/** What `route-task` shows before routing: the previous run's open questions. */
export function unresolvedGates(line) {
  return (Array.isArray(line?.gates) ? line.gates : []).filter(
    (entry) => entry.result === "unmet" || entry.result === "skipped",
  );
}
