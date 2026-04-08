---
name: git
description: Use when the user asks about Git workflows or repository history, including status checks, branches, commits, rebases, cherry-picks, stashes, conflict resolution, or preparing a clean PR.
tags: git, version-control, branches, commits, rebase, merge
---

# Git

Use this skill for repository hygiene and safe Git execution.

## Workflow

1. Start with read-only inspection unless the user already asked for a specific write action.
2. Check the current state before proposing changes:
   - `git status --short --branch`
   - `git branch --show-current`
   - `git log --oneline --decorate --graph -n 15`
3. If the task mentions a file, commit, or branch, inspect that exact target before acting.
4. Prefer the least-destructive command that achieves the goal.
5. After any write action, verify the result with another read-only command.

## Safety Rules

- Never rewrite history unless the user explicitly wants that outcome.
- Never discard user changes without direct confirmation.
- Treat `git reset --hard`, `git checkout --`, force-push, and branch deletion as high-risk.
- If the worktree is dirty, separate your intended change from unrelated edits before continuing.
- When conflicts appear, explain the conflict source, resolve carefully, and re-check status.

## Common Tasks

### Inspect

- Repo state: `git status --short --branch`
- Recent history: `git log --oneline --decorate --graph -n 20`
- File history: `git log -- path/to/file`
- Diff:
  - unstaged: `git diff`
  - staged: `git diff --cached`
  - against another branch: `git diff main...HEAD`

### Branching

- Create and switch: `git switch -c feature/name`
- Switch existing branch: `git switch branch-name`
- Track remote branch: `git switch --track origin/branch-name`

### Commiting

- Stage targeted files first; avoid broad `git add .` unless the scope is truly all changes.
- Review staged content before commit: `git diff --cached`
- Write commit messages that describe the behavior change, not just the file touched.

### Syncing

- Fetch before comparing with remote: `git fetch --all --prune`
- Prefer rebase or merge based on the branch policy already used in the repo.
- If branch policy is unclear, inspect recent history first instead of guessing.

### Recovery

- Use `git reflog` when the user needs to find lost commits or recover a prior HEAD.
- Use `git stash push -m "<name>"` only when temporary shelving is clearly useful.
- When restoring a single file or commit, prefer targeted restore/cherry-pick over broad resets.

## Response Guidelines

- State current branch and worktree state before risky operations.
- Tell the user what you inspected, what you changed, and how you verified it.
- If you are making an inference about intent, say so explicitly.
