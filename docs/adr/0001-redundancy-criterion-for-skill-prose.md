---
status: accepted
---

# Redundancy criterion for skill prose

Much of the skill prose was ported from gstack and written for weaker models. The 2026-10-03 audit found about 40% of it removable. To cut it consistently, we judge every passage by one rule instead of case by case. **A passage may be deleted when it passes at least one of four tests, on both Hosts, for every reader that reaches it:**

1. **Guaranteed copy at the point of action.** The same behaviour is certainly in context when this passage would act: the same generated skill, the Catalog, the preamble Partial, or a Reference the same sentence has just told the agent to read. A Reference that is only one Pointer away does not count unless the Pointer fires at that moment. Subagents do not inherit the parent's skill.
2. **Self-explaining enforcement.** Code enforces the behaviour and its output names the remedy. Warn-mode gates do not count.
3. **Dead referent.** The passage describes a command, file, field or mechanism that does not exist in this plugin.
4. **Default behaviour.** Current Claude and Codex models do this unprompted, and the passage is not a counterweight to a known failure.

**Exceptions.** A passage that passes a test is still kept if any of these hold:
- It guards an irreversible or outward-facing action. Keep exactly one copy, at the action.
- It is an output contract that code, the router or a grader parses.
- It is an Incident line from a Coredoc run. Cutting one needs eval evidence. Lines tied to gstack incidents count as inherited text, not Incident lines.

A test lock is not a reason to keep a passage, but the cut must update the test in the same change.

**Overcomplicated text** may be rewritten instead of deleted. A rewrite keeps every branch and every completion criterion of the original and adds no new prohibition. Neither a cut nor a rewrite may add mechanism (new Partial tokens, per-Host builds, new files) unless it removes more mechanism than it adds.

## Consequences

- This criterion covers prose only. Scripts, hooks, gates, stages and status markers are contracts in this pass. Simplifying them is a separate, later audit.
- Ceilings only move down as cuts land.
- Items the audit marked refuted stay closed unless new evidence appears.
