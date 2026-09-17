---
type: regex
target: last_message
match: contains
flags: im
---
^\|\s*EC-\d+\s*\|[^\n]*edited[^\n]*\|[^\n]*(unresolved|open question|OQ-\d+)
