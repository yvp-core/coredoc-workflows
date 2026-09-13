#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { MAX_INPUT_BYTES, scanText } from "./redact-scan.mjs";

const SCHEMA = "coredoc.git-delivery-preflight/v1";
const OPERATIONS = new Set(["commit", "push", "pr"]);
const RESERVED_TRUNKS = new Set(["main", "master"]);
const REVIEW_SECRET_IDS = new Set([
  "auth.bearer",
  "env.kv",
  "google.api_key",
  "jwt",
]);
const GIT_OUTPUT_LIMIT = MAX_INPUT_BYTES + 256 * 1024;
const DIFF_CONTEXT_LINES = 300;
const LOCAL_ATTRIBUTES_LIMIT = 64 * 1024;
const COMMIT_MESSAGE_LIMIT = 64 * 1024;

function relevantSecret(finding) {
  return (
    finding.category === "secret" &&
    (finding.tier === "HIGH" || REVIEW_SECRET_IDS.has(finding.id))
  );
}

function secretBearing(value) {
  return typeof value === "string" && scanText(value).some(relevantSecret);
}

function gitEnvironment() {
  const env = {
    ...process.env,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return env;
}

function runGit(cwd, args, { maxBuffer = GIT_OUTPUT_LIMIT, timeout = 10_000 } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    maxBuffer,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: !result.error && result.status === 0,
    code: result.status,
    stdout: result.stdout ?? "",
    errorCode: result.error?.code ?? null,
  };
}

function runGitBytes(cwd, args, { maxBuffer = GIT_OUTPUT_LIMIT, timeout = 10_000 } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: gitEnvironment(),
    maxBuffer,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
  };
}

function oneLine(result) {
  return result.ok ? result.stdout.trim() : null;
}

function resolveCommit(cwd, ref) {
  const result = runGit(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  const value = oneLine(result);
  return value && /^[0-9a-f]{40,64}$/.test(value) ? value : null;
}

function validBranchName(cwd, value) {
  if (!value || value.startsWith("-") || value.includes("..")) return false;
  return runGit(cwd, ["check-ref-format", "--branch", value]).ok;
}

function resolveNamedBase(cwd, name, source) {
  if (!validBranchName(cwd, name)) return null;
  for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
    const sha = resolveCommit(cwd, ref);
    if (sha) return { name, ref, sha, source };
  }
  return null;
}

function resolveBase(cwd, branch, baseHint) {
  if (baseHint) return resolveNamedBase(cwd, baseHint, "explicit");

  if (branch) {
    const recorded = oneLine(
      runGit(cwd, ["config", "--get", `branch.${branch}.gh-merge-base`]),
    );
    const resolved = resolveNamedBase(cwd, recorded, "branch-config");
    if (resolved) return resolved;
  }

  const originHead = oneLine(
    runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
  );
  if (originHead?.startsWith("refs/remotes/origin/")) {
    const name = originHead.slice("refs/remotes/origin/".length);
    const resolved = resolveNamedBase(cwd, name, "origin-head");
    if (resolved) return resolved;
  }

  for (const [name, ref, source] of [
    ["main", "refs/remotes/origin/main", "remote-main"],
    ["master", "refs/remotes/origin/master", "remote-master"],
    ["main", "refs/heads/main", "local-main"],
    ["master", "refs/heads/master", "local-master"],
  ]) {
    const sha = resolveCommit(cwd, ref);
    if (sha) return { name, ref, sha, source };
  }
  return null;
}

function inspectRepository(cwd, baseHint) {
  const inside = oneLine(runGit(cwd, ["rev-parse", "--is-inside-work-tree"]));
  if (inside !== "true") {
    return { ok: false, reason: "not-a-git-repository" };
  }

  const head = resolveCommit(cwd, "HEAD");
  if (!head) return { ok: false, reason: "head-unreadable" };

  const branch = oneLine(runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]));
  const originConfigured = Boolean(oneLine(runGit(cwd, ["remote", "get-url", "origin"])));
  const upstream = branch
    ? oneLine(
        runGit(cwd, [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          "@{upstream}",
        ]),
      )
    : null;
  const base = resolveBase(cwd, branch, baseHint);

  return {
    ok: true,
    head,
    branch,
    detached: !branch,
    originConfigured,
    base,
    upstream: {
      short: upstream,
      isOriginCurrent: Boolean(branch && upstream === `origin/${branch}`),
    },
    publication: null,
  };
}

function parsePorcelainStatus(text) {
  const unmergedPairs = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  const records = text.split("\0");
  let stagedPresent = false;
  let unstagedPresent = false;
  let untrackedPresent = false;
  let unmergedPresent = false;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 3) continue;
    const x = record[0];
    const y = record[1];
    if (unmergedPairs.has(`${x}${y}`)) unmergedPresent = true;
    if (x === "?" && y === "?") untrackedPresent = true;
    else {
      if (x !== " " && x !== "?") stagedPresent = true;
      if (y !== " ") unstagedPresent = true;
    }
    if (x === "R" || x === "C" || y === "R" || y === "C") i += 1;
  }
  return { stagedPresent, unstagedPresent, untrackedPresent, unmergedPresent };
}

