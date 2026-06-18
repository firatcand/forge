// `forge orchestrate scan` — read-band, model-free injection scanner over a
// task's owner-authored fields OR arbitrary --text. DETECTION-ONLY: never blocks,
// never emits events, never mutates state (FORGE-202 / Tripwire I1).
//
//   forge orchestrate scan --task <id>            [--json]
//   forge orchestrate scan --text "<str>"         [--source <enum>] [--json]
//   forge orchestrate scan --text -               [--source <enum>] [--json]   (stdin, EXPLICIT only)
//
// `--task` XOR `--text` (both/neither → INVALID_ARGS). `--task` reads the LOCAL
// phases.yaml (lookup idiom from render-worker-prompt: tracker_issue_id OR id)
// and scans `description` (source task_description) + each `acceptance` entry
// (source acceptance_criteria), returning per-field reports + an aggregate
// severity. Tolerant of a missing phases.yaml only for the read; a missing TASK
// is an error.

import { existsSync, readSync } from 'node:fs';
import path from 'node:path';

import { loadPhases } from '../../core/phases.ts';
import { ok, fail, type Envelope } from '../envelope.ts';
import { hasFlag, parseFlag, resolveForgeDir } from './flags.ts';
import {
  scanText,
  TRIPWIRE_MAX_BYTES,
  TRIPWIRE_SOURCES,
  type TripwireReport,
  type TripwireSeverity,
  type TripwireSource,
} from '../../security/tripwire/scan.ts';
import type { VerbHandler } from './index.ts';

const SEVERITY_RANK: Record<TripwireSeverity, number> = {
  clean: 0,
  suspicious: 1,
  hostile: 2,
};

function maxSeverity(reports: readonly TripwireReport[]): TripwireSeverity {
  let s: TripwireSeverity = 'clean';
  for (const r of reports) {
    if (SEVERITY_RANK[r.severity] > SEVERITY_RANK[s]) s = r.severity;
  }
  return s;
}

export interface OrchestrateScanOptions {
  readonly forgeDir: string;
  readonly task?: string;
  readonly text?: string;
  readonly source?: string;
  readonly json?: boolean;
  // Injectable streams for tests (precedent: review-queue.ts / dashboard.ts).
  readonly stdout?: NodeJS.WritableStream;
  // Injectable stdin reader for `--text -` (default: read fd 0). Returns the
  // full stdin contents as a string.
  readonly readStdin?: () => string;
}

export interface OrchestrateScanResult {
  readonly exitCode: number;
}

function writeEnvelope(envelope: Envelope, out: NodeJS.WritableStream): number {
  out.write(`${JSON.stringify(envelope)}\n`);
  return envelope.ok ? 0 : 1;
}

