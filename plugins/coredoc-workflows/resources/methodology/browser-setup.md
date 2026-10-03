## Browser setup

This plugin bundles the browser server and launcher for macOS ARM. Resolve the
plugin root as two directories above the invoking adapter skill, then define `B`
in each command:

```bash
B() { "<plugin-root>"/bin/coredoc-workflows browse "$@"; }
B doctor
```

Daemon state lives in `~/.coredoc/<project-key>/cache/browse`, outside the
repository. Run `B help` for the runtime command reference.
