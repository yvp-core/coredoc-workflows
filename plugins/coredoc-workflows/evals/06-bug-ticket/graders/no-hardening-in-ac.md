---
type: regex
target: last_message
match: not_contains
flags: im
---
^\|\s*AC-\d+\s*\|[^\n]*(NaN|non-numeric|unparseable|warn|fail[- ]?fast|startup|boot)
