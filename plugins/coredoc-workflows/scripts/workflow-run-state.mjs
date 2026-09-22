import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
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
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const RUN_ID_SEGMENT_RE = /^cdr-\d{8}-[0-9a-f]{6}$/;
const GATE_NAMES = new Set(["intent", "candidates", "mcp"]);
const GATE_RESULTS = new Set([
  "passed",
  "skipped",
  "unmet",
  "not-configured",
  "not-observed",
  "not-bound",
  "not-applicable",
]);
const MAX_GATE_RESULTS = 60;
const MAX_GATE_REASON_CHARS = 200;
const MAX_SPEC_REF_CHARS = 400;
const MAX_EVENT_BYTES = 4_096;
const RUN_STATE_VERSION = 1;
const OBSERVATION_TYPES = new Set([
  "edit",
  "verify",
  "coredoc",
  "skill",
  "search",
]);
const VERIFY_KINDS = new Set(["test", "typecheck", "check", "build"]);
const SEARCH_TOOLS = new Set(["Grep", "Glob", "Read", "Bash"]);
const COREDOC_TOOL_NAME_RE = /^[a-z0-9_]{1,64}$/;
const COREDOC_ACCESS = new Set(["read", "write"]);
const COREDOC_RESULTS = new Set([
  "ok",
  "error",
  "denied",
  "not_configured",
  "invalid",
  "unknown",
]);
const MAX_OBSERVATION_REFS = 2;
const MAX_OBSERVATION_REF_CHARS = 120;
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
// A run stays live across a resumable session exit: `suspended` is `active`
// waiting for the same host session to come back. `abandoning` is a suspended
// run another session has claimed for expiry; it can be finished, never resumed.
const LIVE_RUN_STATUSES = new Set(["active", "suspended"]);
const FINISHABLE_RUN_STATUSES = new Set([...LIVE_RUN_STATUSES, "abandoning"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function hasWorkflowSessionAttribution(sessionId) {
  return SESSION_ID_RE.test(String(sessionId ?? ""));
}

export function isLiveWorkflowRun(state) {
  return Boolean(state) && LIVE_RUN_STATUSES.has(state.status);
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

/** Where the durable per-project history and parked runs live beside the ledger. */
export { stateDirectory as workflowStateDirectory };

/**
 * A run parked out of its session slot keeps its own directory, addressed the
 * same way a session slot is. Pointing `COREDOC_WORKFLOWS_STATE_DIR` at that
 * directory is therefore enough to read, complete, or finalise the parked run
 * with the ordinary functions — no second code path anywhere.
 */
export function parkedRunDirectory(projectKey, runId, env = process.env) {
  if (!SAFE_SEGMENT_RE.test(String(projectKey ?? ""))) {
    throw new Error("a parked workflow run requires a project key");
  }
  if (!RUN_ID_SEGMENT_RE.test(String(runId ?? ""))) {
    throw new Error("a parked workflow run requires a run id");
  }
  return join(stateDirectory(env), projectKey, "runs", runId);
}

export function parkedRunEnv(projectKey, runId, env = process.env) {
  return {
    ...env,
    COREDOC_WORKFLOWS_STATE_DIR: parkedRunDirectory(projectKey, runId, env),
  };
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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

function normalizedSpecRef(value) {
  const specRef = String(value ?? "").trim();
  if (specRef === "" || specRef.length > MAX_SPEC_REF_CHARS) {
    throw new Error("specRef must be <repositoryKey>:<repository-relative path>");
  }
  return specRef;
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
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
    repositoryKey,
    bound,
    projectKey,
    specRef,
    investigationReuse,
    at = new Date().toISOString(),
    cwd = process.cwd(),
  },
  { env = process.env, snapshot = gitSnapshot } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { status: "unattributed" };
  }

  const active = readWorkflowRun(sessionId, { env });
  if (active && LIVE_RUN_STATUSES.has(active.status)) {
    throw new Error(
      `workflow run ${active.runId} is already ${active.status}; finish or abandon it before routing another task`,
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
    // What the gates are judged against: the repository the run is in, whether
    // this checkout is enrolled to a workspace at all, the durable-history
    // namespace, and the specification artifact the run is about.
    ...(repositoryKey === undefined ? {} : { repositoryKey }),
    ...(bound === undefined ? {} : { bound: bound === true }),
    ...(projectKey === undefined ? {} : { projectKey }),
    ...(specRef === undefined ? {} : { specRef: normalizedSpecRef(specRef) }),
    ...(investigationReuse === undefined ? {} : { investigationReuse }),
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

export function registerWorkflowRepository(
  sessionId,
  cwd,
  { env = process.env, snapshot = gitSnapshot, at = new Date().toISOString() } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) throw new Error("No attributed workflow session");
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (state?.status !== "active") throw new Error("No active workflow run; resume it before tracking a repository");
    const start = snapshot(cwd);
    if (!start.available || !start.repoRoot) throw new Error("Repository path must resolve to an accessible Git checkout");
    const repositories = state.repositories ?? [];
    if (state.repoRoot === start.repoRoot || repositories.some((repo) => repo.repoRoot === start.repoRoot)) {
      return { status: "already-tracked", runId: state.runId, repoRoot: start.repoRoot };
    }
    if (repositories.length >= 15) throw new Error("A workflow can track at most 16 repository checkouts");
    const repository = {
      repoRoot: start.repoRoot,
      registeredAt: at,
      start: { available: start.available, head: start.head, fingerprint: start.fingerprint },
    };
    atomicWriteJson(statePaths(sessionId, env).state, { ...state, repositories: [...repositories, repository] });
    return { status: "tracked", runId: state.runId, repoRoot: start.repoRoot };
  });
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

function resumeLocked(sessionId, state, env, now) {
  if (state.status !== "suspended") return state;
  const {
    suspendedAt,
    capture: _capture,
    suspendedEnd: _suspendedEnd,
    suspendedRepositories: _suspendedRepositories,
    ...rest
  } = state;
  const next = {
    ...rest,
    status: "active",
    // Time spent suspended is not work; the finish subtracts it.
    suspendedMs:
      nonNegativeInteger(rest.suspendedMs) +
      nonNegativeInteger(now - Date.parse(suspendedAt)),
  };
  atomicWriteJson(statePaths(sessionId, env).state, next);
  return next;
}

// The live run for a session, resumed if a resumable SessionEnd suspended it.
// A lifecycle command from the same host session is proof the session is back;
// abandonment is not, so it reads with `resume: false`. Callers hold the stage
// lock: the resume rewrites the whole file.
function liveRunLocked(sessionId, env, { resume = true, now = Date.now() } = {}) {
  const state = readWorkflowRun(sessionId, { env });
  if (!state || !LIVE_RUN_STATUSES.has(state.status)) return null;
  return resume ? resumeLocked(sessionId, state, env, now) : state;
}

export function liveWorkflowRun(
  sessionId,
  { env = process.env, now = Date.now() } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) return null;
  const state = readWorkflowRun(sessionId, { env });
  if (!state || !LIVE_RUN_STATUSES.has(state.status)) return null;
  if (state.status === "active") return state;
  return withStageStateLock(sessionId, env, () =>
    liveRunLocked(sessionId, env, { now }),
  );
}

function capturedEnd(snapshot) {
  const {
    available,
    head,
    fingerprint,
    filesChanged,
    trackedLinesAdded,
    trackedLinesRemoved,
  } = snapshot;
  return {
    available,
    head,
    fingerprint,
    filesChanged,
    trackedLinesAdded,
    trackedLinesRemoved,
  };
}

/**
 * Park a live run while its session is away. `capture` is the session's own
 * capture identity, kept so a later expiry records the run under its
 * repository and binding rather than under whichever router notices it. The
 * repository is snapshotted now, while it still reflects the session's work.
 */
export function suspendWorkflowRun(
  sessionId,
  { at = new Date().toISOString(), capture = {} } = {},
  { env = process.env, snapshot = gitSnapshot } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) return null;
  // Most sessions never routed a run: read first so they neither create state
  // nor contend for the lock.
  const current = readWorkflowRun(sessionId, { env });
  if (!current || !LIVE_RUN_STATUSES.has(current.status)) return null;
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (!state || !LIVE_RUN_STATUSES.has(state.status)) return null;
    if (state.status === "suspended") return state;
    const next = {
      ...state,
      status: "suspended",
      suspendedAt: stageTimestamp(at),
      capture,
      suspendedEnd: capturedEnd(snapshot(state.repoRoot || process.cwd())),
      ...(state.repositories?.length ? {
        suspendedRepositories: state.repositories.map(({ repoRoot }) => ({
          repoRoot, end: capturedEnd(snapshot(repoRoot)),
        })),
      } : {}),
    };
    atomicWriteJson(statePaths(sessionId, env).state, next);
    return next;
  });
}

