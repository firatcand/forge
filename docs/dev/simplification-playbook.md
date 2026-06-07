# Safe Simplification Playbook (forge)

> A kit for shrinking the forge codebase **without changing behavior**: hard rules, a
> per-change loop, characterization-test guidance, a hot-path benchmark spec, a copy-paste
> **prompt pack**, and a runnable **workflow** (`.claude/workflows/safe-simplify.mjs`).
> Designed for Claude Code (discover + characterize + implement) paired with Codex
> (adversarial equivalence review).

## 0. Prime directive

**Same features. Same observable behavior. Fewer lines.** Perf, security, and elegance are
*secondary* to: no new bugs, no broken consumers, no changed public surface. When equivalence
is uncertain, **don't** — a non-simplification is free; a silent behavior change is not.

> EUREKA worth internalizing: *simplification* (fewer LOC, identical behavior) and
> *optimization* (faster) are **different activities**. Behavior-preserving dedup/inlining is
> usually perf-neutral. Treat a perf change during a "simplification" as a **red flag that the
> refactor isn't actually equivalent**, not a win — unless a benchmark proves both equivalence
> and the speedup.

## 1. The four operating constraints (chosen for this repo)

| Dimension | Rule |
|---|---|
| **Scope** | In-repo refactors + `node:` built-ins + deps **already** in `package.json`. **No new deps. No dep removals.** |
| **Proof bar** | Characterization-test-first → full gate → Codex adversarial review. *A green suite ≠ done.* |
| **Performance** | Measured on hot paths via a benchmark harness; **never regress** (>5% median = reject). |
| **Public API** | forge ships to adopters. CLI verbs, `--json` envelope shapes, error codes/`reason`s, settings/schema fields, and scaffolded template output are **frozen**. |

## 2. Allowed vs. forbidden

**Allowed**
- Collapse duplicated logic into one shared helper (same module or a new internal one).
- Replace a hand-rolled wheel with a `node:` built-in or an API from an **already-installed** dep, **after proving edge-case parity**.
- Inline an abstraction used at exactly one call site.
- Collapse verbose constructs (multi-line conditionals, manual loops → map/filter/reduce) where semantics are identical *and* it reads cleaner.
- Delete provably-dead code (0 consumers across src + test + dynamic dispatch).

**Forbidden (these are behavior/contract changes, not simplifications)**
- Adding or removing any dependency.
- Changing the public surface: CLI verb names/flags, `{ ok, data }` / `{ ok, error }` envelope shapes, error `code`/`reason` strings, `settings.yaml`/schema field names, scaffolded template bytes.
- Altering write-ordering, atomicity, fail-closed, lease/idempotency, or crash-recovery semantics.
- Loosening a zod `.strict()` boundary, or widening a validation/footer/security regex.
- Turning an explicit `catch` into a silent swallow, or collapsing per-shape error disposition.
- Touching argv/env allowlists, secret redaction, subprocess env-stripping, or claim-footer guards "for cleanliness."

### Classify every candidate (adopt this taxonomy)

Each candidate gets exactly one label — it dictates the proof bar:

| Label | Meaning | Proof required |
|---|---|---|
| `delete-safe` | no live usage, no public contract | **≥2 independent signals** of non-usage (see §6) |
| `de-export-safe` | used internally, exported unnecessarily | importer search shows no external consumer |
| `simplify-safe` | behavior-preserving refactor **with existing pinning coverage** | full gate + adversarial review |
| `needs-tests-first` | likely improvement, coverage insufficient | characterization tests (§5) **before** any edit |
| `risky` | touches public behavior, persistence, security, concurrency, or a provider integration | escalate — usually defer or split |
| `do-not-touch` | duplication/complexity is intentional (§3) | leave it; record why |

Default when evidence is weak: **`needs-tests-first` or `risky`, never `simplify-safe`.**

### Protected / frozen surfaces (compatibility contracts)

Anything touching these is `risky` until proven otherwise with strong local coverage **and** a narrow diff:

- `package.json` — `bin`, `files`, `dependencies`/`engines`, `name`, `scripts`, versioning behavior.
- `src/bin/*` — CLI command registration + flags. `src/index.ts` + any public barrels (the npm-consumable API).
- The npm package payload (`files`: `dist/`, `skills/`, `agents/`, `templates/`) and scaffolded template **bytes**.
- Tracker adapters (GitHub / Linear / Notion) and their error-classification + retry behavior.
- Orchestrator persistence: state / lease / question / answer / event / verdict files, and their atomic-write / lock-ownership / crash-recovery / idempotency logic.
- Zod schemas that validate **persisted files or external-API payloads**.
- CI workflows, packaging, smoke tests, `npm pack` contents; CJS/ESM entrypoint handling.
- Security-sensitive code: secrets, env parsing, redaction, path handling, command execution, token handling.

