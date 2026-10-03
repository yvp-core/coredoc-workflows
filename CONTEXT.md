# Coredoc Workflows

An engineering-workflow plugin whose product is agent-facing prose: skills, the files they pull in, and the budgets that keep that prose small.

## Language

### Prose surface

**Partial**:
A methodology file inlined into a skill at build time, paid on every invocation of that skill. A role, not a file type: the same file can be a Partial in one skill and a Reference in another.
_Avoid_: include, snippet, fragment

**Reference**:
A file the agent reads on demand when a Pointer fires, paid only on the branches that reach it.
_Avoid_: appendix, doc, "methodology" as a role name

**Pointer**:
The sentence that names a Reference or a skill and states when to reach it.
_Avoid_: link, see-also

**Catalog**:
Every skill's name and description, always in the agent's context on every turn of every session.
_Avoid_: index, skill list, discovery list

**Ceiling**:
The maximum byte size allowed for one skill or for the Catalog.
_Avoid_: limit, cap

**Incident line**:
A passage added to fix a failure observed in a Coredoc run, as opposed to text inherited from an upstream port.
_Avoid_: guardrail (reserved for guards on irreversible or outward-facing actions)

### Runtime

**Host**:
The agent runtime the plugin runs inside: Claude Code or Codex. Every skill is written for both.
_Avoid_: platform, client, harness
