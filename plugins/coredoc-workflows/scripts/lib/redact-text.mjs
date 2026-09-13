/**
 * redact-text — bounded text for the one capture event that carries prose
 * (`workflow.question.answered`). Every other capture field is an enum, an
 * integer, or a compact identifier; this is the single place free text is
 * admitted, so it is masked and bounded before it can reach the outbox.
 *
 * Masking reuses the redact-scan catalog rather than a second taxonomy: each
 * pattern runs with its own validator and the placeholder guard, and a match is
 * replaced by the catalog's redaction token or the scanner's head/tail mask.
 * Precision matters less here than in the file scanner — a false positive
 * hides a few characters of a question, a false negative ships a credential.
 */

import { PATTERNS, isPlaceholderSpan } from "./redact-patterns.mjs";
import { normalizeWithMap } from "./redact-engine.mjs";
import { maskSpan } from "../redact-scan.mjs";

// Every C0 control except tab and newline, plus DEL.
const CONTROL_CHARACTER_RE = /[\u0000-\u0008\u000B-\u001F\u007F]/g;
const ELLIPSIS = "…";

/** Replace every catalog match in `text` with a mask, validators applied. */
export function maskSecrets(text) {
  let out = normalizeWithMap(String(text)).normalized;
  for (const pattern of PATTERNS) {
    const re = new RegExp(
      pattern.regex.source,
      `${pattern.regex.flags.replace(/[gm]/g, "")}gm`,
    );
    out = out.replace(re, (match, ...rest) => {
      const groups = rest.slice(0, -2);
      const offset = rest[rest.length - 2];
      const span = typeof groups[0] === "string" ? groups[0] : match;
      if (span === "") return match;
      if (pattern.nearRegex) {
        const window = pattern.nearWindow ?? 100;
        const from = Math.max(0, offset - window);
        const to = Math.min(out.length, offset + match.length + window);
        if (!pattern.nearRegex.test(out.slice(from, to))) return match;
      }
      const context = Object.assign([match, ...groups], { index: offset, input: out });
      if (pattern.validate && !pattern.validate(span, context)) return match;
      if (isPlaceholderSpan(span)) return match;
      return match.replace(span, pattern.redactToken ?? maskSpan(span));
    });
  }
  return out;
}

/**
 * Normalize, mask, trim, and bound one text field. Returns "" for a non-string
 * or an input that is empty after cleaning, so callers can omit the field.
 */
export function sanitizeCaptureText(value, maximum) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARACTER_RE, "");
  const masked = maskSecrets(cleaned).trim();
  if (masked.length <= maximum) return masked;
  return `${masked.slice(0, Math.max(0, maximum - ELLIPSIS.length)).trimEnd()}${ELLIPSIS}`;
}
