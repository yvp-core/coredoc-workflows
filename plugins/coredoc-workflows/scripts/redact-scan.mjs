#!/usr/bin/env node
/**
 * redact-scan — detect credentials, PII, and internal-leak markers in text.
 *
 * Reads the detection taxonomy (`scripts/lib/redact-patterns.mjs`)
 * and applies it to files or stdin. Detection only: nothing is rewritten, and no
 * input is persisted anywhere.
 *
 * Usage:
 *   node scripts/redact-scan.mjs <path...>       scan files
 *   node scripts/redact-scan.mjs --stdin         scan stdin
 *   node scripts/redact-scan.mjs --tier HIGH …   report only that tier and above
 *   node scripts/redact-scan.mjs --json …        machine-readable findings
 *   node scripts/redact-scan.mjs --repo-emails … suppress addresses already
 *                                                public in this repo (git
 *                                                identity, recent authors,
 *                                                CODEOWNERS)
 *   node scripts/redact-scan.mjs --allow <addr>  suppress one exact string
 *                                                (repeatable)
 *
 * Exit codes: 0 no HIGH findings · 2 at least one HIGH finding · 1 usage or
 * read error, or an input that exceeded the size cap (fails CLOSED — an input
 * too large to scan is reported as an error, never as "clean").
 *
 * Output NEVER contains a full matched span. Every span is masked before it is
 * printed: a scanner that echoes the secret it found into the transcript has
 * moved the leak rather than caught it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { PATTERNS, isPlaceholderSpan } from "./lib/redact-patterns.mjs";
import { emailAllowed, normalizeWithMap } from "./lib/redact-engine.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

/** Hard input cap. Beyond this we fail closed rather than scan partially. */
export const MAX_INPUT_BYTES = 5 * 1024 * 1024;

const TIER_ORDER = { HIGH: 3, MEDIUM: 2, LOW: 1 };

/**
 * Mask a matched span for output: keep a short head and tail so a human can
 * recognize which secret it is, never enough to use it. Short spans collapse
 * entirely.
 */
export function maskSpan(span) {
  if (span.length <= 8) return "*".repeat(span.length);
  return `${span.slice(0, 4)}${"*".repeat(Math.min(span.length - 6, 12))}${span.slice(-2)}`;
}

/** 1-based line number of a character offset. */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * Scan text against the taxonomy.
 *
 * Matching runs against NORMALIZED text, never the raw input: a zero-width space
 * inside a credential, a fullwidth digit, or an HTML-escaped character each
 * defeat a regex that would otherwise fire, and they defeat it silently — the
 * scan simply reports clean. Offsets are mapped back through `normalizeWithMap`
 * so a reported line points at the real file, not at the normalized copy.
 *
 * Per match, in order: the pattern regex (with `gm` added here, never baked into
 * the catalog), the proximity requirement when the pattern declares one, the
 * pattern's own validators, the email allowlist for `pii.email`, and finally the
 * global placeholder guard — the catalog's rule is that suppression is
 * per-matched-span, and most patterns (`aws.access_key` among them) carry no
 * validator of their own, so without that step AWS's own documentation key would
 * fire on every repository.
 *
 * Findings are deduplicated by (id, original offset): normalization can collapse
 * several raw spans onto one real location.
 */
export function scanText(text, { patterns = PATTERNS, allowEmails = new Set() } = {}) {
  const { normalized, map } = normalizeWithMap(text);
  const toOriginal = (offset) => map[Math.min(offset, map.length - 1)] ?? 0;

  const findings = [];
  const seen = new Set();
  for (const p of patterns) {
    const re = new RegExp(p.regex.source, `${p.regex.flags.replace(/[gm]/g, "")}gm`);
    let match;
    while ((match = re.exec(normalized)) !== null) {
      // Zero-length matches would spin forever.
      if (match[0] === "") {
        re.lastIndex++;
        continue;
      }
      const span = match[1] ?? match[0];

      if (p.nearRegex) {
        const window = p.nearWindow ?? 100;
        const from = Math.max(0, match.index - window);
        const to = Math.min(normalized.length, match.index + match[0].length + window);
        if (!p.nearRegex.test(normalized.slice(from, to))) continue;
      }
      if (p.validate && !p.validate(span, match)) continue;
      if (p.id === "pii.email" && emailAllowed(span, allowEmails)) continue;
      if (isPlaceholderSpan(span)) continue;

      const origOffset = toOriginal(match.index);
      const key = `${p.id}:${origOffset}`;
      if (seen.has(key)) continue;
      seen.add(key);

      findings.push({
        id: p.id,
        tier: p.tier,
        category: p.category,
        description: p.description,
        line: lineAt(text, origOffset),
        masked: maskSpan(span),
      });
    }
  }
  return findings.sort(
    (a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier] || a.line - b.line || a.id.localeCompare(b.id),
  );
}

