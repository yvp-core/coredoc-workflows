Before an authorized cache write, resolve the directory rather than composing it:
`COREDOC_WORKFLOW_CACHE=$(<plugin-root>/bin/coredoc-workflows project-key)`. It returns
`~/.coredoc/<project-key>/cache`, namespaced so unrelated repositories never share
state. Everything under it is disposable; nothing that must survive belongs there.
