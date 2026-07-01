# SYS_MONITOR

A lightweight VS Code extension that displays real-time CPU, RAM, and swap usage in a sidebar panel — with crash-safe session logging and a history view.

No npm dependencies. No telemetry. Pure Node.js.

---

## Features

**Live tab**
- CPU usage % with per-core breakdown via top processes
- RAM usage % with process list sorted by memory
- Swap usage (Linux)
- Colour-coded OK / warn / crit thresholds (70% / 90%)
- Alert banner on high load
- Updates every 2 seconds

**History tab**
- SVG sparklines for CPU free %, RAM free GB, Swap free GB over the last 24h or 7d
- Min / avg / max stats table for the selected range
- Session log — when VS Code was opened and closed (or crashed)
- Process activity — which processes ran during the session, duration, first/last seen
- Configurable log interval: Off / 30s / 1m / 5m
- Crash-safe: a background `collector.js` process writes to disk independently of VS Code; data survives a VS Code crash

---

## Installation

1. Clone or download this repo
2. Open the folder in VS Code
3. Press **F5** to launch the Extension Development Host

Or package it:
```bash
npm install -g @vscode/vsce
vsce package
code --install-extension sys-monitor-*.vsix
```

---

## How to use

1. Open the **SYS_MONITOR** panel (bottom panel or sidebar — depends on your VS Code layout)
2. The **LIVE** tab shows current stats, refreshed every 2s
3. Click **HISTORY** to view logged session data
   - Use **24h / 7d** to change the time range
   - Use **Off / 30s / 1m / 5m** to control how often metrics are written to disk
4. Expand **Process Activity** to see which processes ran and for how long

---

## Log file

Session data is written to:

```
~/.sys-monitor-vscode/metrics.jsonl
```

Each line is a JSON record with a `t` (type) field and `ts` (Unix ms timestamp). Record types:

| Type | Description |
|---|---|
| `session_start` | VS Code opened |
| `session_end` | VS Code closed cleanly |
| `session_crash` | VS Code process was killed |
| `metrics` | Snapshot of CPU/RAM/swap free headroom |
| `proc_start` | A process appeared on the system |
| `proc_end` | A process exited (includes `duration_ms`) |

The log is pruned to the last 7 days on each startup.

---

## Requirements

- VS Code 1.80+
- Linux (swap and `/proc/meminfo` reading; CPU/RAM work on any OS)
- Node.js (bundled with VS Code — no separate install needed)
