#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import {
  ackTerminalCaptureEntries,
  captureStateProjectKey,
} from "./capture-state.mjs";

/**
 * `coredoc-workflows capture-health --ack`: drop the delivery-state entries
 * nothing can act on any more — rejections and payloads the outbox lost — so
 * the SessionStart notice stops naming them. Anything still deliverable is
 * kept: this acknowledges a report, it never abandons an event.
 */
export function ackCaptureHealth({
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  return ackTerminalCaptureEntries(captureStateProjectKey({ env, cwd }), { env });
}

function main() {
  process.stdout.write(`${JSON.stringify(ackCaptureHealth())}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