function inspectWorktree(cwd) {
  const status = runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return null;
  const facts = parsePorcelainStatus(status.stdout);
  const staged = runGit(cwd, ["diff", "--cached", "--quiet", "--exit-code", "--"]);
  if (staged.errorCode || (staged.code !== 0 && staged.code !== 1)) return null;
  return { ...facts, stagedPresent: staged.code === 1 };
}

function nulRecords(buffer) {
  const records = [];
  let start = 0;
  for (let offset = 0; offset < buffer.length; offset++) {
    if (buffer[offset] !== 0) continue;
    if (offset > start) records.push(buffer.subarray(start, offset));
    start = offset + 1;
  }
  if (start !== buffer.length) return null;
  return records;
}

function fingerprintEntries(entries) {
  const hash = createHash("sha256");
  hash.update("coredoc-git-tree-fingerprint/v1\0");
  for (const { mode, object, path } of entries) {
    hash.update(`${mode}\0${object}\0${path.length}\0`);
    hash.update(path);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function fingerprintCommitMessage(message) {
  const hash = createHash("sha256");
  hash.update("coredoc-git-commit-message/v1\0");
  hash.update(message);
  return `sha256:${hash.digest("hex")}`;
}

function indexFingerprint(cwd) {
  const result = runGitBytes(cwd, ["ls-files", "--stage", "-z", "--"]);
  if (!result.ok) return null;
  const records = nulRecords(result.stdout);
  if (!records) return null;
  const entries = [];
  for (const record of records) {
    const separator = record.indexOf(9);
    if (separator < 0) return null;
    const match = record.subarray(0, separator).toString("ascii").match(
      /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])$/,
    );
    if (!match || match[3] !== "0") return null;
    entries.push({
      mode: match[1],
      object: match[2],
      path: record.subarray(separator + 1),
    });
  }
  return fingerprintEntries(entries);
}

function commitTreeFingerprint(cwd, commit) {
  const result = runGitBytes(cwd, ["ls-tree", "-r", "-z", "--full-tree", commit]);
  if (!result.ok) return null;
  const records = nulRecords(result.stdout);
  if (!records) return null;
  const entries = [];
  for (const record of records) {
    const separator = record.indexOf(9);
    if (separator < 0) return null;
    const match = record.subarray(0, separator).toString("ascii").match(
      /^([0-7]{6}) (?:blob|commit) ([0-9a-f]{40,64})$/,
    );
    if (!match) return null;
    entries.push({
      mode: match[1],
      object: match[2],
      path: record.subarray(separator + 1),
    });
  }
  return fingerprintEntries(entries);
}

function storedCommitMessageFingerprint(cwd, commit) {
  const result = runGitBytes(cwd, ["cat-file", "commit", commit], {
    maxBuffer: MAX_INPUT_BYTES + 1,
  });
  if (!result.ok || result.stdout.length > MAX_INPUT_BYTES) return null;
  const boundary = result.stdout.indexOf(Buffer.from("\n\n"));
  if (boundary < 0) return null;
  return fingerprintCommitMessage(result.stdout.subarray(boundary + 2));
}

function patchPath(raw) {
  if (!raw || raw === "/dev/null") return null;
  let value = raw;
  if (value.startsWith("b/")) value = value.slice(2);
  if (value.startsWith('"') && value.endsWith('"')) return "<quoted-path>";
  return value;
}

function parsePatch(patch, commit = null) {
  const chunks = [];
  const binaryPaths = new Set();
  let path = null;
  let nextLine = null;
  let inHunk = false;
  let hunk = [];

  const flush = () => {
    if (hunk.some((entry) => entry.added) && path) {
      chunks.push({ path, commit, lines: hunk });
    }
    hunk = [];
  };

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      flush();
      path = null;
      nextLine = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && raw.startsWith("+++ ")) {
      flush();
      path = patchPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("@@ ")) {
      flush();
      const match = raw.match(/\+(\d+)(?:,\d+)?/);
      nextLine = match ? Number.parseInt(match[1], 10) : null;
      inHunk = true;
      continue;
    }
    if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
      flush();
      if (path) binaryPaths.add(path);
      inHunk = false;
      continue;
    }
    if (inHunk && raw.startsWith("+")) {
      hunk.push({ line: nextLine, text: raw.slice(1), added: true });
      if (nextLine !== null) nextLine += 1;
      continue;
    }
    if (inHunk && raw.startsWith(" ")) {
      hunk.push({ line: nextLine, text: raw.slice(1), added: false });
      if (nextLine !== null) nextLine += 1;
    }
  }
  flush();
  return { chunks, binaryPaths: [...binaryPaths] };
}

