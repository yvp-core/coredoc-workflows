#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveWorkflowRuntime } from "./capture-client.mjs";
import { readWorkflowRun, workflowStateDirectory } from "./workflow-run-state.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function identity(key, scope) {
  if (typeof key !== "string" || !key.trim() || key.length > 200) throw new Error("investigation requires a task key of 1..200 characters");
  if (!Array.isArray(scope) || !scope.length || scope.length > 30 || scope.some((part) => typeof part !== "string" || !part.trim() || part.length > 200)) {
    throw new Error("investigation requires 1..30 explicit scope labels");
  }
  return { key: key.trim(), scope: [...new Set(scope.map((part) => part.trim()))].sort() };
}

function fileDigest(path) {
  if (!lstatSync(path).isFile() || lstatSync(path).size > MAX_BYTES) throw new Error("investigation report must be a regular file no larger than 16 MiB");
  const body = readFileSync(path);
  if (!body.length) throw new Error("investigation report is empty");
  return digest(body);
}

export function investigationSnapshot(cwd) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: MAX_BYTES, stdio: ["ignore", "pipe", "pipe"] });
  const repoRoot = git(["rev-parse", "--show-toplevel"]).trim();
  cwd = repoRoot;
  const head = git(["rev-parse", "HEAD"]).trim();
  const hash = createHash("sha256");
  const status = git(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.split("\0").some((entry) => {
    const [type, , submodule] = entry.split(" ");
    return ["1", "2"].includes(type) && submodule?.startsWith("S") && (submodule[2] === "M" || submodule[3] === "U");
  })) throw new Error("Dirty submodule cannot be reused; commit or restore its changes before saving investigation");
  hash.update(status);
  hash.update(git(["diff", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "--binary", "HEAD", "--"]));
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean).sort();
  let bytes = 0;
  for (const path of untracked) {
    const absolute = resolve(cwd, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Cannot fingerprint untracked file: ${path}`);
    bytes += stat.size;
    if (bytes > MAX_BYTES) throw new Error("Untracked investigation inputs exceed 16 MiB; commit or narrow the checkout before saving");
    hash.update(path).update("\0").update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute)).update("\0");
  }
  return { repoRoot, head, fingerprint: hash.digest("hex") };
}

export function saveInvestigation({ key, scope, report }, { cwd = process.cwd(), env = process.env, sessionId = env.COREDOC_WORKFLOWS_SESSION_ID } = {}) {
  const task = identity(key, scope);
  const state = readWorkflowRun(sessionId, { env });
  const occurrence = state?.stageProgress?.investigate;
  if (!occurrence?.finishedAt || occurrence.outcome !== "success") throw new Error("Save requires a successfully completed investigation stage in this session");
  if (state.stageProgress.implement) throw new Error("Save investigation before implementation starts");
  const primary = investigationSnapshot(cwd);
  if (primary.repoRoot !== state.repoRoot) throw new Error("Save investigation from the workflow's primary checkout");
  const reportPath = resolve(cwd, report ?? "");
  const reportDigest = fileDigest(reportPath);
  const repositories = [primary, ...(state.repositories ?? []).map(({ repoRoot }) => investigationSnapshot(repoRoot))];
  const value = { schemaVersion: 1, ...task, sourceRunId: state.runId, occurrenceId: occurrence.occurrenceId, savedAt: new Date().toISOString(), report: reportPath, reportDigest, repositories };
  const record = join(workflowStateDirectory(env), "investigations", `${digest(JSON.stringify([primary.repoRoot, task]))}.json`);
  mkdirSync(dirname(record), { recursive: true, mode: 0o700 });
  const temporary = `${record}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, record);
  return { status: "saved", record, sourceRunId: state.runId, report: reportPath };
}

export function checkInvestigation({ record, key, scope }, { cwd = process.cwd() } = {}) {
  const task = identity(key, scope);
  const recordPath = resolve(cwd, record);
  if (lstatSync(recordPath).size > 64 * 1024) throw new Error("Investigation record exceeds 64 KiB");
  const raw = readFileSync(recordPath, "utf8");
  const saved = JSON.parse(raw);
  if (saved.schemaVersion !== 1 || saved.key !== task.key || JSON.stringify(saved.scope) !== JSON.stringify(task.scope)) {
    throw new Error("Investigation task or scope changed; investigate the new scope");
  }
  if (!/^cdr-\d{8}-[0-9a-f]{6}$/.test(saved.sourceRunId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.occurrenceId) || !Array.isArray(saved.repositories) || !saved.repositories.length || saved.repositories.length > 16) {
    throw new Error("Invalid investigation provenance");
  }
  if (typeof saved.report !== "string" || !/^[0-9a-f]{64}$/.test(saved.reportDigest) ||
      saved.repositories.some((repo) => typeof repo.repoRoot !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(repo.head) || !/^[0-9a-f]{64}$/.test(repo.fingerprint))) {
    throw new Error("Invalid investigation snapshot");
  }
  const current = investigationSnapshot(cwd);
  if (current.repoRoot !== saved.repositories[0].repoRoot) throw new Error("Investigation belongs to a different checkout");
  for (const [index, repository] of saved.repositories.entries()) {
    const observed = index === 0 ? current : investigationSnapshot(repository.repoRoot);
    if (observed.head !== repository.head || observed.fingerprint !== repository.fingerprint) throw new Error(`Investigation revision changed: ${repository.repoRoot}`);
  }
  if (fileDigest(saved.report) !== saved.reportDigest) throw new Error("Investigation report changed; review and save it again");
  return { record: recordPath, digest: digest(raw), sourceRunId: saved.sourceRunId, report: saved.report, reportDigest: saved.reportDigest, ...task };
}

function parseArgs(args) {
  const [action, ...flags] = args;
  if (!["save", "check"].includes(action)) throw new Error("usage: investigation save|check --key <task> --scope <label> [--scope <label>] --report <path>|--record <path>");
  const input = { scope: [] };
  for (let index = 0; index < flags.length; index += 2) {
    const name = flags[index]?.slice(2);
    const value = flags[index + 1];
    if (!flags[index]?.startsWith("--") || !["key", "scope", action === "save" ? "report" : "record"].includes(name) || !value || value.startsWith("--")) throw new Error("Invalid investigation argument");
    if (name === "scope") input.scope.push(value);
    else if (input[name] !== undefined) throw new Error(`Duplicate investigation argument: ${name}`);
    else input[name] = value;
  }
  if (!input[action === "save" ? "report" : "record"]) throw new Error("Investigation requires a report or record path");
  return { action, input };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { action, input } = parseArgs(process.argv.slice(2));
    const runtime = resolveWorkflowRuntime();
    const result = action === "save" ? saveInvestigation(input, { env: runtime.env, sessionId: runtime.sessionId }) : checkInvestigation(input);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
