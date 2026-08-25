import { strict as assert } from "node:assert";
import { test } from "../test/test-api.mjs";
import {
  PATTERNS,
  PATTERNS_BY_ID,
  isPlaceholderSpan,
  isPublicIPv4,
  luhnValid,
  shannonEntropy,
} from "./lib/redact-patterns.mjs";
import { emailAllowed, normalizeWithMap } from "./lib/redact-engine.mjs";
import { maskSpan, scanText } from "./redact-scan.mjs";

const ids = (findings) => findings.map((f) => f.id);
const AWS_KEY = ["AKIA1234", "567890ABCDEF"].join("");
const AWS_DOCUMENTATION_KEY = ["AKIAIOSF", "ODNN7EXAMPLE"].join("");
const AWS_SECRET = ["abcdefghijklmnopqrst", "uvwxyz0123456789ABCD"].join("");

// ── Normalization: the evasion vectors ──────────────────────────────────────
// Each of these defeated the scanner before normalization was ported, and each
// defeated it SILENTLY — the scan reported clean, which is the worst possible
// failure for a gate. Regression tests, not hypotheticals.

test("a zero-width space inside a credential does not hide it", () => {
  const evaded = ["key = AK", "IA​1234567890ABCDEF"].join("");
  assert.ok(ids(scanText(evaded)).includes("aws.access_key"));
});

test("every zero-width codepoint in the set is stripped", () => {
  for (const zw of ["​", "‌", "‍", "⁠", "﻿"]) {
    assert.ok(
      ids(scanText(`AKIA${zw}1234567890ABCDEF`)).includes("aws.access_key"),
      `U+${zw.codePointAt(0).toString(16)} still hides the key`,
    );
  }
});

test("fullwidth digits do not hide a credential (NFKC)", () => {
  const evaded = ["key = AK", "IA１２３４５６７８９０ABCDEF"].join("");
  assert.ok(ids(scanText(evaded)).includes("aws.access_key"));
});

test("HTML-escaped characters are expanded before matching", () => {
  const { normalized } = normalizeWithMap("a &amp; b &lt;c&gt;");
  assert.equal(normalized, "a & b <c>");
});

test("reported line points at the ORIGINAL text, not the normalized copy", () => {
  const text = ["line one\nline two\nkey = AK", "IA​1234567890ABCDEF\n"].join("");
  const f = scanText(text).find((x) => x.id === "aws.access_key");
  assert.equal(f.line, 3, "offset map must survive the dropped zero-width char");
});

test("normalizeWithMap keeps the map aligned to original offsets", () => {
  const input = "ab​cd";
  const { normalized, map } = normalizeWithMap(input);
  assert.equal(normalized, "abcd");
  // normalized index 2 is 'c', which sits at original index 3 (after the ZWSP).
  assert.equal(map[2], 3);
  assert.equal(map[map.length - 1], input.length, "sentinel maps to input length");
});

test("findings dedupe by original offset", () => {
  const found = scanText(AWS_KEY);
  assert.equal(found.filter((f) => f.id === "aws.access_key").length, 1);
});

// ── Email allowlist ─────────────────────────────────────────────────────────

test("emailAllowed suppresses sample domains and no-reply localparts", () => {
  assert.equal(emailAllowed("someone@example.com"), true);
  assert.equal(emailAllowed("noreply@github.com"), true);
  assert.equal(emailAllowed("no-reply@acme.io"), true);
  assert.equal(emailAllowed("real.person@acme.io"), false);
});

test("emailAllowed honours the caller's allow set, case-insensitively", () => {
  const allow = new Set(["Dev@Acme.IO"]);
  assert.equal(emailAllowed("dev@acme.io", allow), true);
  assert.equal(emailAllowed("other@acme.io", allow), false);
});

test("scanText suppresses allowlisted addresses but keeps the rest", () => {
  const text = "author dev@acme.io\ncustomer jane@client.com\n";
  const withAllow = scanText(text, { allowEmails: new Set(["dev@acme.io"]) });
  assert.equal(withAllow.filter((f) => f.id === "pii.email").length, 1);
  assert.equal(scanText(text).filter((f) => f.id === "pii.email").length, 2);
});

// ── Port parity ─────────────────────────────────────────────────────────────
// The catalog was converted from TypeScript by stripping annotations. This test
// is the guard that the conversion did not drop, rename, or retier a pattern —
// the failure mode a behavioural test would not notice, because a missing
// pattern simply never fires.

test("catalog carries the full upstream id set at the expected tiers", () => {
  const expected = {
    "aws.access_key": "HIGH",
    "aws.secret_key": "HIGH",
    "github.pat": "HIGH",
    "github.oauth": "HIGH",
    "github.server": "HIGH",
    "github.fine_grained": "HIGH",
    "gitlab.token": "HIGH",
    "huggingface.token": "HIGH",
    "npm.token": "HIGH",
    "digitalocean.token": "HIGH",
    "gcp.service_account": "HIGH",
    "anthropic.key": "HIGH",
    "openai.key": "HIGH",
    "sendgrid.key": "HIGH",
    "stripe.secret": "HIGH",
    "slack.token": "HIGH",
    "slack.webhook": "HIGH",
    "discord.webhook": "HIGH",
    "twilio.auth_token": "HIGH",
    "pem.private_key": "HIGH",
    "db.url_with_password": "HIGH",
    "creds.basic_auth_url": "HIGH",
    "stripe.publishable": "MEDIUM",
    "google.api_key": "MEDIUM",
    jwt: "MEDIUM",
    "env.kv": "MEDIUM",
    "auth.bearer": "MEDIUM",
    "pii.email": "MEDIUM",
    "pii.phone.e164": "MEDIUM",
    "pii.ssn": "MEDIUM",
    "pii.cc": "MEDIUM",
    "pii.ip_public": "MEDIUM",
    "pii.wallet": "MEDIUM",
    "internal.hostname": "MEDIUM",
    "internal.url_private": "MEDIUM",
    "legal.nda_marker": "MEDIUM",
    "legal.named_criticism": "MEDIUM",
    "internal.user_path": "LOW",
    "hygiene.todo": "LOW",
  };
  assert.deepEqual(
    PATTERNS.map((p) => p.id).sort(),
    Object.keys(expected).sort(),
    "pattern id set drifted from the upstream catalog",
  );
  for (const [id, tier] of Object.entries(expected)) {
    assert.equal(PATTERNS_BY_ID[id].tier, tier, `${id} changed tier`);
  }
});

