# SYS_MONITOR — History Logging & Collector Service

**Date:** 2026-07-01  
**Status:** Approved  
**Scope:** Adds crash-safe session logging, swap metrics, and a History tab to the existing `extension.js`.

---

## Problem

The existing extension shows live CPU and RAM metrics but keeps no record of what resources were available during a VS Code session. When the indexer or Ollama needs headroom, there is no way to know what free capacity is typical across a workday. Additionally, if VS Code crashes, any in-process buffer is lost.

---

## Goals

1. Log system resource headroom (free CPU, free RAM, free swap) to disk every N seconds across the VS Code session.
2. Survive VS Code crashes — no data loss beyond the current poll interval.
3. Track which processes were running during the session, and when they started and ended.
4. Display session history in a new History tab: sparklines, stats table, session log, process activity.
5. Let the user control the log interval (or disable logging) from the UI.

---

## Non-Goals

- GPU metrics (not available via pure Node.js without external deps).
- Log rotation beyond a 7-day prune on session start.
- Windows support for swap (SwapTotal is Linux-only; gracefully returns 0 on other platforms).
- Per-process CPU/RAM history (process lifecycle only — start/end timestamps, not snapshots).

---

## Architecture Overview

```
extension.js activate()
  └── spawn collector.js (node child process)
        ├── stdin  ← commands from extension (setInterval, stop)
        ├── stderr → inherited (VS Code Output)
        └── polls independently every N seconds
              ├── writes metrics records to ~/.sys-monitor-vscode/metrics.jsonl
              └── tracks process lifecycle (proc_start / proc_end)

extension.js _push() [every 2s, unchanged]
  └── postMessage stats to webview (live tab — unchanged)

webview History tab
  └── sends loadHistory { range } → extension reads JSONL → sends historyData back
```

The collector is **fully independent** of the webview render loop. It writes to disk on its own schedule. The extension only reads the file on demand (when the History tab is opened or the range is changed).

---

## Part 1 — Collector Service (`collector.js`)

### File location

`collector.js` in the extension root, alongside `extension.js`. Shipped as part of the extension package.

### Lifecycle

| Event | What happens |
|---|---|
| `activate()` | Extension spawns collector; collector writes `session_start` and starts poll loop |
| Normal shutdown | Extension writes `{"type":"stop"}` to stdin; collector writes `session_end` and exits 0 |
| VS Code crash | stdin `end` event fires; collector writes `session_crash` and exits 0 |
| Collector early exit | Logging stops silently until next VS Code restart; live view unaffected |

### Poll loop

Default interval: 30 seconds (configurable via `setLogInterval` command). On each tick:

1. Collect system metrics (same `/proc/meminfo` + `os.*` approach as `extension.js`).
2. Diff running PIDs against previous snapshot → emit `proc_start` / `proc_end` events.
3. `appendFileSync` one or more JSON lines to the log file.

`appendFileSync` is synchronous and atomic per line — no buffering that could be lost on crash.

### Stdin command protocol

One JSON object per line, written by the extension:

```jsonl
{"type":"setInterval","seconds":60}
{"type":"stop"}
```

The collector reads stdin line-by-line via `readline`. On `setInterval`, it clears and restarts the poll timer. On `stop`, it writes `session_end` and calls `process.exit(0)`.

### Log file location

```
~/.sys-monitor-vscode/metrics.jsonl
```

Directory is created by the collector on first run. File is appended across sessions (no truncation). On each `session_start`, the collector prunes lines with `ts < now - 7_days` by rewriting the file in-place (read all → filter → write). This keeps the file bounded to roughly 7 days of data.

### JSONL record schemas

All records share the field `t` (type) and `ts` (Unix epoch ms).

**`session_start`**
```json
{"t":"session_start","ts":1751400000000,"pid":12345}
```

**`metrics`**
```json
{
  "t":"metrics","ts":1751400030000,
  "cpu_pct":24.8,"cpu_free":75.2,
  "ram_pct":68.4,"ram_used_gb":10.9,"ram_free_gb":5.1,"ram_total_gb":16.0,"ram_cached_gb":2.3,
  "swap_pct":12.0,"swap_used_gb":0.96,"swap_free_gb":7.04,"swap_total_gb":8.0
}
```

