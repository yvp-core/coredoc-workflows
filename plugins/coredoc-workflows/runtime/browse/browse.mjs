#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { cacheDir } from "../../scripts/project-key.mjs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNTIME_ROOT = dirname(fileURLToPath(import.meta.url));
const SERVER_BINARY = join(RUNTIME_ROOT, "darwin-arm64", "browse-server");
const DEFAULT_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];

export function assertSupportedPlatform(platform = process.platform, arch = process.arch) {
  if (platform !== "darwin" || arch !== "arm64") {
    throw new Error(
      `Bundled browse runtime supports macOS ARM only; received ${platform}/${arch}`,
    );
  }
}

export function resolveChromePath(env = process.env, exists = existsSync) {
  const explicit = env.COREDOC_CHROME_PATH || env.GSTACK_CHROMIUM_PATH;
  if (explicit) {
    if (!exists(explicit)) {
      throw new Error(`Configured Chrome executable does not exist: ${explicit}`);
    }
    return explicit;
  }

  const detected = DEFAULT_CHROME_PATHS.find((candidate) => exists(candidate));
  if (!detected) {
    throw new Error(
      "No supported Chrome installation found. Install Google Chrome or set COREDOC_CHROME_PATH.",
    );
  }
  return detected;
}

export function repositoryRoot(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return resolve(cwd);
  }
}

export function stateFileForRepo(repoRoot, env = process.env) {
  // Browser session state is disposable, so it belongs in the project's cache/.
  // The per-project key comes from the shared resolver rather than a second
  // hashing scheme, so one repository maps to one directory everywhere.
  return join(cacheDir(repoRoot, env), "browse", "state.json");
}

export function extractTabId(args) {
  const remaining = [];
  let tabId;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--tab-id") {
      const value = Number.parseInt(args[index + 1], 10);
      if (Number.isInteger(value)) {
        tabId = value;
      }
      index += 1;
    } else {
      remaining.push(args[index]);
    }
  }
  return { args: remaining, tabId };
}

function readState(stateFile) {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (
      Number.isInteger(state.port) &&
      typeof state.token === "string" &&
      state.token.length > 0
    ) {
      return state;
    }
  } catch {
    // Missing, partial, or stale state is handled by starting a new server.
  }
  return null;
}

async function isHealthy(state) {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: AbortSignal.timeout(750),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer(stateFile, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const state = readState(stateFile);
    if (state && (await isHealthy(state))) {
      return state;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  const errorLog = join(dirname(stateFile), "browse-startup-error.log");
  const detail = existsSync(errorLog) ? readFileSync(errorLog, "utf8").trim() : "";
  throw new Error(
    detail
      ? `Browse runtime failed to start:\n${detail}`
      : "Browse runtime failed to start within 12 seconds",
  );
}

async function ensureServer({ cwd = process.cwd(), env = process.env } = {}) {
  assertSupportedPlatform();
  if (!existsSync(SERVER_BINARY)) {
    throw new Error(`Bundled browse server is missing: ${SERVER_BINARY}`);
  }
  if ((statSync(SERVER_BINARY).mode & 0o111) === 0) {
    chmodSync(SERVER_BINARY, 0o755);
  }

  const stateFile = stateFileForRepo(repositoryRoot(cwd), env);
  const currentState = readState(stateFile);
  if (currentState && (await isHealthy(currentState))) {
    return { state: currentState, stateFile };
  }

  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const chromePath = resolveChromePath(env);
  const server = spawn(SERVER_BINARY, [], {
    detached: true,
    stdio: "ignore",
    env: {
      ...env,
      BROWSE_PARENT_PID: "0",
      BROWSE_STATE_FILE: stateFile,
      GSTACK_CHROMIUM_PATH: chromePath,
    },
  });
  server.unref();

  return { state: await waitForServer(stateFile), stateFile };
}

async function sendCommand(state, command, rawArgs) {
  const { args, tabId } = extractTabId(rawArgs);
  const response = await fetch(`http://127.0.0.1:${state.port}/command`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${state.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      command,
      args,
      ...(tabId === undefined ? {} : { tabId }),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = [parsed.error, parsed.hint].filter(Boolean).join("\n");
    } catch {
      // Plain-text errors are already actionable.
    }
    throw new Error(message || `Browse command failed with HTTP ${response.status}`);
  }
  return text;
}

export function help() {
  return `Coredoc browse — bundled browser for macOS ARM

Usage:
  coredoc-workflows browse doctor
  coredoc-workflows browse <command> [args...]

Typical flow:
  browse.mjs goto https://example.com
  browse.mjs snapshot -i
  browse.mjs click @e1
  browse.mjs fill @e2 "value"
  browse.mjs screenshot /tmp/page.png
  browse.mjs stop
`;
}

export function sanitizeCommandOutput(command, output) {
  return command === "help"
    ? output.replace(/^gstack browse\b/i, "Coredoc browse")
    : output;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help") {
    process.stdout.write(help());
    return;
  }
  if (command === "doctor") {
    assertSupportedPlatform();
    const chromePath = resolveChromePath();
    if (!existsSync(SERVER_BINARY)) {
      throw new Error(`Bundled browse server is missing: ${SERVER_BINARY}`);
    }
    process.stdout.write(`OK darwin/arm64\nChrome: ${chromePath}\nServer: ${SERVER_BINARY}\n`);
    return;
  }

  const { state } = await ensureServer();
  try {
    const rawOutput = await sendCommand(state, command, args);
    const output = sanitizeCommandOutput(command, rawOutput);
    if (output) {
      process.stdout.write(output);
      if (!output.endsWith("\n")) {
        process.stdout.write("\n");
      }
    }
  } catch (error) {
    if (command === "stop" && /fetch failed|other side closed/i.test(error.message)) {
      return;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