function compareFindings(a, b) {
  return (
    (a.tier === b.tier ? 0 : a.tier === "HIGH" ? -1 : 1) ||
    String(a.path ?? a.scope ?? "").localeCompare(String(b.path ?? b.scope ?? "")) ||
    (a.line ?? 0) - (b.line ?? 0) ||
    String(a.commit ?? "").localeCompare(String(b.commit ?? "")) ||
    a.id.localeCompare(b.id)
  );
}

function scanChunks(chunks) {
  const findings = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const text = chunk.lines.map((entry) => entry.text).join("\n");
    for (const finding of scanText(text)) {
      if (!relevantSecret(finding)) continue;
      const mapped = chunk.lines[Math.max(0, finding.line - 1)] ?? chunk.lines[0];
      if (!mapped?.added) continue;
      const normalized = {
        id: finding.id,
        tier: finding.tier,
        path: chunk.path,
        line: mapped?.line ?? null,
        source: "builtin",
        ...(chunk.commit ? { commit: chunk.commit } : {}),
      };
      const key = [
        normalized.id,
        normalized.path,
        normalized.line,
        normalized.commit ?? "staged",
      ].join(":");
      if (!seen.has(key)) {
        seen.add(key);
        findings.push(normalized);
      }
    }
  }
  return findings.sort(compareFindings);
}

function scanPatchSet(patches, byteBudget = MAX_INPUT_BYTES) {
  let bytes = 0;
  const chunks = [];
  const binaryPaths = new Set();
  for (const { patch, commit = null } of patches) {
    bytes += Buffer.byteLength(patch);
    if (bytes > byteBudget) {
      return {
        complete: false,
        reason: "scan-input-too-large",
        findings: [],
        binaryPaths: [],
      };
    }
    const parsed = parsePatch(patch, commit);
    chunks.push(...parsed.chunks);
    for (const path of parsed.binaryPaths) binaryPaths.add(path);
  }
  return {
    complete: true,
    reason: null,
    findings: scanChunks(chunks),
    binaryPaths: [...binaryPaths].sort(),
  };
}

function scanCommitMessage(message) {
  return scanText(message)
    .filter(relevantSecret)
    .map((finding) => ({
      id: finding.id,
      tier: finding.tier,
      scope: "commit-message",
      source: "builtin",
    }))
    .sort(compareFindings);
}

function scanCommitMetadata(metadata, commit) {
  return scanText(metadata)
    .filter(relevantSecret)
    .map((finding) => ({
      id: finding.id,
      tier: finding.tier,
      scope: "commit-metadata",
      source: "builtin",
      commit,
    }))
    .sort(compareFindings);
}

function scanStaged(cwd) {
  const stats = runGit(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--cached",
    "--numstat",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--",
  ]);
  const inventory = numstatInventory(stats);
  if (!inventory) {
    return {
      complete: false,
      reason: "staged-inventory-unreadable",
      findings: [],
      binaryPaths: [],
    };
  }
  const diff = runGit(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    `--unified=${DIFF_CONTEXT_LINES}`,
    "--no-color",
    "--",
  ]);
  if (!diff.ok) {
    return { complete: false, reason: "staged-diff-unreadable", findings: [], binaryPaths: [] };
  }
  return mergeScanInventory(scanPatchSet([{ patch: diff.stdout }]), inventory);
}

function listCommits(cwd, args) {
  const result = runGit(cwd, ["rev-list", "--reverse", ...args]);
  if (!result.ok) return null;
  return result.stdout.split("\n").filter((value) => /^[0-9a-f]{40,64}$/.test(value));
}

function scanCommits(cwd, commits) {
  const patches = [];
  const binaryPaths = new Set();
  const metadataFindings = [];
  let metadataBytes = 0;
  let metadataSecretPresent = false;
  for (const commit of commits) {
    const metadata = runGit(cwd, ["cat-file", "commit", commit], {
      maxBuffer: MAX_INPUT_BYTES + 1,
    });
    if (!metadata.ok) {
      return {
        complete: false,
        reason: "commit-metadata-unreadable",
        findings: [],
        binaryPaths: [],
      };
    }
    metadataBytes += Buffer.byteLength(metadata.stdout);
    if (metadataBytes > MAX_INPUT_BYTES) {
      return {
        complete: false,
        reason: "scan-input-too-large",
        findings: [],
        binaryPaths: [],
      };
    }
    metadataFindings.push(...scanCommitMetadata(metadata.stdout, commit));

    const stats = runGit(cwd, [
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "--root",
      "-m",
      "--no-commit-id",
      "--numstat",
      "-z",
      commit,
      "--",
    ]);
    const inventory = numstatInventory(stats);
    if (!inventory) {
      return {
        complete: false,
        reason: "commit-inventory-unreadable",
        findings: [],
        binaryPaths: [],
      };
    }
    for (const path of inventory.binaryPaths) binaryPaths.add(path);
    metadataSecretPresent ||= inventory.metadataSecretPresent;

    const result = runGit(cwd, [
      "-c",
      "core.quotePath=false",
      "diff-tree",
      "--root",
      "-m",
      "--no-commit-id",
      "--no-ext-diff",
      "--no-textconv",
      `--unified=${DIFF_CONTEXT_LINES}`,
      "--no-color",
      "-p",
      commit,
      "--",
    ]);
    if (!result.ok) {
      return { complete: false, reason: "commit-diff-unreadable", findings: [], binaryPaths: [] };
    }
    patches.push({ patch: result.stdout, commit });
  }
  const patchScan = scanPatchSet(patches, MAX_INPUT_BYTES - metadataBytes);
  if (patchScan.complete) {
    patchScan.findings = [...patchScan.findings, ...metadataFindings].sort(compareFindings);
  }
  return mergeScanInventory(patchScan, {
    binaryPaths: [...binaryPaths],
    metadataSecretPresent,
  });
}

