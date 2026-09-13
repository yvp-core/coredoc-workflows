import assert from "node:assert/strict";
import test from "../../test/test-api.mjs";

import { maskSecrets, sanitizeCaptureText } from "./redact-text.mjs";
import { scanText } from "../redact-scan.mjs";

const GITHUB_PAT = `ghp_${"a1b2c3d4".repeat(4)}Z9y8`;
const AWS_KEY = ["AKIAIOSF", "ODNN7REALKEY"].join("");

test("masks catalog secrets inside otherwise ordinary text", () => {
  const masked = maskSecrets(`Use token ${GITHUB_PAT} for the release?`);
  assert.doesNotMatch(masked, /ghp_a1b2c3d4a1b2/);
  assert.match(masked, /^Use token ghp_\*+y8 for the release\?$/);

  assert.equal(maskSecrets(`key ${AWS_KEY} in env`).includes(AWS_KEY), false);
  assert.equal(
    maskSecrets("Should I rename src/foo.ts to src/bar.ts?"),
    "Should I rename src/foo.ts to src/bar.ts?",
  );
});

test("masks the email address rather than the question around it", () => {
  const masked = maskSecrets("Notify dev@example.com when done?");
  assert.equal(masked, "Notify <REDACTED-EMAIL> when done?");
});

test("strips control characters, keeps newlines, and bounds with an ellipsis", () => {
  assert.equal(sanitizeCaptureText("a\r\nbc\u001b[0m", 100), "a\nbc[0m");
  assert.equal(sanitizeCaptureText("  padded  ", 100), "padded");
  assert.equal(sanitizeCaptureText(42, 100), "");
  assert.equal(sanitizeCaptureText(" ", 100), "");
  const bounded = sanitizeCaptureText("x".repeat(600), 500);
  assert.equal(bounded.length, 500);
  assert.equal(bounded.at(-1), "…");
});

test("normalization cannot hide a credential in captured prose", () => {
  const key = ["AKIA1234", "567890ABCDEF"].join("");
  for (const value of [key, key.slice(0, 2) + "\u200b" + key.slice(2), key.replace("1", "１")]) {
    const result = sanitizeCaptureText(`Use ${value}?`, 2000);
    assert.equal(scanText(result).some((finding) => finding.tier === "HIGH"), false);
    assert.notEqual(result, `Use ${value}?`);
  }
});

test("context validators handle hostnames and dotenv paths during capture", () => {
  const result = maskSecrets("Check api.internal and .env.local");
  assert.doesNotMatch(result, /api\.internal/);
  assert.ok(result.endsWith("and .env.local"));
});
