Before an authorized cache write, resolve the directory rather than composing it:
`COREDOC_WORKFLOW_CACHE=$(<plugin-root>/bin/coredoc-workflows project-key)` returns
`~/.coredoc/<project-key>/cache`. Everything under it is disposable; nothing that
must survive belongs there.
