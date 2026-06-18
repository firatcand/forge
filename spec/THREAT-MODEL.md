# Forge threat model — untrusted content & prompt injection

> Tripwire gate (FORGE-201). This page proves, with `file:line` evidence, which
> externally-authored text can reach an autonomous worker today, and records the
> resulting scope decision for Tripwire (FORGE-199). **No Tripwire code merges
> until this gate's verdict stands.** Durable design-time truth; update it when a
> new external entry point (e.g. a search/browser adapter) lands.

## Assets a prompt-injection attacker would target

A forge worker runs autonomously inside a git worktree with the operator's
ambient authority. The assets at risk:

- **Secrets** — `.forge/.env`, `~/.config/gh`, Linear/Notion tokens, any env the
  worker process inherits. Exfiltration is the highest-value outcome.
- **Repository write + merge** — a worker can edit the worktree, push a branch,
  and (under `/drive`/`/deliver` auto-merge on green CI) reach `main`. Injected
  code is the second-highest-value outcome.
- **Autonomous PR creation** — `/ship` opens PRs with the operator's `gh` auth;
  an attacker who steers a worker can open/modify PRs.
- **Tracker mutation** — claim/answer/issue writes via the configured tracker.

## Attacker model

- **Out of scope:** the repo OWNER (they author the spec, `phases.yaml`, answers,
  CLAUDE.md — all author-controlled trust roots; a malicious owner needs no
  injection). A worker that is already a compromised model.
- **In scope:** a NON-owner who can author text forge might ingest — e.g. a
  stranger filing a GitHub issue (title/body) on a public repo, a comment, or
  (future) a web page / search result a worker fetches. The question this gate
  answers: **does any such text reach the rendered worker prompt today?**

## The rendered worker prompt — every field and its source

The worker prompt is rendered by `src/cli/orchestrate/render-worker-prompt.ts`
from `templates/worker-prompt.template.md`. Every interpolated field and its
trust source (verified at the cited lines):

| Prompt field | Source (`file:line`) | Author | External? |
|---|---|---|---|
| `TASK_ID`/`ATTEMPT_ID`/`RUN_ID`/`WORKTREE_PATH`/`PHASE` | dispatch manifest (orchestrator, UUIDv7 / enum) | system | no |
| `TASK_DESCRIPTION` | `phases.yaml` `task.description` (`render-worker-prompt.ts:121,288,318`) | owner spec → `/decompose` | **no** |
| `ACCEPTANCE_CRITERIA` | `phases.yaml` `task.acceptance` (`render-worker-prompt.ts:122,289,319`) | owner spec → `/decompose` | **no** |
| `CONVENTIONS` | `CLAUDE.md`/`AGENTS.md` (repo file) | owner | no |
| `PRIOR_ATTEMPTS` | per prior attempt, rendered as `attempt <attemptId>: <phase>` (`orchestrator/render-worker-prompt.ts:91-97`): the `attemptId` is the attempt directory name (a system UUIDv7) and `phase` comes from the manifest (written from a dispatch-time schema enum, `dispatch.ts:122-126`; read back as a string, `render-worker-prompt.ts:207-231`). No prior-worker OUTPUT is stored or surfaced. | system | no |
| `ANSWERED_QUESTIONS` | per question: its `decision_key` (worker-authored) + the answer's `option_id` (enum) — rendered as `decisionKey → option_id` (`render-worker-prompt.ts:250-269`, `orchestrator/render-worker-prompt.ts:101-103`). The free-form answer `--note` (`schemas/questions.ts:84-90`, `answer.ts:113-119`) is **NOT** rendered. | worker + supervisor | no |
| `BUDGET_WARNING` / question-budget flags | system + `settings.yaml` | system / owner | no |

The template (`templates/worker-prompt.template.md`) interpolates
`{{TASK_DESCRIPTION}}` (line 9) and the system IDs — there is **no `task.title`
placeholder** in the template or the `WorkerPromptContext`.

## The externally-authorable surface — and why it does NOT reach the prompt

| External input | Externally-authorable? | Fetched? | Parsed to? | Reaches prompt? | Evidence |
|---|---|---|---|---|---|
| GitHub/Linear issue **title** | yes (stranger) | yes | `phases.yaml` `task.title` via `reconcile --pull` | **NO** | `diffPull` mutable fields are `title \| depends_on` only (`reconcile.ts:24,157-159`); adoption sets `title: issue.title` (`reconcile.ts:241,261,271`); the renderer NEVER reads `task.title` (it reads only `description`+`acceptance`, `render-worker-prompt.ts:121-122,288`) |
| GitHub/Linear issue **body/description** | yes (stranger) | yes (adapter) | ONLY the trailing `forge:` footers (`forge:task`/`forge:blockedBy`) via `parseForgeFooters` (`github.ts:1128`, `linear.ts:1603`, `footers.ts`) | **NO** | the prose is discarded after footer extraction; `Issue` (`trackers/types.ts`) exposes **no `body`/`description` field** |
| issue **labels** | yes (stranger) | yes | claim tiebreak only | **NO** | not interpolated into the prompt |
| `forge:claim` body fence | yes (stranger could forge text) | yes | claim identity, schema-validated (`claim-fence.ts:69-81`) | **NO** | advisory claim metadata for gc; never in the prompt |
| supervisor **answer** (`option_id`) | no (owner only) | yes | enum key, paired with the question's `decision_key` | yes (as keys, not prose) | `render-worker-prompt.ts:250-269` |
| supervisor **answer `--note`** (free text) | no (owner only) | stored | — | **NO** | the free-text note exists (`schemas/questions.ts:84-90`, `answer.ts:113-119`) but is never rendered into the prompt |
| worker **question** text / options / `what_happens_if_unanswered` / routing-hint | no (worker) | stored | — | **NO** | only `decision_key` is read back; question prose/options are not surfaced (`question-write.ts:372-390` store; `render-worker-prompt.ts:250-269` read) |
| prior-attempt **output** | no (system) | — | — | **NO** | only the `phase` enum is surfaced; worker output is never stored/surfaced |

