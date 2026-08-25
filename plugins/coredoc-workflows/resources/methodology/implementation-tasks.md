## Implementation tasks

Before closing a plan review, synthesize findings into a flat list of actionable
tasks. Every task must derive from a specific accepted finding; do not pad the
list.

```markdown
## Implementation Tasks

- [ ] **T1 (P1)** — <component> — <imperative title>
  - Surfaced by: <review section and exact finding>
  - Files/contracts: <paths or symbols likely to change>
  - Verify: <test command, graph query, or manual check>
```

Rules:

- The resolved review policy determines which severities block and which proven
  findings are actionable. A nonblocking finding stays out of the change unless
  it was already an explicit accepted requirement or the user opts in.
  `NEEDS_CONTEXT` asks its one resolving question before becoming work, and
  `HYPOTHESIS` never becomes a task.
- Do not estimate human or agent time unless the repository has an established
  estimation convention.
- If a finding produces no actionable work, do not invent a task.
- Preserve dependencies between tasks, but avoid turning sequential work into
  fake parallel lanes.
- When delegating implementation, tag each task `recon`, `mechanical`, or `hard`
  and list its named file ownership according to
  `<plugin-root>/resources/methodology/subagent-dispatch.md`. The class selects
  the agent and execution policy.
- Include a zero-task statement when the review found nothing actionable.
- Keep the task list in the reviewed plan or conversation. Do not write a
  parallel JSONL artifact or workflow-history file.