/**
 * Runs parked by other sessions that expiry may take: suspended ones, and
 * `abandoning` ones whose claimant evidently died. Oldest suspension first.
 */
export function listSuspendedWorkflowRuns({ env = process.env } = {}) {
  const directory = stateDirectory(env);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const suspended = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    let state;
    try {
      state = JSON.parse(readFileSync(join(directory, entry), "utf8"));
    } catch {
      continue;
    }
    if (
      state?.schemaVersion !== RUN_STATE_VERSION ||
      (state.status !== "suspended" && state.status !== "abandoning") ||
      !hasWorkflowSessionAttribution(state.sessionId) ||
      !validStageTimestamp(state.suspendedAt) ||
      (state.status === "abandoning" &&
        !validStageTimestamp(state.abandoningAt)) ||
      // Only the file its own session addresses counts; a stray copy must not
      // be abandoned through a session that never owned it.
      entry !== `${sessionKey(state.sessionId)}.json`
    ) {
      continue;
    }
    suspended.push({
      sessionId: state.sessionId,
      runId: state.runId,
      status: state.status,
      suspendedAt: state.suspendedAt,
      ...(state.status === "abandoning"
        ? { abandoningAt: state.abandoningAt }
        : {}),
      // A run waiting for the user to accept a delivered draft outlives an
      // ordinary suspension; it carries its own TTL for the sweep to honour.
      ...(Number.isInteger(state.acceptance?.ttlDays)
        ? { ttlDays: state.acceptance.ttlDays }
        : {}),
      repoRoot: typeof state.repoRoot === "string" ? state.repoRoot : "",
    });
  }
  return suspended.sort((a, b) => a.suspendedAt.localeCompare(b.suspendedAt));
}

