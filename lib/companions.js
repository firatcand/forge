import { spawnSync } from 'child_process';

export const COMPANIONS = [
  {
    value: 'product-spec',
    name: 'product-spec',
    description: 'powers /draft-prd',
    sourceUrl: 'https://github.com/firatcand/founder-skills/tree/main/skills/product-spec',
    recommended: true,
  },
  {
    value: 'software-architect',
    name: 'software-architect',
    description: 'powers /draft-spec',
    sourceUrl: 'https://github.com/firatcand/founder-skills/tree/main/skills/software-architect',
    recommended: true,
  },
  {
    value: 'ux-design',
    name: 'ux-design',
    description: 'powers /draft-design',
    sourceUrl: 'https://github.com/firatcand/founder-skills/tree/main/skills/ux-design',
    recommended: false,
  },
  {
    value: 'ui-design',
    name: 'ui-design',
    description: 'powers /review for UI tasks',
    sourceUrl: 'https://github.com/firatcand/founder-skills/tree/main/skills/ui-design',
    recommended: false,
  },
];

const TOOL_KEY_TO_AGENT_ID = {
  claude: 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  gemini: 'gemini-cli',
};

export async function installCompanion(slug, targetTools) {
  const companion = COMPANIONS.find(c => c.value === slug);
  if (!companion) {
    throw new Error(`Unknown companion: ${slug}`);
  }

  const agentIds = (targetTools ?? [])
    .map(key => TOOL_KEY_TO_AGENT_ID[key])
    .filter(Boolean);

  const args = ['-y', 'skills', 'add', companion.sourceUrl, '--global', '--yes'];
  if (agentIds.length > 0) {
    args.push('--agent', ...agentIds);
  }

  const result = spawnSync('npx', args, {
    stdio: 'pipe',
    encoding: 'utf-8',
  });

  if (result.status !== 0) {
    throw new Error(
      result.stderr?.split('\n')[0] ||
      `npx skills failed (exit code ${result.status})`
    );
  }
}
