## Implementation tasks

Derive each task from a specific accepted, actionable finding under the resolved
review policy; when none exists, state that there are zero tasks. A nonblocking
finding stays out unless it was already an accepted requirement or the user opts
in. `NEEDS_CONTEXT` asks its one resolving question before becoming work, and
`HYPOTHESIS` never becomes a task.

```markdown
## Implementation Tasks

- [ ] **T1 (P1)** — <component> — <imperative title>
  - Surfaced by: <review section and exact finding>
  - Boundary: <what it changes, and explicit non-goals>
  - Depends on: <earlier tasks, or none>
  - Outcome: <the accepted outcome it delivers>
  - Files/contracts: <paths or symbols, only once evidence supports them>
  - Verify: <decisive test command, graph query, or manual check>
```

Keep the flat list in the reviewed plan or conversation. Estimate time only under
an established repository convention, and do not split sequential work into fake
parallel lanes. When delegating, tag each task `recon`, `mechanical`, or `hard`
with its named file ownership per
`<plugin-root>/resources/methodology/subagent-dispatch.md`.
