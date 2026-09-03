import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { declaredWorkflowStagesV2 } from "../runtime/capture/contract.mjs";
import { stateRoot } from "./project-key.mjs";

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_EVENT_BYTES = 4_096;
const RUN_STATE_VERSION = 1;
const OBSERVATION_TYPES = new Set(["edit", "verify", "coredoc", "skill"]);
const VERIFY_KINDS = new Set(["test", "typecheck", "check", "build"]);
const SKILL_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,75}$/;
const WORKFLOW_SKILL_PREFIX = "coredoc-workflows:";
// Leaves room under the server's 200-key per-event usage bound for lifecycle
// and route dimensions while covering far more skills than one run should use.
const MAX_SKILLS_USED = 190;
const MAX_SKILL_USES = 1_000_000;
const MAX_STAGE_ATTEMPT = 1_000;
const STAGE_FINISH_OUTCOMES = new Set(["success", "failed", "blocked"]);
const PERSISTED_STAGE_OUTCOMES = new Set([
  ...STAGE_FINISH_OUTCOMES,
  "abandoned",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function hasWorkflowSessionAttribution(sessionId) {
  return SESSION_ID_RE.test(String(sessionId ?? ""));
}

function stateDirectory(env = process.env) {
  // One host session can move between a workspace root, repositories, and
  // worktrees. Its active workflow must therefore not be addressed through the
  // current cwd or a project key that can change while the run is open.
  return (
    env.COREDOC_WORKFLOWS_STATE_DIR ??
    join(resolve(stateRoot(env)), "workflow-runs")
  );
}

function sessionKey(sessionId) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    throw new Error("sessionId must be a compact host session identifier");
  }
  return createHash("sha256").update(sessionId).digest("hex");
}

function statePaths(sessionId, env = process.env) {
  const base = join(stateDirectory(env), sessionKey(sessionId));
  return { state: `${base}.json`, events: `${base}.jsonl`, lock: `${base}.json.lock` };
}

// Stage transitions are read-modify-write over the whole run-state file. Two
// concurrent boundary commands would otherwise lose an update wholesale, which
// can leave two open occurrences — a state every later read rejects, bricking
// the run. An O_EXCL file is the smallest advisory lock that works across
// processes without a dependency.
const STAGE_LOCK_RETRIES = 40;
const STAGE_LOCK_RETRY_MS = 25;
const STAGE_LOCK_STALE_MS = 5_000;

function sleepSync(milliseconds) {
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)),
    0,
    0,
    milliseconds,
  );
}

function acquireStageLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt <= STAGE_LOCK_RETRIES; attempt += 1) {
    try {
      closeSync(openSync(path, "wx", 0o600));
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ageMs = 0;
      try {
        ageMs = Date.now() - statSync(path).mtimeMs;
      } catch {
        // The holder released between our failed create and this stat: retry now.
        continue;
      }
      if (ageMs > STAGE_LOCK_STALE_MS) {
        rmSync(path, { force: true });
        continue;
      }
      sleepSync(STAGE_LOCK_RETRY_MS);
    }
  }
  throw new Error(
    "workflow stage state is locked by another command; retry this stage boundary",
  );
}

function withStageStateLock(sessionId, env, transition) {
  const { lock } = statePaths(sessionId, env);
  acquireStageLock(lock);
  try {
    return transition();
  } finally {
    rmSync(lock, { force: true });
  }
}

function runGit(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
  } catch {
    return "";
  }
}

function nonNegativeInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizedWorkflowSkillId(value) {
  if (typeof value !== "string" || !SKILL_ID_RE.test(value)) return "";
  return value.startsWith(WORKFLOW_SKILL_PREFIX)
    ? value.slice(WORKFLOW_SKILL_PREFIX.length)
    : value;
}

function normalizedRequiredSkills(values) {
  const normalized = (Array.isArray(values) ? values : [])
    .map(normalizedWorkflowSkillId)
    .filter(Boolean);
  return [...new Set(normalized)];
}

function numstatTotals(text) {
  let added = 0;
  let removed = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [rawAdded, rawRemoved] = line.split("\t");
    if (/^\d+$/.test(rawAdded)) added += Number(rawAdded);
    if (/^\d+$/.test(rawRemoved)) removed += Number(rawRemoved);
  }
  return { added, removed };
}

