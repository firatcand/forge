import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function writeAtomic(absPath: string, contents: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.forge-tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, contents, 'utf8');
  try {
    renameSync(tmpPath, absPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp may already be gone; ignore
    }
    throw err;
  }
}
