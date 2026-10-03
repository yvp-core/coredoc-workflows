## Step 4.5: Targeted specialist dispatch

### Select specialists

Read and apply `<plugin-root>/resources/methodology/review-policy.md`. The resolved
`specialist breadth` determines which materially affected risk domains need
separate specialist coverage. Under its generic fallback, cover every materially
affected risk domain below. Each carries the evidence bar its specialist must meet
under the finding contract:

- **Testing** — production behavior, a current regression, a public contract, or
  a declared verification gate changed. Missing coverage alone is not a runtime
  defect, but a failed declared numeric or compliance coverage gate is reported
  as such; a behavior defect needs demonstrated wrong behavior on a reachable
  accepted path.
- **Maintainability** — the task is a refactor or current duplication creates a
  demonstrated synchronized-edit risk under the repository's Rule of Three. A
  pure refactor or preference is P3; demonstrated current divergence takes the
  severity of its observable impact. Search for an existing implementation before
  proposing a helper; small local duplication that keeps clarity is fine.
- **Security** — auth, authorization, tenant isolation, secrets, or an untrusted
  execution boundary changed. A finding needs a concrete reachable trust-boundary
  or exploit path; a defense-in-depth idea without one is factual uncertainty,
  not a severity floor.
- **Performance** — a measured hot path or realistically large input changed. A
  finding needs a measured hot path, query plan, or deterministic bound on
  realistic release inputs; a pattern match or possible future scale is factual
  uncertainty.
- **Data migration** — retained current data or a live schema transition changed.
  Establish whether data is retained, the deploy is rolling or coordinated, and a
  migration, export or wipe is already accepted; require no compatibility
  machinery for a deprecated path outside its support window or an approved
  coordinated cutover.
- **API contract** — a current public consumer contract changed. A finding needs
  a current consumer inside its compatibility window; do not invent mobile,
  webhook, SDK, or versioned clients absent release context.
- **Design** — user-facing frontend behavior changed. Use
  `<plugin-root>/resources/review-specialists/design.md` as its checklist.

Select every domain that qualifies, and none from line count alone. Several
domains may share one reviewer only when the resolved policy permits it and the
prompt includes every applicable evidence bar; record the coverage mapping in the
handoff. If none is materially affected, say that specialists were skipped.

### Dispatch

Read and apply `<plugin-root>/resources/methodology/subagent-dispatch.md`. Fresh
candidate generation may hide prior findings, but never hide the specification,
non-goals, repository rules, or release context.

Each prompt includes:

1. The domain's evidence bar above, and `design.md` for Design.
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
missing-context behavior. If no finding, resolvable hypothesis, or context
question exists, output `NO FINDINGS` and nothing else.

### Merge

Reject objects that violate the finding contract, deduplicate by semantic
`root_cause` across categories, and carry the rest into Step 5 with per-specialist
counts, including skipped or failed coverage.
