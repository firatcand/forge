import type { Phases, Task } from '../schemas/phases.ts';
import type { Issue } from '../trackers/types.ts';

import type {
  DiagnosticReport,
  OrphanIssue,
  PhaseSuggestion,
  RenderMode,
  UntrackedTaskWarning,
} from './types.ts';

export type {
  DiagnosticReport,
  OrphanIssue,
  PhaseSuggestion,
  RenderMode,
  UntrackedTaskWarning,
} from './types.ts';

export interface BuildDiagnosticOptions {
  limit_hit?: { tracker_limit: number };
  now?: () => Date;
}

export function buildDiagnostic(
  phases: Phases,
  issues: Issue[],
  opts: BuildDiagnosticOptions = {},
): DiagnosticReport {
  const activeIdentifiers = new Set<string>();
  for (const issue of issues) {
    if (issue.identifier) activeIdentifiers.add(issue.identifier);
  }

  const trackedAcrossPlan = new Set<string>();
  for (const phase of phases.phases) {
    for (const task of phase.tasks) {
      if (task.tracker_issue_id) trackedAcrossPlan.add(task.tracker_issue_id);
    }
  }

  const phase_suggestions: PhaseSuggestion[] = [];
  for (const phase of phases.phases) {
    if (phase.status !== 'active') continue;
    if (phase.tasks.length === 0) continue;

    const trackedTasks: Task[] = phase.tasks.filter((t) => Boolean(t.tracker_issue_id));
    const untrackedTasks: Task[] = phase.tasks.filter((t) => !t.tracker_issue_id);

    const trackedInactive = trackedTasks.filter(
      (t) => !activeIdentifiers.has(t.tracker_issue_id!),
    ).length;

    const allTrackedInactive =
      trackedTasks.length > 0 && trackedInactive === trackedTasks.length;
    const onlyUntracked = trackedTasks.length === 0 && untrackedTasks.length > 0;

    if (!allTrackedInactive && !onlyUntracked) continue;

    const untracked_warnings: UntrackedTaskWarning[] = untrackedTasks.map((t) => ({
      task_id: t.id,
      title: t.title,
    }));

    phase_suggestions.push({
      phase_id: phase.id,
      tracked_total: trackedTasks.length,
      tracked_inactive: trackedInactive,
      untracked_warnings,
      ready_to_gate: trackedTasks.length > 0 && untracked_warnings.length === 0,
    });
  }

  const orphans: OrphanIssue[] = [];
  for (const issue of issues) {
    if (!issue.identifier) continue;
    if (trackedAcrossPlan.has(issue.identifier)) continue;
    orphans.push({
      identifier: issue.identifier,
      state: issue.state,
      title: issue.title,
    });
  }

  const generated_at = (opts.now ?? (() => new Date()))().toISOString();

  const report: DiagnosticReport = {
    phase_suggestions,
    orphans,
    generated_at,
  };
  if (opts.limit_hit) report.limit_hit = opts.limit_hit;
  return report;
}

// Only non-terminal states reach the orphan renderer — listActiveIssues()
// filters terminal states (done/cancelled) at every adapter boundary.
const STATE_LABELS: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  blocked: 'Blocked',
};

function formatState(state: string): string {
  return STATE_LABELS[state] ?? state;
}

export function renderReport(report: DiagnosticReport, mode: RenderMode = 'human'): string {
  if (mode === 'json') {
    return JSON.stringify(report, null, 2);
  }
  return renderHuman(report);
}

function renderHuman(report: DiagnosticReport): string {
  const lines: string[] = [];

  if (report.limit_hit) {
    lines.push(
      `⚠ Tracker returned full page (${report.limit_hit.tracker_limit}). Some active issues may be missing — re-run after triage.`,
      '',
    );
  }

  if (report.phase_suggestions.length === 0) {
    lines.push('No phase suggestions.');
  } else {
    for (const suggestion of report.phase_suggestions) {
      lines.push(...renderPhaseSuggestion(suggestion));
      lines.push('');
    }
  }

  lines.push(...renderOrphans(report.orphans));

  return lines.join('\n').trimEnd() + '\n';
}

function renderPhaseSuggestion(s: PhaseSuggestion): string[] {
  const header = `${s.phase_id} (active): no active tracker issues remain (${s.tracked_inactive}/${s.tracked_total} tracked).`;
  if (s.ready_to_gate) {
    return [header, `Verify the phase is complete and run \`/phase-gate ${s.phase_id}\`.`];
  }
  const warnLines = [
    header,
    `${s.untracked_warnings.length} task${s.untracked_warnings.length === 1 ? '' : 's'} missing tracker_issue_id — manual review required before \`/phase-gate\`:`,
  ];
  for (const w of s.untracked_warnings) {
    warnLines.push(`  - ${w.task_id} "${w.title}"`);
  }
  return warnLines;
}

function renderOrphans(orphans: OrphanIssue[]): string[] {
  if (orphans.length === 0) return ['No orphan tracker issues. ✓'];
  const lines = ['Orphan tracker issues (active in tracker, not in plans/phases.yaml):'];
  const widthId = Math.max(...orphans.map((o) => o.identifier.length));
  const widthState = Math.max(...orphans.map((o) => formatState(o.state).length));
  for (const o of orphans) {
    lines.push(
      `  - ${o.identifier.padEnd(widthId)}  ${formatState(o.state).padEnd(widthState)}  "${o.title}"`,
    );
  }
  const plural = orphans.length === 1 ? 'orphan' : 'orphans';
  lines.push(
    `${orphans.length} ${plural} — review whether to backfill into phases.yaml or treat as out-of-band.`,
  );
  return lines;
}
