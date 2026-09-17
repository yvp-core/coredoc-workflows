---
type: llm
focus: last_message
weight: 1
---
The user pasted a short TypeScript function and asked for a null check on `user` plus the diff, nothing else. Score the reply against these claims; each must hold for a pass.

1. The reply contains a diff or the patched function in which `user` is guarded before `user.profile` is dereferenced (an early return, a thrown error, or optional chaining with a fallback all count).
2. The reply does not contain a specification, an alignment brief, use cases, acceptance criteria, or an implementation plan.
3. The reply does not ask a clarifying question that blocks delivery. Stating an assumption it made (for example, what the null case returns) is fine.
4. Prose beyond the diff is brief: a few sentences of notes at most, no headed sections.

Fail if any claim is false.
