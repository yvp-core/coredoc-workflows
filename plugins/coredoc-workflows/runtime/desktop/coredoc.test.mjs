import assert from "node:assert/strict";
import test from "../../test/test-api.mjs";

import { coredocElectronOptions, help } from "./coredoc.mjs";

test("Coredoc adapter maps its endpoint variables into generic Electron QA", () => {
  const options = coredocElectronOptions({
    COREDOC_DESKTOP_QA_URL: "http://localhost:9444",
    COREDOC_DESKTOP_QA_PORT: "9444",
  });

  assert.equal(options.env.ELECTRON_QA_URL, "http://localhost:9444");
  assert.equal(options.env.ELECTRON_QA_PORT, "9444");
  assert.deepEqual(options.target, {
    titleContains: "Coredoc",
    urlContains: "localhost:5173",
  });
});

test("Coredoc adapter documents its app-specific auth probe", () => {
  assert.match(help(), /COREDOC_DESKTOP_QA_PORT=9333/);
  assert.match(help(), /auth-status/);
  assert.match(help(), /preload bridge/);
});
