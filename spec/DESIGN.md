# forge — DESIGN

> Mode: project_owned
> Reference: (none — forge owns its own design system)
> Surface: CLI output + README/docs voice. No web/app UI in v-next.

## Surface scope

Forge is a CLI tool. "Design" here means:

1. **CLI output** — chalk-styled stdout, structured info/warn/error/success patterns, init-flow prompts, orchestrator live view, `doctor` reports
2. **JSONL log entries** — readable when `cat`-ed but optimized for `jq`
3. **README / docs voice** — the public-facing tone of the project
4. **Tracker comments** — what the orchestrator writes back to Linear/GitHub/Notion issues

No fonts, no logos beyond the existing banner image (`forge-cover-v1--horizon-banner-3x1@2x.png`), no web UI in scope.

---

## Tokens

### Color palette (chalk semantic mapping)

Forge uses **6 semantic roles** mapped to chalk styles. Never use raw chalk colors in `src/`; route through `core/logger.ts` semantic helpers (`logger.info`, `logger.warn`, etc.).

| Role | Chalk style | Used for |
|---|---|---|
| `info` | `chalk.cyan` | Status updates, neutral facts, section headers |
| `success` | `chalk.green` | Completed steps, passed checks, "✓" prefixes |
| `warn` | `chalk.yellow` | Recoverable issues, deprecation, "skip and configure later" prompts |
| `error` | `chalk.red` | Hard failures, validation errors, exit-1 conditions |
| `muted` | `chalk.gray` | Timestamps, log metadata, secondary info |
| `accent` | `chalk.bold` | Command names, file paths, identifiers |

**Anti-patterns:**
- Don't use `chalk.blue` / `chalk.magenta` directly — terminals render them inconsistently
- Don't combine more than 2 styles per token (`chalk.bold.red` is fine; `chalk.bold.underline.red` is shouting)
- Don't color whole sentences when only the verb matters

### Typography

- **Single typeface:** terminal default monospace. Forge controls no fonts.
- **No bold/italic for emphasis** — chalk roles do that work.
- **Width target:** 80 columns. Output that exceeds 80 wraps explicitly via the `wrap()` util in `core/logger.ts`, never relies on terminal soft-wrap.

### Spacing (vertical rhythm)

| Element | Lines around it |
|---|---|
| Section header | 1 blank above, 0 below |
| Subsection | 0 blank above, 0 below |
| Status line | 0 blank around |
| Init flow question | 1 blank above question, 0 below |
| Final summary block | 1 blank above, 0 below |
| Error before exit | 1 blank above, 0 below |

### Indentation

- 2 spaces per level
- Status prefixes (`✓`, `✗`, `→`, `…`) align at column 0
- Continuation lines align under the prefix's start

---

## Components (CLI output primitives)

All implemented in `src/core/logger.ts` and used through these named helpers — **never** ad-hoc `console.log` outside that module.

### `banner(title, subtitle?)`
First line of CLI commands (`forge init`, `forge orchestrate status`, etc.). One-time per command invocation.
```
🔨 forge — orchestrate status
   project: my-product · 3 subagents/main · primary=claude review=codex
```

### `section(title)`
Cyan + bold. Marks a logical block.
```
Init checks
```

### `step(message, status?)`
Single-line status. Status is one of `'pending' | 'running' | 'pass' | 'fail' | 'skip'`.
```
  ✓  gh CLI authenticated
  ✗  Linear MCP not detected
  …  validating workspace path
  →  skipping (configure later with --reconfigure)
```

### `kv(key, value)`
For dump-style output (`forge doctor`, init summary).
```
  tracker:           linear
  primary_host_cli:  claude
  review_host_cli:   codex
```

### `list(items)`
Bulleted, used for findings, next-steps, options.
```
  - spec/BRIEF.md   ✓ written
  - spec/PRD.md     ✓ written
  - spec/SPEC.md    ✓ written
```

### `table(rows)`
Aligned columns. For `forge doctor`, `forge orchestrate status` worker list.
```
  TASK        PHASE       STATE              ATTEMPT  ELAPSED
  FORGE-12    implement   running            2/10     2m13s
  FORGE-15    review      running            1/10     0m08s
  FORGE-19    ship        running            1/10     0m02s
  FORGE-22    implement   blocked_on_question 1/10    14m
```

### `spinner(message)` / `spinner.succeed()` / `spinner.fail()`
Active waiting indicator. Auto-disabled when `FORGE_NO_COLOR=1` (falls back to plain `step('running')`).

### `prompt(...)`
Wraps `@inquirer/prompts`. Always shown above 1 blank line. Question ends with `?`. Defaults shown in `chalk.muted`.

### `errorBlock(title, detail, hint?)`
Final-error format before nonzero exit. Title in `error` chalk; detail body in default; hint (if any) in `muted` prefixed with `Hint:`.
```
✗ Tracker validation failed

   GitHub Issues adapter requires `gh` CLI. Run `gh auth status`
   to verify, or install with `brew install gh`.

   Hint: re-run `forge init --reconfigure` after installing.
```

---

## Layouts

### Init flow layout

