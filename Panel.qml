import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Jobs.js" as Jobs

// Apply Quest: bar label (🔥 streak, tinted by today's progress) + popup
// listing today's 5 picked companies, each with a "generate resume" and a
// "mark applied" action. Daily goal is 3/5 applied; hitting it advances the
// streak at midnight rollover. Mirrors the structure of the transactions
// widget: Panel base for popup lifecycle, a `store` QtObject for state,
// FileView for JSON persistence — plus two Process elements that shell out
// to career-ops (scan.mjs for new jobs, bin/build-resume.mjs for a PDF).
Panel {
  id: root
  moduleName: "quest.apply"
  ipcTarget: "quest.apply"
  manageIpc: false

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color goodColor: "#3ea34d"
  readonly property color midColor: "#e0a530"
  readonly property color badColor: Color.urgent

  readonly property int dailyGoal: 3

  readonly property var today: store.state.days ? store.state.days[Jobs.todayKey()] : null
  readonly property var todayPicks: today ? today.picks : []
  readonly property int appliedCount: today ? (today.applied || []).length : 0
  readonly property bool goalMet: appliedCount >= root.dailyGoal
  readonly property int streak: store.state.streak || 0
  readonly property int longestStreak: store.state.longestStreak || 0
  readonly property int xp: Jobs.computeXp(store.state)
  readonly property int level: Jobs.computeLevel(root.xp)
  readonly property var badges: Jobs.computeBadges(store.state)

  readonly property color statusColor: root.goalMet ? root.goodColor : (root.appliedCount > 0 ? root.midColor : root.badColor)

  property string scanStatus: ""
  property string resumeStatus: ""
  property var resumeBusyUrl: null

  implicitWidth: barButton.implicitWidth
  implicitHeight: barButton.implicitHeight

  // ---- config: career-ops path + this plugin's own path, written by
  // install.sh so nothing personal is hardcoded in source. ----
  QtObject {
    id: config
    property string careerOpsDir: ""
    property string pluginDir: ""
  }

  FileView {
    id: configFile
    path: Quickshell.env("HOME") + "/.config/omarchy-apply-quest/config.json"
    watchChanges: true
    printErrors: false
    onLoaded: {
      try {
        var c = JSON.parse(text() || "{}")
        config.careerOpsDir = c.careerOpsDir || ""
        config.pluginDir = c.pluginDir || ""
      } catch (e) { /* leave blank; UI shows "not configured" */ }
    }
    onLoadFailed: { config.careerOpsDir = ""; config.pluginDir = "" }
  }

  // ---- state store (streak/xp/picks/applied), mirrors transactions' store ----
  QtObject {
    id: store
    property var state: ({})
    property var pool: []

    function persist() {
      stateFile.setText(JSON.stringify(state, null, 2) + "\n")
    }

    function setPool(list) {
      pool = list || []
      ensureToday()
    }

    function setState(s) {
      state = s || {}
      ensureToday()
    }

    function ensureToday() {
      if (!config.careerOpsDir) return
      var before = JSON.stringify(state.days || {})
      Jobs.rollDay(state, pool)
      if (JSON.stringify(state.days || {}) !== before) persist()
      // Force property re-evaluation (QML doesn't deep-watch plain JS objects).
      state = state
    }

    function toggleApplied(url) {
      var d = state.days && state.days[Jobs.todayKey()]
      if (!d) return
      var applied = d.applied || []
      var idx = applied.indexOf(url)
      if (idx >= 0) applied.splice(idx, 1)
      else applied.push(url)
      d.applied = applied
      state = state
      persist()
    }

    function recordResume(url, pdfPath) {
      var d = state.days && state.days[Jobs.todayKey()]
      if (!d) return
      d.resumes = d.resumes || {}
      d.resumes[url] = pdfPath
      state = state
      persist()
    }
  }

  FileView {
    id: stateFile
    path: Quickshell.env("HOME") + "/.local/state/omarchy/apply-quest-state.json"
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: store.setState(JSON.parse(text() || "{}"))
    onLoadFailed: store.setState({})
  }

  FileView {
    id: pipelineFile
    path: config.careerOpsDir ? (config.careerOpsDir + "/data/pipeline.md") : ""
    watchChanges: true
    printErrors: false
    onLoaded: store.setPool(Jobs.parsePipelinePool(text()))
    onLoadFailed: store.setPool([])
  }

  onOpenedChanged: if (opened) {
    pipelineFile.reload()
    stateFile.reload()
    if (config.careerOpsDir) store.ensureToday()
  }

  // ---- career-ops scan: pulls fresh jobs into data/pipeline.md ----
  Process {
    id: scanProcess
    running: false
    workingDirectory: config.careerOpsDir
    command: ["node", config.careerOpsDir + "/scan.mjs", "--json"]
    stdout: StdioCollector { id: scanStdout; waitForEnd: true }
    stderr: StdioCollector { id: scanStderr; waitForEnd: true }
    onExited: function (exitCode) {
      root.scanStatus = "idle"
      if (exitCode === 0) {
        try {
          var lines = String(scanStdout.text || "").trim().split("\n")
          var receipt = JSON.parse(lines[lines.length - 1])
          root.scanStatus = "Found " + receipt.found + " · added " + receipt.added + " new"
        } catch (e) {
          root.scanStatus = "Scan finished"
        }
        pipelineFile.reload()
      } else {
        root.scanStatus = "Scan failed (see career-ops logs)"
      }
    }
  }

  function runScan() {
    if (!config.careerOpsDir || scanProcess.running) return
    root.scanStatus = "Scanning…"
    scanProcess.running = true
  }

  // ---- resume generation: shells to bin/build-resume.mjs ----
  Process {
    id: resumeProcess
    running: false
    workingDirectory: config.careerOpsDir
    command: []
    stdout: StdioCollector { id: resumeStdout; waitForEnd: true }
    stderr: StdioCollector { id: resumeStderr; waitForEnd: true }
    onExited: function (exitCode) {
      var url = root.resumeBusyUrl
      root.resumeBusyUrl = null
      try {
        var result = JSON.parse(String(resumeStdout.text || "{}"))
        if (result.ok) {
          store.recordResume(url, result.pdf)
          root.resumeStatus = "Resume ready"
          if (root.bar) root.bar.run("xdg-open " + root.bar.shellQuote(result.pdf))
        } else {
          root.resumeStatus = "Resume failed: " + (result.error || "unknown error")
        }
      } catch (e) {
        root.resumeStatus = "Resume failed (see " + config.careerOpsDir + "/output logs)"
      }
    }
  }

  function generateResume(job) {
    if (!config.careerOpsDir || !config.pluginDir || root.resumeBusyUrl) return
    root.resumeBusyUrl = job.url
    root.resumeStatus = "Building " + job.company + " resume…"
    resumeProcess.command = [
      "node", config.pluginDir + "/bin/build-resume.mjs",
      "--career-ops", config.careerOpsDir,
      "--company", job.company,
      "--role", job.role
    ]
    resumeProcess.running = true
  }

  // ---- bar label ----
  Item {
    id: barButton
    anchors.fill: parent
    implicitWidth: label.implicitWidth + Style.space(16)
    implicitHeight: bar ? bar.barSize : 26

    Text {
      id: label
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: config.careerOpsDir ? ("🔥" + root.streak + (root.goalMet ? " ✅" : " " + root.appliedCount + "/" + root.dailyGoal)) : "🔥?"
      color: root.statusColor
      font.family: bar ? bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
      font.bold: true
    }

    MouseArea {
      id: mouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.toggle()
      onEntered: if (root.bar) root.bar.showTooltip(barButton,
        "Apply Quest — streak " + root.streak + "d (best " + root.longestStreak + ")\n" +
        "Today: " + root.appliedCount + "/" + root.dailyGoal + " applied\n" +
        "Level " + root.level + " · " + root.xp + " XP\n" +
        "Click to open")
      onExited: if (root.bar) root.bar.hideTooltip(barButton)
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: barButton
    owner: root
    bar: root.bar
    open: root.opened
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(column.implicitHeight, Style.space(560))

    Flickable {
      id: flick
      anchors.fill: parent
      contentWidth: width
      contentHeight: column.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds
      flickableDirection: Flickable.VerticalFlick
      interactive: contentHeight > height
      ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

      Column {
        id: column
        width: flick.width
        spacing: Style.space(12)

        PanelHero {
          width: parent.width
          title: "Apply Quest"
          meta: "🔥 " + root.streak + "d streak · Lv " + root.level + " · " + root.xp + " XP"
          detail: root.appliedCount + "/" + root.dailyGoal
          foreground: root.foreground
        }

        Text {
          visible: !config.careerOpsDir
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          text: "Not configured yet. Run install.sh from the plugin repo to point this at your career-ops checkout."
          color: root.badColor
          font.family: Style.font.family
          font.pixelSize: Style.font.body
        }

        ActionRow {
          width: parent.width
          label: scanProcess.running ? "Scanning…" : "🔍 Scan for jobs"
          rowEnabled: config.careerOpsDir !== "" && !scanProcess.running
          onClicked: root.runScan()
        }

        Text {
          visible: root.scanStatus !== ""
          width: parent.width
          textFormat: Text.PlainText
          text: root.scanStatus
          color: Qt.darker(root.foreground, 1.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }

        PanelSeparator { foreground: root.foreground }
        PanelSectionHeader { text: "TODAY'S 5"; foreground: root.foreground }

        Column {
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: root.todayPicks
            delegate: JobRow {
              required property var modelData
              width: parent.width
              job: modelData
              applied: (root.today && root.today.applied || []).indexOf(modelData.url) >= 0
              hasResume: !!(root.today && root.today.resumes && root.today.resumes[modelData.url])
              busy: root.resumeBusyUrl === modelData.url
              foreground: root.foreground
              onToggleApplied: store.toggleApplied(modelData.url)
              onGenerateResume: root.generateResume(modelData)
              onOpenPosting: if (root.bar) root.bar.run("xdg-open " + root.bar.shellQuote(modelData.url))
            }
          }

          Text {
            visible: root.todayPicks.length === 0
            width: parent.width
            textFormat: Text.PlainText
            text: config.careerOpsDir ? "No jobs picked yet — scan for jobs above." : ""
            color: Qt.darker(root.foreground, 1.5)
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            horizontalAlignment: Text.AlignHCenter
          }
        }

        Text {
          visible: root.resumeStatus !== ""
          width: parent.width
          textFormat: Text.PlainText
          wrapMode: Text.WordWrap
          text: root.resumeStatus
          color: Qt.darker(root.foreground, 1.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          horizontalAlignment: Text.AlignHCenter
        }

        PanelSeparator { foreground: root.foreground }
        PanelSectionHeader { text: "BADGES"; foreground: root.foreground }

        Flow {
          width: parent.width
          spacing: Style.space(6)

          Repeater {
            model: root.badges
            delegate: BorderSurface {
              required property var modelData
              implicitWidth: badgeText.implicitWidth + Style.space(14)
              implicitHeight: badgeText.implicitHeight + Style.space(8)
              radius: Style.cornerRadius
              color: modelData.achieved ? Util.alpha(root.goodColor, 0.20) : "transparent"
              borderSpec: Border.controlSpec("normal", modelData.achieved ? root.goodColor : Qt.darker(root.foreground, 2.0), root.goodColor)

              Text {
                id: badgeText
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: modelData.label
                color: modelData.achieved ? root.foreground : Qt.darker(root.foreground, 2.0)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                font.bold: modelData.achieved
              }
            }
          }
        }
      }
    }
  }

  // Full-width labeled action button, copied from the transactions widget's
  // local ActionRow (qs.Ui has no plain labeled-button component).
  component ActionRow: BorderSurface {
    id: actionRow
    property string label: ""
    property bool rowEnabled: true
    signal clicked()

    readonly property bool _hot: rowEnabled && mouse.containsMouse

    implicitHeight: Style.space(44)
    implicitWidth: Style.space(240)
    radius: Style.cornerRadius
    color: rowEnabled ? Style.controlFill(false, _hot, Color.accent, Color.accent) : "transparent"
    borderSpec: Border.controlSpec(_hot ? "hover-cursor" : "normal", Color.accent, Color.accent)

    Behavior on color { ColorAnimation { duration: 100 } }

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: actionRow.label
      color: actionRow.rowEnabled ? Color.accent : Qt.darker(root.foreground, 2.0)
      font.family: Style.font.family
      font.pixelSize: Style.font.body
      font.bold: true
    }

    MouseArea {
      id: mouse
      anchors.fill: parent
      enabled: actionRow.rowEnabled
      hoverEnabled: true
      cursorShape: actionRow.rowEnabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: actionRow.clicked()
    }
  }

  // One job row: company/role + status line, with a resume button and an
  // applied toggle pinned to the right edge (PanelActionButton, the same
  // inline-row-action component the first-party panels use).
  component JobRow: BorderSurface {
    id: jobRow
    property var job: null
    property bool applied: false
    property bool hasResume: false
    property bool busy: false
    property color foreground: Color.foreground
    signal toggleApplied()
    signal generateResume()
    signal openPosting()

    implicitHeight: content.implicitHeight + Style.space(14)
    radius: Style.cornerRadius
    color: jobRow.applied ? Util.alpha(root.goodColor, 0.15) : "transparent"
    borderSpec: Border.controlSpec("normal", jobRow.foreground, Color.accent)

    Row {
      anchors.left: parent.left
      anchors.right: actions.left
      anchors.verticalCenter: parent.verticalCenter
      anchors.leftMargin: Style.spacing.rowPaddingX
      anchors.rightMargin: Style.space(8)

      Column {
        id: content
        width: parent.width
        spacing: Style.spacing.xs

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: jobRow.job ? jobRow.job.company : ""
          color: jobRow.foreground
          font.family: Style.font.family
          font.pixelSize: Style.font.subtitle
          font.bold: true
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          width: parent.width
          text: jobRow.job ? jobRow.job.role : ""
          color: Qt.darker(jobRow.foreground, 1.5)
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        MouseArea {
          width: parent.width
          height: Style.space(14)
          cursorShape: Qt.PointingHandCursor
          onClicked: jobRow.openPosting()

          Text {
            textFormat: Text.PlainText
            text: "open posting ↗"
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }
        }
      }
    }

    Row {
      id: actions
      anchors.right: parent.right
      anchors.rightMargin: Style.spacing.rowPaddingX
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(6)

      PanelActionButton {
        iconText: jobRow.busy ? "…" : "📄"
        tooltipText: jobRow.hasResume ? "Resume ready — regenerate" : "Generate resume"
        foreground: jobRow.hasResume ? root.goodColor : jobRow.foreground
        enabled: !jobRow.busy
        onClicked: jobRow.generateResume()
      }

      PanelActionButton {
        iconText: jobRow.applied ? "✅" : "⬜"
        tooltipText: jobRow.applied ? "Applied — click to undo" : "Mark applied"
        foreground: jobRow.applied ? root.goodColor : jobRow.foreground
        onClicked: jobRow.toggleApplied()
      }
    }
  }
}
