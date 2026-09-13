# Optional session feedback

`finish-run` reports `feedbackOwed` when a completed run has enough evidence for
feedback, with `feedbackScope: session` or `graph+session`. This is availability,
not authorization to send data or a required end-of-task question. Continue only
when the user requested feedback; otherwise finish the task without prompting.

Assess the run using observed routing, skill instructions, task context, agent
behavior, host environment, capture, and transport problems. Include graph-tool
issues only for `graph+session`. Prepare a compact draft with an overall rating
1–5, a one-sentence summary, concrete issues, and missing capabilities.

If the user authorized submission, resolve the host's `submit_session_feedback`
tool by its documented contract. Use only supported fields; do not assume every
backend accepts `sessionIssues`, `userNotes`, or `reviewStatus`. For a compatible
tool, `sessionIssues.area` uses its closed vocabulary (`workflow-routing`,
`skill-instructions`, `task-context`, `mcp-transport`, `agent-behavior`,
`host-environment`, `capture`, `other`). Include the observed run/session IDs only
where the tool accepts them. An unavailable or incompatible tool leaves a local
draft; do not install anything or send the record elsewhere.

Show the exact draft before sending. Asking to review feedback alone does not
authorize submission: ask once only when the requested outcome needs that write.
Existing authorization for the shown operation needs no repeated confirmation.
Record the user's rating or corrected notes only when they actually provided
them, and redact sensitive details before sending. Never send source, diffs,
prompts, command text, absolute paths, secrets, or tool responses.

A new task, silence, unattended execution, or a subagent context never authorizes
submission. A worker returns its draft to the parent. Submit once; on a refused
or uncertain response report the outcome without retrying. Feedback never blocks
completion of the engineering task.
