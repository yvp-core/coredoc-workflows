/**
 * Capture delivery state: what this checkout knows about the events it emitted.
 *
 * The recorder (`runtime/capture/index.mjs`) owns payloads and receipts and
 * nothing else — it reports every attempt through an injected `onTransition`
 * callback and stays free of run, project and history knowledge. This module is
 * that callback's other end: it writes one small file per run,
 * `<stateDir>/<projectKey>/capture/<runId>.json`, holding STATE ONLY (never a
 * payload) as `{ runId, events: [{ eventId, kind, state, lastAttemptAt, error?,
 * rejectionCode? }] }`, upserted by `eventId` in emission order. The run id on
 * every workflow capture event is the join: any session — the one that emitted
 * the event, or a later `retry-pending` in another session — updates the right
 * file without knowing which run it belongs to. `finish-run` folds the file into
 * its BR-6 history line (`capture: [...]`, the entries verbatim minus `runId`)
 * and deletes it once everything is delivered; a file with undelivered entries
 * survives on purpose, because `session-env` and `run-status` read it to say so
 * out loud — as up to three lines: what a refused binding never recorded, what
 * is still deliverable, and what the server rejected, because the three need
 * different answers. Terminal
 * entries (`rejected`, `payload_missing`) are not a backlog forever: they age
 * out after `TERMINAL_ENTRY_TTL_DAYS` and can be dropped on demand with
 * `coredoc-workflows capture-health --ack`. Every path here is fail-open: a
 * broken or unwritable state file can never throw out of a hook or block a
 * close.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createCaptureRecorder } from "../runtime/capture/index.mjs";
import { emptyCaptureHealth } from "../runtime/capture/health.mjs";
import {
  captureDirectory as outboxDirectory,
  createConfiguredCaptureRecorder,
  workspaceCaptureEnv,
} from "./capture-client.mjs";
import { resolveProjectKey } from "./project-key.mjs";
import { workflowStateDirectory } from "./workflow-run-state.mjs";

export const UNDELIVERED_STATES = Object.freeze(["queued", "failed", "rejected"]);
// One run cannot emit more than a stage-per-attempt handful of events; the cap
// only bounds a pathological loop.
const MAX_ENTRIES = 200;
// A rejection or a lost payload is a fact to act on once, not a permanent nag:
// after this it has been reported at every SessionStart for two weeks.
export const TERMINAL_ENTRY_TTL_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
// Nothing retries these: they are reported until acknowledged or aged out.
const TERMINAL_ERRORS = new Set(["payload_missing", "overflow"]);
// A binding the recorder refuses to build (a workspace id that contradicts the
// endpoint, an unusable header) loses the event before any outbox exists: there
// is no payload to retry, so the entry is terminal and says what was wrong.
export const BINDING_CONFLICT = "CAPTURE_BINDING_CONFLICT";
const MAX_CONFLICT_MESSAGE_CHARS = 120;
const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function captureDirectory(projectKey, env) {
  return join(workflowStateDirectory(env), projectKey, "capture");
}

export function captureStatePath(projectKey, runId, env = process.env) {
  return join(captureDirectory(projectKey, env), `${runId}.json`);
}

/** The project key a delivery belongs to; `undefined` disables state writing. */
export function captureStateProjectKey({
  projectKey,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  if (typeof projectKey === "string" && projectKey !== "") return projectKey;
  try {
    return resolveProjectKey(cwd, env);
  } catch {
    return undefined;
  }
}

export function readCaptureState(projectKey, runId, { env = process.env } = {}) {
  try {
    const value = JSON.parse(
      readFileSync(captureStatePath(projectKey, runId, env), "utf8"),
    );
    return Array.isArray(value?.events) ? value.events : [];
  } catch {
    return [];
  }
}

function captureStateRunIds(projectKey, env) {
  try {
    return readdirSync(captureDirectory(projectKey, env))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
  } catch {
    return [];
  }
}

function writeCaptureState(projectKey, runId, events, env) {
  const path = captureStatePath(projectKey, runId, env);
  if (events.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(captureDirectory(projectKey, env), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ runId, events })}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
}

