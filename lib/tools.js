import path from 'path';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs-extra';

const HASH_IGNORE = new Set(['.DS_Store', 'Thumbs.db', '.git']);

async function hashEntry(entryPath) {
  let stat;
  try {
    stat = await fs.stat(entryPath);
  } catch {
    return null;
  }
  if (stat.isFile()) {
    const buf = await fs.readFile(entryPath);
    return crypto.createHash('sha256').update(buf).digest('hex');
  }
  if (stat.isDirectory()) {
    const entries = (await fs.readdir(entryPath))
      .filter(name => !HASH_IGNORE.has(name))
      .sort();
    const hash = crypto.createHash('sha256');
    for (const name of entries) {
      const childHash = await hashEntry(path.join(entryPath, name));
      if (childHash === null) continue;
      hash.update(name);
      hash.update('\0');
      hash.update(childHash);
    }
    return hash.digest('hex');
  }
  return null;
}

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

  let agentsCount = 0;
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
      agentsCount = agents.length;
    }
  }

  return {
    skillsCount: skills.length,
    agentsCount,
    skillsTarget,
    agentsTarget,
  };
}

export async function listExpectedSkills(forgeRoot) {
  return fs.readdir(path.join(forgeRoot, 'skills'));
}

export async function listExpectedAgents(forgeRoot) {
  const agentsSource = path.join(forgeRoot, 'agents');
  if (!(await fs.pathExists(agentsSource))) return [];
  return fs.readdir(agentsSource);
}

async function diffByContent(names, sourceDir, targetDir) {
  const stale = [];
  for (const name of names) {
    const sourceHash = await hashEntry(path.join(sourceDir, name));
    const targetHash = await hashEntry(path.join(targetDir, name));
    if (sourceHash !== targetHash) stale.push(name);
  }
  return stale;
}

export async function auditTool(tool, forgeRoot) {
  const expectedSkills = await listExpectedSkills(forgeRoot);
  const skillsTarget = path.join(tool.dir, tool.skillsDir);
  const skillsSource = path.join(forgeRoot, 'skills');
  const skillsInstalled = (await fs.pathExists(skillsTarget))
    ? new Set(await fs.readdir(skillsTarget))
    : new Set();
  const installedSkills = expectedSkills.filter(s => skillsInstalled.has(s));
  const missingSkills = expectedSkills.filter(s => !skillsInstalled.has(s));
  const staleSkills = await diffByContent(installedSkills, skillsSource, skillsTarget);

  let agentsTarget = null;
  let expectedAgents = [];
  let installedAgents = [];
  let missingAgents = [];
  let staleAgents = [];
  if (tool.agentsDir) {
    agentsTarget = path.join(tool.dir, tool.agentsDir);
    const agentsSource = path.join(forgeRoot, 'agents');
    expectedAgents = await listExpectedAgents(forgeRoot);
    const agentsInstalled = (await fs.pathExists(agentsTarget))
      ? new Set(await fs.readdir(agentsTarget))
      : new Set();
    installedAgents = expectedAgents.filter(a => agentsInstalled.has(a));
    missingAgents = expectedAgents.filter(a => !agentsInstalled.has(a));
    staleAgents = await diffByContent(installedAgents, agentsSource, agentsTarget);
  }

  return {
    skillsTarget,
    expectedSkills,
    installedSkills,
    missingSkills,
    staleSkills,
    agentsTarget,
    expectedAgents,
    installedAgents,
    missingAgents,
    staleAgents,
  };
}