export function gitSnapshot(cwd = process.cwd()) {
  const repoRoot = runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
  if (!repoRoot) {
    return {
      available: false,
      repoRoot: "",
      head: "",
      fingerprint: "",
      filesChanged: 0,
      trackedLinesAdded: 0,
      trackedLinesRemoved: 0,
    };
  }

  const head = runGit(repoRoot, ["rev-parse", "HEAD"]).trim();
  const status = runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  // Hash tracked content changes in memory as well as the status shape. A
  // status-only fingerprint would miss a second edit to a file that was already
  // dirty when the workflow started. The diff itself is never written or sent.
  const trackedDiff = head
    ? runGit(repoRoot, ["diff", "--no-ext-diff", "--binary", "HEAD", "--"])
    : [
        runGit(repoRoot, ["diff", "--no-ext-diff", "--binary", "--"]),
        runGit(repoRoot, [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--binary",
          "--",
        ]),
      ].join("\0");
  const unstaged = numstatTotals(runGit(repoRoot, ["diff", "--numstat"]));
  const staged = numstatTotals(
    runGit(repoRoot, ["diff", "--cached", "--numstat"]),
  );

  return {
    available: true,
    repoRoot,
    head,
    fingerprint: createHash("sha256")
      .update(status)
      .update("\0")
      .update(trackedDiff)
      .digest("hex"),
    filesChanged: status === "" ? 0 : status.split("\n").filter(Boolean).length,
    trackedLinesAdded: unstaged.added + staged.added,
    trackedLinesRemoved: unstaged.removed + staged.removed,
  };
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

export function readWorkflowRun(sessionId, { env = process.env } = {}) {
  try {
    const parsed = JSON.parse(
      readFileSync(statePaths(sessionId, env).state, "utf8"),
    );
    return parsed?.schemaVersion === RUN_STATE_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

export function startWorkflowRun(
  {
    sessionId,
    runId,
    workflowId,
    intent,
    risk,
    requiredSkills = [],
    declaredStages,
    at = new Date().toISOString(),
    cwd = process.cwd(),
  },
  { env = process.env, snapshot = gitSnapshot } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }

  const active = readWorkflowRun(sessionId, { env });
  if (active?.status === "active") {
    throw new Error(
      `workflow run ${active.runId} is already active; finish or abandon it before routing another task`,
    );
  }

  const start = snapshot(cwd);
  const normalizedDeclaredStages =
    declaredStages === undefined
      ? undefined
      : declaredWorkflowStagesV2(declaredStages);
  const state = {
    schemaVersion: RUN_STATE_VERSION,
    status: "active",
    sessionId,
    runId,
    workflowId,
    intent,
    risk,
    requiredSkills: normalizedRequiredSkills(requiredSkills),
    ...(normalizedDeclaredStages === undefined
      ? {}
      : {
          captureSchemaVersion: 2,
          declaredStages: normalizedDeclaredStages,
          stageCaptureVersion: 1,
          stageProgress: {},
        }),
    startedAt: at,
    repoRoot: start.repoRoot,
    start: {
      available: start.available,
      head: start.head,
      fingerprint: start.fingerprint,
    },
  };
  const paths = statePaths(sessionId, env);
  atomicWriteJson(paths.state, state);
  writeFileSync(paths.events, "", { encoding: "utf8", mode: 0o600 });
  return { status: "started", state };
}

function stageTimestamp(value) {
  if (!validStageTimestamp(value)) {
    throw new Error("stage boundary time must be an ISO-8601 timestamp");
  }
  return value;
}

function validStageTimestamp(value) {
  return (
    typeof value === "string" &&
    ISO_TIMESTAMP_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function stageOccurrenceId(value) {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new Error("stage occurrenceId must be a UUID");
  }
  return value.toLowerCase();
}

function activeStageRun(sessionId, env) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { result: { status: "unattributed" } };
  }
  const state = readWorkflowRun(sessionId, { env });
  if (!state || state.status !== "active") {
    return {
      result: {
        status: "inactive",
        reason: "active-run-unavailable",
        action: "route-again",
      },
    };
  }
  if (
    state.stageCaptureVersion !== 1 ||
    !Array.isArray(state.declaredStages) ||
    !state.stageProgress ||
    typeof state.stageProgress !== "object" ||
    Array.isArray(state.stageProgress)
  ) {
    throw new Error(
      "active workflow run does not support stage capture; route again",
    );
  }
  const declaredIds = new Set(
    state.declaredStages.map(({ stageId }) => stageId),
  );
  let openCount = 0;
  for (const [stageId, occurrence] of Object.entries(state.stageProgress)) {
    const hasFinishedAt = occurrence?.finishedAt !== undefined;
    const hasOutcome = occurrence?.outcome !== undefined;
    if (
      !occurrence ||
      typeof occurrence !== "object" ||
      Array.isArray(occurrence) ||
      occurrence.stageId !== stageId ||
      !declaredIds.has(stageId) ||
      !UUID_RE.test(String(occurrence.occurrenceId ?? "")) ||
      !Number.isInteger(occurrence.attempt) ||
      occurrence.attempt < 1 ||
      occurrence.attempt > MAX_STAGE_ATTEMPT ||
      !validStageTimestamp(occurrence.startedAt) ||
      hasFinishedAt !== hasOutcome ||
      (hasFinishedAt &&
        (!validStageTimestamp(occurrence.finishedAt) ||
          !PERSISTED_STAGE_OUTCOMES.has(occurrence.outcome) ||
          Date.parse(occurrence.finishedAt) < Date.parse(occurrence.startedAt)))
    ) {
      throw new Error("persisted stage progress is invalid; route again");
    }
    if (!hasFinishedAt) openCount += 1;
  }
  if (openCount > 1) {
    throw new Error("persisted stage progress is invalid; route again");
  }
  return { state };
}

function declaredStage(state, stageId) {
  const declared = state.declaredStages.find(
    (candidate) => candidate.stageId === stageId,
  );
  if (!declared) throw new Error(`stage ${stageId} was not declared for this run`);
  return declared;
}

function progressFor(state, stageId) {
  return Object.hasOwn(state.stageProgress, stageId)
    ? state.stageProgress[stageId]
    : undefined;
}

function openStage(state) {
  return Object.values(state.stageProgress).find(
    (occurrence) => occurrence.finishedAt === undefined,
  );
}

function stageStartedEvent(state, occurrence) {
  return {
    schemaVersion: 2,
    occurredAt: occurrence.startedAt,
    type: "workflow.stage.started",
    runId: state.runId,
    data: {
      occurrenceId: occurrence.occurrenceId,
      stageId: occurrence.stageId,
      attempt: occurrence.attempt,
    },
  };
}

function stageFinishedEvent(state, occurrence) {
  return {
    schemaVersion: 2,
    occurredAt: occurrence.finishedAt,
    type: "workflow.stage.finished",
    runId: state.runId,
    data: {
      occurrenceId: occurrence.occurrenceId,
      stageId: occurrence.stageId,
      attempt: occurrence.attempt,
      outcome: occurrence.outcome,
    },
  };
}

function persistStageProgress(sessionId, state, occurrence, env) {
  const next = {
    ...state,
    stageProgress: {
      ...state.stageProgress,
      [occurrence.stageId]: occurrence,
    },
  };
  atomicWriteJson(statePaths(sessionId, env).state, next);
  return next;
}

export function startWorkflowStage(
  sessionId,
  stageId,
  { at = new Date().toISOString() } = {},
  { env = process.env, idFactory = randomUUID } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }
  return withStageStateLock(sessionId, env, () =>
    startStageLocked(sessionId, stageId, at, env, idFactory),
  );
}

