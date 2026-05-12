import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface TemplateVars {
  PROJECT_NAME: string;
  ISO_DATE: string;
  DESIGN_MODE: string;
  DESIGN_REFERENCE: string;
}

// Locate templates/ both in dev (src) and shipped npm layout (dist/).
// Dev:   src/cli/init/templates.ts → ../../../templates/
// Built: dist/bin/forge.cjs        → ../templates/  (per package.json files[])
export function resolveTemplatesDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'templates'),
    resolve(here, '..', '..', 'templates'),
    resolve(here, '..', 'templates'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(
    `forge: templates directory not found. Looked at: ${candidates.join(', ')}. Reinstall: npm i -g @firatcand/forge`,
  );
}

export function substitute(raw: string, vars: TemplateVars): string {
  return raw
    .replace(/\{\{PROJECT_NAME\}\}/g, vars.PROJECT_NAME)
    .replace(/\{\{ISO_DATE\}\}/g, vars.ISO_DATE)
    .replace(/\{\{DESIGN_MODE\}\}/g, vars.DESIGN_MODE)
    .replace(/\{\{DESIGN_REFERENCE\}\}/g, vars.DESIGN_REFERENCE);
}

export function renderTemplate(templatesDir: string, name: string, vars: TemplateVars): string {
  const path = resolve(templatesDir, name);
  const raw = readFileSync(path, 'utf8');
  return substitute(raw, vars);
}
