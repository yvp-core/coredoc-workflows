---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep]
runs: 3
---
Write the engineering spec for this PRD. There is no spec folder convention here, so return it in your reply.

---
status: approved
---

# Bulk approval of pending punches

## Goals
- G-1: Supervisors close a period materially faster than approving punches one at a time.
- G-2: Approval stays as trustworthy in bulk as it is one at a time.

## Non-goals and guardrails
- NG-1: No bulk rejection.
- NG-2: Unchanged: which punches require approval and the rules that decide it.
- NG-3: Not for Employees; Admins keep their existing single approval and get nothing new.

## Current vs Desired
**Current behaviour.** A Supervisor approves pending punches one at a time from the punch list. Approving a punch writes an audit row with the approver and time `[unverified]` (OQ-1). The mobile app approval path writes the same audit row `[unverified]` (OQ-2).
**Desired behaviour.** A Supervisor or Manager selects many pending punches from one team and approves them in one action.

## Decisions
| ID | Decided | Alternative weighed | Who decided |
| --- | --- | --- | --- |
| D-1 | Bulk approval runs the same validation as single approval; a failing punch stays pending and the rest are approved | Abort the whole batch | PM |
| D-2 | Only punches in the open period are eligible | Allow re-opening closed periods | PM |
| D-3 | A selection spans one team | Cross-team selection for Managers | PM |

## User stories
**US-1 Bulk approve pending punches for one team**
*As a Supervisor or Manager, I want to approve many pending punches at once, so that closing a period takes minutes, not an hour.*
| # | Acceptance criterion |
| --- | --- |
| 1 | The user can select one or more pending punches from one team and approve the selection in one action |
| 2 | A punch that fails validation stays pending with a stated reason; the others are approved |
| 3 | Every bulk-approved punch carries the same approval record as a singly approved one |

## Edge cases
| ID | Case | Resolution |
| --- | --- | --- |
| EC-1 | Two supervisors approve the same punch at once | The second is told it was already approved |
| EC-2 | Empty selection | The approve action is disabled |

## Open questions
| ID | Question | Affects | For |
| --- | --- | --- | --- |
| OQ-1 | Does single approval write an audit row with approver and time today? | US-1 #3 | Engineering |
| OQ-2 | Does the mobile approval path write the same audit row? | US-1 #3 | Engineering |
| OQ-3 | Is there an upper bound on selection size the UI must enforce? | US-1 #1 | PM |
