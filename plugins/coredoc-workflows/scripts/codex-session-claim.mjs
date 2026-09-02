#!/usr/bin/env node

import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_STDIN_BYTES = 64 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,256}$/;
const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function ingressToken(env) {
  const configuredRoot = env.COREDOC_HOME;
  if (configuredRoot && !isAbsolute(configuredRoot)) throw new Error("unavailable");
  const root = configuredRoot ? resolve(configuredRoot) : join(homedir(), ".coredoc");
  const path = join(
    root,
    "capture-agent",
    "capture-relay",
    "codex-ingress.json",
  );
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > 4_096
  ) {
    throw new Error("unavailable");
  }
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 2 ||
    value.schemaVersion !== 1 ||
    !TOKEN_RE.test(value.token)
  ) {
    throw new Error("unavailable");
  }
  return value.token;
}

async function stdinJson(stream) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_STDIN_BYTES) throw new Error("too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

export async function claimCodexSession({
  input,
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 1_500,
} = {}) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    !SESSION_ID_RE.test(input.session_id) ||
    typeof input.cwd !== "string" ||
    input.cwd.length === 0 ||
    input.cwd.length > 4_096
  ) {
    return { status: "ignored" };
  }
  const response = await fetchImpl(
    "http://127.0.0.1:43181/codex/v1/session-claims",
    {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "X-Coredoc-Relay-Ingress": ingressToken(env),
      },
      body: JSON.stringify({ sessionId: input.session_id, cwd: input.cwd }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  await response.body?.cancel().catch(() => undefined);
  return { status: response.ok ? "sent" : "ignored" };
}

async function main() {
  try {
    await claimCodexSession({ input: await stdinJson(process.stdin) });
  } catch {
    // Hooks must never block Codex when local capture is unavailable.
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
