Tests should prove accepted scenarios and invariants on the real changed path.

### 0. Resolve declared gates

Apply the resolved `coverage gates` from
`<plugin-root>/resources/methodology/review-policy.md`, and check contributor
instructions, CI config, and compliance requirements. An explicit numeric
threshold, mandatory suite, or compliance control
is a declared numeric or compliance coverage gate and is binding: record its
scope, metric or control, command, and required result, and never weaken it or
replace it with a risk judgment. Percentage coverage does not replace behavioral
proof. Without a declared gate, size coverage to risk, never a percentage target
or every syntactic branch.

### Test Framework Detection

Reuse the repository's runner and smallest established test surface. With no
framework, plan a manual verification step, not new infrastructure; a manual
step cannot satisfy a declared automated or numeric gate, so report that gate as
unresolved.

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

Use a type, build, or schema check; a unit test for pure behavior or a local
branch; integration where mocking could hide wiring or persistence; one E2E for a
release-critical journey across real components; or an eval when LLM behavior
quality, not merely schema, changed. Do not require one test at every layer;
prefer one that fails loudly for the real regression over several tests of
implementation details.

### 3. Classify gaps

- **REQUIRED** — an accepted criterion or current regression has no reliable
  verification; add the smallest test or explicit manual check to the plan.
- **OPTIONAL** — strengthening for behavior already proven elsewhere; leave it out
  of implementation unless the resolved policy or the user opts in.
- **NOT APPLICABLE** — unreachable, framework-guaranteed, deprecated, or outside
  declared release scope; do not add it.

A missing test is not proof of a bug. Call something a regression only when
source, history, a failing test, or observed behavior proves a working current
path broke.

### 4. Output the validation map

Fill plan-review's validation map, listing each declared gate first with its
current evidence and status. Add REQUIRED gaps and unsatisfied declared gates to
implementation tasks, naming exact test files and commands where evidence
supports them.
