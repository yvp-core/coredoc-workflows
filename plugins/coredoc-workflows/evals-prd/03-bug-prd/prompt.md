---
max_turns: 25
timeout_seconds: 600
allowed_tools: [Skill, Read, Glob, Grep]
runs: 3
---
Turn this into a bug PRD for engineering.

Customers on the weekly overtime policy see the wrong overtime total on the Monday after a period closes; by Tuesday the number is right. It affects only accounts with a shift crossing midnight on Sunday. Expected: the total is right as soon as the period closes. I think it's the nightly recalculation job not picking up the overnight shift until the next run, but that's my guess.

Draft it now; anything you would still ask goes into open questions. Return the PRD in your reply; there's no PRD folder here.
