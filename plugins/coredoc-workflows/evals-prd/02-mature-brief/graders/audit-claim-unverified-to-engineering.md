---
type: regex
target: last_message
match: contains
flags: im
---
audit[^\n]*\[unverified\][\s\S]*^\|\s*OQ-\d+\s*\|[^\n]*audit[^\n]*\|\s*Engineering\s*\|