test("no pattern bakes in the g or m flag (the scanner adds them)", () => {
  for (const p of PATTERNS) {
    assert.ok(!p.regex.flags.includes("g"), `${p.id} bakes in the g flag`);
    assert.ok(!p.regex.flags.includes("m"), `${p.id} bakes in the m flag`);
  }
});

// ── Validators ──────────────────────────────────────────────────────────────

test("luhnValid accepts a valid card and rejects a near-miss", () => {
  assert.equal(luhnValid("4111 1111 1111 1111"), true);
  assert.equal(luhnValid("4111111111111112"), false);
  assert.equal(luhnValid("12345"), false);
});

test("shannonEntropy separates repetitive from random", () => {
  assert.ok(shannonEntropy("aaaaaaaaaaaa") < 1);
  assert.ok(shannonEntropy("Xq7#pL2vRt9Z") > 3);
  assert.equal(shannonEntropy(""), 0);
});

test("isPublicIPv4 excludes every private range", () => {
  for (const ip of ["10.0.0.1", "192.168.1.1", "172.16.0.1", "127.0.0.1", "169.254.1.1", "100.64.0.1", "224.0.0.1"]) {
    assert.equal(isPublicIPv4(ip), false, `${ip} should not be public`);
  }
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  assert.equal(isPublicIPv4("172.32.0.1"), true, "172.32 is outside the /12");
  assert.equal(isPublicIPv4("999.1.1.1"), false);
});

test("isPlaceholderSpan is per-span, and spares compound spans", () => {
  assert.equal(isPlaceholderSpan(AWS_DOCUMENTATION_KEY), true);
  assert.equal(isPlaceholderSpan("<your-key>"), true);
  assert.equal(isPlaceholderSpan("your_token"), true);
  assert.equal(isPlaceholderSpan("xxxxxxxx"), true);
  // Compound spans keep the substring guard OFF: a real host may contain
  // "example" without the credential being a placeholder.
  assert.equal(isPlaceholderSpan(["postgres://u:", "p@db.example.com/x"].join("")), false);
});

// ── Scanning ────────────────────────────────────────────────────────────────

test("detects a real-shaped AWS key and suppresses the documentation one", () => {
  assert.ok(ids(scanText(`key = ${AWS_KEY}`)).includes("aws.access_key"));
  assert.ok(!ids(scanText(`key = ${AWS_DOCUMENTATION_KEY}`)).includes("aws.access_key"));
});

test("proximity gating: a bare 40-char token is not an AWS secret key", () => {
  const token = AWS_SECRET;
  assert.ok(!ids(scanText(`hash = ${token}`)).includes("aws.secret_key"));
  assert.ok(
    ids(scanText(`aws_secret_access_key = ${token}`)).includes("aws.secret_key"),
    "should fire once the anchoring key name is within the window",
  );
});

test("proximity window is bounded, not global", () => {
  const token = AWS_SECRET;
  const far = `aws_secret_access_key = x\n${"filler ".repeat(40)}\n${token}`;
  assert.ok(!ids(scanText(far)).includes("aws.secret_key"));
});

test("entropy gate kills a low-entropy env assignment", () => {
  assert.ok(!ids(scanText("API_KEY=changemechangeme")).includes("env.kv"));
  assert.ok(ids(scanText("API_KEY=Xq7pL2vRt9ZbNm4W")).includes("env.kv"));
  assert.ok(!ids(scanText("API_KEY=${SOME_VAR}")).includes("env.kv"));
});

test("a placeholder password suppresses the DB-URL finding", () => {
  const databaseUrl = ["postgres://user:", "hunter2xyz@db.internal:5432/app"].join("");
  assert.ok(ids(scanText(databaseUrl)).includes("db.url_with_password"));
  assert.ok(!ids(scanText("postgres://user:${DB_PASS}@localhost:5432/app")).includes("db.url_with_password"));
});

test("findings carry a 1-based line number", () => {
  const found = scanText(`line one\nline two\nkey = ${AWS_KEY}\n`);
  const aws = found.find((f) => f.id === "aws.access_key");
  assert.equal(aws.line, 3);
});

test("findings sort HIGH first", () => {
  const found = scanText(`TODO(bob) fix\nkey = ${AWS_KEY}\n`);
  assert.equal(found[0].tier, "HIGH");
});

// ── The scanner must not become the leak ─────────────────────────────────────

test("maskSpan never returns the input and keeps only a recognizable stub", () => {
  const secret = AWS_KEY;
  const masked = maskSpan(secret);
  assert.notEqual(masked, secret);
  assert.ok(!masked.includes("1234567890"), "middle must be masked");
  assert.equal(maskSpan("short"), "*****");
});

test("no finding echoes the full matched span", () => {
  const secret = AWS_KEY;
  for (const f of scanText(`key = ${secret}`)) {
    assert.ok(!f.masked.includes(secret), "a finding leaked the full span");
  }
});
