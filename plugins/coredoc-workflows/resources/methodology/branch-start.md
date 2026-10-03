## Branch start: sync the base branch

Before a run's first repository edit (implementation, TDD, or a spec written
into the repository), bring the base branch up to date once:

1. Resolve the base branch: the open PR/MR target (read-only, via an
   already-authenticated `gh` or `glab`), else `origin/HEAD`, else `main`, else
   `master`. Call it `<base>`.
2. `git fetch origin <base>`; it never touches the working tree or the current
   branch. If a local `<base>` exists and is not checked out, fast-forward it in
   the same step with `git fetch origin <base>:<base>`.
3. Fold the refreshed trunk into the checkout:
   - On `<base>` itself with a clean working tree: `git pull --ff-only origin <base>`.
   - Starting a new branch: `git switch --no-track -c <branch> origin/<base>`,
     never from a stale local ref, so the branch does not track trunk.
   - On an existing feature branch with a clean working tree: when
     `git rev-list --count HEAD..origin/<base>` is non-zero, run
     `git merge --no-edit origin/<base>`. Merge, never rebase, so possibly
     published history stays intact.
4. Print the current branch, `<base>`, and the commit `origin/<base>` now
   points at.

Stop and report instead of forcing when:

- the working tree is dirty: fetch only and preserve it. If the changes belong
  to the authorized task and the refreshed trunk is already an ancestor of HEAD,
  continue without another confirmation. Otherwise report the divergence and
  ask before any stash, merge, or rebase;
- the merge conflicts: run `git merge --abort`, list the conflicting paths, and
  ask how to proceed;
- the fetch fails (offline, no `origin`, authentication): continue on the local
  refs and state that the branch may be behind trunk.

This is the one automatic fetch-and-integrate step; its merge commit is the only
commit it makes. It does not authorize commit, push, or pull-request creation;
those stay with `coredoc-git-delivery`.

For concurrent branches or client forks, use separate worktrees before editing.
Keep the user's dirty checkout and staging intact. For a run spanning repositories,
call `coredoc-workflows track-repo --path <checkout>` before the first edit in each
additional checkout, including a worktree created after routing; it cannot
reconstruct earlier changes, and only aggregate change counts reach capture.