## 3. DO-NOT-SIMPLIFY registry (load-bearing look-alikes)

These *look* like duplication but are intentionally divergent. Extend this list as you find more.

- `orchestrator/glob-match.ts` vs `orchestrator/overlap.ts` — different `**` semantics (FORGE-97 boundary fix).
- `classifyGitHubError` / `classifyLinearError` / `classifyNotionError` — map genuinely different provider surfaces; branch order is load-bearing.
- `cli/orchestrate/status.ts` double size-cap — deliberate TOCTOU defense (re-check after read).
- `core/logger.ts` `redact` — explicit by design to aid the secret-redaction audit.
- Atomic-write **placement** in `orchestrator/{leases,state-machine,questions/writer}.ts` — link-never-overwrite vs unlink→link-verify vs rename-after-CAS differ on purpose. Extract the **plumbing** (`tempName`/`writeTempFile`/fsync) only; **never unify placement**.
- Lease identity tuples + the `state-machine.ts ↔ leases.ts` TWIN comment — duplicated on purpose (circular-dep avoidance).

## 4. The per-change loop (one cohesive change at a time)

Run this for **each** candidate. One change = one PR. Never batch unrelated simplifications.

0. **SLICE** — pick the smallest reviewable unit (one duplication cluster, one helper).
1. **MAP THE BLAST RADIUS** ("ballistic surface") — enumerate every consumer of each symbol you'll touch: importers, test usages, dynamic dispatch (string/registry keys), barrel re-exports, `src/index.ts` public exports, and anything matching `CRITICAL.md`. **Never infer "unused" from TypeScript / `ts-prune` alone** — our own audit got 654 noisy hits that way; require **≥2 independent signals** (`grep` across `src`+`test`+`scripts`+`docs`+`templates`, `knip`, the import graph, runtime string refs, dynamic CLI dispatch, package entrypoints) before classifying anything `delete-safe`. If it's public surface → frozen; stop.
2. **CHARACTERIZE** — the current behavior must be pinned by tests **before** you edit. If coverage is thin, write characterization tests against the **current** code and confirm they pass on it. These become the invariant and **must not be edited during the refactor**.
3. **SOTA COMPARE** — identify the best-known implementation (built-in / installed-dep / idiom). For any library-specific detail, **fetch current docs with `ctx7` first** (`npx ctx7@latest library <name> "<q>"` → `npx ctx7@latest docs <id> "<q>"`) — never judge a dep's API from memory. Don't paste external code; use references to evaluate patterns. Prove edge-case equivalence (error, empty, malformed, unicode/utf8-vs-utf16, throw behavior). **Record every external reference used** and what it changed about the recommendation.
4. **REFACTOR** — apply it, behavior-preserving. Keep explicit error handling explicit.
5. **VERIFY** — run the **full gate** (below), all green; characterization tests **unchanged** and green; record the LOC delta; if a hot path, run the benchmark and confirm no regression.

   **Full gate** (the complete set — partial gates have shipped bugs here before):
   `npm run typecheck` · `npm run lint` (non-blocking, but **review every new warning**) · `npm run lint:test-helpers` · `npm test` (run outside any restricted sandbox — `tsx` IPC fails under one) · `npm run build` · `node dist/bin/forge.cjs --version` · `node dist/bin/forge.cjs --help` · `npm run test:pack`. CI additionally runs **gitleaks**.
6. **ADVERSARIAL REVIEW** — hand the diff to Codex (or a second model) with one job: *prove this changes behavior*. Default to **reject** on any uncertainty.
7. **SHIP** — one small PR; link the characterization tests; state the LOC delta and the equivalence argument.

## 5. Characterization tests — how to pin behavior

You cannot safely simplify what you cannot pin. Before refactoring under-tested code, capture:

- **Golden output** — the exact stdout / `--json` envelope / written-file bytes today; assert equality.
- **Error parity** — the exact `code` + message shape on every failure path.
- **Round-trip** — `parse → serialize → parse` is identity; `encode → decode` is identity.
- **Edge inputs** — empty, missing, malformed, oversized, unicode (utf8 byte vs utf16 length), duplicate keys, concurrent writers.
- **Parsers/regex** — a corpus including adversarial inputs.

If you can't express the current behavior as a test, that's a signal the code is too entangled to simplify safely yet — pin it first or leave it.

## 6. Performance — hot-path benchmarks

Hot paths in forge: orchestrator state-machine transitions, lease read/write, tracker
normalize/parse, `loadPhases`, glob/overlap matching. Use `node:perf_hooks`; run N iterations
on identical inputs **before and after**; reject if the median regresses > 5%.

