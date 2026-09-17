---
max_turns: 20
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep]
runs: 3
---
Revise this PRD: drop the second goal (we're not doing the digest), and add a new decision: the reminder is sent only on working days (we rejected sending every day). Return the full revised PRD in your reply.

---
status: draft
---

## Summary
Employees forget to submit their timesheet before the period closes; a reminder reduces late submissions.

## Goals
- G-1: Employees submit before close without their manager chasing them.
- G-2: Managers get a weekly digest of who has not submitted.

## Non-goals
- NG-1: No change to the close date itself.

## Decisions
| ID | Decided | Alternative weighed | Who decided |
| --- | --- | --- | --- |
| D-1 | Reminder goes out 24 hours before close | 48 hours | PM |

## User stories
- US-1: As an Employee, I want a reminder before close, so that I submit on time.
- US-2: As a Manager, I want a weekly digest of missing timesheets, so that I can chase early.

## Edge cases
| ID | Case | Resolution |
| --- | --- | --- |
| EC-1 | Employee on leave for the whole period | No reminder is sent |

## Open questions
| ID | Question | Affects | For |
| --- | --- | --- | --- |
| OQ-1 | Does the existing notification service support scheduled sends? [unverified: PM believes yes] | D-1 | Engineering |
