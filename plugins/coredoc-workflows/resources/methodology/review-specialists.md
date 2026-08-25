## Step 4.5: Review Army — targeted specialist dispatch

### Detect risk and context

Use the resolved `DIFF_BASE` to inspect changed paths and line totals. Read the
specification/non-goals when present and record the release context: supported
paths, current users/tenants, realistic load, deployment mode, data-retention
requirements, deprecations, and accepted rollout decisions. Missing context is
unknown; it is not permission to assume enterprise scale or a rolling deploy.

### Select specialists

Read and apply `<plugin-root>/resources/methodology/review-policy.md`. The resolved
`specialist breadth` determines which materially affected risk domains need
separate specialist coverage. Under its generic fallback, cover every materially
affected risk domain below:

- **Testing** — production behavior, a current regression, a public contract, or
  a declared verification gate changed.
- **Maintainability** — the task is a refactor or current duplication creates a
  demonstrated synchronized-edit risk under the repository's Rule of Three.
- **Security** — auth, authorization, tenant isolation, secrets, or an untrusted
  execution boundary changed.
- **Performance** — a measured hot path or realistically large input changed.
- **Data migration** — retained current data or a live schema transition changed.
- **API contract** — a current public consumer contract changed.
- **Design** — user-facing frontend behavior changed.

Do not cap the number of selected domains and do not select one from LOC alone.
Several domains may share one reviewer only when the resolved policy permits it
and the prompt includes every applicable checklist; record the coverage mapping
in the handoff. If none is materially affected, print `Specialists skipped: no
additional risk-specific verification needed.`

### Dispatch

Read and apply `<plugin-root>/resources/methodology/subagent-dispatch.md`. Launch
selected specialists in as many batches as needed. Batch size is bounded by the
resolved policy and host concurrency, but concurrency is not a total assurance
cap. Fresh candidate generation may hide prior findings, but never hide the
specification, non-goals, repository rules, or release context.

Each prompt includes:

1. The specialist checklist content.
2. The canonical finding contract content.
3. The specification, non-goals, release context, and relevant repository rules.
4. Stack/test-framework context and the resolved diff-base command.

Use this output schema, one JSON object per line:

```json
{"severity":"P0|P1|P2|P3|HYPOTHESIS","confidence":8,"path":"file","line":1,"category":"category","summary":"...","evidence":"...","trigger":"...","reachability":"...","observer":"...","impact":"...","violated_contract":"...","existing_handling":"...","release_context":"...","fix":"...","root_cause":"...","specialist":"name"}
```

When only repository-owner release context can determine severity or disposition,
emit the candidate as a main-finding control record instead of inventing severity:

```json
{"status":"NEEDS_CONTEXT","severity":null,"confidence":8,"path":"file","line":1,"category":"category","summary":"...","evidence":"...","trigger":"...","reachability":"...","observer":"...","impact":"...","violated_contract":"...","existing_handling":"...","release_context":"unknown","question":"one concrete question that resolves the item","root_cause":"...","specialist":"name"}
```

Validate every object against the canonical finding contract, including its
missing-context behavior. `test_stub` may be added as a proposed check, but it is
not evidence. If no finding, resolvable hypothesis, or context question exists,
output `NO FINDINGS` and nothing else.

Use `coredoc-workflows:coredoc-reviewer`, or the host's general-purpose equivalent
when plugin agents are unavailable. Retry a failed specialist once. Then handle
the uncovered domain as the resolved policy requires and name the coverage gap;
do not silently claim that domain was reviewed.

### Merge

Parse valid objects and reject entries that violate the finding contract.
Deduplicate by semantic `root_cause`, merging affected locations even when
categories differ. Reviewer agreement is metadata only: do not boost confidence
or severity. Present findings, context questions, and any landing disposition as
the canonical finding contract and resolved Review policy require. Keep every
`NEEDS_CONTEXT` record in the main findings with its one resolving question.
Findings continue into Step 5; review remains read-only.

Compile per-specialist counts for the handoff, including skipped/failed coverage,
without converting counts into a quality score.