function startStageLocked(sessionId, stageId, at, env, idFactory) {
  const active = activeStageRun(sessionId, env);
  if (active.result) return active.result;
  const { state } = active;
  const declared = declaredStage(state, stageId);
  const open = openStage(state);
  if (open) {
    if (open.stageId !== stageId) {
      throw new Error(
        `stage ${open.stageId} is already open; finish it before starting stage ${stageId}`,
      );
    }
    return {
      status: "replayed",
      occurrence: open,
      event: stageStartedEvent(state, open),
    };
  }

  for (const dependency of declared.after) {
    const progress = progressFor(state, dependency);
    if (progress?.finishedAt === undefined || progress.outcome !== "success") {
      throw new Error(
        `dependency ${dependency} must finish successfully before stage ${stageId} can start`,
      );
    }
  }
  const previous = progressFor(state, stageId);
  const attempt = (previous?.attempt ?? 0) + 1;
  if (attempt > MAX_STAGE_ATTEMPT) {
    throw new Error(`stage ${stageId} exceeded ${MAX_STAGE_ATTEMPT} attempts`);
  }
  const occurrence = {
    occurrenceId: stageOccurrenceId(idFactory()),
    stageId,
    attempt,
    startedAt: stageTimestamp(at),
  };
  const next = persistStageProgress(sessionId, state, occurrence, env);
  return {
    status: "started",
    occurrence,
    event: stageStartedEvent(next, occurrence),
  };
}

