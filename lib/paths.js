import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const FORGE_ROOT = path.resolve(__dirname, '..');

export function getPackageVersion() {
  const pkg = fs.readJsonSync(path.join(FORGE_ROOT, 'package.json'));
  return pkg.version;
}
