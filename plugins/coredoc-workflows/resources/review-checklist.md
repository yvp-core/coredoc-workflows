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

## Suppressions

- Do not flag style preferences already enforced by repository tooling.
- Do not request speculative abstractions or unrelated cleanup.
- Do not report theoretical security issues without a concrete exploit path.
- Do not infer enterprise scale, rolling deploys, durable data, or future consumers
  when the release context says otherwise.
- Do not treat missing tests as proof of broken behavior.
- Do not treat tests, examples, or comments as production paths unless they are
  executed or imported by production code.

## Finding format

Provide severity, confidence, `path:line`, evidence, impact, and the smallest
recommended fix. Review is read-only unless the user asks to address findings.
