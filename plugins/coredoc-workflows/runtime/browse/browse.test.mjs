import assert from "node:assert/strict";
import test from "../../test/test-api.mjs";

import {
  assertSupportedPlatform,
  extractTabId,
  help,
  resolveChromePath,
  sanitizeCommandOutput,
  stateFileForRepo,
} from "./browse.mjs";

test("browse runtime is explicitly limited to macOS ARM", () => {
  assert.doesNotThrow(() => assertSupportedPlatform("darwin", "arm64"));
  assert.throws(
    () => assertSupportedPlatform("linux", "x64"),
    /supports macOS ARM only; received linux\/x64/,
  );
});

test("explicit Chrome path wins and must exist", () => {
  const exists = (path) => path === "/custom/chrome";
  assert.equal(
    resolveChromePath({ COREDOC_CHROME_PATH: "/custom/chrome" }, exists),
    "/custom/chrome",
  );
  assert.throws(
    () => resolveChromePath({ COREDOC_CHROME_PATH: "/missing" }, exists),
    /does not exist/,
  );
});

test("browse state lives outside the repository and is stable per repo", () => {
  const first = stateFileForRepo("/repo/a", {
    COREDOC_WORKFLOWS_STATE_HOME: "/state",
  });
  const second = stateFileForRepo("/repo/a", {
    COREDOC_WORKFLOWS_STATE_HOME: "/state",
  });
  const other = stateFileForRepo("/repo/b", {
    COREDOC_WORKFLOWS_STATE_HOME: "/state",
  });

  assert.equal(first, second);
  assert.notEqual(first, other);
  // Namespaced per project and parked under the disposable cache/, so browser
  // sessions from unrelated repositories never share a directory and clearing
  // the cache cannot reach anything that must survive.
  assert.match(first, /^\/state\/[a-z0-9-]+-[a-f0-9]{8}\/cache\/browse\/state\.json$/);
  assert.ok(!first.startsWith("/repo/"), "state must not live inside the repository");
});

test("tab id is carried separately from command arguments", () => {
  assert.deepEqual(extractTabId(["click", "@e1", "--tab-id", "4"]), {
    args: ["click", "@e1"],
    tabId: 4,
  });
});

test("browser help is prompt-neutral", () => {
  assert.doesNotMatch(help(), /gstack|gbrain|\.gstack/i);
  assert.equal(
    sanitizeCommandOutput("help", "gstack browse — headless browser\nCommands"),
    "Coredoc browse — headless browser\nCommands",
  );
  assert.equal(sanitizeCommandOutput("text", "gstack is page content"), "gstack is page content");
});