**`proc_start`**
```json
{"t":"proc_start","ts":1751400030000,"pid":9876,"name":"ollama"}
```

**`proc_end`**
```json
{"t":"proc_end","ts":1751403630000,"pid":9876,"name":"ollama","duration_ms":3600000}
```

**`session_end`**
```json
{"t":"session_end","ts":1751428800000,"duration_ms":28800000}
```

**`session_crash`**
```json
{"t":"session_crash","ts":1751428800000}
```

### Process lifecycle tracking

On each poll, run `ps -eo pid,comm --no-headers`. Keep an in-memory `Map<pid, { name, startTs }>`. Compare current PID set with previous:

- **New PID:** write `proc_start`, add to map.
- **Gone PID:** write `proc_end` with `duration_ms = now - startTs`, remove from map.
- **Unchanged PIDs:** no record written.

Processes already running when the collector starts are treated as `proc_start` events at session start time (so the session's process log is complete).

### File size estimate

| Interval | Records/session (8h) | Approx size/session |
|---|---|---|
| 30s | ~960 metrics + process events | ~300 KB |
| 1m | ~480 metrics + process events | ~150 KB |
| 5m | ~96 metrics + process events | ~40 KB |

7-day cap keeps the file well under 5 MB at 30s intervals.

---

## Part 2 — `extension.js` Changes

### 2a. Swap added to `collectStats()`

New helper function alongside `getMemCachedBytes()`:

```js
function getSwapBytes() {
    try {
        const raw   = fs.readFileSync('/proc/meminfo', 'utf8');
        const total = raw.match(/^SwapTotal:\s+(\d+)/m);
        const free  = raw.match(/^SwapFree:\s+(\d+)/m);
        const t = total ? parseInt(total[1], 10) * 1024 : 0;
        const f = free  ? parseInt(free[1],  10) * 1024 : 0;
        return { swap_total: t, swap_free: f, swap_used: t - f };
    } catch (e) {
        return { swap_total: 0, swap_free: 0, swap_used: 0 };
    }
}
```

`collectStats()` calls `getSwapBytes()` and appends `swap_total_gb`, `swap_free_gb`, `swap_pct` to its return object. The live webview receives swap data immediately via the existing `_push()` path.

### 2b. Collector spawned in `activate()` / torn down in `deactivate()`

```js
const { spawn } = require('child_process');
const path      = require('path');

let collectorProc = null;  // module-level

// In activate():
const collectorPath = path.join(context.extensionPath, 'collector.js');
collectorProc = spawn(process.execPath, [collectorPath], {
    stdio: ['pipe', 'inherit', 'inherit']
});
collectorProc.on('error', (e) => console.error('[SysMonitor] collector error:', e));

// In deactivate():
if (collectorProc) {
    collectorProc.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
    collectorProc.stdin.end();
    collectorProc = null;
}
```

### 2c. Message handlers added to `resolveWebviewView()`

The existing `webview.onDidReceiveMessage` handler gains three new cases:

**`loadHistory`**
```
1. Read ~/.sys-monitor-vscode/metrics.jsonl (sync, file is small)
2. Split on newlines, JSON.parse each line (skip malformed lines)
3. Filter: ts >= Date.now() - rangeMs  (24h = 86_400_000 ms, 7d = 604_800_000 ms)
4. Partition into records[], sessions[], processes[]
5. postMessage({ type: 'historyData', records, sessions, processes, logInterval })
```

**`setLogInterval`**
```
1. context.globalState.update('logInterval', seconds)
2. if (collectorProc) collectorProc.stdin.write(JSON.stringify({ type: 'setInterval', seconds }) + '\n')
```

**`setRange`** *(new — triggered by range picker clicks)*
```
1. Re-run loadHistory with new range value, post historyData again
```

### Message protocol summary

| Direction | Type | Payload |
|---|---|---|
| webview → ext | `loadHistory` | `{ range: '24h' \| '7d' }` |
| ext → webview | `historyData` | `{ records, sessions, processes, logInterval }` |
| webview → ext | `setLogInterval` | `{ seconds: 0 \| 30 \| 60 \| 300 }` |
| webview → ext | `setRange` | `{ range: '24h' \| '7d' }` |
| ext → collector stdin | (JSON line) | `{ type: 'stop' }` or `{ type: 'setInterval', seconds }` |

---

## Part 3 — Webview History Tab

### Tab bar

A tab strip is added beneath the existing topbar. Two buttons: `LIVE` and `HISTORY`. Clicking `HISTORY` hides the existing `.cols` / alert div and shows `#tab-history`. Clicking `LIVE` reverses this. The `LIVE` tab content requires zero restructuring — it is simply wrapped in a `#tab-live` div.

On `switchTab('history')`: send `loadHistory { range: currentRange }` and show a dimmed `loading…` line until `historyData` arrives (typically <50 ms).

### History tab layout

```
┌─────────────────────────────────────────────────────┐
│  [24h] [7d]          Log interval: [Off][30s][1m][5m]│
├─────────────────────────────────────────────────────┤
│  CPU FREE %    ━━━━━━╌╌╌━━━━━━━━━━━━━━━━━━━━━        │  ← SVG sparkline
│  RAM FREE GB   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        │
│  SWAP FREE GB  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━        │
├─────────────────────────────────────────────────────┤
│              MIN     AVG     MAX                     │
│  CPU free    42%     71%     98%                     │
│  RAM free    3.1 GB  4.8 GB  7.2 GB                  │
│  Swap free   6.1 GB  7.0 GB  8.0 GB                  │
├─────────────────────────────────────────────────────┤
│  Sessions                                           │
│  ▶ 09:01 session_start  →  17:32 session_end (8h)   │
├─────────────────────────────────────────────────────┤
│  ▶ Process activity  (collapsed <details>)          │
│    ollama       3h 12m   09:01–12:13                 │
│    node         7h 01m   09:01–16:02                 │
│    code-server  8h 00m   09:01–17:01                 │
└─────────────────────────────────────────────────────┘
```

### Sparklines

Pure SVG polylines, rendered inline by JS from the `records` array. Each sparkline:

- **X axis:** `ts` mapped linearly to SVG width (full time range).
- **Y axis:** metric value mapped linearly to SVG height (inverted, SVG origin top-left). Free metrics: higher = better.
- **Colour:** `ok` (green) when the final value is above 30%, `warn` (yellow) 15–30%, `crit` (red) below 15% — same CSS variables as the live bars.
- **No axes, no labels** (space is tight in a sidebar). Tooltip on hover showing `value @ time` via a `<title>` element on the polyline.
- If `records.length === 0`: sparkline area shows a centred dimmed text `no data for this range`.

### Stats table

Client-side computation from `records`. Three rows × three columns (min / avg / max). Values formatted the same as the live panel (`fmt()` for GB, `toFixed(1)+'%'` for percentages).

### Session log

Rendered from `sessions` array. Each `session_start` / `session_end` / `session_crash` record shown as a timestamped line. `session_crash` entries shown in `crit` colour. `duration_ms` shown as `Xh Ym` for `session_end` records.

### Process activity

Rendered from `processes` array. `proc_start` and `proc_end` records are paired by `pid`. Grouped by process `name`, summing `duration_ms` across all appearances. Sorted by total duration descending. Wrapped in `<details><summary>Process activity (N processes)</summary>…</details>` so it is collapsed by default.

---

## Files Changed / Added

| File | Change |
|---|---|
| `extension.js` | Add `getSwapBytes()`, extend `collectStats()`, spawn/stop collector, add 3 message handlers |
| `collector.js` | **New file** — crash-safe poll loop, JSONL writer, process lifecycle tracker |

No new npm dependencies. No changes to `package.json`.

---

## Open Questions / Future Work

- Add a swap indicator to the live view's RAM panel (a small `SWAP: X%` line under the RAM bar).
- Consider a VS Code status-bar click shortcut to jump directly to the History tab.
- If swap is always 0 (system has no swap), hide the swap sparkline automatically.
