# omarchy-apply-quest

Omarchy bar widget (Quickshell/QML plugin) that turns daily job applications
into a streak game. Sits in the top bar as 🔥 and your current streak,
colored by today's progress — click it for the day's picks.

- **🔥 in the bar** — streak count, tinted red (0 applied today), amber
  (1-2), green (3+, goal met).
- **Click → popup** — today's 5 picked companies, pulled from
  [career-ops](https://github.com/santifer/career-ops)'s scan pool
  (`data/pipeline.md`). Each row: company, role, a link to the posting, a
  📄 button to generate a resume PDF, and a toggle to mark it applied.
- **Daily goal: 3 of 5 applied.** Hit it and the streak advances at the next
  day's rollover; miss it and the streak resets. Picks never repeat once used.
- **🔍 Scan for jobs** — runs career-ops's `scan.mjs` across its configured
  portals (Greenhouse/Ashby/Lever/etc.) and tops up today's picks if the pool
  was thin.
- **XP, levels, badges** — +10 XP per application, +50 for hitting the daily
  goal, +100 per streak milestone (7/14/30/60/100/200 days). Badges:
  First Blood, Goal Crusher, Week Warrior, Unstoppable, Centurion, Resume
  Machine.

## How resume generation works

📄 shells out to `bin/build-resume.mjs`, which reads career-ops's `cv.md`
(its canonical CV — see career-ops's `AGENTS.md` Data Contract), fills its
`templates/cv-template.tex` structure, retitles the header with the
target company/role, and compiles it via career-ops's own
`generate-latex.mjs` (tectonic, no separate TeX Live install needed).

This is a **baseline** resume — same bullets every time, just retitled, so
it works instantly with zero LLM calls and no API key. For a real
JD-tailored resume, open career-ops in Claude Code (`cd career-ops && claude`)
and ask for `latex` mode against the job URL.

Test the generator standalone any time, no QML involved:

```bash
node bin/build-resume.mjs --career-ops /path/to/career-ops --company "Acme" --role "AI Engineer"
```

## Install

Requires a working [career-ops](https://github.com/santifer/career-ops)
checkout (its `scan.mjs`/`generate-latex.mjs`) and Node on `PATH`.

```bash
ln -s "$(pwd)" ~/.config/omarchy/plugins/quest.apply   # or just run install.sh, which does this
./install.sh /path/to/career-ops
```

`install.sh` writes `~/.config/omarchy-apply-quest/config.json` (career-ops
path + this repo's own path — nothing personal lives in the repo itself),
symlinks this folder into `~/.config/omarchy/plugins/quest.apply`, and adds
`{"id": "quest.apply"}` to `bar.layout.right` in `~/.config/omarchy/shell.json`
(backing that file up first; it's a merge, not an overwrite).

If the bar icon doesn't show up:

```bash
omarchy-shell shell rescanPlugins
omarchy plugin list     # confirm quest.apply is enabled
omarchy plugin validate
```

## State

All of it lives outside this repo, so the repo itself is safe to publish:

- `~/.config/omarchy-apply-quest/config.json` — career-ops path, plugin path
- `~/.local/state/omarchy/apply-quest-state.json` — streak, XP, daily picks,
  applied/resume status

## Files

- `manifest.json` — plugin manifest (id `quest.apply`, kind `bar-widget`)
- `Panel.qml` — bar label + popup panel, entry point
- `Jobs.js` — pure logic: pipeline.md parsing, streak/XP/badge math
- `bin/build-resume.mjs` — cv.md → tex → PDF, standalone-testable with `node`
- `install.sh` — wires it into this machine's Omarchy shell

## Not built yet

- JD-tailored resumes (needs an LLM call; use career-ops's `latex` mode
  directly for that today).
- Cross-machine sync of streak state.
