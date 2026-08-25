#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_COMMITS = 20;
const MAX_SUBJECT_LENGTH = 200;

export function parseWindow(value) {
  const match = /^([1-9]\d{0,2})([hdw])$/.exec(value);
  if (!match) {
    throw new Error(
      `Invalid --since value "${value}". Use a positive window such as 24h, 7d, or 4w`,
    );
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const units = {
    h: ["hour", "hours"],
    d: ["day", "days"],
    w: ["week", "weeks"],
  };
  const name = units[unit][amount === 1 ? 0 : 1];

  return {
    label: value,
    gitSince: `${amount} ${name} ago`,
  };
}

export function parseCommitLog(output) {
  return output
    .split("\x1e")
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [sha, authoredAt, author, ...subjectParts] = record.split("\x1f");
      if (!sha || !authoredAt || !author || subjectParts.length === 0) {
        throw new Error("Git returned an unexpected commit record");
      }

      return {
        sha,
        authoredAt,
        author,
        subject: subjectParts.join("\x1f").slice(0, MAX_SUBJECT_LENGTH),
      };
    });
}

export function parseNumstat(output) {
  return output
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [addedText, deletedText, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      if (!addedText || !deletedText || !path) {
        throw new Error("Git returned an unexpected numstat record");
      }

      return {
        path,
        added: addedText === "-" ? null : Number(addedText),
        deleted: deletedText === "-" ? null : Number(deletedText),
      };
    });
}

function commitType(subject) {
  return (
    /^([a-z][a-z0-9-]*)(?:\([^)]+\))?!?:/.exec(subject)?.[1] ?? "other"
  );
}

function areaFor(path) {
  const separator = path.indexOf("/");
  return separator === -1 ? "(root)" : path.slice(0, separator);
}

function isTestPath(path) {
  return (
    /(^|\/)(?:__tests__|test|tests|spec)(?:\/|$)/.test(path) ||
    /(?:\.test\.|\.spec\.|_test\.|_spec\.)/.test(path)
  );
}

function sortedCounts(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .sort(([leftName, leftCount], [rightName, rightCount]) => {
      return rightCount - leftCount || leftName.localeCompare(rightName);
    })
    .map(([name, count]) => ({ name, count }));
}

export function summarizeEvidence(commits, changes) {
  const files = [...new Set(changes.map(({ path }) => path))].sort();
  const testFiles = files.filter(isTestPath);
  const numericChanges = changes.filter(
    ({ added, deleted }) => added !== null && deleted !== null,
  );

  return {
    commitCount: commits.length,
    contributors: [...new Set(commits.map(({ author }) => author))].sort(),
    activeDays: [
      ...new Set(commits.map(({ authoredAt }) => authoredAt.slice(0, 10))),
    ].sort(),
    filesChanged: files.length,
    testFilesChanged: testFiles.length,
    insertions: numericChanges.reduce((total, { added }) => total + added, 0),
    deletions: numericChanges.reduce((total, { deleted }) => total + deleted, 0),
    binaryChanges: changes.length - numericChanges.length,
    commitTypes: sortedCounts(commits.map(({ subject }) => commitType(subject))),
    topAreas: sortedCounts(changes.map(({ path }) => areaFor(path))).slice(0, 10),
  };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = error.stderr?.trim();
    throw new Error(`Git evidence collection failed${detail ? `: ${detail}` : ""}`);
  }
}

export function collectEvidence({ cwd = process.cwd(), since = "7d" } = {}) {
  const window = parseWindow(since);
  const repositoryRoot = git(["rev-parse", "--show-toplevel"], cwd).trim();
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], repositoryRoot).trim();
  const head = git(["rev-parse", "HEAD"], repositoryRoot).trim();
  const commitOutput = git(
    [
      "log",
      "HEAD",
      `--since=${window.gitSince}`,
      "--no-merges",
      "--format=%H%x1f%aI%x1f%aN%x1f%s%x1e",
    ],
    repositoryRoot,
  );
  const numstatOutput = git(
    [
      "log",
      "HEAD",
      `--since=${window.gitSince}`,
      "--no-merges",
      "--format=",
      "--numstat",
    ],
    repositoryRoot,
  );
  const commits = parseCommitLog(commitOutput);
  const changes = parseNumstat(numstatOutput);
  const dirtyPathCount = git(
    ["status", "--short", "--untracked-files=all"],
    repositoryRoot,
  )
    .split("\n")
    .filter(Boolean).length;

  return {
    schemaVersion: 1,
    scope: {
      source: "local HEAD",
      window: window.label,
      since: window.gitSince,
    },
    repository: {
      root: repositoryRoot,
      branch,
      head,
      dirtyPathCount,
    },
    summary: summarizeEvidence(commits, changes),
    commits: commits.slice(0, MAX_COMMITS),
    truncatedCommitCount: Math.max(0, commits.length - MAX_COMMITS),
  };
}

function parseArgs(args) {
  const options = { since: "7d" };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--since") {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[index + 1];
    if (!value) {
      throw new Error("--since requires a value");
    }
    options.since = value;
    index += 1;
  }
  return options;
}

async function main() {
  try {
    const evidence = collectEvidence(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