```
[banner]
[section: Project]
  [prompt: name]
  [prompt: description]
  [prompt: goal]
[section: Tooling]
  [prompt: tracker]
  [prompt: secret manager]
[section: Orchestration]
  [prompt: primary_host_cli]
  [prompt: review_host_cli]
  [prompt: subagent_cap_per_main]
  [prompt: retry_attempts]
  [prompt: lease_ttl_ms (with sensible default)]
[section: Validating]
  [step × N for each tool check]
[section: Scaffolding]
  [step × N for each file written]
[section: Next steps]
  [list]
```

### `forge orchestrate status` layout (one-shot CLI command — see ORCHESTRATOR.md "CLI surface")

```
[banner]
[kv block: project, host pair, active mains, total active workers]
[blank]
[section: Active workers (across all mains)]
  [table: TASK / PHASE / STATE / ATTEMPT / ELAPSED]
[blank]
[section: Open questions]
  [list: TASK / DECISION_KEY / one-line question / "answer with: forge orchestrate answer <id>"]
[blank]
[section: Recent events (last 10)]
  [list of timestamped log lines, newest at bottom]
[blank]
[footer: muted "use --json for machine output · gc --dry-run to see reconciliation plan"]
```

### `/forge orchestrate` skill live view (inside Claude Code / Codex main session)

Rendered by the dispatch skill in the user's main session — not by the CLI. Shows progress as the skill iterates: dispatched workers, surfaced questions, completed tasks. The skill polls `forge orchestrate status --json` and `forge orchestrate questions --open --json` to update its display.

### Doctor layout

```
[banner]
[section: Settings]
  [step or kv per check]
[section: Tracker]
  [step or kv per check]
[section: Hosts]
  [step or kv per host CLI detected]
[section: Worktrees]
  [list orphans, if any]
[errorBlock | success summary]
```

---

## Voice & tone

### Register

- **Terse, declarative, lowercase status verbs** (`writing`, `validating`, `claimed`, `failed`)
- **Past tense for completed actions**, present-continuous for in-progress (`wrote spec/BRIEF.md` vs `writing spec/BRIEF.md`)
- **No exclamation marks.** Ever. Forge is calm.
- **No emojis** in CLI output except: `✓` `✗` `→` `…` (status prefixes) and `🔨` (banner only)
- **Sentence case for headings.** Title case feels marketing.
- **Subject-elision is OK** — `validating Linear MCP…` is better than `forge is validating Linear MCP…`

### Examples

| Avoid | Prefer |
|---|---|
| `Successfully wrote your BRIEF! 🎉` | `wrote spec/BRIEF.md` |
| `ERROR: Failed to validate the configuration!!!` | `✗ settings.yaml: agents.subagent_cap_per_main must be a positive integer` |
| `Now we're going to ask you a series of questions...` | (just ask the question) |
| `The system has detected that gh CLI is not installed` | `✗ gh CLI not detected` |
| `Please wait while we process...` | `[spinner] validating tracker connection` |

### README / docs voice

Same register, more breathing room. Use second-person sparingly (`you`), never first-person plural (`we`). Code samples wrap at 80 columns. Headings sentence-case.

### Tracker comments

Posted by the `forge orchestrate complete` CLI verb (when REVIEW returns changes_requested or a task transitions to a blocked state) to issue threads. Format:

```
[forge orchestrate] phase=review verdict=changes_requested attempt=2/10
findings:
  - src/core/settings.ts:42 — error path swallows zod issues
  - src/orchestrator/state-machine.ts:88 — missing await on tracker.claim()
retry queued at 2026-05-09T14:23:11Z
```

Machine-parseable header line + human-readable body. Never adds emoji. Never editorializes.

---

## Accessibility

- **NO_COLOR support** — `FORGE_NO_COLOR=1` disables all chalk styling; output remains semantically structured (status prefixes still present)
- **ASCII-safe fallback** — when `LANG` indicates non-UTF-8 or terminal lacks unicode, status prefixes degrade: `✓` → `[ok]`, `✗` → `[FAIL]`, `→` → `->`, `…` → `...`
- **Screen reader compatibility** — never use color-only signaling; every error has a textual `✗` or `[FAIL]` marker
- **Width safety** — output respects `process.stdout.columns`; tables truncate gracefully with `…` in the rightmost column when squeezed
- **No flashing** — spinners revolve at ≤4 fps, never strobe; disabled in CI (auto-detect via `process.env.CI`)

---

## States

Every CLI command surfaces these states explicitly:

| State | When | Visual |
|---|---|---|
| **starting** | Command begins | `banner()` + first `section()` |
| **running** | Active long operation | `spinner()` or repeated `step('running')` |
| **partial / skip** | Optional check skipped, non-fatal | `step(msg, 'skip')` in `warn` chalk |
| **success** | Operation complete, exit 0 | Final `section('Done')` + summary `kv()` block |
| **error (recoverable)** | Validation failed but user can fix | `errorBlock()` with hint, exit 1 |
| **error (fatal)** | Unexpected crash, internal bug | `errorBlock()` + log file path + GitHub issue link |
| **interrupted** | User Ctrl-C | `section('Interrupted')` + summary of what was/wasn't done before exit |

**Exit codes:**
- `0` — success
- `1` — recoverable error (validation, missing tooling, user fixable)
- `2` — fatal / unexpected (internal bug — logged to `.forge/logs/` and surfaced)
- `130` — SIGINT (Ctrl-C; standard convention)
