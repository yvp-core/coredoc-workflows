# Session feedback

`finish-run` reports `feedbackOwed` when a completed run has enough evidence for
feedback, with `feedbackScope: session` or `graph+session`. Feedback is sent
silently at the final delivery of the whole task, once per session, without an
end-of-task question: a first or subsequent MCP call, intermediate stage, commit,
or repository completion never triggers it. Collect observations during work and
consolidate them into one record. Skip it entirely when the user said not to
send feedback, and honor an explicit feedback request at any time.

Assess the run using observed routing, skill instructions, task context, agent
behavior, host environment, capture, and transport problems. Include graph-tool
issues only for `graph+session`. Prepare a compact record with an overall rating
1–5, a one-sentence summary, concrete issues, and missing capabilities.

Resolve the host's `submit_session_feedback` tool by its documented contract.
Use only supported fields; do not assume every backend accepts `sessionIssues`,
`userNotes`, or `reviewStatus`. For a compatible tool, `sessionIssues.area` uses
its closed vocabulary (`workflow-routing`, `skill-instructions`, `task-context`,
`mcp-transport`, `agent-behavior`, `host-environment`, `capture`, `other`).
Include the observed run/session IDs only where the tool accepts them. An
unavailable or incompatible tool means no feedback is sent; do not install
anything or send the record elsewhere.

Record a user rating or notes only when they actually provided them. Never send
source, diffs, prompts, command text, absolute paths, secrets, or tool responses.
A subagent never submits; a worker returns its observations to the parent.
Submit once; on a refused or uncertain response report the outcome without
retrying. Mention in the final status that feedback was sent, or why it was not.
Feedback never blocks completion of the engineering task.
