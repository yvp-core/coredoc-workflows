## Base branch detection

Determine the comparison base without mutating remote state.

1. Inspect `git remote get-url origin` and existing local refs.
2. When an authenticated GitHub or GitLab CLI is already available, read the
   current PR/MR target branch. This is optional and read-only.
3. Otherwise resolve `refs/remotes/origin/HEAD`.
4. Fall back to an existing `origin/main`, then `origin/master`, then local
   `main` or `master`.
5. If none resolve, use `HEAD^` only when it exists; otherwise explain that
   there is no meaningful branch comparison.

```bash
BASE_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
[ -z "$BASE_BRANCH" ] && git rev-parse --verify origin/main >/dev/null 2>&1 && BASE_BRANCH=main
[ -z "$BASE_BRANCH" ] && git rev-parse --verify origin/master >/dev/null 2>&1 && BASE_BRANCH=master

if [ -n "$BASE_BRANCH" ] && git rev-parse --verify "origin/$BASE_BRANCH" >/dev/null 2>&1; then
  DIFF_BASE=$(git merge-base "origin/$BASE_BRANCH" HEAD)
elif [ -n "$BASE_BRANCH" ] && git rev-parse --verify "$BASE_BRANCH" >/dev/null 2>&1; then
  DIFF_BASE=$(git merge-base "$BASE_BRANCH" HEAD)
else
  DIFF_BASE=$(git rev-parse HEAD^ 2>/dev/null || git rev-parse HEAD)
fi
```

Print the selected branch and commit. Use the same `DIFF_BASE` for all diff and
log commands in the workflow. Fetch only when the user explicitly asks for fresh
remote state.
