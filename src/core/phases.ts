import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, YAMLParseError } from 'yaml';
import { z } from 'zod';

import { PhasesSchema, type Phases } from '../schemas/phases.ts';
import { PhasesError } from './errors.ts';
import { computeFreshnessLine } from './freshness.ts';

export interface LoadPhasesResult {
  phases: Phases;
  // Pre-rendered freshness summary line; callers print to stderr before their
  // own output. Loader stays pure of I/O side-effects; each caller decides
  // whether/where to surface this. See plans/tasks/FORGE-113.plan.md §0 Q1.
  freshnessLine: string;
}

export function loadPhases(filePath: string): LoadPhasesResult {
  const resolved = path.resolve(filePath);

  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') {
      throw new PhasesError(
        'FILE_NOT_FOUND',
        `phases file not found: ${resolved}`,
        { path: resolved },
        { cause: err },
      );
    }
    throw new PhasesError(
      'READ_FAILED',
      `failed to read phases file: ${resolved}`,
      { path: resolved, errno },
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const details: Record<string, unknown> = { path: resolved };
    if (err instanceof YAMLParseError && err.linePos && err.linePos[0]) {
      details.line = err.linePos[0].line;
      details.col = err.linePos[0].col;
    }
    throw new PhasesError(
      'PARSE_ERROR',
      `failed to parse phases YAML: ${resolved}`,
      details,
      { cause: err },
    );
  }

  let phases: Phases;
  try {
    phases = PhasesSchema.parse(parsed);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new PhasesError(
        'SCHEMA_INVALID',
        `phases schema validation failed: ${resolved}`,
        { path: resolved, issues: err.issues },
        { cause: err },
      );
    }
    throw err;
  }

  return { phases, freshnessLine: computeFreshnessLine(phases.source) };
}
