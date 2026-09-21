# Review checklist

Load only the sections relevant to the diff.

## High-impact candidates

These categories identify where to inspect. Assign severity only after the shared
finding contract proves current reachability, impact, and violated behavior;
then use the resolved Review policy to determine whether the finding blocks.

- Data loss, unsafe migrations, incorrect transaction boundaries, or writes that
  bypass invariants.
- Reachable race conditions, non-idempotent retries, or read-check-write sequences
  that can violate a current invariant under the declared deployment model.
- Untrusted LLM, user, database, browser, or shell data crossing a trust boundary
  without validation.
- Command, SQL, path, template, or prompt injection.
- Authentication, authorization, tenant-isolation, or secret-exposure failures.
- New enum/status/type values missing from consumers outside the diff.
- Public contract changes without compatibility handling.

## Other candidates

- Acceptance criteria without implementation or test evidence.
- Error paths that fail silently or return misleading success.
- N+1 queries, unbounded work, leaked processes/handles, or obvious hot-path
  regressions.
- Runtime or distribution changes without an operational delivery path.
- User-visible behavior changed while relevant documentation remains stale.

## Simplification advice

Within the requested diff, look for unused flexibility, one-implementation
abstractions, and custom code or dependencies duplicating an available built-in.
Apply `<plugin-root>/resources/methodology/search-before-building.md` before recommending a
replacement and prove it preserves the current contract. Name the concrete
structure that can be removed and what replaces it. Correct behavior with a
smaller implementation is P3 advice; it does not become a defect or approved work
because of line count. Do not spawn an extra reviewer solely for this lens.
Tests, security checks, input validation, error paths, and accessibility are not
deletion targets. If no useful simplification exists, say nothing about it.

Each observation names one category, and the category carries the claim:

- `delete` — dead code, unused flexibility, or a speculative feature. Nothing
  replaces it.
- `stdlib` — a hand-rolled thing the standard library already ships. Name the
  function.
- `native` — code or a dependency doing what the platform already does. Name the
  feature.
- `speculative` — an abstraction with one implementation, configuration nobody
  sets, or a layer with one caller.
- `shrink` — the same logic in fewer lines, and only when the reduction is at
  least five lines. Below that the advice is noise, not a smaller implementation.

Give the location, what is removed, and what replaces it in one line, plus the
lines removed if the advice is applied, so the reader can weigh it against the
risk of touching working code.

Useful: `lib/email.ts:12 (stdlib) — 27-line validator class; an '@' check covers
it and the confirmation mail is the real validation. Replace with one line, -26.`

Not useful: "this validator class might be more complex than necessary — have you
considered whether all of these rules are needed at this stage?"

## Suppressions

- Do not flag style preferences already enforced by repository tooling.
- Do not request speculative abstractions or unrelated cleanup.
- Do not report theoretical security issues without a concrete exploit path.
- Do not infer enterprise scale, rolling deploys, durable data, or future consumers
  when the release context says otherwise.
- Do not treat missing tests as proof of broken behavior.
- Do not treat tests, examples, or comments as production paths unless they are
  executed or imported by production code.
- Do not report anything the reviewed diff already addresses; read the full diff
  before reporting.

## Finding format

Provide severity, confidence, `path:line`, evidence, impact, and the smallest
recommended fix. Review is read-only unless the user asks to address findings.
