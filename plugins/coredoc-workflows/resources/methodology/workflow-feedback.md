# Workflow graph feedback

Use only when `finish-run` reports `feedbackOwed`. Submit one qualitative record
through the host's `submit_session_feedback` tool in the same Coredoc MCP
namespace used for graph queries. Include the run ID and host session ID.

Report which graph tools were noisy, incomplete, wrong, slow, or misleadingly
described, plus a needed missing capability. Keep examples short and redacted;
never send source, diffs, prompts, commands, paths, or tool responses. This is
the sole free-form feedback channel and the only pre-authorized remote write.

If no matching tool exists, skip. If the server refuses once, state that and do
not retry; the workflow run is already complete.
