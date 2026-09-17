---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep]
runs: 3
---
Write the PRD for bulk approval of pending punches. Everything I know is below; draft it now and put anything you would still ask into open questions.

Goal: supervisors close a period faster. Today they approve pending punches one at a time from the punch list; a supervisor with 40 people spends about an hour per period on it.
For: Supervisors and Managers. Explicitly not for Employees; Admins keep their existing single approval and get nothing new.
Decisions I've made:
- bulk approval runs exactly the same validation as single approval; an item that fails validation stays pending and the rest are approved (alternative we rejected: abort the whole batch).
- only punches in the open period are eligible; closed periods are untouched (alternative rejected: allow re-opening).
- selection is limited to one team at a time (alternative rejected: cross-team selection for Managers).
Current behaviour as I understand it: approving a punch writes an audit row with the approver and time; I believe the same audit row is written by the mobile app approval path, but I'm not certain.
Non-goals: no bulk rejection, no keyboard shortcuts, no change to which punches need approval.
Edge cases: two supervisors approving the same punch at once, second one gets a message that it was already approved; an empty selection, the approve button is disabled; a punch edited between selection and approval, I have not decided what happens there.

There is no PRD folder convention in this repo, so return the PRD in your reply.
