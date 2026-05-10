#!/usr/bin/env node
const VERSION = '0.2.1';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}
console.error(
  'forge: TypeScript entrypoint placeholder (FD-6). The active CLI lives at bin/forge.js until a later task ports it here.',
);
process.exit(1);
