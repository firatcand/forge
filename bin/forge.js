#!/usr/bin/env node

import { checkbox, input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';

import { detectTools, installToTool, auditTool } from '../lib/tools.js';
import { COMPANIONS, installCompanion } from '../lib/companions.js';
import { FORGE_ROOT, getPackageVersion } from '../lib/paths.js';

function tildify(p) {
  if (!p) return p;
  const home = os.homedir();
  return p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

function formatInstallSummary(tool, result) {
  const parts = [`${result.skillsCount} skills → ${tildify(result.skillsTarget)}`];
  if (result.agentsTarget) {
    const agentLabel = tool.key === 'codex' ? 'subagents' : 'agents';
    parts.push(`${result.agentsCount} ${agentLabel} → ${tildify(result.agentsTarget)}`);
  }
  return `${tool.name} — ${parts.join(', ')}`;
}

function showHelp() {
  console.log(`
${chalk.bold('🔨 forge')} — A lightweight framework for shipping software products with AI coding agents

${chalk.bold('Usage:')}
  npx @firatcand/forge                  Run interactive setup (default)
  npx @firatcand/forge install          Install forge skills + agents only
  npx @firatcand/forge doctor           Audit installed skills + agents per tool
  npx @firatcand/forge init [name]      Initialize a forge project in current directory
  npx @firatcand/forge companions       Install founder-skills companions
  npx @firatcand/forge --version        Show version
  npx @firatcand/forge --help           Show this help

${chalk.bold('Skills (use inside your AI coding tool):')}
  /forge          Discovery interview → BRIEF.md
  /draft-prd      Generate PRD.md from BRIEF.md
  /draft-spec     Generate SPEC.md from PRD.md
  /draft-design   Generate DESIGN.md from PRD.md (optional)
  /ingest-spec    Validate spec docs
  /decompose      spec → phases.yaml
  /setup-repo     GitHub repo + workflows + branch protection
  /push-to-linear Linear project + cycles + issues
  /pickup-task    Claim next task, create worktree
  /plan-task      Plan mode for task
  /implement      Execute plan
  /review         Multi-agent review
  /qa             Tests + browser checks
  /codex          Second-opinion review via Codex CLI
  /ship           Push branch, open PR
  /learn          Capture learning
  /phase-gate     Advance phase ceremony
  /retro          Phase retrospective

${chalk.dim('More: https://github.com/firatcand/forge')}
`);
}

async function runInteractiveSetup() {
  console.log(chalk.bold('\n🔨 forge') + chalk.dim(` v${getPackageVersion()}`));
  console.log(chalk.dim('A lightweight framework for shipping software products with AI coding agents\n'));

  console.log(chalk.bold('Detecting installed AI coding tools...'));
  const detected = detectTools();

  if (detected.length === 0) {
    console.log(chalk.red('\n  ⚠️  No supported AI coding tools detected.'));
    console.log(chalk.dim('  Install one of: Claude Code, Codex CLI, Cursor, Gemini CLI'));
    console.log(chalk.dim('  Then re-run: npx @firatcand/forge\n'));
    process.exit(1);
  }

  for (const tool of detected) {
    console.log(chalk.green('  ✓') + ' ' + tool.name + chalk.dim(' (' + tool.dir + ')'));
  }
  console.log();

  let selectedTools;
  if (detected.length === 1) {
    selectedTools = [detected[0].key];
    console.log(chalk.dim(`Installing to ${detected[0].name} (only tool detected).\n`));
  } else {
    selectedTools = await checkbox({
      message: 'Install forge skills + agents to:',
      choices: detected.map(t => ({
        value: t.key,
        name: t.name,
        checked: true,
      })),
      validate: (answer) => answer.length > 0 || 'Select at least one tool.',
    });
  }

  console.log(chalk.bold('\n📦 Installing forge skills (21) and agents (12)...\n'));
  for (const toolKey of selectedTools) {
    const tool = detected.find(t => t.key === toolKey);
    const result = await installToTool(tool, FORGE_ROOT);
    console.log(chalk.green('  ✓') + ' ' + formatInstallSummary(tool, result));
  }

  console.log();
  const wantsCompanions = await confirm({
    message: 'Install founder-skills companions? These extend /draft-prd, /draft-spec, /draft-design, and /review with deeper domain expertise.',
    default: true,
  });

  if (wantsCompanions) {
    const selectedCompanions = await checkbox({
      message: 'Choose which companions to install (Space to select, Enter to confirm):',
      choices: COMPANIONS.map(c => ({
        value: c.value,
        name: `${c.name} ${chalk.dim(`(${c.description})`)}`,
        checked: c.recommended,
      })),
    });

    if (selectedCompanions.length > 0) {
      console.log(chalk.bold(`\n📦 Installing ${selectedCompanions.length} companion(s) via npx skills...\n`));
      for (const slug of selectedCompanions) {
        try {
          await installCompanion(slug, selectedTools);
          console.log(chalk.green('  ✓') + ` ${slug}`);
        } catch (err) {
          console.log(chalk.yellow('  ⚠️') + ` ${slug} — ${err.message}`);
        }
      }
    }
  }

  console.log(chalk.bold.green('\n✅ Forge installed successfully\n'));
  console.log(chalk.bold('Next steps:'));
  console.log('  1. ' + chalk.cyan('cd into a project directory'));
  console.log('  2. ' + chalk.cyan('npx @firatcand/forge init') + ' — initialize project structure');
  console.log('  3. Open your AI coding tool (claude, codex)');
  console.log('  4. Run ' + chalk.cyan('/forge') + ' to start the lifecycle\n');
  console.log(chalk.dim('Docs: https://github.com/firatcand/forge#quickstart\n'));
}

async function commandInstall() {
  console.log(chalk.bold('\n🔨 forge install\n'));

  const detected = detectTools();
  if (detected.length === 0) {
    console.log(chalk.red('No supported tools detected.'));
    process.exit(1);
  }

  const selectedTools = detected.length === 1
    ? [detected[0].key]
    : await checkbox({
        message: 'Install to:',
        choices: detected.map(t => ({ value: t.key, name: t.name, checked: true })),
        validate: (a) => a.length > 0 || 'Select at least one.',
      });

  for (const toolKey of selectedTools) {
    const tool = detected.find(t => t.key === toolKey);
    const result = await installToTool(tool, FORGE_ROOT);
    console.log(chalk.green('  ✓') + ' ' + formatInstallSummary(tool, result));
  }

  console.log(chalk.bold.green('\n✅ Done\n'));
}

async function commandDoctor() {
  console.log(chalk.bold('\n🔨 forge doctor\n'));

  const detected = detectTools();
  if (detected.length === 0) {
    console.log(chalk.red('  ⚠️  No supported AI coding tools detected.'));
    console.log(chalk.dim('  Install one of: Claude Code, Codex CLI, Cursor, Gemini CLI'));
    console.log(chalk.dim('  Then re-run: npx @firatcand/forge\n'));
    process.exit(1);
  }

  let anyMissing = false;
  for (const tool of detected) {
    const audit = await auditTool(tool, FORGE_ROOT);
    const skillsLabel = `${audit.installedSkills.length}/${audit.expectedSkills.length} skills`;
    const agentLabelWord = tool.key === 'codex' ? 'subagents' : 'agents';
    const agentsLabel = audit.agentsTarget
      ? `${audit.installedAgents.length}/${audit.expectedAgents.length} ${agentLabelWord}`
      : null;
    const toolMissing = audit.missingSkills.length > 0 || audit.missingAgents.length > 0;

    const statusIcon = toolMissing ? chalk.yellow('  ⚠') : chalk.green('  ✓');
    const counts = agentsLabel ? `${skillsLabel}, ${agentsLabel}` : skillsLabel;
    console.log(`${statusIcon} ${tool.name} — ${counts}`);
    console.log(chalk.dim(`     skills:  ${tildify(audit.skillsTarget)}`));
    if (audit.agentsTarget) {
      console.log(chalk.dim(`     ${agentLabelWord}:  ${tildify(audit.agentsTarget)}`));
    }

    if (audit.missingSkills.length > 0) {
      console.log(chalk.yellow(`     missing skills: ${audit.missingSkills.join(', ')}`));
    }
    if (audit.missingAgents.length > 0) {
      console.log(chalk.yellow(`     missing ${agentLabelWord}: ${audit.missingAgents.join(', ')}`));
    }

    if (toolMissing) anyMissing = true;
  }

  console.log();
  if (anyMissing) {
    console.log(chalk.yellow('Some tools are missing forge skills or agents.'));
    console.log(chalk.dim('Run: ') + chalk.cyan('npx @firatcand/forge install') + chalk.dim(' to sync.\n'));
    process.exit(1);
  }

  console.log(chalk.bold.green('✅ All detected tools are in sync\n'));
}

async function commandCompanions() {
  console.log(chalk.bold('\n🔨 forge companions\n'));

  const detected = detectTools();
  if (detected.length === 0) {
    console.log(chalk.red('No supported tools detected.'));
    process.exit(1);
  }

  const selectedCompanions = await checkbox({
    message: 'Choose which founder-skills companions to install:',
    choices: COMPANIONS.map(c => ({
      value: c.value,
      name: `${c.name} ${chalk.dim(`(${c.description})`)}`,
      checked: c.recommended,
    })),
    validate: (a) => a.length > 0 || 'Select at least one.',
  });

  const selectedTools = detected.length === 1
    ? [detected[0].key]
    : await checkbox({
        message: 'Install companions to:',
        choices: detected.map(t => ({ value: t.key, name: t.name, checked: true })),
        validate: (a) => a.length > 0 || 'Select at least one.',
      });

  for (const slug of selectedCompanions) {
    try {
      await installCompanion(slug, selectedTools);
      console.log(chalk.green('  ✓') + ` ${slug}`);
    } catch (err) {
      console.log(chalk.yellow('  ⚠️') + ` ${slug} — ${err.message}`);
    }
  }

  console.log(chalk.bold.green('\n✅ Done\n'));
}

async function commandInit(projectNameArg) {
  console.log(chalk.bold('\n🔨 forge init\n'));

  const cwd = process.cwd();

  if (await fs.pathExists(path.join(cwd, 'CLAUDE.md'))) {
    const overwrite = await confirm({
      message: 'CLAUDE.md already exists. Overwrite?',
      default: false,
    });
    if (!overwrite) {
      console.log(chalk.dim('Cancelled.\n'));
      process.exit(0);
    }
  }

  const projectName = projectNameArg || await input({
    message: 'Project name:',
    default: path.basename(cwd),
  });

  const initGit = await fs.pathExists(path.join(cwd, '.git'))
    ? false
    : await confirm({ message: 'Initialize git repo?', default: true });

  console.log(chalk.bold('\n📁 Creating directory structure...'));
  await fs.ensureDir(path.join(cwd, 'spec'));
  await fs.ensureDir(path.join(cwd, 'plans', 'tasks'));
  await fs.ensureDir(path.join(cwd, 'docs', 'learnings'));
  await fs.ensureDir(path.join(cwd, 'docs', 'retros'));
  console.log(chalk.green('  ✓') + ' spec/, plans/, docs/{learnings,retros}/');

  console.log(chalk.bold('\n📄 Copying templates...'));
  const templatesDir = path.join(FORGE_ROOT, 'templates');

  const claudeTemplate = await fs.readFile(
    path.join(templatesDir, 'CLAUDE.project.template.md'),
    'utf-8'
  );
  await fs.writeFile(
    path.join(cwd, 'CLAUDE.md'),
    claudeTemplate.replaceAll('{{PROJECT_NAME}}', projectName)
  );
  console.log(chalk.green('  ✓') + ' CLAUDE.md');

  const criticalPath = path.join(cwd, 'CRITICAL.md');
  let writeCritical = true;
  if (await fs.pathExists(criticalPath)) {
    writeCritical = await confirm({
      message: 'CRITICAL.md already exists. Overwrite?',
      default: false,
    });
  }
  if (writeCritical) {
    await fs.copy(
      path.join(templatesDir, 'CRITICAL.template.md'),
      criticalPath,
      { overwrite: true }
    );
    console.log(chalk.green('  ✓') + ' CRITICAL.md');
  } else {
    console.log(chalk.dim('  - CRITICAL.md (kept existing)'));
  }

  const projectTemplates = path.join(cwd, 'templates');
  let copyTemplates = true;
  if (await fs.pathExists(projectTemplates)) {
    copyTemplates = await confirm({
      message: 'templates/ already exists. Refresh from forge templates? (your edits will be overwritten)',
      default: false,
    });
  }
  if (copyTemplates) {
    const skipList = new Set(['CLAUDE.project.template.md', 'CRITICAL.template.md']);
    await fs.ensureDir(projectTemplates);
    const entries = await fs.readdir(templatesDir);
    for (const entry of entries) {
      if (skipList.has(entry)) continue;
      await fs.copy(
        path.join(templatesDir, entry),
        path.join(projectTemplates, entry),
        { overwrite: true }
      );
    }
    console.log(chalk.green('  ✓') + ' templates/ (BRIEF, PRD, SPEC, DESIGN, phases, retro, learning + github-workflows/)');
  } else {
    console.log(chalk.dim('  - templates/ (kept existing)'));
  }

  if (!await fs.pathExists(path.join(cwd, '.env.example'))) {
    await fs.writeFile(
      path.join(cwd, '.env.example'),
      '# Environment variables — populate based on spec/SPEC.md\n# Copy to .env (gitignored) for local development\n'
    );
    console.log(chalk.green('  ✓') + ' .env.example');
  }

  const gitignorePath = path.join(cwd, '.gitignore');
  const forgeIgnoreLines = [
    '# Forge defaults',
    '.env',
    '.env.local',
    '.env.production',
    'node_modules/',
    '*.log',
    '.DS_Store',
  ];
  let existing = '';
  if (await fs.pathExists(gitignorePath)) {
    existing = await fs.readFile(gitignorePath, 'utf-8');
  }
  if (!existing.includes('# Forge defaults')) {
    await fs.writeFile(gitignorePath, existing + '\n' + forgeIgnoreLines.join('\n') + '\n');
    console.log(chalk.green('  ✓') + ' .gitignore (forge defaults appended)');
  }

  if (initGit) {
    try {
      execSync('git init', { cwd, stdio: 'ignore' });
      console.log(chalk.green('  ✓') + ' git initialized');
    } catch (err) {
      console.log(chalk.yellow('  ⚠️') + ' git init failed (is git installed?)');
    }
  }

  console.log(chalk.bold.green('\n✅ Project initialized\n'));
  console.log(chalk.bold('Next:'));
  console.log('  Open your AI coding tool: ' + chalk.cyan('claude') + ' or ' + chalk.cyan('codex'));
  console.log('  Run: ' + chalk.cyan('/forge') + ' (discovery interview → BRIEF.md)\n');
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  try {
    switch (command) {
      case 'install':
        await commandInstall();
        break;
      case 'doctor':
        await commandDoctor();
        break;
      case 'companions':
        await commandCompanions();
        break;
      case 'init':
        await commandInit(args[1]);
        break;
      case '-h':
      case '--help':
      case 'help':
        showHelp();
        break;
      case '-v':
      case '--version':
        console.log(getPackageVersion());
        break;
      case undefined:
        await runInteractiveSetup();
        break;
      default:
        console.log(chalk.red(`Unknown command: ${command}\n`));
        showHelp();
        process.exit(1);
    }
  } catch (err) {
    if (err.name === 'ExitPromptError') {
      console.log(chalk.dim('\nCancelled.\n'));
      process.exit(0);
    }
    console.error(chalk.red('\n❌ Error:'), err.message);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
