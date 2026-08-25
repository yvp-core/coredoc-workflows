---
name: coredoc-learn
description: Extract, inspect, or explicitly persist a concise reusable engineering lesson grounded in repository evidence. Use when asked what was learned, to remember a lesson, or to audit documented learnings.
---

# Evidence-grounded learning

Turn an observed outcome into a future action, not a transcript or prompt archive.

## Default behavior

- Stay read-only unless the user explicitly asks to save, update, or remove a
  learning.
- Use the current task evidence plus local repository history, tests, rules, and
  Coredoc graph context where useful.
- Do not automatically capture anything at the end of a task.
- Do not create a global memory database, append-only ledger, hidden history, or
  plugin-specific state directory.
- Never persist the original task, prompts, command bodies, source, diffs, logs,
  credentials, personal data, or full incident narratives.

## Quality gate

A candidate is worth retaining only when it:

1. generalizes beyond the current incident;
2. cites concrete evidence;
3. changes a future decision or action;
4. states its scope and a condition for revalidation; and
5. does not merely repeat a repository rule that already exists.

If it fails this gate, explain the observation in the current conversation and do
not recommend persistence.

## Learning card

Resolve the plugin root as two directories above this file and use
`<plugin-root>/resources/learning-card.md`. Keep the card under 120 words.
Prefer a stable SHA, file path, test name, incident identifier, or measurement as
evidence. Mark inference as inference.

## Persistence boundary

Only persist when the user explicitly asks:

1. Search repository documentation for an existing learning or rule first.
2. Update the existing entry when it expresses the same lesson.
3. Prefer the repository's established contributor or agent documentation.
4. If no convention exists, ask where the learning belongs before creating a new
   storage location.
5. Show the exact proposed card and target before writing.

Deletion or broad pruning requires an explicit target. Do not infer permission to
rewrite unrelated guidance.
