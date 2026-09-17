---
type: regex
target: last_message
match: not_contains
flags: i
---
\b(endpoint|rest api|graphql|schema migration|database table|sql|queue worker|message queue|row[- ]level lock|transaction isolation|idempotency key|code path)\b