function expiryDue(state, now, ttlMs, staleClaimMs) {
  if (state.status === "suspended") {
    return Date.parse(state.suspendedAt) + ttlMs <= now;
  }
  return (
    state.status === "abandoning" &&
    validStageTimestamp(state.abandoningAt) &&
    Date.parse(state.abandoningAt) + staleClaimMs <= now
  );
}

/**
 * Take an expired run for abandonment. Under the lock the status and TTL are
 * re-checked, the open stage is closed as abandoned at the suspension time, and
 * the run becomes `abandoning`, which no session can resume and no other
 * sweeper can claim until `staleClaimMs` passes. Returns the state and the
 * stage event to record, or null when the run is not due.
 */
export function claimExpiredWorkflowRun(
  sessionId,
  { now = Date.now(), ttlMs, staleClaimMs },
  { env = process.env } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) return null;
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (
      !state ||
      !validStageTimestamp(state.suspendedAt) ||
      !expiryDue(state, now, ttlMs, staleClaimMs)
    ) {
      return null;
    }
    let stageEvent = null;
    if (state.status === "suspended" && state.stageCaptureVersion === 1) {
      const open = openStage(
        activeStageRun(sessionId, env, { resume: false }).state,
      );
      if (open) {
        stageEvent = finishStageLocked(
          sessionId,
          open.stageId,
          "abandoned",
          state.suspendedAt,
          env,
          { allowReplay: false, resume: false },
        ).event;
      }
    }
    const claimed = {
      ...readWorkflowRun(sessionId, { env }),
      status: "abandoning",
      abandoningAt: new Date(now).toISOString(),
    };
    atomicWriteJson(statePaths(sessionId, env).state, claimed);
    return { state: claimed, stageEvent };
  });
}

