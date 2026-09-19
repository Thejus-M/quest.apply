// Jobs.js — data + logic for the Apply Quest bar widget.
//
// Everything here is pure functions operating on plain JS objects/strings;
// all mutable state lives in the `store` QtObject in Panel.qml (same split
// as the transactions widget's Model.js / Panel.qml).
//
// Resume PDF generation is NOT done here — it's a Node script
// (bin/build-resume.mjs) run via Quickshell's Process element, so it can be
// tested standalone with plain `node` and never races a QML file write.
//
// Data sources (read-only, via FileView, from career-ops):
//   <careerOps>/data/pipeline.md   - "- [ ] URL | Company | Role" pool
//
// Data this widget owns (~/.local/state/omarchy/apply-quest-state.json):
//   { streak, longestStreak, usedUrls: [...], days: { "YYYY-MM-DD": {
//       picks: [{url,company,role}], checked: [url,...], applied: [url,...],
//       resumes: {url: pdfPath},
//       liveness: {url: {status: "active"|"expired"|"uncertain", reason, checkedAt}}
//   } } }
//
// `checked` = "I opened the posting and confirmed this is worth a resume".
// The widget only enables 📄 once a pick is checked — resumes are generated
// for confirmed-relevant jobs, not blindly for everything the scanner found.
// `liveness` = last "🔎 check exists" result — informational (shown on the
// row), not a hard gate: liveness checks can come back "uncertain" for jobs
// that are actually still open, so it doesn't block 📄.

var DAILY_GOAL = 3
var PICKS_PER_DAY = 5

// ---- dates -----------------------------------------------------------

function pad2(n) { return n < 10 ? "0" + n : String(n) }

function dateKey(d) {
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

function todayKey() { return dateKey(new Date()) }

function yesterdayKey() {
  var d = new Date()
  d.setDate(d.getDate() - 1)
  return dateKey(d)
}

// ---- pipeline.md parsing ----------------------------------------------

// Parses career-ops's "- [ ] URL | Company | Role" pending-inbox lines.
// Checked ("- [x]") lines are skipped — those are already actioned inside
// career-ops's own pipeline mode.
function parsePipelinePool(text) {
  var lines = String(text || "").split("\n")
  var pool = []
  var re = /^-\s*\[\s\]\s*(\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/
  for (var i = 0; i < lines.length; i++) {
    var m = re.exec(lines[i])
    if (!m) continue
    pool.push({ url: m[1].trim(), company: m[2].trim(), role: m[3].trim() })
  }
  return pool
}

// ---- streak / xp / badges ----------------------------------------------

// Advances `state` to today if it hasn't been already (resolving yesterday's
// streak outcome), then tops up today's picks toward PICKS_PER_DAY from
// `pool`. Mutates and returns state.
//
// Topping up (rather than a one-shot pick) matters for two reasons: the pool
// FileView can load *after* the state FileView at startup, so the first call
// may see an empty pool — a one-shot pick would permanently lock in 0 jobs
// for the day; and it lets "Scan for jobs" mid-day fill remaining slots when
// the pool was thin the first time.
function rollDay(state, pool) {
  state.streak = state.streak || 0
  state.longestStreak = state.longestStreak || 0
  state.usedUrls = state.usedUrls || []
  state.days = state.days || {}

  var today = todayKey()
  var entry = state.days[today]

  if (!entry) {
    var hadAnyDay = Object.keys(state.days).length > 0
    var yDay = state.days[yesterdayKey()]
    if (yDay) {
      state.streak = (yDay.applied || []).length >= DAILY_GOAL ? state.streak + 1 : 0
    } else if (hadAnyDay) {
      state.streak = 0
    }
    state.longestStreak = Math.max(state.longestStreak, state.streak)
    entry = { picks: [], checked: [], applied: [], resumes: {}, liveness: {} }
    state.days[today] = entry
  }

  if (entry.picks.length < PICKS_PER_DAY) {
    var already = {}
    for (var i = 0; i < entry.picks.length; i++) already[entry.picks[i].url] = true
    var more = pickMore(pool || [], state.usedUrls, already, PICKS_PER_DAY - entry.picks.length)
    for (var j = 0; j < more.length; j++) {
      entry.picks.push(more[j])
      state.usedUrls.push(more[j].url)
    }
  }

  return state
}

function pickMore(pool, usedUrls, alreadyPicked, need) {
  var used = {}
  for (var i = 0; i < usedUrls.length; i++) used[usedUrls[i]] = true
  var fresh = pool.filter(function (p) { return !used[p.url] && !alreadyPicked[p.url] })
  var source = fresh.length > 0 ? fresh : pool.filter(function (p) { return !alreadyPicked[p.url] })
  return source.slice(0, need)
}

function computeXp(state) {
  var xp = 0
  var days = state.days || {}
  for (var key in days) {
    var d = days[key]
    var applied = (d.applied || []).length
    xp += applied * 10
    if (applied >= DAILY_GOAL) xp += 50
  }
  var milestones = [7, 14, 30, 60, 100, 200]
  for (var m = 0; m < milestones.length; m++) {
    if ((state.longestStreak || 0) >= milestones[m]) xp += 100
  }
  return xp
}

function computeLevel(xp) {
  return Math.floor(xp / 200) + 1
}

function computeBadges(state) {
  var days = state.days || {}
  var totalApplied = 0
  var totalResumes = 0
  var anyGoalMet = false
  var anyApplied = false
  for (var key in days) {
    var d = days[key]
    var appliedCount = (d.applied || []).length
    totalApplied += appliedCount
    totalResumes += Object.keys(d.resumes || {}).length
    if (appliedCount >= DAILY_GOAL) anyGoalMet = true
    if (appliedCount > 0) anyApplied = true
  }
  var longest = state.longestStreak || 0
  return [
    { id: "first-blood", label: "🩸 First Blood", achieved: anyApplied },
    { id: "goal-crusher", label: "🎯 Goal Crusher", achieved: anyGoalMet },
    { id: "week-warrior", label: "🔥 Week Warrior (7d)", achieved: longest >= 7 },
    { id: "unstoppable", label: "⚡ Unstoppable (30d)", achieved: longest >= 30 },
    { id: "centurion", label: "💯 Centurion (100 applied)", achieved: totalApplied >= 100 },
    { id: "resume-machine", label: "📄 Resume Machine (10 built)", achieved: totalResumes >= 10 }
  ]
}
