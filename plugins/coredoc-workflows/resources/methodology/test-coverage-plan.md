Tests should prove accepted scenarios and invariants on the real changed path.

### 0. Resolve declared gates

Read and apply `<plugin-root>/resources/methodology/review-policy.md`, including
its resolved `coverage gates`, before planning tests. Also inspect contributor
instructions, CI config, and compliance requirements. An explicit numeric
coverage threshold, mandatory suite, or compliance control is a declared numeric
or compliance coverage gate and is binding:
record its scope, metric/control, command, and required result, and do not weaken
or replace it with a risk judgment. Percentage coverage does not replace
behavioral proof.

When the repository declares no numeric or compliance gate, use risk-based,
proportionate coverage. Do not invent a percentage target or require every
syntactic branch.

### Test Framework Detection

Read repository instructions and existing test configuration. Reuse the normal
runner and the smallest established test surface; do not create a parallel runner.
If no framework exists, return a manual verification step rather than inventing
infrastructure. A manual step cannot satisfy a declared automated or numeric gate;
report that gate as unresolved instead.

### 1. Trace accepted runtime paths

For each acceptance criterion:

1. Start at a current supported entrypoint and follow the changed data/control path.
2. Record the observable success result and any repository invariant it protects.
3. Include an error or boundary case only when a current caller or trust boundary
   can produce it under the release context.
4. Exclude framework-guaranteed internal states, future consumers, unsupported
   deployment modes, and deprecated paths outside their support window.

Search existing tests before proposing a new one. A test that already proves the
criterion counts even if its name or layer differs from the plan.

### 2. Choose the smallest meaningful layer

- **Unit** — pure behavior or a local reachable branch.
- **Integration** — wiring or persistence where mocking could hide the failure.
- **E2E** — one release-critical journey across multiple real components.
- **Eval** — an LLM behavior whose quality, not merely schema, changed.

Do not require one test at every layer. Prefer one test that fails loudly for the
real regression over several tests of implementation details.

### 3. Classify gaps

- **REQUIRED** — an accepted criterion or current regression has no reliable
  verification. Add the smallest test or explicit manual check to the plan.
- **OPTIONAL** — useful strengthening for reachable behavior that is already
  proven elsewhere. Keep it out of implementation unless the resolved policy or
  user opts in.
- **NOT APPLICABLE** — unreachable, framework-guaranteed, deprecated, or outside
  declared release scope. Do not add it.

A missing test is not proof of a bug. Call something a regression only when source,
history, a failing test, or observed behavior proves a previously working current
path broke; uncertainty alone does not create a critical requirement.

### 4. Output the validation map

First list every declared numeric/compliance gate with its current evidence and
status. Then use a compact table mapping each accepted scenario or invariant to
its entrypoint, test/manual check, and status. Add REQUIRED gaps and unsatisfied
declared gates to implementation tasks. Name exact test files and commands when
repository evidence supports them. Do not draw per-file branch diagrams or
enumerate hypothetical user interactions.