```ts
// bench/<name>.bench.ts  — run before & after, compare medians
import { performance } from 'node:perf_hooks';
export function bench(label: string, fn: () => void, iters = 50_000): number {
  fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = performance.now() - t0;
  process.stdout.write(`${label}: ${(ms / iters).toFixed(5)} ms/op\n`);
  return ms / iters;
}
```

## 7. Security

Don't touch argv/env allowlists, `logger.redact`, subprocess env-stripping, zod `.strict()`
boundaries, or footer-injection guards as "simplification." Any change under a `CRITICAL.md`
path → a security-auditor pass before merge.

## 8. Acceptance checklist (per PR)

- [ ] One cohesive change, smallest reviewable unit.
- [ ] **Classification** recorded (`delete-safe` / `de-export-safe` / `simplify-safe`); a deletion lists **every search** used to prove non-usage (≥2 signals).
- [ ] Blast radius mapped; **no public/protected surface changed**.
- [ ] Behavior pinned by characterization tests (written first if coverage was thin).
- [ ] Net LOC-negative (or the increase is justified, e.g. added tests).
- [ ] Full gate green (§4); characterization tests **unchanged**.
- [ ] Hot path? benchmark shows no regression.
- [ ] Codex adversarial review returned "behavior-equivalent."
- [ ] No new/removed deps; no DO-NOT-SIMPLIFY entry touched.
- [ ] **Rollback noted** (revert is just dropping the PR — but record any data/migration implication, which for pure refactors should be "none").

---

## 9. Prompt pack

Copy-paste. Each prompt names its role, its hard constraints, and its output contract. Run them
in order; never let one agent both implement *and* sign off.

### P1 — Discover & propose  (Claude Code, **read-only**)

```
You are auditing <SUBSYSTEM PATH> in the forge repo for SAFE simplification candidates.
READ-ONLY — do not edit. Goal: code that can be made shorter/simpler with IDENTICAL behavior.

Constraints: in-repo refactors + node: builtins + deps ALREADY in package.json only — no new
or removed deps. Do NOT propose anything that changes public surface (CLI verbs/flags, --json
envelope shapes, error codes/reasons, settings/schema fields, template output), write-ordering/
atomicity/lease/crash-recovery semantics, .strict() boundaries, explicit error handling, or any
DO-NOT-SIMPLIFY entry (see docs/dev/simplification-playbook.md §3).

For each candidate output: id | file:line | what it is | proposed simpler form (sketch) | why
behavior is identical (cite the edge cases) | blast radius (every consumer: importers, tests,
dynamic dispatch, re-exports, public exports) | coverage (pinned/thin/none) | classification
(delete-safe | de-export-safe | simplify-safe | needs-tests-first | risky | do-not-touch) |
est. LOC saved. For any `delete-safe`, LIST the ≥2 independent searches proving non-usage —
never infer "unused" from ts-prune/TypeScript alone. Default to `needs-tests-first`/`risky` when
evidence is weak. Rank by (safety × LOC × inverse-blast-radius). Skip clean code rather than
inventing nits. Cap at the ~15 best. Verify every line number by reading the code.
```

### P2 — Characterize  (Claude Code)

```
Target: <CANDIDATE id + file:line from P1>. Before any refactor, PIN its current behavior with
tests. READ the code, then ADD characterization tests (don't modify production code) that capture
EXACTLY what it does today: golden outputs / --json envelopes / written bytes, the error code +
message on every failure path, round-trips, and edge inputs (empty, missing, malformed, oversized,
unicode utf8-vs-utf16, duplicate keys, concurrency where relevant). **Pin observable BEHAVIOR only —
NEVER assert source text, byte-identity, "the two copies are identical", function location/count,
or import structure.** Such structural tests defeat the very refactor they're meant to guard (a
dedup necessarily removes a duplicate definition) — a real battle-test run wrongly rejected two good
dedups this exact way. Run them and confirm they PASS
against the CURRENT code. These tests are the invariant — they must not change during the refactor.
Report the new test file(s), what behaviors are now pinned, and any behavior you could NOT pin
(that blocks the simplification — flag it).
```

### P3 — Implement one change  (Claude Code, isolated worktree)

```
Apply EXACTLY ONE approved simplification: <CANDIDATE>. Work in a fresh git worktree. Make the
change behavior-preserving — keep explicit error handling explicit. If it replaces hand-rolled
code with a node: builtin or an installed dep, you MUST first have a characterization test (P2)
covering the edge cases. Do NOT touch anything outside the candidate. Then run the FULL gate:
`npm run typecheck && npm test && npm run build && node dist/bin/forge.cjs --version`. Confirm the
characterization tests are UNCHANGED and green. If it's a hot path, run the benchmark before/after
and confirm no >5% median regression. Report: the diff, LOC delta, gate result, bench result, and
the one-paragraph equivalence argument. If anything fails, REVERT and report — do not patch around it.
```

