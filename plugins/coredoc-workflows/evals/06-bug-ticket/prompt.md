---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep]
runs: 3
---
Turn this into a ticket.

Bug: users get logged out after 5 minutes instead of 30.

Root cause, already confirmed: `src/auth/session.ts` sets the TTL with `parseInt(process.env.SESSION_TTL_SECONDS) || 300` and compares `Date.now() > created + ttl * 1000`. `SESSION_TTL_SECONDS` is unset in the production environment, so the 300-second fallback applies. Staging sets it to 1800, which is why the bug never showed up there.

Return the ticket in your reply.
