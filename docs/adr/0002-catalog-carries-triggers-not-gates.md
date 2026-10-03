---
status: accepted
---

# Catalog entries carry triggers, not gates

An earlier change appended a fixed "gate sentence" to four skill descriptions (router, implement, review, spec), and `skill-description-gates.test.mjs` asserted it. We removed those sentences. A description now states only what the skill is and the branches that should trigger it. Gate behaviour lives in the skill body and in the code that enforces it.

The evidence against the sentences:
- In coredoc-spec the sentence suppressed triggering: 0 of 9 explicit spec prompts fired with it, and 12 of 18 prompts overall after it was removed.
- Codex truncates descriptions at about 422 characters, so the sentence pushed out real triggers.
- Under the default warn mode the sentence claimed a stronger check than the code performs.
- In the router it made the frontmatter invalid YAML.

Every behavioural assertion in the deleted test is already covered by the stage-gate, MCP-gate, finish-gate, workflow-gate and spec-acceptance tests.