function activeStageRun(sessionId, env, { resume = true } = {}) {
  if (!hasWorkflowSessionAttribution(sessionId)) {
    return { result: { status: "unattributed" } };
  }
  const state = liveRunLocked(sessionId, env, { resume });
  if (!state) {
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

/** The stage currently open on a live run, or undefined outside a stage. */
export function openStageId(state) {
  if (!state || !LIVE_RUN_STATUSES.has(state.status) || !state.stageProgress) {
    return undefined;
  }
  return openStage(state)?.stageId;
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
  { allowReplay = true, resume = true } = {},
) {
  const active = activeStageRun(sessionId, env, { resume });
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
  if (
    !current ||
    !LIVE_RUN_STATUSES.has(current.status) ||
    current.stageCaptureVersion !== 1
  ) {
    return null;
  }
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (
      !state ||
      !LIVE_RUN_STATUSES.has(state.status) ||
      state.stageCaptureVersion !== 1
    ) {
      return null;
    }
    // Abandonment is not a sign of life: a suspended run stays suspended.
    const active = activeStageRun(sessionId, env, { resume: false });
    if (active.result || !openStage(active.state)) return null;
    return finishStageLocked(
      sessionId,
      openStage(active.state).stageId,
      "abandoned",
      at,
      env,
      { allowReplay: false, resume: false },
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
  if (input.type === "search") {
    return SEARCH_TOOLS.has(input.tool)
      ? { type: "search", at: input.at, tool: input.tool }
      : null;
  }
  if (typeof input.success !== "boolean") return null;
  // Every field below is optional: an observation written by an older plugin
  // carries none of them, and an invalid value is dropped, never thrown on.
  return {
    type: "coredoc",
    at: input.at,
    success: input.success,
    ...(typeof input.tool === "string" && COREDOC_TOOL_NAME_RE.test(input.tool)
      ? { tool: input.tool }
      : {}),
    ...(COREDOC_ACCESS.has(input.access) ? { access: input.access } : {}),
    ...(COREDOC_RESULTS.has(input.result) ? { result: input.result } : {}),
    ...(input.unclassified === true ? { unclassified: true } : {}),
    ...(typeof input.specMatch === "boolean"
      ? { specMatch: input.specMatch }
      : {}),
    ...(Number.isSafeInteger(input.created) && input.created >= 0
      ? { created: input.created }
      : {}),
    ...(Array.isArray(input.refs)
      ? {
          refs: input.refs
            .filter((ref) => typeof ref === "string")
            .slice(0, MAX_OBSERVATION_REFS)
            .map((ref) => ref.slice(0, MAX_OBSERVATION_REF_CHARS)),
        }
      : {}),
  };
}

export function appendWorkflowObservation(
  sessionId,
  input,
  { env = process.env } = {},
) {
  const state = liveWorkflowRun(sessionId, { env });
  if (!state) return { status: "inactive" };
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

/**
 * Read the run's observations, optionally narrowed to the CURRENT occurrence of
 * one stage — `stageProgress` keeps only the latest attempt per stage, so the
 * occurrence's own start/finish timestamps are the attempt boundary (LIM-1).
 * An `attempt` that is not the current one returns nothing.
 */
export function readWorkflowObservations(
  sessionId,
  { env = process.env, stageId, attempt } = {},
) {
  const events = readObservationLines(sessionId, env);
  if (stageId === undefined) return events;
  const state = readWorkflowRun(sessionId, { env });
  const occurrence =
    state?.stageProgress && typeof state.stageProgress === "object"
      ? state.stageProgress[stageId]
      : undefined;
  if (!occurrence) return [];
  if (attempt !== undefined && occurrence.attempt !== attempt) return [];
  const from = Date.parse(occurrence.startedAt);
  const until =
    occurrence.finishedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(occurrence.finishedAt);
  return events.filter((event) => {
    const at = Date.parse(event.at);
    return at >= from && at <= until;
  });
}

function readObservationLines(sessionId, env) {
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
    allowUnavailableRepositories = false,
    useSuspendedSnapshots = false,
  } = {},
) {
  const state = readWorkflowRun(sessionId, { env });
  if (!state || !FINISHABLE_RUN_STATUSES.has(state.status)) return null;

  // Expiry measures the session's own checkout snapshots, never later edits
  // or the primary checkout reused as a substitute for every repository.
  const unavailableEnd = {
    available: false, head: "", fingerprint: "", filesChanged: 0,
    trackedLinesAdded: 0, trackedLinesRemoved: 0,
  };
  const unavailableRepositories = [];
  const checkouts = [
    { start: state.start, end: useSuspendedSnapshots
      ? state.suspendedEnd ?? unavailableEnd
      : snapshot(state.repoRoot || process.cwd()) },
    ...(state.repositories ?? []).map((repository) => {
      const end = useSuspendedSnapshots
        ? state.suspendedRepositories?.find(({ repoRoot }) => repoRoot === repository.repoRoot)?.end ?? unavailableEnd
        : snapshot(repository.repoRoot);
      if (!end.available) {
        if (!allowUnavailableRepositories) {
          throw new Error(`Tracked repository is unavailable: ${repository.repoRoot}`);
        }
        unavailableRepositories.push(repository.repoRoot);
      }
      return { start: repository.start, end };
    }),
  ];
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
      ? nonNegativeInteger(
          endMs - startMs - nonNegativeInteger(state.suspendedMs),
        )
      : 0;

  return {
    state,
    // Local diagnostic only: never add paths to the event or capture summary.
    ...(unavailableRepositories.length ? {
      repositoryMeasurement: { status: "incomplete", unavailableRepositories },
    } : {}),
    summary: {
      durationMs,
      changed: checkouts.some(({ start, end }) =>
        start.available && end.available && (start.fingerprint !== end.fingerprint || start.head !== end.head)),
      headChanged: checkouts.some(({ start, end }) =>
        start.available && end.available && start.head !== end.head),
      filesChangedAtFinish: checkouts.reduce((total, { end }) => total + end.filesChanged, 0),
      trackedLinesAddedAtFinish: checkouts.reduce((total, { end }) => total + end.trackedLinesAdded, 0),
      trackedLinesRemovedAtFinish: checkouts.reduce((total, { end }) => total + end.trackedLinesRemoved, 0),
      ...observations,
    },
  };
}

/**
 * The single end of a run: its session slot, its observations, and its parked
 * directory go together. A second call for the same run finds nothing to
 * remove and says so — callers log it instead of sending a second finished
 * event, which the server rejects anyway (BR-5).
 */
export function terminateRun(
  sessionId,
  runId,
  { env = process.env, projectKey } = {},
) {
  const state = readWorkflowRun(sessionId, { env });
  const owned = state !== null && state.runId === runId;
  if (owned) {
    const paths = statePaths(sessionId, env);
    rmSync(paths.state, { force: true });
    rmSync(paths.events, { force: true });
  }
  let parked = false;
  const key = projectKey ?? state?.projectKey;
  if (key !== undefined) {
    try {
      const directory = parkedRunDirectory(key, runId, env);
      parked = existsSync(directory);
      rmSync(directory, { force: true, recursive: true });
    } catch {
      // A run without a usable project key was never parked.
    }
  }
  return {
    status: owned || parked ? "terminated" : "already-terminated",
    runId,
    ...(owned ? { state } : {}),
  };
}

export function finalizeWorkflowRun(
  sessionId,
  runId,
  { env = process.env } = {},
) {
  const state = readWorkflowRun(sessionId, { env });
  if (!state || !FINISHABLE_RUN_STATUSES.has(state.status)) return null;
  if (runId !== state.runId) {
    throw new Error("finished workflow run must match the active run");
  }

  terminateRun(sessionId, runId, { env });
  return state;
}

function normalizedGateResults(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter(
      (entry) =>
        entry &&
        GATE_NAMES.has(entry.gate) &&
        GATE_RESULTS.has(entry.result) &&
        typeof entry.stage === "string" &&
        SKILL_ID_RE.test(entry.stage),
    )
    .map((entry) => ({
      stage: entry.stage,
      gate: entry.gate,
      result: entry.result,
      ...(typeof entry.reason === "string" && entry.reason !== ""
        ? { reason: entry.reason.slice(0, MAX_GATE_REASON_CHARS) }
        : {}),
      ...(Number.isSafeInteger(entry.searches) ? { searches: entry.searches } : {}),
      ...(Number.isSafeInteger(entry.writes) ? { writes: entry.writes } : {}),
      ...(Number.isInteger(entry.attempt) ? { attempt: entry.attempt } : {}),
      ...(typeof entry.at === "string" ? { at: entry.at } : {}),
    }));
}

/**
 * Accumulate a stage close's gate results on the run so `finish-run` can write
 * them to the durable history and `run-status` can show them. Local only: no
 * gate result ever reaches a capture event (LIM-3).
 */
export function recordWorkflowGates(
  sessionId,
  entries,
  { env = process.env } = {},
) {
  const additions = normalizedGateResults(entries);
  if (additions.length === 0) return null;
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (!state || !FINISHABLE_RUN_STATUSES.has(state.status)) return null;
    const next = {
      ...state,
      gates: [
        ...(Array.isArray(state.gates) ? normalizedGateResults(state.gates) : []),
        ...additions,
      ].slice(-MAX_GATE_RESULTS),
    };
    atomicWriteJson(statePaths(sessionId, env).state, next);
    return next;
  });
}

export function workflowRunGates(state) {
  return Array.isArray(state?.gates) ? normalizedGateResults(state.gates) : [];
}

/** Confirm or set the specification artifact a live run is about. */
export function setWorkflowRunSpecRef(
  sessionId,
  specRef,
  { env = process.env } = {},
) {
  const normalized = normalizedSpecRef(specRef);
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (!state || !FINISHABLE_RUN_STATUSES.has(state.status)) return null;
    if (state.specRef === normalized) return state;
    const next = { ...state, specRef: normalized };
    atomicWriteJson(statePaths(sessionId, env).state, next);
    return next;
  });
}

