#!/usr/bin/env bash
set -euo pipefail

# Forge installer — symlinks skills and agents into ~/.claude/

FORGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${HOME}/.claude"
SKILLS_DIR="${CLAUDE_DIR}/skills"
AGENTS_DIR="${CLAUDE_DIR}/agents"
BIN_DIR="${HOME}/.local/bin"

echo "🔨 Forge installer"
echo ""
echo "Forge directory: ${FORGE_DIR}"
echo "Target Claude directory: ${CLAUDE_DIR}"
echo ""

# Sanity checks
if [[ ! -d "${FORGE_DIR}/skills" ]] || [[ ! -d "${FORGE_DIR}/agents" ]]; then
  echo "❌ Error: skills/ or agents/ directory missing. Are you running from the forge repo root?"
  exit 1
fi

# Create target directories
mkdir -p "${SKILLS_DIR}" "${AGENTS_DIR}" "${BIN_DIR}"

# Symlink skills
echo "📦 Installing 21 skills..."
for skill_dir in "${FORGE_DIR}/skills"/*/; do
  skill_name=$(basename "${skill_dir}")
  target="${SKILLS_DIR}/${skill_name}"

  if [[ -L "${target}" ]] || [[ -d "${target}" ]]; then
    echo "  ⚠️  ${skill_name} already exists — backing up to ${target}.bak"
    mv "${target}" "${target}.bak"
  fi

  ln -s "${skill_dir%/}" "${target}"
  echo "  ✓ ${skill_name}"
done

# Symlink agents
echo ""
echo "🤖 Installing 12 subagents..."
for agent_file in "${FORGE_DIR}/agents"/*.md; do
  agent_name=$(basename "${agent_file}")
  target="${AGENTS_DIR}/${agent_name}"

  if [[ -L "${target}" ]] || [[ -f "${target}" ]]; then
    echo "  ⚠️  ${agent_name} already exists — backing up to ${target}.bak"
    mv "${target}" "${target}.bak"
  fi

  ln -s "${agent_file}" "${target}"
  echo "  ✓ ${agent_name%.md}"
done

# Install forge CLI
echo ""
echo "⚙️  Installing forge CLI..."
cli_target="${BIN_DIR}/forge"
if [[ -L "${cli_target}" ]] || [[ -f "${cli_target}" ]]; then
  rm "${cli_target}"
fi
ln -s "${FORGE_DIR}/forge" "${cli_target}"
chmod +x "${FORGE_DIR}/forge"
echo "  ✓ forge → ${cli_target}"

# Check PATH
if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
  echo ""
  echo "⚠️  ${BIN_DIR} is not in your PATH. Add this to your shell config:"
  echo ""
  echo "  export PATH=\"${BIN_DIR}:\$PATH\""
  echo ""
fi

echo ""
echo "✅ Forge installed successfully"
echo ""
echo "Next steps:"
echo "  1. cd into a project directory"
echo "  2. Run: forge init"
echo "  3. Open Claude Code: claude"
echo "  4. Run: /forge"
echo ""
echo "Docs: ${FORGE_DIR}/docs/QUICKSTART.md"
