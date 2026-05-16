export interface UntrackedTaskWarning {
  task_id: string;
  title: string;
}

export interface PhaseSuggestion {
  phase_id: string;
  tracked_total: number;
  tracked_inactive: number;
  untracked_warnings: UntrackedTaskWarning[];
  ready_to_gate: boolean;
}

export interface OrphanIssue {
  identifier: string;
  state: string;
  title: string;
}

export interface DiagnosticReport {
  phase_suggestions: PhaseSuggestion[];
  orphans: OrphanIssue[];
  limit_hit?: { tracker_limit: number };
  generated_at: string;
}

export type RenderMode = 'human' | 'json';