/**
 * Park a run out of its session slot so the session can route other work while
 * the run waits for something only the user can give it (BR-5). The run stays
 * `suspended`; only its address changes, and its capture identity and origin
 * session are kept so its eventual terminal event is attributed to the session
 * that started it, which is what the server requires.
 */
export function parkWorkflowRun(
  sessionId,
  {
    runId,
    reason,
    ttlDays,
    specRef,
    capture = {},
    at = new Date().toISOString(),
  },
  { env = process.env, snapshot = gitSnapshot } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) return null;
  return withStageStateLock(sessionId, env, () => {
    const state = readWorkflowRun(sessionId, { env });
    if (!state || !LIVE_RUN_STATUSES.has(state.status)) return null;
    if (runId !== undefined && state.runId !== runId) return null;
    if (state.projectKey === undefined) {
      throw new Error(
        "this run was routed before parking existed; finish it instead of parking it",
      );
    }
    // Re-parking is bookkeeping, not a new wait: a run that is parked again —
    // by the next route, or after a resumable session exit — keeps the moment
    // the user was first asked, so its TTL cannot be reset indefinitely.
    const previous = validStageTimestamp(state.acceptance?.parkedAt)
      ? state.acceptance.parkedAt
      : undefined;
    const parkedAt = previous ?? stageTimestamp(at);
    const parked = {
      ...state,
      status: "suspended",
      suspendedAt: parkedAt,
      capture,
      suspendedEnd: capturedEnd(snapshot(state.repoRoot || process.cwd())),
      ...(state.repositories?.length ? {
        suspendedRepositories: state.repositories.map(({ repoRoot }) => ({
          repoRoot, end: capturedEnd(snapshot(repoRoot)),
        })),
      } : {}),
      acceptance: {
        reason: reason ?? state.acceptance?.reason,
        ttlDays: ttlDays ?? state.acceptance?.ttlDays,
        parkedAt,
        originSessionId: state.acceptance?.originSessionId ?? state.sessionId,
        capture: state.acceptance?.capture ?? capture,
        ...(specRef === undefined
          ? state.specRef === undefined
            ? {}
            : { specRef: state.specRef }
          : { specRef: normalizedSpecRef(specRef) }),
      },
      ...(specRef === undefined ? {} : { specRef: normalizedSpecRef(specRef) }),
    };
    const target = parkedRunDirectory(state.projectKey, state.runId, env);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const from = statePaths(sessionId, env);
    const to = statePaths(sessionId, {
      ...env,
      COREDOC_WORKFLOWS_STATE_DIR: target,
    });
    atomicWriteJson(to.state, parked);
    try {
      renameSync(from.events, to.events);
    } catch {
      // A run with no observations has no events file to move.
    }
    rmSync(from.state, { force: true });
    rmSync(from.events, { force: true });
    return parked;
  });
}

