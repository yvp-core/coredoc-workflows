## Browser setup

This plugin bundles the browser server and launcher for macOS ARM. Resolve the
plugin root as two directories above the invoking adapter skill, then use:

```bash
B="<plugin-root>/bin/coredoc-workflows browse"
$B doctor
```

The launcher uses an installed Google Chrome-compatible browser. It stores
daemon state under `~/Library/Caches/coredoc-workflows`, outside the repository.
Run `$B help` for the runtime command reference.