/**
 * The project whose run owns this event. The outbox is shared across the
 * checkouts that bind to the same workspace, so the session that DELIVERS an
 * event is often not the one that emitted it: writing the transition under the
 * delivering session's project would leave the owner's file `queued` forever
 * and reconcile it to `payload_missing` once the payload is gone. The run's own
 * state file is the owner's mark — one readdir of the project directories finds
 * it, and it is already there because the owner wrote `queued` first.
 */
function captureStateOwner(runId, env) {
  let entries;
  try {
    entries = readdirSync(workflowStateDirectory(env), { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (existsSync(captureStatePath(entry.name, runId, env))) return entry.name;
  }
  return undefined;
}

/**
 * Apply one recorder transition batch. Entries without a `runId` (a question
 * event emitted outside a run) have no history line to reach and are dropped.
 */
export function recordCaptureTransitions(
  entries,
  { projectKey, env = process.env } = {},
) {
  if (projectKey === undefined) return;
  const byRun = new Map();
  for (const entry of entries) {
    const { runId, ...record } = entry;
    if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) continue;
    byRun.set(runId, [...(byRun.get(runId) ?? []), record]);
  }
  for (const [runId, records] of byRun) {
    try {
      const owner = captureStateOwner(runId, env);
      const target = owner ?? projectKey;
      const events = readCaptureState(target, runId, { env });
      // The recorder queues an event in the session that emits it, so the first
      // `queued` IS this project claiming the run. A later transition with no
      // owner file anywhere is a delivery for a run this checkout cannot place:
      // it lands here, but says so rather than claiming it.
      let owned = owner !== undefined;
      for (const record of records) {
        if (record.state === "queued") owned = true;
        const entry = owned ? record : { ...record, note: "owner-unknown" };
        const index = events.findIndex(
          (event) => event.eventId === record.eventId,
        );
        if (index === -1) events.push(entry);
        else events[index] = entry;
      }
      writeCaptureState(target, runId, events.slice(-MAX_ENTRIES), env);
    } catch {
      // Fail-open: delivery state is diagnostic, never a delivery precondition.
    }
  }
}

/**
 * A `createRecorder` for `deliverCaptureEvent` / `createConfiguredCaptureRecorder`
 * that writes delivery state as a side effect. Wiring happens at the call sites
 * because `capture-client.mjs` is hash-pinned by the capture-agent manifest.
 */
export function captureStateRecorder({
  projectKey,
  env = process.env,
  cwd = process.cwd(),
  now = () => new Date().toISOString(),
} = {}) {
  const resolved = captureStateProjectKey({ projectKey, env, cwd });
  return (options) => {
    try {
      return createCaptureRecorder({
        ...options,
        onTransition: (entries) =>
          recordCaptureTransitions(entries, { projectKey: resolved, env }),
      });
    } catch (error) {
      // A recorder that cannot be built has no outbox to queue into: the event
      // is lost at the door. Fail-open, but never silent — the loss is recorded
      // under the run and named in the command's own result.
      return refusedRecorder(error, options, { projectKey: resolved, env, now });
    }
  };
}

/**
 * Stands in for a recorder whose binding was refused. It accepts nothing,
 * delivers nothing, and reports the conflict with every event it is handed.
 */
function refusedRecorder(error, options, { projectKey, env, now }) {
  const code = `${BINDING_CONFLICT}: ${String(error?.message ?? "unknown").slice(
    0,
    MAX_CONFLICT_MESSAGE_CHARS,
  )}`;
  return {
    record(event) {
      let eventId = "binding";
      try {
        eventId = options?.idFactory?.() ?? eventId;
      } catch {
        // An id factory that fails does not change what was lost.
      }
      recordCaptureTransitions(
        [
          {
            eventId,
            ...(event?.runId === undefined ? {} : { runId: event.runId }),
            kind: event?.type ?? "unknown",
            state: "failed",
            lastAttemptAt: now(),
            error: code,
          },
        ],
        { projectKey, env },
      );
      return { status: "failed", error: code };
    },
    pending: () => [],
    health: () => emptyCaptureHealth(),
    flush: async () => ({
      attempted: 0,
      accepted: 0,
      duplicates: 0,
      rejected: 0,
      unmatched: 0,
      pending: 0,
      bindingRefused: 0,
      unreadable: 0,
      receipt: { acceptedEventIds: [], duplicateEventIds: [], rejected: [] },
    }),
  };
}

/**
 * The entries a history line carries, reconciled against the outbox: an event
 * the state still calls queued or failed is `payload_missing` when its payload
 * is gone, and `binding_mismatch` when the payload is still on disk but under
 * another capture binding — that one is kept, because a re-binding can still
 * deliver it. An event with a payload the current binding owns is left alone.
 */
export function reconcileCaptureState(events, { pending, present } = {}) {
  if (pending === undefined) return events;
  const deliverable = new Set(pending);
  const onDisk = present === undefined ? undefined : new Set(present);
  return events.map((event) => {
    if (
      (event.state !== "queued" && event.state !== "failed") ||
      deliverable.has(event.eventId)
    ) {
      return event;
    }
    return onDisk?.has(event.eventId)
      ? { ...event, state: "failed", error: "binding_mismatch" }
      : { ...event, state: "failed", error: "payload_missing" };
  });
}

/** Event ids with a payload file in the outbox, whatever binding owns it. */
export function outboxPayloadIds({ env = process.env, cwd = process.cwd() } = {}) {
  try {
    return readdirSync(outboxDirectory(cwd, workspaceCaptureEnv(env, cwd)))
      .filter((name) => name.endsWith(".event.json"))
      .map((name) => name.slice(0, -".event.json".length));
  } catch {
    return [];
  }
}

/** A state nothing can act on any more: reported, then aged out or acknowledged. */
export function isTerminalCaptureEntry(entry) {
  return (
    entry?.state === "rejected" ||
    (entry?.state === "failed" &&
      (TERMINAL_ERRORS.has(entry.error) || isBindingConflict(entry)))
  );
}

export function isBindingConflict(entry) {
  return (
    entry?.state === "failed" &&
    typeof entry.error === "string" &&
    entry.error.startsWith(BINDING_CONFLICT)
  );
}

export function captureStateIsDelivered(events) {
  return events.every((event) => event.state === "delivered");
}

/**
 * Fold a run's delivery state into its history line and drop the file once the
 * run has nothing left to reconcile.
 */
export function foldCaptureState(
  projectKey,
  runId,
  { env = process.env, pending, present } = {},
) {
  const events = reconcileCaptureState(readCaptureState(projectKey, runId, { env }), {
    pending,
    present,
  });
  if (events.length === 0) return undefined;
  if (captureStateIsDelivered(events)) {
    try {
      rmSync(captureStatePath(projectKey, runId, env), { force: true });
    } catch {
      // A stale delivered file only costs a byte count.
    }
  } else {
    try {
      writeCaptureState(projectKey, runId, events, env);
    } catch {
      // The history line still carries the reconciled entries.
    }
  }
  return events;
}

/** Every run's undelivered entries on this checkout, oldest attempt first. */
export function undeliveredCaptureEvents(projectKey, { env = process.env } = {}) {
  const undelivered = [];
  for (const runId of captureStateRunIds(projectKey, env)) {
    for (const event of readCaptureState(projectKey, runId, { env })) {
      if (UNDELIVERED_STATES.includes(event.state)) {
        undelivered.push({ runId, ...event });
      }
    }
  }
  return undelivered.sort((left, right) =>
    String(left.lastAttemptAt).localeCompare(String(right.lastAttemptAt)),
  );
}

/** Per-kind counts plus the last error and rejection code, for `run-status`. */
export function captureStateSummary(events) {
  const kinds = {};
  let lastError;
  let lastRejectionCode;
  for (const event of events) {
    const counts = (kinds[event.kind] ??= {
      delivered: 0,
      queued: 0,
      failed: 0,
      rejected: 0,
    });
    if (counts[event.state] !== undefined) counts[event.state] += 1;
    if (event.error !== undefined) lastError = event.error;
    if (event.rejectionCode !== undefined) lastRejectionCode = event.rejectionCode;
  }
  return {
    kinds,
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastRejectionCode === undefined ? {} : { lastRejectionCode }),
  };
}