function originPushEndpoints(cwd) {
  const result = runGit(cwd, ["remote", "get-url", "--push", "--all", "origin"]);
  if (!result.ok) return null;
  return result.stdout.split("\n").filter(Boolean);
}

function liveRemoteHeads(cwd, remote = "origin") {
  const result = runGit(cwd, ["ls-remote", "--heads", "--", remote], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 10_000,
  });
  if (!result.ok) return null;
  const heads = new Map();
  for (const line of result.stdout.split("\n")) {
    const [sha, ref] = line.split("\t", 2);
    if (/^[0-9a-f]{40,64}$/.test(sha ?? "") && ref?.startsWith("refs/heads/")) {
      heads.set(ref.slice("refs/heads/".length), sha);
    }
  }
  return heads;
}

function relationToRemote(cwd, repo, heads) {
  const remoteRef = `refs/heads/${repo.branch}`;
  const remoteSha = heads.get(repo.branch) ?? null;
  if (!remoteSha) {
    return {
      remoteRef,
      remoteSha: null,
      relation: "unpublished",
      localOnly: null,
      remoteOnly: null,
      freshness: "live",
    };
  }
  if (!resolveCommit(cwd, remoteSha)) {
    return {
      remoteRef,
      remoteSha,
      relation: "remote-head-not-local",
      localOnly: null,
      remoteOnly: null,
      freshness: "live",
    };
  }
  const counts = runGit(cwd, [
    "rev-list",
    "--left-right",
    "--count",
    `${remoteSha}...${repo.head}`,
  ]);
  const match = counts.ok ? counts.stdout.trim().match(/^(\d+)\s+(\d+)$/) : null;
  if (!match) {
    return {
      remoteRef,
      remoteSha,
      relation: "unknown",
      localOnly: null,
      remoteOnly: null,
      freshness: "live",
    };
  }
  const remoteOnly = Number.parseInt(match[1], 10);
  const localOnly = Number.parseInt(match[2], 10);
  const relation =
    remoteOnly > 0 && localOnly > 0
      ? "diverged"
      : remoteOnly > 0
        ? "behind"
        : localOnly > 0
          ? "ahead"
          : "equal";
  return { remoteRef, remoteSha, relation, localOnly, remoteOnly, freshness: "live" };
}

function parseNumstat(text) {
  const records = text.split("\0");
  const entries = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) return null;
    const addedRaw = record.slice(0, firstTab);
    const deletedRaw = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!path) {
      i += 2;
      path = records[i] ?? "";
    }
    if (!path) return null;
    const binary = addedRaw === "-" || deletedRaw === "-";
    const added = binary ? null : Number.parseInt(addedRaw, 10);
    const deleted = binary ? null : Number.parseInt(deletedRaw, 10);
    if (!binary && (!Number.isInteger(added) || !Number.isInteger(deleted))) return null;
    entries.push({ path, added, deleted, binary });
  }
  return entries;
}

function numstatInventory(result) {
  if (!result.ok) return null;
  const entries = parseNumstat(result.stdout);
  if (!entries) return null;
  return {
    binaryPaths: entries.filter((entry) => entry.binary).map((entry) => entry.path),
    metadataSecretPresent: entries.some((entry) => secretBearing(entry.path)),
  };
}

function mergeScanInventory(scan, inventory) {
  return {
    ...scan,
    binaryPaths: [...new Set([...scan.binaryPaths, ...inventory.binaryPaths])].sort(),
    metadataSecretPresent: inventory.metadataSecretPresent,
  };
}

function heuristicGenerated(path) {
  return (
    /(^|\/)(?:dist|build|vendor|generated)(?:\/|$)/i.test(path) ||
    /\.min\.(?:js|css)$/i.test(path) ||
    /(^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|composer\.lock)$/i.test(path)
  );
}

