#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const REPOSITORY_KEY_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
const GIT_ORIGIN_PROTOCOLS = new Set([
  "git:",
  "git+ssh:",
  "http:",
  "https:",
  "ssh:",
]);

function isRepositoryKey(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  const segments = value.split("/");
  return (
    segments.length >= 2 &&
    segments.every(
      (segment) =>
        segment !== "." &&
        segment !== ".." &&
        REPOSITORY_KEY_SEGMENT_RE.test(segment),
    )
  );
}

export function repositoryKeyFromOrigin(origin) {
  if (typeof origin !== "string" || origin === "") return "";
  const input = origin.trim();
  let path = input;
  const scp =
    !/^[a-z+]+:\/\//i.test(input) && input.match(/^[^@]+@[^:]+:(.+)$/);
  if (scp) {
    path = scp[1];
  } else if (/^[a-z+]+:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      if (
        !GIT_ORIGIN_PROTOCOLS.has(parsed.protocol) ||
        !parsed.hostname ||
        parsed.password ||
        parsed.search ||
        parsed.hash ||
        ((parsed.protocol === "http:" || parsed.protocol === "https:") &&
          parsed.username)
      ) {
        return "";
      }
      path = parsed.pathname.replace(/^\/+/, "");
    } catch {
      return "";
    }
  }
  path = path.replace(/\.git$/, "");
  return isRepositoryKey(path) ? path : "";
}

export function sessionEnvText(event, origin = "") {
  const sessionId = String(event?.session_id ?? "");
  if (
    event?.hook_event_name !== "SessionStart" ||
    !SESSION_ID_RE.test(sessionId)
  ) {
    return "";
  }
  const repoKey = repositoryKeyFromOrigin(origin);
  return [
    `export COREDOC_WORKFLOWS_SESSION_ID=${sessionId}`,
    ...(repoKey ? [`export COREDOC_WORKFLOWS_REPO_KEY=${repoKey}`] : []),
    "",
  ].join("\n");
}

function originFor(event) {
  try {
    return execFileSync(
      "git",
      ["-C", String(event?.cwd ?? process.cwd()), "config", "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        timeout: 1_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return "";
  }
}

async function main() {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;

  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const event = JSON.parse(input || "{}");
  const text = sessionEnvText(event, originFor(event));
  if (text) appendFileSync(envFile, text, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    /* Session attribution is fail-open. */
  });
}
