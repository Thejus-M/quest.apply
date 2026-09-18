#!/usr/bin/env bash
# install.sh — wires Apply Quest into this machine's Omarchy shell.
#
# Usage:
#   ./install.sh "/path/to/career-ops"
#
# Does NOT touch anything under /usr/share/omarchy (system-owned). Only
# writes to ~/.config/omarchy-apply-quest/, ~/.local/state/omarchy/,
# ~/.config/omarchy/plugins/, and (after backing it up) ~/.config/omarchy/shell.json.
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAREER_OPS_DIR="${1:-}"

if [ -z "$CAREER_OPS_DIR" ]; then
  echo "Usage: ./install.sh /path/to/career-ops" >&2
  exit 1
fi
if [ ! -f "$CAREER_OPS_DIR/generate-latex.mjs" ]; then
  echo "Warning: $CAREER_OPS_DIR doesn't look like a career-ops checkout (no generate-latex.mjs)." >&2
fi

CONFIG_DIR="$HOME/.config/omarchy-apply-quest"
STATE_DIR="$HOME/.local/state/omarchy"
PLUGINS_DIR="$HOME/.config/omarchy/plugins"
SHELL_JSON="$HOME/.config/omarchy/shell.json"

mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$PLUGINS_DIR"

# 1. Config: this plugin's own path + the career-ops checkout it drives.
cat > "$CONFIG_DIR/config.json" <<EOF
{
  "careerOpsDir": "$CAREER_OPS_DIR",
  "pluginDir": "$PLUGIN_DIR"
}
EOF
echo "Wrote $CONFIG_DIR/config.json"

# 2. Symlink into the shell's plugin directory (same pattern as any other
#    third-party bar-widget plugin).
if [ -e "$PLUGINS_DIR/quest.apply" ] && [ ! -L "$PLUGINS_DIR/quest.apply" ]; then
  echo "Refusing to overwrite non-symlink $PLUGINS_DIR/quest.apply" >&2
  exit 1
fi
ln -sfn "$PLUGIN_DIR" "$PLUGINS_DIR/quest.apply"
echo "Symlinked $PLUGINS_DIR/quest.apply -> $PLUGIN_DIR"

# 3. Add to the bar layout (right section) if not already present. shell.json
#    has no deep-merge once customized, so this reads-modifies-writes the
#    user's actual file rather than overwriting it, and backs it up first.
node - "$SHELL_JSON" <<'NODE'
const fs = require("fs");
const path = process.argv[2];
if (!fs.existsSync(path)) {
  console.log("No shell.json yet — Omarchy will create one on first run; re-run install.sh after that.");
  process.exit(0);
}
const backup = path + ".bak." + Date.now();
fs.copyFileSync(path, backup);
console.log("Backed up shell.json to " + backup);

const shell = JSON.parse(fs.readFileSync(path, "utf-8"));
shell.bar = shell.bar || {};
shell.bar.layout = shell.bar.layout || {};
shell.bar.layout.right = shell.bar.layout.right || [];

const already = shell.bar.layout.right.some((w) => w && w.id === "quest.apply");
if (already) {
  console.log("quest.apply already in bar.layout.right — leaving shell.json untouched.");
} else {
  shell.bar.layout.right.push({ id: "quest.apply" });
  fs.writeFileSync(path, JSON.stringify(shell, null, 2) + "\n");
  console.log("Added quest.apply to bar.layout.right.");
}
NODE

# 4. Nudge the running shell to pick it up.
if command -v omarchy-shell >/dev/null 2>&1; then
  omarchy-shell shell rescanPlugins || true
fi
if command -v omarchy >/dev/null 2>&1; then
  omarchy plugin enable quest.apply || true
fi

echo
echo "Done. Look for 🔥 in your top-right bar. If it's not there:"
echo "  omarchy-shell shell rescanPlugins"
echo "  omarchy plugin list      # confirm quest.apply is enabled"
