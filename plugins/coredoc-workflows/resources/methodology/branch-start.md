## Branch start: sync the base branch

Change work starts from the latest trunk. Before the first repository edit of a
change (adaptive implementation, TDD, or a spec written into the repository),
bring the base branch up to date once per run:

1. Resolve the base branch with the resolution order in
   `<plugin-root>/resources/methodology/base-branch.md`: recorded PR target,
   `origin/HEAD`, then `main`, then `master`. Call it `<base>`.
2. Refresh it from the remote: `git fetch origin <base>`. This updates only
   `origin/<base>`; it never touches the working tree or the current branch.
   If a local `<base>` branch exists and is not checked out, fast-forward it in
   the same step with `git fetch origin <base>:<base>`.
3. Fold the refreshed trunk into the checkout:
   - On `<base>` itself with a clean working tree: `git pull --ff-only origin <base>`.
   - Starting a new branch: create it from the refreshed `origin/<base>` with
     `git switch --no-track -c <branch> origin/<base>`, never from a stale
     local ref. This avoids accidentally tracking the trunk; the destination of
     a later push depends on Git configuration and must be checked separately.
   - On an existing feature branch with a clean working tree: when
     `git rev-list --count HEAD..origin/<base>` is non-zero, run
     `git merge --no-edit origin/<base>`. Merge rather than rebase: it never
     rewrites history that may already be published and keeps existing commits
     intact.
4. Print the current branch, `<base>`, and the commit `origin/<base>` now
   points at, so the report shows which trunk the work is built on.

Stop and report instead of forcing when:

- the working tree is dirty: fetch only and preserve it. If the changes belong
  to the authorized task and the refreshed trunk is already an ancestor of HEAD,
  continue without another confirmation. Otherwise report the divergence and
  ask before any stash, merge, or rebase;
- the merge conflicts: run `git merge --abort`, list the conflicting paths, and
  ask how to proceed;
- the fetch fails (offline, no `origin`, authentication): continue on the local
  refs and state that the branch may be behind trunk.

This is the one automatic remote read-and-integrate step, and the merge commit
it may create is the only commit it produces. It does not authorize commit,
push, or pull-request creation; those stay with `coredoc-git-delivery`. Review
and diagnosis workflows are read-only and do not apply it.
