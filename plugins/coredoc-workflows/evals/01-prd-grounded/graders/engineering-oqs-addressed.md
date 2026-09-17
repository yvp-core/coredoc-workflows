---
type: regex
target: last_message
match: contains
flags: is
---
OQ-1[^\n]{0,400}(verif|cannot|needed|input|source|read)[\s\S]*OQ-2[^\n]{0,400}(verif|cannot|needed|input|source|read)|OQ-2[^\n]{0,400}(verif|cannot|needed|input|source|read)[\s\S]*OQ-1[^\n]{0,400}(verif|cannot|needed|input|source|read)
