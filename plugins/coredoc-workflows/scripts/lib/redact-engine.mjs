/**
 * redact-engine — PARTIAL port of the upstream `lib/redact-engine.ts` (MIT, see
 * ../../THIRD_PARTY_NOTICES.md). Two pieces only: input normalization and the
 * email allowlist, including Git transport identities.
 *
 * What came across, and why each is load-bearing:
 *
 *   normalizeWithMap — matching against raw text is evadable. A zero-width space
 *     inside a credential, a fullwidth digit, or an HTML-escaped character all
 *     break a regex that would otherwise fire, and they break it SILENTLY: the
 *     scan reports clean. Normalizing first closes that, and the offset map is
 *     what keeps the reported line pointing at the real text rather than at the
 *     normalized copy.
 *
 *   emailAllowed — `pii.email` matches every address in the input, including the
 *     committed author emails, `noreply@` addresses and `example.com` samples
 *     that every repository carries. Without the allowlist the MEDIUM tier fills
 *     with noise, and the catalog's own calibration note applies: a gate that
 *     cries wolf gets ignored.
 *
 *   isSshGitRemote — `git@github.com:owner/repo.git` and
 *     `ssh://user@host/repo.git` are transport identities, not mailboxes, and
 *     they appear in every README and CI config. The exemption matches the
 *     transport SHAPE (known forge host, scp-style `:path.git`, or an `ssh://`
 *     URL) rather than exempting `git@` wholesale, so a real address on a
 *     git-looking host still reports.
 *
 * What deliberately did NOT come across:
 *   - `applyRedactions` / `redactFindingSpans` — file scanning never rewrites
 *     source. Bounded, opt-in question capture uses `redact-text.mjs` instead.
 *   - `toolFenceRanges` — degrades findings inside tool-output fences to WARN.
 *     That is for scanning agent transcripts; here the inputs are source files
 *     and specification artifacts.
 *   - repo-visibility tiering and the WARN severity — the scanner reports the
 *     catalog's three tiers as-is and never mutates a finding's tier.
 */

// ── Normalization ────────────────────────────────────────────────────────────

const ZERO_WIDTH = /[​‌‍⁠﻿]/;

const HTML_ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * Normalize text for matching while producing an index map back to the original.
 * Returns the normalized string and an array mapping each normalized offset to
 * the corresponding original offset.
 *
 * Strategy: walk the original char-by-char, applying NFKC per char, dropping
 * zero-width chars, and expanding a small fixed set of HTML entities. Each
 * emitted normalized char records the original offset it came from, which keeps
 * the map exact because every transformation applied here is local.
 */
export function normalizeWithMap(input) {
  const out = [];
  const map = [];
  let i = 0;
  while (i < input.length) {
    // HTML entity expansion (fixed small set).
    let matchedEntity = false;
    for (const ent in HTML_ENTITIES) {
      if (input.startsWith(ent, i)) {
        for (const ch of HTML_ENTITIES[ent]) {
          out.push(ch);
          map.push(i);
        }
        i += ent.length;
        matchedEntity = true;
        break;
      }
    }
    if (matchedEntity) continue;

    const ch = input[i];
    if (ZERO_WIDTH.test(ch)) {
      i += 1;
      continue;
    }

    for (const nch of ch.normalize("NFKC")) {
      out.push(nch);
      map.push(i);
    }
    i += 1;
  }
  // Sentinel so an offset equal to the length maps to the original length.
  map.push(input.length);
  return { normalized: out.join(""), map };
}

// ── Email allowlist ──────────────────────────────────────────────────────────

const EMAIL_ALLOW_DOMAINS = [/@example\.(com|org|net)$/i, /@example\.[a-z]{2,}$/i];
const EMAIL_ALLOW_LOCALPARTS = [/^noreply@/i, /^no-reply@/i, /^donotreply@/i];

/**
 * Whether an email address should be suppressed. `allow` is a set of exact
 * addresses the caller gathered (the invoking user's own address, and the
 * addresses already public in the repository — git authors, CODEOWNERS,
 * package manifests).
 */
export function emailAllowed(email, allow = new Set()) {
  const lower = email.toLowerCase();
  for (const a of allow) {
    if (a.toLowerCase() === lower) return true;
  }
  if (EMAIL_ALLOW_DOMAINS.some((re) => re.test(email))) return true;
  if (EMAIL_ALLOW_LOCALPARTS.some((re) => re.test(email))) return true;
  return false;
}

const SSH_GIT_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "ssh.dev.azure.com"]);

// Match the transport shape; a blanket git@ exemption would hide real email.
export function isSshGitRemote(email, text, start) {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at).toLowerCase();
  const host = email.slice(at + 1).toLowerCase();
  if (local === "git" && SSH_GIT_HOSTS.has(host)) return true;
  const rest = text.slice(start + email.length, start + email.length + 512);
  const scp = /^:(?!\/)([^\s'"`<>]*)/.exec(rest);
  if (scp && /\.git\/?$/.test(scp[1])) return true;
  const before = text.slice(Math.max(0, start - 16), start);
  return /(?:git\+)?ssh:\/\/$/i.test(before) && /^\/[^\s'"`<>]*\.git\/?(?=$|[\s'"`<>])/.test(rest);
}
