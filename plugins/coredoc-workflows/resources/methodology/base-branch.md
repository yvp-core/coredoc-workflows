## Base branch detection

Determine the comparison base without mutating remote state; the script tries
the open PR/MR target first, read-only through an already-authenticated `gh` or
`glab`. If no base branch resolves and HEAD has no parent, say there is no
meaningful branch comparison.

```bash
BASE_BRANCH=$({ gh pr view --json baseRefName -q .baseRefName || glab mr view -F json | jq -r .target_branch; } 2>/dev/null)
[ -z "$BASE_BRANCH" ] && BASE_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
[ -z "$BASE_BRANCH" ] && git rev-parse --verify origin/main >/dev/null 2>&1 && BASE_BRANCH=main
[ -z "$BASE_BRANCH" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE_BRANCH=master

if [ -n "$BASE_BRANCH" ] && git rev-parse --verify "origin/$BASE_BRANCH" >/dev/null 2>&1; then
  DIFF_BASE=$(git merge-base "origin/$BASE_BRANCH" HEAD)
elif [ -n "$BASE_BRANCH" ] && git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  DIFF_BASE=$(git merge-base "$BASE_BRANCH" HEAD)
else
  DIFF_BASE=$(git rev-parse HEAD^ 2>/dev/null || git rev-parse HEAD)
fi
echo "BASE_BRANCH=$BASE_BRANCH DIFF_BASE=$DIFF_BASE"
```

Each tool call starts a fresh shell: use the printed values as literals in later
commands, and the same `DIFF_BASE` for every diff and log command of the
workflow. Fetch only when the user explicitly asks for fresh remote state.
