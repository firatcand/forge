// Template-shape contract for `templates/adr.template.md`.
//
// FORGE-92 (P2.5-T01) ships the ephemeral-ADR scaffold ahead of v0.5 consumers
// (FORGE-93 `/update-spec --draft`, FORGE-95 `apply-decision`). These tests
// guarantee the template stays in sync with what `spec/SPEC.md §ADR layer`
// promises — drift between the two would silently break v0.5 work once it lands.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatePath = join(__dirname, '../../templates/adr.template.md');
const specPath = join(__dirname, '../../spec/SPEC.md');

const template = readFileSync(templatePath, 'utf8');
const spec = readFileSync(specPath, 'utf8');

// Mirrors AdrFrontmatterSchema in spec/SPEC.md §ADR layer (line ~800).
// Hardcoded here because `src/schemas/adr.ts` is v0.5 scope (FORGE-93) and
// doesn't exist yet. When it lands, this test should import the enum + key list
// from there and the duplicate constants can be removed.
const REQUIRED_FRONTMATTER_KEYS = [
  'slug',
  'date',
  'status',
  'affected_tasks',
  'affected_spec_sections',
  'affected_prd_sections',
  'affected_phases_tasks',
] as const;

const ADR_STATUS_VALUES = ['proposed', 'accepted', 'rejected'] as const;

test('adr-template: file exists and is non-empty', () => {
  assert.ok(template.length > 0, 'templates/adr.template.md is empty');
});

test('adr-template: frontmatter contains all 7 required keys', () => {
  const frontmatterMatch = template.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'template has no YAML frontmatter block');
  const fm = frontmatterMatch[1];
  for (const key of REQUIRED_FRONTMATTER_KEYS) {
    assert.match(fm, new RegExp(`^${key}:`, 'm'), `frontmatter missing key: ${key}`);
  }
});

test('adr-template: status default is in AdrStatus enum', () => {
  const statusMatch = template.match(/^status:\s*(\S+)/m);
  assert.ok(statusMatch, 'frontmatter has no status line');
  const value = statusMatch[1];
  assert.ok(
    ADR_STATUS_VALUES.includes(value as (typeof ADR_STATUS_VALUES)[number]),
    `status default '${value}' is not in AdrStatus enum [${ADR_STATUS_VALUES.join(', ')}]`,
  );
});

test('adr-template: body contains all 4 required section headings', () => {
  for (const heading of ['## Context', '## Decision', '## Consequences', '## Alternatives considered']) {
    assert.match(template, new RegExp(`^${heading.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'm'),
      `template missing heading: ${heading}`);
  }
});

test('adr-template: matches the inline block in spec/SPEC.md §ADR template', () => {
  // Extract the fenced ```markdown block immediately following the
  // "### ADR template (`templates/adr.template.md`)" heading in SPEC.md.
  // Drift between the two would silently break v0.5 consumers.
  const sectionMatch = spec.match(
    /### ADR template \(`templates\/adr\.template\.md`\)[\s\S]*?```markdown\n([\s\S]*?)\n```/,
  );
  assert.ok(sectionMatch, 'spec/SPEC.md §ADR template inline block not found');
  const inlineBlock = sectionMatch[1];
  const normalize = (s: string) => s.replace(/\s+$/, '');
  assert.equal(
    normalize(template),
    normalize(inlineBlock),
    'templates/adr.template.md drifted from spec/SPEC.md §ADR template inline block',
  );
});
