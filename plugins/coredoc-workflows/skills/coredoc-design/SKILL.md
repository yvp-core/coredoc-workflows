---
name: coredoc-design
description: Explore architecture or design options before an implementation plan exists. Use to compare approaches and recommend a direction; use coredoc-plan-review to assess an existing plan.
---

# Design exploration

Start from the user's goal, constraints and decisions already in the conversation.
Read the nearest implementation and its consumers. When Coredoc covers the code,
use one relevant graph read and the applicable accepted intent, then verify the
critical source paths. Missing graph coverage is a limit, not a reason to stop
read-only exploration.

Compare two or three viable approaches only where there is a real tradeoff.
Include the current approach when it is viable. For each, explain the observable
behavior, compatibility and migration cost, principal failure mode, and cheapest
check that would distinguish it from alternatives. Recommend one with reasons.
Do not turn an unexplored requirement into a fixed product decision.

Produce a short direction with affected boundaries, explicit non-goals, open
questions and a proof plan. Bundle independent unanswered questions; reuse prior
answers. A request to explore design alone does not authorize implementation.
If implementation is already authorized, carry the chosen direction into the
appropriate change route without repeating settled questions. Large-change
`design` stages continue to use coredoc-plan-review on their existing spec.