// Default stdin reader: drain fd 0 synchronously. Used ONLY for explicit `--text -`.
// CAPPED at TRIPWIRE_MAX_BYTES: scanText discards anything past the cap anyway, so
// reading further would only burn unbounded memory on a hostile/huge pipe. We read
// one chunk PAST the cap so the downstream byteCap observes the overflow and flags
// `truncated`.
function readStdinSync(): string {
  const chunks: Buffer[] = [];
  const buf = Buffer.alloc(65536);
  let total = 0;
  // Read until EOF. On a closed/empty stdin this returns 0 immediately.
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      // EAGAIN on a non-blocking TTY with no input → treat as empty.
      if ((err as NodeJS.ErrnoException).code === 'EAGAIN') break;
      if ((err as NodeJS.ErrnoException).code === 'EOF') break;
      throw err;
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
    total += n;
    // Enough to cover the scan cap → stop; the rest is discarded by byteCap.
    if (total > TRIPWIRE_MAX_BYTES) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolveSource(raw: string | undefined): TripwireSource | undefined {
  if (raw === undefined) return 'search_result';
  return (TRIPWIRE_SOURCES as readonly string[]).includes(raw)
    ? (raw as TripwireSource)
    : undefined;
}

interface FieldReport {
  readonly field: string;
  readonly report: TripwireReport;
}

function scanTask(
  forgeDir: string,
  taskId: string,
): { ok: true; fields: FieldReport[] } | { ok: false; code: string; message: string } {
  const repoRoot = path.dirname(forgeDir);
  const phasesPath = path.join(repoRoot, 'plans', 'phases.yaml');
  if (!existsSync(phasesPath)) {
    return {
      ok: false,
      code: 'PHASES_NOT_FOUND',
      message: `plans/phases.yaml not found at ${phasesPath}; cannot scan task '${taskId}'.`,
    };
  }
  let phases;
  try {
    phases = loadPhases(phasesPath).phases;
  } catch (err) {
    return {
      ok: false,
      code: 'PHASES_INVALID',
      message: `failed to load plans/phases.yaml: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  for (const phase of phases.phases) {
    for (const task of phase.tasks) {
      if (task.id === taskId || task.tracker_issue_id === taskId) {
        const fields: FieldReport[] = [
          { field: 'description', report: scanText(task.description, 'task_description') },
        ];
        task.acceptance.forEach((a, i) => {
          fields.push({
            field: `acceptance[${i}]`,
            report: scanText(a, 'acceptance_criteria'),
          });
        });
        return { ok: true, fields };
      }
    }
  }
  return {
    ok: false,
    code: 'TASK_NOT_FOUND',
    message: `task '${taskId}' not found in plans/phases.yaml.`,
  };
}

export function runOrchestrateScan(opts: OrchestrateScanOptions): OrchestrateScanResult {
  const out = opts.stdout ?? process.stdout;
  const json = opts.json === true;
  const hasTask = opts.task !== undefined && opts.task !== '';
  const hasText = opts.text !== undefined;

  // --task XOR --text.
  if (hasTask && hasText) {
    return {
      exitCode: writeEnvelope(
        fail('INVALID_ARGS', 'forge orchestrate scan: --task and --text are mutually exclusive.', false),
        out,
      ),
    };
  }
  if (!hasTask && !hasText) {
    return {
      exitCode: writeEnvelope(
        fail('INVALID_ARGS', 'forge orchestrate scan: provide exactly one of --task <id> or --text <str> (or --text - for stdin).', false),
        out,
      ),
    };
  }

  // ── --task path ──
  if (hasTask) {
    const result = scanTask(opts.forgeDir, opts.task!);
    if (!result.ok) {
      return { exitCode: writeEnvelope(fail(result.code, result.message, false), out) };
    }
    const reports = result.fields.map((f) => f.report);
    const aggregate = maxSeverity(reports);
    if (json) {
      return {
        exitCode: writeEnvelope(
          ok({
            task: opts.task,
            severity: aggregate,
            fields: result.fields,
          }),
          out,
        ),
      };
    }
    const lines = [`task ${opts.task}: ${aggregate}`];
    for (const f of result.fields) {
      lines.push(`  ${f.field}: ${f.report.severity} (${f.report.findings.length} finding(s))`);
      for (const fd of f.report.findings) {
        lines.push(`    - ${fd.rule} [${fd.severity}] @${fd.span.start}-${fd.span.end}: ${fd.excerpt}`);
      }
    }
    out.write(lines.join('\n') + '\n');
    return { exitCode: 0 };
  }

  // ── --text path ──
  const source = resolveSource(opts.source);
  if (source === undefined) {
    return {
      exitCode: writeEnvelope(
        fail(
          'INVALID_ARGS',
          `forge orchestrate scan: invalid --source '${opts.source}'. Expected one of: ${TRIPWIRE_SOURCES.join(', ')}.`,
          false,
        ),
        out,
      ),
    };
  }
  let text = opts.text!;
  if (text === '-') {
    const reader = opts.readStdin ?? readStdinSync;
    text = reader();
  }
  const report = scanText(text, source);
  if (json) {
    return { exitCode: writeEnvelope(ok({ severity: report.severity, report }), out) };
  }
  const lines = [`${source}: ${report.severity} (${report.findings.length} finding(s))`];
  for (const fd of report.findings) {
    lines.push(`  - ${fd.rule} [${fd.severity}] @${fd.span.start}-${fd.span.end}: ${fd.excerpt}`);
  }
  out.write(lines.join('\n') + '\n');
  return { exitCode: 0 };
}

export const scanHandler: VerbHandler = {
  band: 'read',
  synopsis:
    'Scan a task\'s owner fields (--task <id>) or arbitrary text (--text <str> | --text -) for injection patterns. Report-only — never blocks, never emits events.',
  async run(rest, opts) {
    const forgeDir = resolveForgeDir(rest, opts.cwd);
    const task = parseFlag(rest, 'task');
    const text = parseFlag(rest, 'text');
    const source = parseFlag(rest, 'source');
    return runOrchestrateScan({
      forgeDir,
      json: hasFlag(rest, 'json'),
      ...(task !== undefined ? { task } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(source !== undefined ? { source } : {}),
    });
  },
};
