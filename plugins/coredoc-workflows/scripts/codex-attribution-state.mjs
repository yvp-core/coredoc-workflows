import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_BYTES = 256 * 1024;
export const MAX_CODEX_ATTRIBUTION_CLAIMS = 2_000;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const BINDING_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_RE = /^repo-[a-f0-9]{24}$/;

function emptyState() {
  return {
    schemaVersion: 1,
    claims: {},
    health: {},
    unattributed: { pendingCount: 0, rejectedCount: 0 },
  };
}

function timestamp(value) {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function boundedCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

function parseState(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    value.schemaVersion !== 1 ||
    !value.claims ||
    typeof value.claims !== "object" ||
    Array.isArray(value.claims) ||
    !value.health ||
    typeof value.health !== "object" ||
    Array.isArray(value.health) ||
    !value.unattributed ||
    typeof value.unattributed !== "object" ||
    Array.isArray(value.unattributed) ||
    Object.keys(value.unattributed).length !== 2 ||
    !boundedCount(value.unattributed.pendingCount) ||
    !boundedCount(value.unattributed.rejectedCount)
  ) {
    throw new Error("invalid Codex attribution state");
  }
  const claims = Object.entries(value.claims);
  if (
    claims.length > MAX_CODEX_ATTRIBUTION_CLAIMS ||
    claims.some(
      ([sessionId, claim]) =>
        !SESSION_ID_RE.test(sessionId) ||
        !claim ||
        typeof claim !== "object" ||
        Array.isArray(claim) ||
        Object.keys(claim).length !== 4 ||
        !BINDING_ID_RE.test(claim.bindingId) ||
        !SCOPE_RE.test(claim.repositoryScopeKey) ||
        !timestamp(claim.claimedAt) ||
        !timestamp(claim.expiresAt)
    )
  ) {
    throw new Error("invalid Codex attribution state");
  }
  const health = Object.entries(value.health);
  if (
    health.length > 128 ||
    health.some(
      ([bindingId, entry]) =>
        !BINDING_ID_RE.test(bindingId) ||
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        Object.keys(entry).length !== 1 ||
        (entry.lastClaimAt !== null && !timestamp(entry.lastClaimAt))
    )
  ) {
    throw new Error("invalid Codex attribution state");
  }
  return value;
}

export function codexAttributionStatePath(configPath) {
  return join(dirname(configPath), "codex-attribution-state.json");
}

export function readCodexAttributionState(path) {
  if (!existsSync(path)) return emptyState();
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > MAX_BYTES
  ) {
    throw new Error("invalid Codex attribution state");
  }
  return parseState(JSON.parse(readFileSync(path, "utf8")));
}

export function writeCodexAttributionState(path, value) {
  const state = parseState(value);
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return state;
}

export function pruneCodexAttributionState(state, nowMs) {
  for (const [sessionId, claim] of Object.entries(state.claims)) {
    if (Date.parse(claim.expiresAt) <= nowMs) delete state.claims[sessionId];
  }
  return state;
}

export function setCodexAttributionClaim(state, sessionId, claim) {
  if (
    !Object.hasOwn(state.claims, sessionId) &&
    Object.keys(state.claims).length >= MAX_CODEX_ATTRIBUTION_CLAIMS
  ) {
    const oldest = Object.entries(state.claims).sort(
      ([leftId, left], [rightId, right]) =>
        left.claimedAt.localeCompare(right.claimedAt) ||
        leftId.localeCompare(rightId)
    )[0];
    if (oldest) delete state.claims[oldest[0]];
  }
  state.claims[sessionId] = claim;
  return state;
}

export function codexAttributionHealth(configPath, bindingId) {
  const state = pruneCodexAttributionState(
    readCodexAttributionState(codexAttributionStatePath(configPath)),
    Date.now()
  );
  const health = state.health[bindingId];
  return {
    pendingCount: state.unattributed.pendingCount,
    rejectedCount: state.unattributed.rejectedCount,
    lastClaimAt: health?.lastClaimAt ?? null,
  };
}
