#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { resolveWorkflowRuntime } from "./capture-client.mjs";
import { registerWorkflowRepository } from "./workflow-run-state.mjs";

export function parseTrackRepoArgs(args) {
  if (args.length !== 2 || args[0] !== "--path" || !args[1]?.trim() || args[1].startsWith("--")) {
    throw new Error("usage: coredoc-workflows track-repo --path <checkout>");
  }
  return args[1];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const path = parseTrackRepoArgs(process.argv.slice(2));
    const runtime = resolveWorkflowRuntime();
    const result = registerWorkflowRepository(runtime.sessionId, path, { env: runtime.env });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
