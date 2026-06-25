// FORGE-213 (R2): the low-level host-CLI probe primitives, shared by both the
// init validator (src/cli/init/validate.ts) and the availability prober
// (src/orchestrator/availability.ts). Extracted so the bin map and the thin
// `<bin> --version` check live in ONE place instead of being duplicated (or
// re-exported out of init internals).
//
// SAFETY (R5): the only thing these primitives ever do is run `<bin> --version`
// — no model invocation, no paid API call. Every probe uses a short timeout and
// rejects stdin so a hung/interactive binary can never block the prober.
//
// SAFETY (FORGE-224): the probe also runs with the AI-subprocess env allowlist
// (buildSubprocessEnv + extendEnv:false). The probed binary is resolved off PATH
// and could be hijacked (a fake `claude`/`codex` placed earlier on PATH); without
// a sanitized env it would inherit GITHUB_TOKEN / tracker keys / injected secrets
// just to answer `--version`. One source of truth with the harness subprocess env.

import type { ExecaLike } from '../cli/init/validate.ts';
import { buildSubprocessEnv } from '../harnesses/subprocess.ts';

// FORGE-160: cursor's probe binary differs from its host key — the CLI is
// `agent`, not `cursor`. All other hosts probe their own name. validate.ts
// imports this map (was previously a private const there); availability.ts uses
// it too.
export const HOST_CLI_BIN: Record<'claude' | 'codex' | 'gemini' | 'cursor', string> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  cursor: 'agent',
};

// Default probe timeout. Short on purpose (R5): a `--version` call that doesn't
// answer almost immediately is treated as absent rather than blocking dispatch.
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

// Thin `<bin> --version` exitCode-0 check used by the availability prober.
// Returns `true` only when the binary is on PATH AND exits 0. ENOENT (binary
// not found — execa@9 with reject:false resolves with exitCode undefined/null
// and a string `code`) → false. A timeout → false. Any throw → false. Never a
// paid/model-invoking call (R5).
export async function probeBinVersion(
  bin: string,
  exec: ExecaLike,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    // reject:false so spawn failures resolve instead of throwing; stdin:'ignore'
    // so an interactive binary cannot block on stdin (R5 "reject stdin").
    const r = await exec(bin, ['--version'], {
      timeout: timeoutMs,
      reject: false,
      stdin: 'ignore',
      // FORGE-224: sanitized env — a PATH-hijacked probe binary must not inherit
      // secrets. Only HOME/PATH/locale/term are forwarded (buildSubprocessEnv).
      env: buildSubprocessEnv(undefined),
      extendEnv: false,
    });
    if (r.timedOut) return false;
    return r.exitCode === 0;
  } catch {
    return false;
  }
}