function generatedAttributes(cwd, paths) {
  const attributeDiff = runGit(cwd, [
    "diff",
    "--cached",
    "--quiet",
    "--exit-code",
    "HEAD",
    "--",
    ".gitattributes",
    ":(glob)**/.gitattributes",
  ]);
  if (attributeDiff.errorCode || (attributeDiff.code !== 0 && attributeDiff.code !== 1)) {
    return { ok: false, reason: "pr-attributes-unreadable" };
  }
  if (attributeDiff.code === 1) {
    return { ok: false, reason: "pr-attributes-not-at-head" };
  }

  const localAttributes = runGit(cwd, ["rev-parse", "--git-path", "info/attributes"]);
  const localPath = oneLine(localAttributes);
  if (!localPath) return { ok: false, reason: "pr-attributes-unreadable" };
  const resolvedLocalPath = isAbsolute(localPath) ? localPath : resolve(cwd, localPath);
  try {
    const stat = lstatSync(resolvedLocalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LOCAL_ATTRIBUTES_LIMIT) {
      return { ok: false, reason: "pr-local-attributes-present" };
    }
    if (readFileSync(resolvedLocalPath, "utf8").trim()) {
      return { ok: false, reason: "pr-local-attributes-present" };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { ok: false, reason: "pr-attributes-unreadable" };
    }
  }

  const generated = new Set();
  for (let offset = 0; offset < paths.length; offset += 128) {
    const batch = paths.slice(offset, offset + 128);
    const result = runGit(cwd, [
      "-c",
      "core.attributesFile=/dev/null",
      "check-attr",
      "--cached",
      "-z",
      "linguist-generated",
      "--",
      ...batch,
    ]);
    if (!result.ok) return { ok: false, reason: "pr-attributes-unreadable" };
    const fields = result.stdout.split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [path, attribute, value] = fields.slice(i, i + 3);
      if (attribute === "linguist-generated" && (value === "set" || value === "true")) {
        generated.add(path);
      }
    }
  }
  return { ok: true, generated };
}

function measureChanges(cwd, diffArgs) {
  const result = runGit(cwd, [
    "-c",
    "core.quotePath=false",
    "diff",
    "--numstat",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    ...diffArgs,
    "--",
  ]);
  if (!result.ok) return { ok: false, reason: "pr-diff-unreadable" };
  const entries = parseNumstat(result.stdout);
  if (!entries) return { ok: false, reason: "pr-diff-unreadable" };
  const attributes = generatedAttributes(cwd, entries.map((entry) => entry.path));
  if (!attributes.ok) return attributes;

  const generatedFiles = [];
  let totalLines = 0;
  let totalBinary = 0;
  let reviewableFiles = 0;
  let reviewableLines = 0;
  let reviewableBinary = 0;
  for (const entry of entries) {
    const source = attributes.generated.has(entry.path)
      ? "gitattributes"
      : heuristicGenerated(entry.path)
        ? "heuristic"
        : null;
    if (entry.binary) totalBinary += 1;
    else totalLines += entry.added + entry.deleted;
    if (source) generatedFiles.push({ path: entry.path, source });
    else {
      reviewableFiles += 1;
      if (entry.binary) reviewableBinary += 1;
      else reviewableLines += entry.added + entry.deleted;
    }
  }
  return {
    ok: true,
    changes: {
      total: { files: entries.length, lines: totalLines, binaryFiles: totalBinary },
      reviewable: {
        files: reviewableFiles,
        lines: reviewableLines,
        binaryFiles: reviewableBinary,
      },
      generatedFiles: generatedFiles.sort((a, b) => a.path.localeCompare(b.path)),
    },
  };
}

function loadCommitMessage(cwd, message, messageFile) {
  if (message !== null && messageFile !== null) {
    return { ok: false, reason: "commit-message-ambiguous", text: null };
  }
  let bytes = typeof message === "string" ? Buffer.from(message, "utf8") : null;
  if (messageFile !== null) {
    if (typeof messageFile !== "string" || !messageFile) {
      return { ok: false, reason: "commit-message-unreadable", text: null };
    }
    const path = isAbsolute(messageFile) ? messageFile : resolve(cwd, messageFile);
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { ok: false, reason: "commit-message-unreadable", text: null };
      }
      if (stat.size > COMMIT_MESSAGE_LIMIT) {
        return { ok: false, reason: "commit-message-too-large", text: null };
      }
      bytes = readFileSync(path);
    } catch {
      return { ok: false, reason: "commit-message-unreadable", text: null };
    }
  }
  if (!bytes) {
    return { ok: false, reason: "commit-message-required", text: null };
  }
  if (bytes.length > COMMIT_MESSAGE_LIMIT) {
    return { ok: false, reason: "commit-message-too-large", text: null };
  }
  if (bytes.includes(0)) {
    return { ok: false, reason: "commit-message-invalid", text: null };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "commit-message-invalid", text: null };
  }
  if (!text.trim()) {
    return { ok: false, reason: "commit-message-empty", text: null };
  }
  if (bytes.at(-1) !== 10) {
    return { ok: false, reason: "commit-message-final-newline-required", text: null };
  }
  return {
    ok: true,
    reason: null,
    text,
    fingerprint: fingerprintCommitMessage(bytes),
  };
}

