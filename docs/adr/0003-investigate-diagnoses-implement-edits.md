---
status: accepted
---

# Investigate diagnoses; implement edits

`coredoc-investigate` ends at a verified diagnosis and does not edit code. In a routed run it stops there, and the router's implement stage makes the fix. In a standalone run its fix phase is a Pointer to `coredoc-implement`, so every code edit goes through implement's branch-start, gates and regression proof.

Before this, Phase 4 of investigate made the fix itself. On the routed bug-fix route that meant edits landed before branch-start and outside implement's gates. Investigate's own DONE condition also required "fix applied".

We rejected shortening Phase 4 in place and adding a routed-run stop line. That would leave two places describing how a fix is made.
