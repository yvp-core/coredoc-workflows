#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  evaluateRenderer,
  runElectronCommand,
  withElectronPage,
} from "./desktop.mjs";

export function coredocElectronOptions(env = process.env) {
  return {
    env: {
      ...env,
      ELECTRON_QA_URL: env.COREDOC_DESKTOP_QA_URL || env.ELECTRON_QA_URL,
      ELECTRON_QA_PORT: env.COREDOC_DESKTOP_QA_PORT || env.ELECTRON_QA_PORT,
    },
    target: {
      titleContains: "Coredoc",
      urlContains: "localhost:5173",
    },
  };
}

async function status(options) {
  return withElectronPage(async ({ endpoint, target, session }) => {
    const renderer = await evaluateRenderer(
      session,
      "({ hasElectronApi: typeof window.electronAPI === 'object', title: document.title, url: location.href })",
    );
    return { endpoint, targetId: target.id, ...renderer };
  }, options);
}

async function authStatus(options) {
  return withElectronPage(({ session }) =>
    evaluateRenderer(
      session,
      `(async () => {
        if (typeof window.electronAPI?.getWorkspaceAuthStatus !== 'function') return { available: false, isLoggedIn: false };
        const status = await window.electronAPI.getWorkspaceAuthStatus();
        return { available: true, isLoggedIn: status?.isLoggedIn === true };
      })()`,
    ), options,
  );
}

export function help() {
  return `Coredoc desktop QA — Coredoc adapter over the generic Electron QA runtime

Start the app:
  COREDOC_DESKTOP_QA_PORT=9333 pnpm --filter @coredoc/desktop dev

Commands:
  coredoc.mjs doctor
  coredoc.mjs status
  coredoc.mjs auth-status
  coredoc.mjs snapshot
  coredoc.mjs click @e1
  coredoc.mjs fill @e2 "value"
  coredoc.mjs screenshot /tmp/coredoc-desktop.png
  coredoc.mjs console

Authentication status is queried through the app's preload bridge.
`;
}

export async function runCoredocCommand(command, args = [], env = process.env) {
  const options = coredocElectronOptions(env);
  if (command === "doctor" || command === "status") return status(options);
  if (command === "auth-status") return authStatus(options);
  return runElectronCommand(command, args, options);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    process.stdout.write(help());
    return;
  }

  const result = await runCoredocCommand(command, args);
  if (typeof result === "string") process.stdout.write(`${result}\n`);
  else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