/**
 * The relay's last known state, from the health snapshot the recorder already
 * persists on every attempt (`capture-health-report.mjs` reads the same one for
 * the `capture-health` command). Never probes the relay.
 */
export function relayHealth({
  env = process.env,
  cwd = process.cwd(),
  createRecorder = createConfiguredCaptureRecorder,
} = {}) {
  try {
    return createRecorder({ env, cwd }).health().errorCode ===
      "TRANSPORT_UNAVAILABLE"
      ? "unreachable"
      : "healthy";
  } catch {
    return "unreachable";
  }
}

/**
 * The loud fail-open line(s) for this checkout, read fresh: `retry-pending`
 * prints it AFTER its flush, so a backlog cleared by the same SessionStart is
 * never reported.
 */
export function captureNoticeText({ env = process.env, cwd = process.cwd() } = {}) {
  try {
    const projectKey = captureStateProjectKey({ env, cwd });
    if (projectKey === undefined) return "";
    const undelivered = undeliveredCaptureEvents(projectKey, { env });
    if (undelivered.length === 0) return "";
    return undeliveredCaptureNotice(undelivered, {
      relay: relayHealth({ env, cwd }),
    });
  } catch {
    // A diagnostic line is never worth failing a SessionStart hook over.
    return "";
  }
}