/** Parked runs of this checkout, oldest first. */
export function listParkedWorkflowRuns({ env = process.env, projectKey } = {}) {
  if (!SAFE_SEGMENT_RE.test(String(projectKey ?? ""))) return [];
  const directory = join(stateDirectory(env), projectKey, "runs");
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const parked = [];
  for (const runId of entries) {
    if (!RUN_ID_SEGMENT_RE.test(runId)) continue;
    const state = readParkedRunState(join(directory, runId));
    if (
      !state ||
      state?.schemaVersion !== RUN_STATE_VERSION ||
      state.runId !== runId ||
      !state.acceptance ||
      !validStageTimestamp(state.suspendedAt)
    ) {
      continue;
    }
    parked.push({
      runId,
      sessionId: state.sessionId,
      originSessionId: state.acceptance.originSessionId ?? state.sessionId,
      intent: state.intent,
      workflowId: state.workflowId,
      reason: state.acceptance.reason,
      ttlDays: state.acceptance.ttlDays,
      parkedAt: state.acceptance.parkedAt ?? state.suspendedAt,
      suspendedAt: state.suspendedAt,
      ...(state.specRef === undefined ? {} : { specRef: state.specRef }),
      repoRoot: typeof state.repoRoot === "string" ? state.repoRoot : "",
    });
  }
  return parked.sort((a, b) => a.parkedAt.localeCompare(b.parkedAt));
}