function finishStageLocked(
  sessionId,
  stageId,
  outcome,
  at,
  env,
  { allowReplay = true } = {},
) {
  const active = activeStageRun(sessionId, env);
  if (active.result) return active.result;
  const { state } = active;
  declaredStage(state, stageId);
  const open = openStage(state);
  if (open) {
    if (open.stageId !== stageId) {
      throw new Error(
        `stage ${open.stageId} is open; finish it before stage ${stageId}`,
      );
    }
    const finishedAt = stageTimestamp(at);
    if (Date.parse(finishedAt) < Date.parse(open.startedAt)) {
      throw new Error(`stage ${stageId} finish time cannot precede its start time`);
    }
    const occurrence = {
      ...open,
      finishedAt,
      outcome,
    };
    const next = persistStageProgress(sessionId, state, occurrence, env);
    return {
      status: "finished",
      occurrence,
      event: stageFinishedEvent(next, occurrence),
    };
  }

  const previous = progressFor(state, stageId);
  if (allowReplay && previous?.finishedAt !== undefined) {
    if (previous.outcome !== outcome) {
      throw new Error(
        `stage ${stageId} already finished with outcome ${previous.outcome}`,
      );
    }
    return {
      status: "replayed",
      occurrence: previous,
      event: stageFinishedEvent(state, previous),
    };
  }
  throw new Error(`stage ${stageId} is not open`);
}

export function finishWorkflowStage(
  sessionId,
  stageId,
  outcome,
  { at = new Date().toISOString() } = {},
  { env = process.env } = {},
) {
  if (!STAGE_FINISH_OUTCOMES.has(outcome)) {
    throw new Error("stage outcome must be one of: success, failed, blocked");
  }
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }
  return withStageStateLock(sessionId, env, () =>
    finishStageLocked(sessionId, stageId, outcome, at, env),
  );
}

export function abandonOpenWorkflowStage(
  sessionId,
  { at = new Date().toISOString() } = {},
  { env = process.env } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) return null;
  // SessionEnd fires for every session, most of which never routed a run. Read
  // first so those sessions never create state or contend for the lock; the
  // authoritative check happens again under it.
  const current = readWorkflowRun(sessionId, { env });
  if (!current || current.status !== "active" || current.stageCaptureVersion !== 1) {
    return null;
  }
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (!state || state.status !== "active" || state.stageCaptureVersion !== 1) {
      return null;
    }
    const active = activeStageRun(sessionId, env);
    if (active.result || !openStage(active.state)) return null;
    return finishStageLocked(
      sessionId,
      openStage(active.state).stageId,
      "abandoned",
      at,
      env,
      { allowReplay: false },
    );
  });
}

function normalizedObservation(input) {
  if (!input || !OBSERVATION_TYPES.has(input.type)) return null;
  if (typeof input.at !== "string" || Number.isNaN(Date.parse(input.at))) {
    return null;
  }
  if (input.type === "edit") return { type: "edit", at: input.at };
  if (input.type === "skill") {
    return typeof input.skillId === "string" && SKILL_ID_RE.test(input.skillId)
      ? { type: "skill", at: input.at, skillId: input.skillId }
      : null;
  }
  if (input.type === "verify") {
    if (!VERIFY_KINDS.has(input.kind) || typeof input.success !== "boolean") {
      return null;
    }
    return {
      type: "verify",
      at: input.at,
      kind: input.kind,
      success: input.success,
    };
  }
  if (typeof input.success !== "boolean") return null;
  return { type: "coredoc", at: input.at, success: input.success };
}

