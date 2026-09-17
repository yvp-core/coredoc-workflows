---
type: llm
focus: {source: file, path: docs/prd/export-scheduling.md}
weight: 1
---
This file is a PRD written from a decided brief. Decision rows, the unverified CSV claim, the two supplied edge-case resolutions, and the unresolved timezone case are checked by regex. Judge only these two claims; both must hold for a pass.

1. No engineering design is presented as decided: no scheduler or queue technology, cron expression, job table, or code path is stated as what will be built. Mentioning such things inside a rejected alternative, an assumption, or an open question for Engineering is fine.
2. Non-goals name the excluded report columns and per-user schedules, and Managers are named as not served.

Fail only if one of these is false. Quote the offending text in the reasoning.
