---
max_turns: 5
timeout_seconds: 120
allowed_tools: [Skill]
runs: 3
---
Add a null check for `user` to this function and show me the diff. Nothing else.

```ts
export function displayName(user: User): string {
  const first = user.profile.firstName.trim();
  const last = user.profile.lastName.trim();
  if (!first && !last) {
    return user.email;
  }
  return `${first} ${last}`.trim();
}
```