export function appendWorkflowObservation(
  sessionId,
  input,
  { env = process.env } = {},
) {
  const state = readWorkflowRun(sessionId, { env });
  if (!state || state.status !== "active") return { status: "inactive" };
  const event = normalizedObservation(input);
  if (!event) return { status: "ignored" };

  const line = `${JSON.stringify(event)}\n`;
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
    return { status: "ignored" };
  }
  appendFileSync(statePaths(sessionId, env).events, line, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { status: "recorded", event };
}

export function readWorkflowObservations(
  sessionId,
  { env = process.env } = {},
) {
  try {
    return readFileSync(statePaths(sessionId, env).events, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        try {
          return normalizedObservation(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function summarizeWorkflowObservations(
  events,
  { requiredSkills = [] } = {},
) {
  const summary = {
    editCalls: 0,
    editVerifyRounds: 0,
    verificationRuns: 0,
    verificationFailures: 0,
    verificationPasses: 0,
    coredocCalls: 0,
    coredocFailures: 0,
    skillsUsed: [],
  };
  let failedVerificationNeedsEdit = false;
  const skillCounts = new Map();
  const required = new Set(normalizedRequiredSkills(requiredSkills));
  const isRequired = (skillId) =>
    required.has(normalizedWorkflowSkillId(skillId));

  for (const event of events) {
    if (event.type === "edit") {
      summary.editCalls += 1;
      if (failedVerificationNeedsEdit) {
        summary.editVerifyRounds += 1;
        failedVerificationNeedsEdit = false;
      }
    } else if (event.type === "verify") {
      summary.verificationRuns += 1;
      if (event.success) {
        summary.verificationPasses += 1;
      } else {
        summary.verificationFailures += 1;
        failedVerificationNeedsEdit = true;
      }
    } else if (event.type === "coredoc") {
      summary.coredocCalls += 1;
      if (!event.success) summary.coredocFailures += 1;
    } else if (event.type === "skill") {
      const previous = skillCounts.get(event.skillId);
      if (previous !== undefined) {
        skillCounts.set(event.skillId, Math.min(previous + 1, MAX_SKILL_USES));
      } else if (skillCounts.size < MAX_SKILLS_USED) {
        skillCounts.set(event.skillId, 1);
      } else if (isRequired(event.skillId)) {
        const removable = [...skillCounts.keys()].find(
          (skillId) => !isRequired(skillId),
        );
        if (removable !== undefined) {
          skillCounts.delete(removable);
          skillCounts.set(event.skillId, 1);
        }
      }
    }
  }
  summary.skillsUsed = [...skillCounts]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, count]) => ({ name, count }));
  return summary;
}

export function completeWorkflowRun(
  sessionId,
  {
    env = process.env,
    at = new Date().toISOString(),
    snapshot = gitSnapshot,
    requiredSkills = [],
  } = {},
) {
  const state = readWorkflowRun(sessionId, { env });
  if (!state || state.status !== "active") return null;

  const end = snapshot(state.repoRoot || process.cwd());
  const observations = summarizeWorkflowObservations(
    readWorkflowObservations(sessionId, { env }),
    {
      requiredSkills: [
        ...(Array.isArray(state.requiredSkills) ? state.requiredSkills : []),
        ...requiredSkills,
      ],
    },
  );
  const startMs = Date.parse(state.startedAt);
  const endMs = Date.parse(at);
  const durationMs =
    Number.isFinite(startMs) && Number.isFinite(endMs)
      ? nonNegativeInteger(endMs - startMs)
      : 0;

  return {
    state,
    summary: {
      durationMs,
      changed:
        state.start.available &&
        end.available &&
        (state.start.fingerprint !== end.fingerprint ||
          state.start.head !== end.head),
      headChanged:
        state.start.available &&
        end.available &&
        state.start.head !== end.head,
      filesChangedAtFinish: end.filesChanged,
      trackedLinesAddedAtFinish: end.trackedLinesAdded,
      trackedLinesRemovedAtFinish: end.trackedLinesRemoved,
      ...observations,
    },
  };
}

export function finalizeWorkflowRun(
  sessionId,
  runId,
  { env = process.env } = {},
) {
  const state = readWorkflowRun(sessionId, { env });
  if (!state || state.status !== "active") return null;
  if (runId !== state.runId) {
    throw new Error("finished workflow run must match the active run");
  }

  const paths = statePaths(sessionId, env);
  rmSync(paths.state, { force: true });
  rmSync(paths.events, { force: true });
  return state;
}
