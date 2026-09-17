---
max_turns: 30
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep, Write]
runs: 3
---
This repo keeps PRDs in `docs/prd/`. Write `docs/prd/export-scheduling.md` for this. Draft it now as `status: draft`; anything you would still ask goes into open questions. Everything I know is below:

Goal: account admins stop exporting the hours report by hand every Monday. For: Admins. Not for: Managers (they keep the manual export).
Decisions: weekly schedule only, Monday 06:00 in the account's timezone (rejected: arbitrary cron); the export goes to the account's existing email recipients (rejected: new recipient list); a failed export retries once an hour later, then notifies the admin (rejected: silent skip).
Current behaviour: the manual export is a button on the report page; I believe it uses the same CSV as the API export, not sure.
Non-goals: no new report columns, no per-user schedules.
Edge cases: the report has zero rows, then skip the send and notify the admin; the recipient list is empty, then skip the run and notify the admin; the account timezone changes mid-week, I have not decided what happens there.