function baseResult(operation, repo) {
  return {
    schema: SCHEMA,
    operation,
    verdict: "blocked",
    reason: null,
    repo: repo.ok
      ? {
          head: repo.head,
          branch: repo.branch,
          detached: repo.detached,
          originConfigured: repo.originConfigured,
          base: repo.base,
          upstream: repo.upstream,
          publication: repo.publication,
        }
      : null,
    scan: {
      scope: null,
      range: null,
      commitCount: null,
      complete: false,
      findings: [],
      binaryPaths: [],
    },
    changes: null,
    commit: null,
    push: null,
  };
}

function applyScanVerdict(result) {
  if (!result.scan.complete) {
    result.verdict = "blocked";
    result.reason = result.scan.reason ?? "secret-scan-incomplete";
    return result;
  }
  if (result.scan.findings.some((finding) => finding.tier === "HIGH")) {
    result.verdict = "blocked";
    result.reason = "secret-detected";
    return result;
  }
  if (result.scan.findings.length > 0 || result.scan.binaryPaths.length > 0) {
    result.verdict = "needs-action";
    result.reason = result.scan.findings.length > 0
      ? "credential-review-required"
      : "binary-review-required";
    return result;
  }
  result.verdict = "ready";
  result.reason = null;
  return result;
}

function sanitizeDeliveryResult(result) {
  const state = { redacted: false };
  const scrub = (value) => {
    if (typeof value === "string") {
      if (secretBearing(value)) {
        state.redacted = true;
        return "<redacted>";
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === "object") {
      const sanitized = {};
      for (const [key, child] of Object.entries(value)) {
        if (key === "metadataSecretPresent") {
          state.redacted ||= child === true;
          continue;
        }
        sanitized[key] = scrub(child);
      }
      return sanitized;
    }
    return value;
  };

  const sanitized = scrub(result);
  if (state.redacted) {
    sanitized.verdict = "blocked";
    sanitized.reason = "secret-bearing-git-metadata";
    sanitized.push = null;
    sanitized.metadataRedacted = true;
  }
  return sanitized;
}

function commonRepositoryBlock(result, repo, { requireBase = false, requireOrigin = false } = {}) {
  if (!repo.ok) return repo.reason;
  if (repo.detached) return "detached-head";
  if (RESERVED_TRUNKS.has(repo.branch) || repo.branch === repo.base?.name) return "on-trunk";
  if (requireBase && !repo.base) return "base-not-found";
  if (requireOrigin && !repo.originConfigured) return "origin-not-configured";
  return null;
}

function preflightCommit(cwd, repo, commitMessage) {
  const result = baseResult("commit", repo);
  const blocked = commonRepositoryBlock(result, repo);
  if (blocked) {
    result.reason = blocked;
    return result;
  }
  const worktree = inspectWorktree(cwd);
  if (!worktree) {
    result.reason = "worktree-unreadable";
    return result;
  }
  result.changes = { worktree };
  if (worktree.unmergedPresent) {
    result.reason = "unmerged-index";
    return result;
  }
  if (!worktree.stagedPresent) {
    result.verdict = "needs-action";
    result.reason = worktree.unstagedPresent || worktree.untrackedPresent
      ? "nothing-staged"
      : "no-changes";
    return result;
  }
  if (!commitMessage.ok) {
    result.reason = commitMessage.reason;
    return result;
  }
  const fingerprintBefore = indexFingerprint(cwd);
  if (!fingerprintBefore) {
    result.reason = "index-fingerprint-unavailable";
    return result;
  }
  const scan = scanStaged(cwd);
  const fingerprintAfter = indexFingerprint(cwd);
  if (!fingerprintAfter) {
    result.reason = "index-fingerprint-unavailable";
    return result;
  }
  result.scan = {
    scope: "staged-and-message",
    range: null,
    commitCount: null,
    ...scan,
    findings: [...scan.findings, ...scanCommitMessage(commitMessage.text)].sort(compareFindings),
  };
  if (fingerprintBefore !== fingerprintAfter) {
    result.reason = "index-changed-during-scan";
    return result;
  }
  result.commit = {
    expectedParent: repo.head,
    indexFingerprint: fingerprintAfter,
    messageFingerprint: commitMessage.fingerprint,
  };
  return applyScanVerdict(result);
}

function preflightPush(cwd, repo) {
  const result = baseResult("push", repo);
  const blocked = commonRepositoryBlock(result, repo, { requireBase: true, requireOrigin: true });
  if (blocked) {
    result.reason = blocked;
    return result;
  }
  const pushEndpoints = originPushEndpoints(cwd);
  if (!pushEndpoints || pushEndpoints.length === 0) {
    result.reason = "push-destination-unavailable";
    return result;
  }
  if (pushEndpoints.length !== 1) {
    result.reason = "multiple-push-destinations";
    return result;
  }
  const heads = liveRemoteHeads(cwd, pushEndpoints[0]);
  if (!heads) {
    result.reason = "remote-state-unavailable";
    return result;
  }
  const publication = relationToRemote(cwd, repo, heads);
  repo.publication = publication;
  result.repo.publication = publication;

  let commits;
  let range;
  if (publication.relation === "remote-head-not-local") {
    result.reason = "remote-head-needs-fetch";
    return result;
  }
  if (["behind", "diverged", "unknown"].includes(publication.relation)) {
    result.reason = "non-fast-forward-push";
    return result;
  }
  if (publication.remoteSha) {
    commits = listCommits(cwd, [`${publication.remoteSha}..${repo.head}`]);
    range = `${publication.remoteSha}..${repo.head}`;
  } else {
    const reachableRemoteHeads = [...heads.values()].filter((sha) => resolveCommit(cwd, sha));
    commits = listCommits(cwd, [repo.head, "--not", ...reachableRemoteHeads]);
    range = `${repo.head} --not <live-push-heads>`;
  }
  if (!commits) {
    result.reason = "outbound-range-unreadable";
    return result;
  }
  if (commits.length === 0) {
    result.verdict = "needs-action";
    result.reason = "no-commits-to-push";
    return result;
  }
  const scan = scanCommits(cwd, commits);
  result.scan = {
    scope: "outbound-commits",
    range,
    commitCount: commits.length,
    ...scan,
  };
  result.push = {
    remote: "origin",
    source: repo.head,
    destination: `refs/heads/${repo.branch}`,
    configureUpstream: publication.relation === "unpublished",
  };
  return applyScanVerdict(result);
}

function preflightPullRequest(cwd, repo) {
  const result = baseResult("pr", repo);
  const blocked = commonRepositoryBlock(result, repo, { requireBase: true, requireOrigin: true });
  if (blocked) {
    result.reason = blocked;
    return result;
  }
  const heads = liveRemoteHeads(cwd);
  if (!heads) {
    result.reason = "remote-state-unavailable";
    return result;
  }
  const publication = relationToRemote(cwd, repo, heads);
  repo.publication = publication;
  result.repo.publication = publication;
  if (publication.relation === "unpublished") {
    result.verdict = "needs-action";
    result.reason = "branch-not-published";
    return result;
  }
  if (publication.relation === "ahead") {
    result.verdict = "needs-action";
    result.reason = "branch-has-unpushed-commits";
    return result;
  }
  if (publication.relation === "remote-head-not-local") {
    result.reason = "remote-head-needs-fetch";
    return result;
  }
  if (publication.relation !== "equal") {
    result.reason = "branch-not-current-with-origin";
    return result;
  }

  const liveBaseSha = heads.get(repo.base.name);
  if (!liveBaseSha) {
    result.reason = "base-not-on-origin";
    return result;
  }
  if (!resolveCommit(cwd, liveBaseSha)) {
    result.reason = "base-needs-fetch";
    return result;
  }
  const mergeBase = oneLine(runGit(cwd, ["merge-base", liveBaseSha, repo.head]));
  if (!mergeBase || !/^[0-9a-f]{40,64}$/.test(mergeBase)) {
    result.reason = "merge-base-unavailable";
    return result;
  }
  const commits = listCommits(cwd, [`${liveBaseSha}..${repo.head}`]);
  if (!commits) {
    result.reason = "pr-range-unreadable";
    return result;
  }
  if (commits.length === 0) {
    result.verdict = "needs-action";
    result.reason = "no-commits-for-pr";
    return result;
  }
  const measurement = measureChanges(cwd, [`${mergeBase}..${repo.head}`]);
  if (!measurement.ok) {
    result.reason = measurement.reason;
    return result;
  }
  result.changes = measurement.changes;
  const scan = scanCommits(cwd, commits);
  result.scan = {
    scope: "pull-request-commits",
    range: `${liveBaseSha}..${repo.head}`,
    commitCount: commits.length,
    ...scan,
  };
  return applyScanVerdict(result);
}

export function verifyCreatedCommit({
  cwd = process.cwd(),
  commit,
  expectedParent,
  expectedIndexFingerprint,
  expectedMessageFingerprint,
}) {
  const result = {
    schema: "coredoc.git-delivery-commit-verification/v1",
    operation: "commit",
    phase: "post-commit",
    verdict: "blocked",
    reason: null,
    commit: null,
    scan: {
      scope: "created-commit",
      range: null,
      commitCount: 1,
      complete: false,
      findings: [],
      binaryPaths: [],
    },
    push: null,
  };
  if (
    !/^[0-9a-f]{40,64}$/.test(commit ?? "") ||
    !/^[0-9a-f]{40,64}$/.test(expectedParent ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedIndexFingerprint ?? "") ||
    !/^sha256:[0-9a-f]{64}$/.test(expectedMessageFingerprint ?? "")
  ) {
    result.reason = "verification-input-invalid";
    return result;
  }
  const resolved = resolveCommit(cwd, commit);
  const currentHead = resolveCommit(cwd, "HEAD");
  if (!resolved || resolved !== commit) {
    result.reason = "created-commit-unreadable";
    return result;
  }
  if (currentHead !== commit) {
    result.reason = "head-changed-after-commit";
    return result;
  }
  const parents = oneLine(runGit(cwd, ["rev-list", "--parents", "-n", "1", commit]))
    ?.split(/\s+/)
    .filter(Boolean);
  if (!parents || parents[0] !== commit || parents.length !== 2) {
    result.reason = "created-commit-parent-unreadable";
    return result;
  }
  const treeFingerprint = commitTreeFingerprint(cwd, commit);
  if (!treeFingerprint) {
    result.reason = "created-commit-tree-unreadable";
    return result;
  }
  const messageFingerprint = storedCommitMessageFingerprint(cwd, commit);
  if (!messageFingerprint) {
    result.reason = "created-commit-message-unreadable";
    return result;
  }
  const parent = parents[1];
  const treeMatchesExpected = treeFingerprint === expectedIndexFingerprint;
  const messageMatchesExpected = messageFingerprint === expectedMessageFingerprint;
  result.commit = {
    sha: commit,
    parent,
    treeFingerprint,
    treeMatchesExpected,
    messageFingerprint,
    messageMatchesExpected,
  };
  result.scan = {
    scope: "created-commit",
    range: commit,
    commitCount: 1,
    ...scanCommits(cwd, [commit]),
  };
  applyScanVerdict(result);
  if (result.reason === "secret-detected") return sanitizeDeliveryResult(result);
  if (parent !== expectedParent) {
    result.verdict = "blocked";
    result.reason = "commit-parent-drift";
  } else if (!treeMatchesExpected) {
    result.verdict = "blocked";
    result.reason = "commit-tree-drift";
  } else if (!messageMatchesExpected) {
    result.verdict = "blocked";
    result.reason = "commit-message-drift";
  }
  return sanitizeDeliveryResult(result);
}

export function preflightDelivery({
  cwd = process.cwd(),
  operation,
  base = null,
  message = null,
  messageFile = null,
}) {
  if (!OPERATIONS.has(operation)) {
    throw new TypeError("operation must be commit, push, or pr");
  }
  if (operation !== "commit" && (message !== null || messageFile !== null)) {
    throw new TypeError("commit messages apply only to the commit operation");
  }
  const repo = inspectRepository(cwd, base);
  const commitMessage = operation === "commit"
    ? loadCommitMessage(cwd, message, messageFile)
    : null;
  const result = operation === "commit"
    ? preflightCommit(cwd, repo, commitMessage)
    : operation === "push"
      ? preflightPush(cwd, repo)
      : preflightPullRequest(cwd, repo);
  return sanitizeDeliveryResult(result);
}

function parseArgs(argv) {
  let operation = null;
  let base = null;
  let messageFile = null;
  let verifyCommit = null;
  let expectedParent = null;
  let expectedIndexFingerprint = null;
  let expectedMessageFingerprint = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--operation") operation = argv[++i] ?? null;
    else if (argv[i] === "--base") base = argv[++i] ?? null;
    else if (argv[i] === "--message-file") messageFile = argv[++i] ?? null;
    else if (argv[i] === "--verify-created") verifyCommit = argv[++i] ?? null;
    else if (argv[i] === "--expected-parent") expectedParent = argv[++i] ?? null;
    else if (argv[i] === "--expected-index") {
      expectedIndexFingerprint = argv[++i] ?? null;
    }
    else if (argv[i] === "--expected-message") {
      expectedMessageFingerprint = argv[++i] ?? null;
    }
    else throw new TypeError(`unknown argument: ${argv[i]}`);
  }
  if (verifyCommit !== null) {
    if (operation !== null || base !== null || messageFile !== null) {
      throw new TypeError("verification arguments cannot be combined with preflight arguments");
    }
    if (!expectedParent || !expectedIndexFingerprint || !expectedMessageFingerprint) {
      throw new TypeError("verification requires expected parent, index, and message fingerprints");
    }
    return {
      mode: "verify",
      commit: verifyCommit,
      expectedParent,
      expectedIndexFingerprint,
      expectedMessageFingerprint,
    };
  }
  if (!OPERATIONS.has(operation)) throw new TypeError("--operation must be commit, push, or pr");
  if (operation !== "commit" && messageFile !== null) {
    throw new TypeError("--message-file applies only to commit");
  }
  return { mode: "preflight", operation, base, messageFile };
}

async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch {
    process.stderr.write(
      "git-delivery-preflight: use --operation commit --message-file <path>, " +
      "--operation push|pr [--base <branch>], or --verify-created <sha> " +
      "--expected-parent <sha> --expected-index <fingerprint> " +
      "--expected-message <fingerprint>\n",
    );
    return 64;
  }
  try {
    const result = parsed.mode === "verify"
      ? verifyCreatedCommit(parsed)
      : preflightDelivery(parsed);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        schema: parsed.mode === "verify"
          ? "coredoc.git-delivery-commit-verification/v1"
          : SCHEMA,
        operation: parsed.mode === "preflight" ? parsed.operation : "commit",
        verdict: "blocked",
        reason: "internal-error",
      })}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  // Let piped stdout drain before exit; a forced exit can truncate the JSON.
  process.exitCode = await main(process.argv.slice(2));
}
