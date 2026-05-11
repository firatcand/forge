---
name: setup-repo
description: Bootstrap the GitHub repo for a forge project — repo creation, branch protection, GitHub Environments, CI workflows, secrets configuration.
tools: Read, Write, Edit, Bash(gh*), Bash(git*)
subagent: devops-engineer
---

# /setup-repo

Delegate to the `devops-engineer` subagent.

## Preconditions

- `gh` CLI installed and authenticated
- spec/PRD.md exists
- Run from inside the project directory

## Steps (transparent — show each to user, don't hide)

1. **Verify gh CLI**: `gh auth status`
2. **Create repo**: `gh repo create [name] --private --source=. --remote=origin`
   - Or skip if origin already exists
3. **Initial commit**: if no commits, commit current state to `main`
4. **Branch protection on main**:
   - Require PR review (1)
   - Require `test` status check
   - No direct pushes
   - No force pushes
5. **GitHub Environments**:
   - `development` (auto-deploy, no approval)
   - `production` (manual approval)
6. **Copy CI workflows** from `templates/github-workflows/` to `.github/workflows/`:
   - `claude-issue.yml`
   - `claude-pr-review.yml`
   - `test.yml`
   - `claude-scheduled.yml`
7. **Generate `.env.example`** from SPEC.md env_vars list
8. **Setup Claude Code OAuth token**:
   - Prompt user: `claude setup-token`
   - Read token from clipboard or stdin
   - Set as repo secret: `gh secret set CLAUDE_CODE_OAUTH_TOKEN`
9. **Commit and push**: `.github/`, updated `.env.example`

## Each step shown to user

Don't run all 9 steps silently. Print each:

```
[1/9] Verifying gh CLI authentication... ✓
[2/9] Creating repo firatcand/time-logger... ✓
[3/9] Initial commit on main... ✓
...
```

User can interrupt at any step.

## Output

Repo URL + summary of what was configured. Branch protection rules summary. Workflow files list.
