# Proactive session feedback

When `finish-run` reports `feedbackOwed`, assess and draft session feedback at the
final task delivery. Do not wait for the user to request it. The same applies
after Coredoc MCP use or concrete tooling, workflow, or host problems; also honor
an explicit feedback request. `feedbackScope: session` or `graph+session` describes
the evidence. Preparation is required; submission still needs authorization.
Respect an explicit Skip or no-feedback instruction and an already completed
feedback review. During work only collect observations. A first or subsequent MCP
call, intermediate stage, commit, or repository completion never triggers drafting,
a review question, or submission. `feedbackOwed` from an intermediate run waits
until the entire task's final delivery, unless the user requests feedback now.

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

Show the exact redacted draft at completion. In an interactive session, offer
Submit as is / Add or correct / Skip once when authorization is missing. A draft-only
request needs no submission question. Existing authorization needs no repeated
confirmation. Automatic activation never authorizes submission.
Record the user's rating or corrected notes only when they actually provided
them, and redact sensitive details before sending. Never send source, diffs,
prompts, command text, absolute paths, secrets, or tool responses.

A new task, silence, unattended execution, or a subagent context never authorizes
submission. A worker returns its draft to the parent. Submit once; on a refused
or uncertain response report the outcome without retrying. Feedback never blocks
completion of the engineering task.
