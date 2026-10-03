---
name: coredoc-learn
description: Extract, inspect, or explicitly persist a concise reusable engineering lesson grounded in repository evidence. Use when asked what was learned, to record a lesson, or to audit documented learnings.
---

# Evidence-grounded learning

Turn an observed outcome into a future action, using the current task's
evidence, local repository history, tests and rules, and Coredoc graph context
where useful.

## Quality gate

Keep a candidate only if it generalizes beyond this incident, cites concrete
evidence, changes a future decision or action, states its scope and when to
revalidate it, and does not repeat an existing repository rule. Otherwise
explain the observation in the conversation and do not recommend persisting it.

## Learning card

Keep it under 120 words and mark inference as inference.

- **Lesson:** the reusable conclusion, stated concretely.
- **Applies when:** scope and trigger conditions.
- **Evidence:** a stable commit SHA, path, test name, incident identifier, or
  measurement.
- **Do:** the future action it supports.
- **Avoid:** the failure pattern it replaces.
- **Revalidate when:** what may make it stale.
- **Confidence:** `high`, `medium`, or `low`, with one short reason.

## Persistence boundary

Save, update, or remove a learning only when the user explicitly asks, never
automatically at the end of a task. Lessons live in repository docs, not host
memory or a private state directory. Search them first and update an entry that
states the same lesson; otherwise use the established contributor or agent docs,
and ask where it belongs when there is no convention. Show the exact card and
target before writing. Never persist the original task, prompts, command bodies,
source, diffs, logs, credentials, personal data, or full incident narratives.
Delete or prune only an explicit target, and do not rewrite unrelated guidance.
