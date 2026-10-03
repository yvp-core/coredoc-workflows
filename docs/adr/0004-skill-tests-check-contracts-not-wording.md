---
status: accepted
---

# Skill tests check contracts, not wording

Skill tests assert only contracts: properties that survive any rewrite that keeps the meaning. The tests that pinned skill prose by regex (several hundred assertions across the skill-content, intent-adoption and Jira suites) are deleted. They failed on harmless rewording and even on line rewrapping. They also made every cut cost a test edit, and they protected sentences, not behaviour. Sediment built up because removing a line felt risky.

A contract test is one of these:
- a generated skill matches its sources;
- frontmatter parses as strict YAML;
- every skill and the Catalog stay under their Ceiling;
- every path a Pointer names exists;
- no unexpanded Partial token or Host-specific identifier appears in a skill;
- CLI command strings appear only in skills that can run them;
- the release manifests agree.

Behaviour that matters is protected by evals and by the code that enforces it, not by pinning the words that describe it. Maintainer policy that has no enforcing code (for example, silent session feedback) is protected by its ADR and by review.