### P4 — Adversarial verify  (Codex / second model)

```
Independent equivalence review. Here is a diff that claims to simplify code with ZERO behavior
change: <DIFF or `git diff origin/main...HEAD`>. Your ONLY job: try to PROVE it changes observable
behavior. Check: error codes/messages on every path, edge inputs (empty/malformed/oversized/unicode/
concurrent), ordering/atomicity/crash-recovery, public surface (CLI/envelope/schema), and whether a
substituted builtin/library differs from the original at any edge. Read the surrounding code and the
characterization tests — do the tests actually cover the changed branches, or is coverage theatre?
Default to REFUTED if uncertain. Verdict per concern: EQUIVALENT / CHANGED / UNVERIFIED, with
file:line evidence. End: APPROVE only if you found no behavior change AND coverage is real.
```

### P5 — SOTA compare  (Codex / Claude)

```
For this hand-rolled implementation: <file:line + code>, identify the state-of-the-art equivalent
reachable WITHOUT adding a dependency — a node: built-in, an API from a dep already in package.json,
or a well-established idiom. Before judging any library/builtin API, fetch current docs with ctx7
(`npx ctx7@latest library <name> "<q>"` → `docs <id> "<q>"`) — never rely on memory; record the
references used. For each option: show the replacement, and prove edge-case parity with
the current code (error behavior, empty/unicode/throwing inputs, return-shape). If NO drop-in is
equivalent (the hand-rolled version handles an edge the builtin doesn't), say so and recommend
keeping it. Output: recommended replacement (or "keep"), the parity proof, and the LOC delta.
```

---

## 9a. Two execution paths (same merge gate)

- **Manual / audit-first (most conservative — use for high-risk surfaces):** run the audit prompt in **`docs/audits/refactoring-audit-agent-prompt.md`** (its *Audit File Template* gives the human-readable output shape — every finding carries Classification / Evidence / Tests-required / Validation / Rollback). You approve specific finding IDs; then run its *Implementation Prompt* on only those. The human gate is **before any code is written**.
- **Automated (higher throughput — use for mechanical dedup):** the workflow below discovers + characterizes + implements + adversarially-verifies autonomously, gating the human at **merge**.

Both end identically: a human reviews each diff against the §8 checklist and merges. The audit prompt and this playbook are complementary — *audit prompt = how to audit & decide; playbook = how to safely execute & verify.*

## 10. Orchestrated workflow

`.claude/workflows/safe-simplify.mjs` encodes the pipeline so you can run it in one shot:

**discover** (one reader per subsystem, read-only) → **code-level filter** (scope allowlist +
protected-surface denylist + drop `risky`/`do-not-touch`) → per candidate: **build** (characterize
+ refactor + full gate, *all inside ONE isolated worktree*) → **verify** (3 skeptics review the
diff; hard-gate on isolation/scope/protected first; majority-refute kills it) → **report**.

**It stops before merging.** The human reviews each confirmed diff and merges — the zero-bug
constraint keeps the *apply* decision with a person, while discovery, characterization, and
adversarial vetting are automated.

### Battle-test learnings (v1 run, src/trackers) — baked into v2

The first run **polluted `main`** and surfaced three defects, now fixed:

1. **Isolation must wrap the WHOLE per-candidate pipeline, not just "implement."** v1 ran *characterize* on main (no isolation) and some implement agents leaked via absolute paths → 735 lines landed on `main`. **v2 merges characterize+refactor+gate into one worktree-isolated agent** that must confirm `git rev-parse --show-toplevel` is a worktree before editing, edit only relative to cwd, and report `diffPaths`; verify hard-fails if `inWorktreeConfirmed` is false.
2. **Enforce scope + protected surfaces in CODE, not prompts.** v1's subsystem arg was ignored and the discoverer ranged repo-wide (even touching `leases.ts`). **v2 filters every candidate's path** through a scope allowlist + a protected-surface denylist, and re-checks `diffPaths` at verify.
3. **Characterize behavior, never structure** (see P2) — v1 wrote "byte-identical" tests that auto-reject dedups.

Also observed: net payoff was thin (≈ −51 LOC for 5.1M tokens / 101 agents) — **scope each run to one subsystem** and treat tiny net-positive-LOC dedups as not worth the indirection.

Run it:
```
Workflow({ scriptPath: ".claude/workflows/safe-simplify.mjs", args: { subsystems: ["src/trackers", "src/orchestrator"] } })
```
(Workflow is opt-in and token-heavy — scope `args.subsystems` to keep each run bounded.)
