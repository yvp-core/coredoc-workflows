# Testing Specialist Review Checklist

Selection and blocking: the resolved Review policy decides both; treat this
checklist as evidence guidance, not a policy override.
Output: use the canonical JSON schema supplied by dispatch, with
`category` and `specialist` set to `testing`.
If no findings: output `NO FINDINGS` and nothing else.

Apply the shared finding contract. Missing coverage alone does not prove a runtime
defect, but report failure of any declared numeric or compliance coverage gate as
such. A behavior defect requires demonstrated wrong behavior on a reachable
accepted path.

---

## Categories

### Missing Negative-Path Tests
- New code paths that handle errors, rejections, or invalid input with NO corresponding test
- Guard clauses and early returns that are untested
- Error branches in try/catch, rescue, or error boundaries with no failure-path test
- Permission/auth checks that are asserted in code but never tested for the "denied" case

### Missing Reachable Edge-Case Coverage
- Boundary values accepted by a current public or trust-boundary input
- Single-element collections (off-by-one on loops)
- Unicode and special characters in user-facing inputs
- Concurrent access patterns that the declared runtime can actually produce

### Test Isolation Violations
- Tests sharing mutable state (class variables, global singletons, DB records not cleaned up)
- Order-dependent tests (pass in sequence, fail when randomized)
- Tests that depend on system clock, timezone, or locale
- Tests that make real network calls instead of using stubs/mocks

### Flaky Test Patterns
- Timing-dependent assertions (sleep, setTimeout, waitFor with tight timeouts)
- Assertions on ordering of unordered results (hash keys, Set iteration, async resolution order)
- Tests that depend on external services (APIs, databases) without fallback
- Randomized test data without seed control

### Security Enforcement Tests Missing
- Auth/authz checks in controllers with no test for the "unauthorized" case
- Rate limiting logic with no test proving it actually blocks
- Input sanitization with no test for malicious input
- CSRF/CORS configuration with no integration test

### Coverage Gaps
- New public methods/functions with zero test coverage
- Changed methods where existing tests only cover the old behavior, not the new branch
- Utility functions called from multiple places but tested only indirectly
