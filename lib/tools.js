import path from 'path';
import os from 'os';
import fs from 'fs-extra';

const TOOL_DEFINITIONS = [
  {
    key: 'claude',
    name: 'Claude Code',
    dir: path.join(os.homedir(), '.claude'),
    skillsDir: 'skills',
    agentsDir: 'agents',
  },
  {
    key: 'codex',
    name: 'Codex CLI',
    dir: path.join(os.homedir(), '.codex'),
    skillsDir: 'skills',
    agentsDir: 'subagents',
  },
  {
    key: 'cursor',
    name: 'Cursor',
    dir: path.join(os.homedir(), '.cursor'),
    skillsDir: 'skills',
    agentsDir: 'agents',
  },
  {
    key: 'gemini',
    name: 'Gemini CLI',
    dir: path.join(os.homedir(), '.gemini'),
    skillsDir: 'extensions',
    agentsDir: null,
  },
];

export function detectTools() {
  return TOOL_DEFINITIONS.filter(tool => fs.pathExistsSync(tool.dir));
}

export async function installToTool(tool, forgeRoot) {
  const skillsTarget = path.join(tool.dir, tool.skillsDir);
  const agentsTarget = tool.agentsDir ? path.join(tool.dir, tool.agentsDir) : null;

  await fs.ensureDir(skillsTarget);
  if (agentsTarget) await fs.ensureDir(agentsTarget);

  const skillsSource = path.join(forgeRoot, 'skills');
  const skills = await fs.readdir(skillsSource);
  for (const skill of skills) {
    const src = path.join(skillsSource, skill);
    const dst = path.join(skillsTarget, skill);
    await fs.remove(dst);
    await fs.copy(src, dst, { overwrite: true, errorOnExist: false });
  }

  if (agentsTarget) {
    const agentsSource = path.join(forgeRoot, 'agents');
    if (await fs.pathExists(agentsSource)) {
      const agents = await fs.readdir(agentsSource);
      for (const agent of agents) {
        const src = path.join(agentsSource, agent);
        const dst = path.join(agentsTarget, agent);
        await fs.remove(dst);
        await fs.copy(src, dst, { overwrite: true, errorOnExist: false });
      }
    }
  }
}