/**
 * The one loud fail-open line. Empty when nothing is outstanding, so a caller
 * can print it unconditionally.
 */
export function undeliveredCaptureNotice(events, { relay = "healthy" } = {}) {
  const refused = events.filter(isBindingConflict);
  const outstanding = events.filter(
    (event) =>
      (event.state === "queued" || event.state === "failed") &&
      !isBindingConflict(event),
  );
  const rejected = events.filter((event) => event.state === "rejected");
  const lines = [];
  if (refused.length > 0) {
    lines.push(
      `coredoc capture: ${refused.length} events not recorded (capture binding conflict: ${refused
        .at(-1)
        .error.slice(BINDING_CONFLICT.length + 2)}) — run \`coredoc-workflows capture-health\``,
    );
  }
  if (outstanding.length > 0) {
    lines.push(
      `coredoc capture: ${outstanding.length} events from ${outstanding[0].lastAttemptAt} not delivered (relay ${relay}) — run \`coredoc-workflows capture-health\``,
    );
  }
  if (rejected.length > 0) {
    const codes = [
      ...new Set(rejected.map((event) => event.rejectionCode ?? "unknown")),
    ];
    lines.push(
      `coredoc capture: ${rejected.length} events rejected (${codes.join(", ")}) — run \`coredoc-workflows capture-health\`, then \`capture-health --ack\` once handled`,
    );
  }
  return lines.join("\n");
}

/**
 * Rewrite every run's state file against the payloads the outbox still holds,
 * and drop terminal entries older than the TTL. `retry-pending` owns this: it
 * is the one command that both knows what is still deliverable and runs on
 * every session start.
 */
export function reconcileCaptureFiles(
  projectKey,
  pending,
  { env = process.env, present, now = Date.now() } = {},
) {
  if (projectKey === undefined) return;
  const cutoff = now - TERMINAL_ENTRY_TTL_DAYS * DAY_MS;
  for (const runId of captureStateRunIds(projectKey, env)) {
    try {
      const events = reconcileCaptureState(
        readCaptureState(projectKey, runId, { env }),
        { pending, present },
      ).filter(
        (entry) =>
          !isTerminalCaptureEntry(entry) ||
          !(Date.parse(entry.lastAttemptAt) < cutoff),
      );
      writeCaptureState(projectKey, runId, events, env);
    } catch {
      // Fail-open: reconciliation is diagnostic.
    }
  }
}

/**
 * `capture-health --ack`: the developer has seen the rejections and lost
 * payloads, so stop reporting them. Deliverable entries are never dropped.
 */
export function ackTerminalCaptureEntries(projectKey, { env = process.env } = {}) {
  let acknowledged = 0;
  if (projectKey === undefined) return { acknowledged };
  for (const runId of captureStateRunIds(projectKey, env)) {
    try {
      const events = readCaptureState(projectKey, runId, { env });
      const kept = events.filter((entry) => !isTerminalCaptureEntry(entry));
      if (kept.length === events.length) continue;
      acknowledged += events.length - kept.length;
      writeCaptureState(projectKey, runId, kept, env);
    } catch {
      // Fail-open: an unreadable state file is not worth an error exit.
    }
  }
  return { acknowledged };
}