// A parked directory holds exactly one run, in a file named by the session key
// of whichever session parked it — the same layout as a session slot, so every
// ordinary function reads it unchanged once the state directory points here.
function readParkedRunState(directory) {
  let files;
  try {
    files = readdirSync(directory).filter((entry) => entry.endsWith(".json"));
  } catch {
    return null;
  }
  if (files.length !== 1) return null;
  try {
    const state = JSON.parse(readFileSync(join(directory, files[0]), "utf8"));
    return hasWorkflowSessionAttribution(state?.sessionId) &&
      files[0] === `${sessionKey(state.sessionId)}.json`
      ? state
      : null;
  } catch {
    return null;
  }
}

/**
 * Move a parked run back into a session slot and make it active again. The
 * reactivating session becomes the slot's session — the slot invariant is that
 * the file is named by its own state's session — while `acceptance` keeps the
 * origin session the run's capture events must carry.
 */
export function reactivateParkedRun(
  { projectKey, runId, sessionId, at = new Date().toISOString() },
  { env = process.env } = {},
) {
  if (!hasWorkflowSessionAttribution(sessionId)) return null;
  const directory = parkedRunDirectory(projectKey, runId, env);
  const parkedEnv = { ...env, COREDOC_WORKFLOWS_STATE_DIR: directory };
  const seen = readParkedRunState(directory);
  if (!seen) return null;
  // The parked run is claimable by an expiry sweep and by any other session's
  // `spec accept`, so the move happens under the PARKED run's own lock — the
  // same lock `claimExpiredWorkflowRun` takes — and the state is read again
  // inside it. Lock order is always parked-run first, session slot second.
  return withStageStateLock(seen.sessionId, parkedEnv, () =>
    reactivateLocked({ directory, parkedEnv, runId, sessionId, at }, env),
  );
}

function reactivateLocked({ directory, parkedEnv, runId, sessionId, at }, env) {
  const parked = readParkedRunState(directory);
  if (
    !parked ||
    parked.runId !== runId ||
    parked.schemaVersion !== RUN_STATE_VERSION ||
    // `abandoning` is a run an expiry sweep has already claimed: it can be
    // finished, never taken back.
    !LIVE_RUN_STATUSES.has(parked.status)
  ) {
    return null;
  }
  const originSessionId = parked.sessionId;
  return withStageStateLock(sessionId, env, () => {
    const current = readWorkflowRun(sessionId, { env });
    if (current && LIVE_RUN_STATUSES.has(current.status)) {
      if (current.runId !== runId) {
        throw new Error(
          `workflow run ${current.runId} is ${current.status} in this session; finish or abandon it before accepting another run`,
        );
      }
      return current;
    }
    const {
      suspendedAt,
      capture: _capture,
      suspendedEnd: _suspendedEnd,
      suspendedRepositories: _suspendedRepositories,
      ...rest
    } = parked;
    const next = {
      ...rest,
      status: "active",
      sessionId,
      suspendedMs:
        nonNegativeInteger(rest.suspendedMs) +
        nonNegativeInteger(Date.parse(at) - Date.parse(suspendedAt)),
    };
    const from = statePaths(originSessionId, parkedEnv);
    const to = statePaths(sessionId, env);
    atomicWriteJson(to.state, next);
    try {
      renameSync(from.events, to.events);
    } catch {
      writeFileSync(to.events, "", { encoding: "utf8", mode: 0o600 });
    }
    rmSync(directory, { force: true, recursive: true });
    return next;
  });
}
