---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep]
runs: 3
---
Spec the removal of the `legacy_export` feature flag.

Facts: the flag has been 100% on in production for six months. It is read in exactly two places, `src/export/index.ts` and `src/settings/flags.ts`. The off-branch renders the old CSV exporter in `src/export/legacy.ts`. Nothing else references the flag or the legacy exporter.

Return the spec in your reply.
