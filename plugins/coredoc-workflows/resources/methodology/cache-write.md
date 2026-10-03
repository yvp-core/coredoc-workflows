Before an authorized cache write, resolve the directory rather than composing it:
`<plugin-root>/bin/coredoc-workflows project-key` prints
`~/.coredoc/<project-key>/cache`, written `$COREDOC_WORKFLOW_CACHE` here. Each
tool call starts a fresh shell, so use the printed path literally. Everything
under it is disposable; nothing that must survive belongs there.
