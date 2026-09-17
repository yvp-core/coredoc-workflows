---
type: regex
target: last_message
match: contains
---
!user\b|user\s*==\s*null|user\s*===\s*null|user\s*==\s*undefined|user\s*===\s*undefined|user\s*\?\.