## Verdict (the gate decision)

**TODAY, no externally-authorable text reaches the rendered worker prompt.** The
only stranger-writable field that forge ingests is the issue **title** (synced
into `phases.yaml` by `reconcile --pull`), and it is structurally excluded from
the prompt — the renderer reads only `description` + `acceptance`, which
originate from the owner's spec via `/decompose`. Issue bodies are fetched but
reduced to scheme-validated `forge:` footers; the prose never escapes the adapter.

Therefore: **render-time prompt scanning is NOT justified against current code.**
Per the gate's decision rule, Tripwire is **narrowed to the adapter boundary** —
it should defend the FIRST path that will actually carry untrusted free-form text
into a worker: the **search / browser result adapters (FORGE-203 / FORGE-204)**,
which are deferred. Tripwire I1 (FORGE-202) is re-scoped to scan/boundary-wrap
adapter-fetched content at ingestion, and the render-time scanner is
de-prioritized until an external→prompt path is proven to exist.

**Tripwire guardrail (binding):** any future change that places externally-
authorable text into the worker prompt — e.g. surfacing issue title/body,
comments, or full question/answer text, or an adapter that returns web content —
MUST land together with the Tripwire boundary scan for that path. This file is
the checklist: adding such a path without updating this table + the scan is a
gate violation.

## Tripwire I1 (FORGE-202) — detection engine landed, report-only

The deterministic injection-detection engine shipped: `src/security/tripwire/`
(`scanText` + five high-precision rules) plus the standalone read-band
`forge orchestrate scan` verb. This is **detection only and report-only** — the
engine never blocks, never emits events, and is **not wired into the renderer**.
The renderer remains untouched, so the gate verdict above still stands: no
externally-authorable text reaches the worker prompt today, and the boundary
scan that actually wraps/scrubs untrusted spans lands **with** the first
untrusted→prompt adapter (search/browser, FORGE-203/204). The binding guardrail
above is unchanged. Tripwire **does not** prevent exfiltration — a deterministic
scanner over input is best-effort detection, not an egress control (see the
limitations below).

## Loom code symbols (FORGE-219 / I2b-1) — stored, not rendered

Loom's I2b-1 increment indexes **code symbols** (function/class/method/type
names, their kind, and line spans) from repository source via bundled
tree-sitter. This deliberately stays inside the trust boundary above:

- The extractor stores **names, kinds, start/end line, and the file path ONLY** —
  it never reads or persists function bodies, docstrings, comments, or any other
  source text. (Asserted in `test/unit/memory/symbols.test.ts`.)
- Symbol nodes are **excluded from FTS** and **not surfaced by recall** in
  I2b-1: there is no `references` edge and `recallForTask` is unchanged, so no
  symbol name reaches a rendered worker prompt. Symbols are structural
  intermediaries (file → symbol `defines`), invisible to the prompt today.
- Therefore I2b-1 introduces **no new external→prompt path** and needs no
  Tripwire boundary scan. The file paths it consumes are the same untrusted
  worker self-reports the I2a projector already path-validates; the extractor
  additionally lstat/realpath/O_NOFOLLOW-guards every read (no symlink escape).

The decision on whether symbol **names** may ever appear in recall `why`
strings / worker prompts (vs. constrained payloads) is **deferred to I2b-2** and
is a Tripwire-adjacent fork. Per the binding guardrail above, the I2b-2 change
that first surfaces symbol names into a prompt MUST land with the corresponding
Tripwire decision + scan; doing so without updating this table is a gate
violation.

## What Tripwire does NOT defend (limitations — read before trusting it)

- **Network exfiltration / Sentinel Marks.** Sentinel Marks (canary tokens
  seeded into context to detect leakage) only detect exfil through an
  **observable** channel. A worker with outbound network access can exfiltrate a
  secret over an arbitrary connection without ever emitting the canary —
  Sentinel Marks do **not** prevent or reliably detect network exfiltration.
  Network egress control is an OS/sandbox concern, out of Tripwire's scope.
- **A compromised model.** Tripwire scans untrusted INPUT; it cannot defend
  against a base model that is itself adversarial or jailbroken by
  author-controlled content.
- **Owner-authored content.** spec/PRD/phases.yaml/answers/CLAUDE.md are trust
  roots by design — Tripwire does not scan them (a malicious owner is out of the
  attacker model).
- **Semantic injection that survives scanning.** A deterministic scanner catches
  known injection patterns + boundary-wraps untrusted spans; it is best-effort,
  not a proof. Defense-in-depth (least-privilege secrets, sandboxed egress, the
  human merge gate) remains primary.
- **Unicode-normalization / homoglyph bypasses (I1 limitation).** The I1 rules
  match on the raw string without NFKC normalization, so a full-width or
  homoglyph rendering of an injection phrase (e.g. `Ｉｇｎｏｒｅ all previous
  instructions`) can evade the phrase rules. Zero-width and bidi control
  characters ARE caught (separate `encoded_payload` finding). Confusable-fold
  normalization is deferred to the Tier-2 pass (I2); until then this is a known
  detection gap, not a guarantee.
- **Encoding coverage (I1 limitation).** `encoded_payload` strict-decodes
  standard padded base64 and even-length hex, then recursively scans. base64url,
  unpadded, or multiply-nested encodings may downgrade to `suspicious` (opaque
  blob) or be missed. Strict decoding is the intended I1 scope to keep the
  detector deterministic and false-positive-light.