/**
 * Addresses that are public in this repository already, so a finding on them is
 * noise rather than a leak: the invoking user's own git identity, recent commit
 * authors, and any address in CODEOWNERS. Read-only, and best-effort — a repo
 * without git simply yields an empty set. The commit scan is capped because on a
 * large history `git log` over every commit costs more than the scan itself.
 */
export function repoPublicEmails(cwd = process.cwd()) {
  const found = new Set();
  const run = (cmd) => {
    try {
      return execFileSync("git", cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return "";
    }
  };
  const self = run(["config", "user.email"]).trim();
  if (self) found.add(self);
  for (const line of run(["log", "-n", "500", "--format=%ae"]).split("\n")) {
    const e = line.trim();
    if (e) found.add(e);
  }
  const owners = run(["show", "HEAD:CODEOWNERS"]) || run(["show", "HEAD:.github/CODEOWNERS"]);
  for (const m of owners.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    found.add(m[0]);
  }
  return found;
}

function parseArgs(argv) {
  const opts = { paths: [], stdin: false, tier: "LOW", json: false, repoEmails: false, allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stdin") opts.stdin = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--repo-emails") opts.repoEmails = true;
    else if (a === "--allow") {
      const v = argv[++i];
      if (!v) throw new Error("--allow expects a value");
      opts.allow.push(v);
    } else if (a === "--tier") {
      const v = (argv[++i] ?? "").toUpperCase();
      if (!TIER_ORDER[v]) throw new Error(`--tier expects HIGH|MEDIUM|LOW, got "${v}"`);
      opts.tier = v;
    } else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
    else opts.paths.push(a);
  }
  if (!opts.stdin && opts.paths.length === 0) {
    throw new Error("Nothing to scan. Pass file paths or --stdin.");
  }
  return opts;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`redact-scan: ${e.message}\n`);
    return 1;
  }

  const sources = [];
  if (opts.stdin) {
    const buf = await readAll(process.stdin);
    if (buf.byteLength > MAX_INPUT_BYTES) {
      process.stderr.write(`redact-scan: stdin exceeds ${MAX_INPUT_BYTES} bytes; not scanned\n`);
      return 1;
    }
    sources.push({ label: "<stdin>", text: buf.toString("utf8") });
  }
  for (const p of opts.paths) {
    try {
      const buf = readFileSync(p);
      if (buf.byteLength > MAX_INPUT_BYTES) {
        process.stderr.write(`redact-scan: ${p} exceeds ${MAX_INPUT_BYTES} bytes; not scanned\n`);
        return 1;
      }
      sources.push({ label: relative(PLUGIN_ROOT, p) || p, text: buf.toString("utf8") });
    } catch (e) {
      process.stderr.write(`redact-scan: cannot read ${p}: ${e.message}\n`);
      return 1;
    }
  }

  const allowEmails = new Set(opts.allow);
  if (opts.repoEmails) for (const e of repoPublicEmails()) allowEmails.add(e);

  const floor = TIER_ORDER[opts.tier];
  const all = [];
  for (const s of sources) {
    for (const f of scanText(s.text, { allowEmails })) {
      if (TIER_ORDER[f.tier] >= floor) all.push({ ...f, file: s.label });
    }
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
  } else if (all.length === 0) {
    process.stdout.write(`redact-scan: no findings at or above ${opts.tier}\n`);
  } else {
    for (const f of all) {
      process.stdout.write(`${f.tier.padEnd(6)} ${f.id.padEnd(24)} ${f.file}:${f.line}  ${f.masked}\n`);
    }
    const high = all.filter((f) => f.tier === "HIGH").length;
    process.stdout.write(`\n${all.length} finding(s), ${high} HIGH\n`);
  }

  return all.some((f) => f.tier === "HIGH") ? 2 : 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await main(process.argv.slice(2)));
}
