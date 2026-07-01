# SYS_MONITOR History Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a crash-safe session collector service and a History tab to the SYS_MONITOR VS Code extension.

**Architecture:** A spawned `collector.js` child process polls system metrics every N seconds and appends JSONL records to `~/.sys-monitor-vscode/metrics.jsonl` independently of the VS Code process. The extension reads that file on demand when the History tab is opened and renders sparklines, a stats table, a session log, and process activity in the webview.

**Tech Stack:** Plain Node.js (no npm deps), VS Code Extension API, inline SVG, JSONL.

**Spec:** `docs/superpowers/specs/2026-07-01-history-logging-design.md`

## Global Constraints

- No npm dependencies — Node.js stdlib only (`fs`, `os`, `child_process`, `path`, `readline`)
- Plain JavaScript — no TypeScript, no build step
- VS Code engine `^1.80.0`
- `/proc/meminfo` is Linux-only — `getSwapBytes()` must return zeros silently on non-Linux
- Log file path: `~/.sys-monitor-vscode/metrics.jsonl`; directory created on first run
- All JSONL records must have fields `t` (string type key) and `ts` (Unix epoch ms, integer)
- 7-day prune runs once on each `session_start` — rewrite file, keep only records with `ts >= now - 604_800_000`
- Default log interval: 30 seconds

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `collector.js` | **Create** | Standalone crash-safe poll loop; owns all disk writes |
| `extension.js` | **Modify** | Swap metric, spawn/stop collector, three new message handlers, History tab HTML |

---

## Task 1 — `collector.js`: metrics loop, lifecycle markers, stdin commands

**Files:**
- Create: `collector.js`

**Interfaces:**
- Produces: `~/.sys-monitor-vscode/metrics.jsonl` populated with `session_start`, `metrics`, `session_end`, `session_crash` records
- Produces: stdin command protocol — accepts `{"type":"stop"}` and `{"type":"setInterval","seconds":N}` (consumed by Task 2)

- [ ] **Step 1: Write a manual test script to verify output before implementing**

Create `test_collector_output.js` in the extension root:

```js
// Run: node test_collector_output.js
// Expected: prints session_start, then 2 metrics records 2s apart, then session_end
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const logPath = require('path').join(os.homedir(), '.sys-monitor-vscode', 'metrics.jsonl');

// Clean up any previous run
try { fs.unlinkSync(logPath); } catch (_) {}

const child = spawn(process.execPath, ['collector.js'], {
    stdio: ['pipe', 'inherit', 'inherit']
});

// Let it run for 5s at 2s interval then stop
setTimeout(() => {
    child.stdin.write(JSON.stringify({ type: 'setInterval', seconds: 2 }) + '\n');
}, 100);

setTimeout(() => {
    child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
    child.stdin.end();
}, 5500);

child.on('exit', () => {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    console.log('Records written:', lines.length);
    console.log('Types:', lines.map(l => l.t));
    const ok = lines[0].t === 'session_start'
        && lines[lines.length - 1].t === 'session_end'
        && lines.filter(l => l.t === 'metrics').length >= 2;
    console.log(ok ? '✓ PASS' : '✗ FAIL');
});
```

- [ ] **Step 2: Run the test — expect FAIL (collector.js does not exist)**

```bash
cd /home/dieter/Desktop/help_programs/sys-monitor-vscode
node test_collector_output.js
```

Expected: `Error: Cannot find module './collector.js'` or similar crash.

- [ ] **Step 3: Create `collector.js`**

```js
'use strict';

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const readline = require('readline');

const LOG_DIR  = path.join(os.homedir(), '.sys-monitor-vscode');
const LOG_FILE = path.join(LOG_DIR, 'metrics.jsonl');
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─── File helpers ─────────────────────────────────────────────────────────────

function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function appendRecord(obj) {
    fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n', 'utf8');
}

function pruneOldRecords() {
    if (!fs.existsSync(LOG_FILE)) return;
    const cutoff = Date.now() - SEVEN_DAYS_MS;
    const lines  = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean);
    const kept   = lines.filter(line => {
        try { return JSON.parse(line).ts >= cutoff; } catch (_) { return false; }
    });
    fs.writeFileSync(LOG_FILE, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
}

// ─── Metrics collection ───────────────────────────────────────────────────────

let prevCpuTimes = null;

function getCpuFree() {
    const cpus = os.cpus();
    if (!prevCpuTimes) {
        prevCpuTimes = cpus.map(c => ({ ...c.times }));
        return { cpu_pct: 0, cpu_free: 100 };
    }
    const perCore = cpus.map((cpu, i) => {
        const curr  = cpu.times;
        const prev  = prevCpuTimes[i] || curr;
        const total = (curr.user + curr.nice + curr.sys + curr.idle + curr.irq)
                    - (prev.user + prev.nice + prev.sys + prev.idle + prev.irq);
        const idle  = curr.idle - prev.idle;
        return total === 0 ? 0 : Math.min(100, Math.max(0, ((total - idle) / total) * 100));
    });
    prevCpuTimes = cpus.map(c => ({ ...c.times }));
    const cpu_pct = perCore.reduce((a, b) => a + b, 0) / (perCore.length || 1);
    return { cpu_pct: +cpu_pct.toFixed(2), cpu_free: +(100 - cpu_pct).toFixed(2) };
}

function getSwapBytes() {
    try {
        const raw   = fs.readFileSync('/proc/meminfo', 'utf8');
        const total = raw.match(/^SwapTotal:\s+(\d+)/m);
        const free  = raw.match(/^SwapFree:\s+(\d+)/m);
        const t = total ? parseInt(total[1], 10) * 1024 : 0;
        const f = free  ? parseInt(free[1],  10) * 1024 : 0;
        return { swap_total: t, swap_free: f, swap_used: t - f };
    } catch (_) {
        return { swap_total: 0, swap_free: 0, swap_used: 0 };
    }
}

function getMemCachedBytes() {
    try {
        const raw   = fs.readFileSync('/proc/meminfo', 'utf8');
        const match = raw.match(/^Cached:\s+(\d+)/m);
        return match ? parseInt(match[1], 10) * 1024 : 0;
    } catch (_) { return 0; }
}

function collectMetrics() {
    const { cpu_pct, cpu_free } = getCpuFree();
    const totalMem  = os.totalmem();
    const freeMem   = os.freemem();
    const usedMem   = totalMem - freeMem;
    const cachedMem = getMemCachedBytes();
    const ram_pct   = +((usedMem / totalMem) * 100).toFixed(2);
    const { swap_total, swap_free, swap_used } = getSwapBytes();
    const swap_pct  = swap_total > 0 ? +((swap_used / swap_total) * 100).toFixed(2) : 0;

    return {
        t:            'metrics',
        ts:           Date.now(),
        cpu_pct,
        cpu_free,
        ram_pct,
        ram_used_gb:  +(usedMem   / 1e9).toFixed(3),
        ram_free_gb:  +(freeMem   / 1e9).toFixed(3),
        ram_total_gb: +(totalMem  / 1e9).toFixed(3),
        ram_cached_gb:+(cachedMem / 1e9).toFixed(3),
        swap_pct,
        swap_used_gb: +(swap_used  / 1e9).toFixed(3),
        swap_free_gb: +(swap_free  / 1e9).toFixed(3),
        swap_total_gb:+(swap_total / 1e9).toFixed(3),
    };
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

let pollInterval = 30;
let timer        = null;
const sessionStart = Date.now();

function startTimer() {
    if (timer) clearInterval(timer);
    timer = setInterval(poll, pollInterval * 1000);
}

function poll() {
    appendRecord(collectMetrics());
    trackProcesses();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function shutdown(type) {
    if (timer) clearInterval(timer);
    appendRecord({ t: type, ts: Date.now(), duration_ms: Date.now() - sessionStart });
    process.exit(0);
}

// ─── Process lifecycle tracking (stub — filled in Task 2) ─────────────────────

function trackProcesses() { /* Task 2 */ }

// ─── Stdin command handler ────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', line => {
    try {
        const cmd = JSON.parse(line);
        if (cmd.type === 'stop') shutdown('session_end');
        if (cmd.type === 'setInterval' && Number.isFinite(cmd.seconds) && cmd.seconds > 0) {
            pollInterval = cmd.seconds;
            startTimer();
        }
    } catch (_) {}
});

rl.on('close', () => shutdown('session_crash'));

// ─── Boot ─────────────────────────────────────────────────────────────────────

ensureDir();
pruneOldRecords();
getCpuFree(); // prime CPU snapshot so first real poll has a valid diff
appendRecord({ t: 'session_start', ts: Date.now(), pid: process.pid });
startTimer();
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
node test_collector_output.js
```

Expected output:
```
Records written: 4
Types: [ 'session_start', 'metrics', 'metrics', 'session_end' ]
✓ PASS
```

(Exact metrics count may vary by ±1 depending on timing.)

- [ ] **Step 5: Commit**

```bash
git add collector.js test_collector_output.js
git commit -m "feat: add collector.js — crash-safe JSONL metrics writer"
```

---

## Task 2 — `collector.js`: process lifecycle tracking

**Files:**
- Modify: `collector.js` — replace `trackProcesses()` stub with full implementation

**Interfaces:**
- Consumes: `appendRecord()` from Task 1
- Produces: `proc_start` and `proc_end` records in the JSONL log (consumed by the webview in Task 5)

- [ ] **Step 1: Write a manual test script for process tracking**

Create `test_process_tracking.js`:

```js
// Run: node test_process_tracking.js
// Expected: proc_start records for current processes, then proc_end when a short-lived process ends
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const logPath = require('path').join(os.homedir(), '.sys-monitor-vscode', 'metrics.jsonl');

try { fs.unlinkSync(logPath); } catch (_) {}

const child = spawn(process.execPath, ['collector.js'], {
    stdio: ['pipe', 'inherit', 'inherit']
});

// Fast interval so we see process changes quickly
setTimeout(() => {
    child.stdin.write(JSON.stringify({ type: 'setInterval', seconds: 2 }) + '\n');
}, 100);

// Stop after enough time for 3 polls
setTimeout(() => {
    child.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
    child.stdin.end();
}, 7000);

child.on('exit', () => {
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const procStarts = lines.filter(l => l.t === 'proc_start');
    const procEnds   = lines.filter(l => l.t === 'proc_end');
    console.log('proc_start records:', procStarts.length);
    console.log('proc_end records:', procEnds.length);
    const ok = procStarts.length > 0
        && procStarts.every(r => r.pid && r.name && r.ts);
    console.log(ok ? '✓ PASS' : '✗ FAIL');
});
```

- [ ] **Step 2: Run — expect PASS with 0 proc_start (stub returns nothing)**

```bash
node test_process_tracking.js
```

Expected: `proc_start records: 0` — confirms the stub is wired but empty.

- [ ] **Step 3: Replace the `trackProcesses` stub in `collector.js`**

Replace the entire `trackProcesses` function and add the supporting state above it:

```js
// ─── Process lifecycle tracking ───────────────────────────────────────────────

// Map of pid (string) → { name, startTs }
const runningProcs = new Map();

function getRunningPids() {
    try {
        const { execSync } = require('child_process');
        const raw = execSync('ps -eo pid,comm --no-headers 2>/dev/null', {
            encoding: 'utf8',
            timeout: 1500,
        });
        return raw.trim().split('\n').map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 2) return null;
            return { pid: parts[0], name: parts.slice(1).join(' ').substring(0, 32) };
        }).filter(Boolean);
    } catch (_) {
        return [];
    }
}

function trackProcesses() {
    const now     = Date.now();
    const current = getRunningPids();
    const currentPids = new Set(current.map(p => p.pid));

    // New processes
    for (const { pid, name } of current) {
        if (!runningProcs.has(pid)) {
            runningProcs.set(pid, { name, startTs: now });
            appendRecord({ t: 'proc_start', ts: now, pid: +pid, name });
        }
    }

    // Ended processes
    for (const [pid, { name, startTs }] of runningProcs) {
        if (!currentPids.has(pid)) {
            appendRecord({ t: 'proc_end', ts: now, pid: +pid, name, duration_ms: now - startTs });
            runningProcs.delete(pid);
        }
    }
}

// Seed runningProcs from current state at startup so they appear as proc_start at session start
function seedInitialProcesses() {
    const now  = Date.now();
    for (const { pid, name } of getRunningPids()) {
        runningProcs.set(pid, { name, startTs: now });
        appendRecord({ t: 'proc_start', ts: now, pid: +pid, name });
    }
}
```

Also update the Boot section to call `seedInitialProcesses()` after `session_start`:

```js
// ─── Boot ─────────────────────────────────────────────────────────────────────

ensureDir();
pruneOldRecords();
getCpuFree();
appendRecord({ t: 'session_start', ts: Date.now(), pid: process.pid });
seedInitialProcesses();  // ← add this line
startTimer();
```

- [ ] **Step 4: Run the process tracking test — expect PASS**

```bash
node test_process_tracking.js
```

Expected:
```
proc_start records: 50+   (all processes running at seed time)
proc_end records: 0+      (any that ended during the 7s run)
✓ PASS
```

- [ ] **Step 5: Commit**

```bash
git add collector.js test_process_tracking.js
git commit -m "feat: add process lifecycle tracking to collector.js"
```

---

## Task 3 — `extension.js`: swap metric + collector spawn/stop

**Files:**
- Modify: `extension.js` — add `getSwapBytes()`, extend `collectStats()`, spawn/stop collector

**Interfaces:**
- Consumes: `collector.js` from Tasks 1–2 (spawned as child process)
- Produces: `collectStats()` now returns `swap_total_gb`, `swap_free_gb`, `swap_pct` (consumed by the live webview immediately via existing `_push()`)
- Produces: module-level `collectorProc` (consumed by Task 4's message handlers via `collectorProc.stdin.write`)

- [ ] **Step 1: Add `getSwapBytes()` after `getMemCachedBytes()` in `extension.js`**

Insert after the closing brace of `getMemCachedBytes()` (after line 53):

```js
function getSwapBytes() {
    try {
        const raw   = fs.readFileSync('/proc/meminfo', 'utf8');
        const total = raw.match(/^SwapTotal:\s+(\d+)/m);
        const free  = raw.match(/^SwapFree:\s+(\d+)/m);
        const t = total ? parseInt(total[1], 10) * 1024 : 0;
        const f = free  ? parseInt(free[1],  10) * 1024 : 0;
        return { swap_total: t, swap_free: f, swap_used: t - f };
    } catch (_) {
        return { swap_total: 0, swap_free: 0, swap_used: 0 };
    }
}
```

- [ ] **Step 2: Extend `collectStats()` to include swap fields**

In `collectStats()`, after the `cachedMem` line (around line 83), add:

```js
const { swap_total, swap_free, swap_used } = getSwapBytes();
const swap_pct = swap_total > 0 ? (swap_used / swap_total) * 100 : 0;
```

Then add these fields to the returned object (after `ram_cached`):

```js
swap_total_gb: swap_total / 1e9,
swap_free_gb:  swap_free  / 1e9,
swap_pct:      swap_pct,
```

- [ ] **Step 3: Add `require` statements and module-level `collectorProc` at the top of `extension.js`**

After the existing `require` lines (after line 6), add:

```js
const { spawn } = require('child_process');
const path      = require('path');

let collectorProc = null;
```

- [ ] **Step 4: Spawn the collector in `activate()`**

Add at the end of the `activate()` function, before the closing brace:

```js
    const collectorPath = path.join(context.extensionPath, 'collector.js');
    collectorProc = spawn(process.execPath, [collectorPath], {
        stdio: ['pipe', 'inherit', 'inherit'],
    });
    collectorProc.on('error', e => console.error('[SysMonitor] collector error:', e.message));
    collectorProc.on('exit',  c => console.log('[SysMonitor] collector exited with code', c));
```

- [ ] **Step 5: Stop the collector in `deactivate()`**

Replace the empty `function deactivate() {}` with:

```js
function deactivate() {
    if (collectorProc) {
        try {
            collectorProc.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
            collectorProc.stdin.end();
        } catch (_) {}
        collectorProc = null;
    }
}
```

- [ ] **Step 6: Verify in VS Code Extension Development Host**

Open the extension folder in VS Code and press **F5** to launch the Extension Development Host.

1. Open the SYS_MONITOR panel — the live view should still work as before.
2. Open a terminal in the dev host and run:
   ```bash
   tail -f ~/.sys-monitor-vscode/metrics.jsonl
   ```
3. Confirm you see a `session_start` record immediately, then `metrics` records every 30s, then `proc_start` records.
4. Close the Extension Development Host window — confirm a `session_end` record appears.

- [ ] **Step 7: Commit**

```bash
git add extension.js
git commit -m "feat: add swap metric and spawn collector service in extension.js"
```

---

## Task 4 — `extension.js`: message handlers for History tab

**Files:**
- Modify: `extension.js` — add `loadHistory`, `setLogInterval`, `setRange` message handlers inside `resolveWebviewView()`

**Interfaces:**
- Consumes: `collectorProc` from Task 3 (writes `setInterval` command to its stdin)
- Consumes: `~/.sys-monitor-vscode/metrics.jsonl` (reads and parses on `loadHistory`)
- Produces: `historyData` message to webview — `{ records, sessions, processes, logInterval }` (consumed by Task 5)
- Produces: `setLogInterval` message stored in `context.globalState` key `'logInterval'`

- [ ] **Step 1: Add the message handlers**

Inside `resolveWebviewView()`, the existing `webviewView.webview.onDidReceiveMessage` is not present yet — `_push()` is one-way. Add a new handler block after `this._startPolling()`:

```js
        // ── History tab message handlers ──────────────────────────────────────
        webviewView.webview.onDidReceiveMessage(msg => {
            if (msg.type === 'loadHistory' || msg.type === 'setRange') {
                const rangeMs = msg.range === '7d' ? 7 * 24 * 3600 * 1000 : 24 * 3600 * 1000;
                const cutoff  = Date.now() - rangeMs;
                const logFile = require('path').join(require('os').homedir(), '.sys-monitor-vscode', 'metrics.jsonl');
                let records = [], sessions = [], processes = [];
                try {
                    const lines = require('fs').readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
                    for (const line of lines) {
                        try {
                            const r = JSON.parse(line);
                            if (r.ts < cutoff) continue;
                            if (r.t === 'metrics')                           records.push(r);
                            else if (r.t.startsWith('session_'))             sessions.push(r);
                            else if (r.t === 'proc_start' || r.t === 'proc_end') processes.push(r);
                        } catch (_) {}
                    }
                } catch (_) {}
                const logInterval = context.globalState.get('logInterval', 30);
                webviewView.webview.postMessage({ type: 'historyData', records, sessions, processes, logInterval });
            }

            if (msg.type === 'setLogInterval') {
                const seconds = msg.seconds;
                context.globalState.update('logInterval', seconds);
                if (collectorProc && seconds > 0) {
                    try {
                        collectorProc.stdin.write(JSON.stringify({ type: 'setInterval', seconds }) + '\n');
                    } catch (_) {}
                }
            }
        });
```

- [ ] **Step 2: Verify in Extension Development Host**

Open VS Code developer tools (Help → Toggle Developer Tools) in the Extension Development Host. In the Console, run:

```js
// In the webview console — accessible via right-clicking the panel → Inspect Element
window.postMessage({ type: 'historyData', records: [], sessions: [], processes: [], logInterval: 30 }, '*');
```

At this stage the webview has no handler yet, so nothing visible happens — but no errors should appear in the extension host output panel. The handler will be exercised in Task 5.

- [ ] **Step 3: Commit**

```bash
git add extension.js
git commit -m "feat: add loadHistory / setLogInterval message handlers"
```

---

## Task 5 — Webview: History tab HTML, CSS, JS

This task modifies `_buildHtml()` to add the tab bar, the History tab content, all associated CSS, and all History rendering JS. It is the largest single task.

**Files:**
- Modify: `extension.js` — the `_buildHtml()` method

**Interfaces:**
- Consumes: `historyData` message from Task 4 — `{ records, sessions, processes, logInterval }`
- Consumes: `stats` message (existing) — no changes to existing live-tab rendering
- Produces: rendered History tab visible to user

- [ ] **Step 1: Wrap the existing live-tab content and add the tab bar**

In `_buildHtml()`, find the opening of `<div class="wrap">` and make these two changes:

**a)** After the `.topbar` closing `</div>`, insert the tab bar:

```html
  <!-- Tab bar -->
  <div class="tabs">
    <button class="tab-btn active" id="btn-live"    onclick="switchTab('live')">LIVE</button>
    <button class="tab-btn"        id="btn-history" onclick="switchTab('history')">HISTORY</button>
  </div>
```

**b)** Wrap the two `.cols` columns and the `.alert` div in a `#tab-live` div:

```html
  <!-- Live tab -->
  <div id="tab-live">
    <!-- existing <div class="cols"> … </div> -->
    <!-- existing <div class="alert" …>  </div> -->
  </div>
```

**c)** Add tab bar CSS to the `<style>` block:

```css
  /* ── Tab bar ── */
  .tabs {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.07));
  }

  .tab-btn {
    background: none;
    border: none;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.45));
    font-family: var(--vscode-font-family, monospace);
    font-size: 9px;
    letter-spacing: 0.14em;
    cursor: pointer;
    padding: 2px 8px;
    border-radius: 2px;
  }

  .tab-btn.active {
    color: var(--vscode-foreground, #c0c8e0);
    background: var(--vscode-editor-background, rgba(0,0,0,0.18));
  }
```

- [ ] **Step 2: Add the History tab HTML div (after `#tab-live`)**

```html
  <!-- History tab -->
  <div id="tab-history" style="display:none; flex:1; display:none; flex-direction:column; gap:8px; overflow-y:auto; min-height:0;">

    <!-- Controls -->
    <div class="h-controls">
      <div class="h-range">
        <button class="h-btn active" id="range-24h" onclick="setRange('24h')">24h</button>
        <button class="h-btn"        id="range-7d"  onclick="setRange('7d')">7d</button>
      </div>
      <div class="h-interval">
        <span class="ptitle" style="margin-right:4px">LOG</span>
        <button class="h-btn" id="li-0"   onclick="setLogInterval(0)">Off</button>
        <button class="h-btn" id="li-30"  onclick="setLogInterval(30)">30s</button>
        <button class="h-btn active" id="li-60"  onclick="setLogInterval(60)">1m</button>
        <button class="h-btn" id="li-300" onclick="setLogInterval(300)">5m</button>
      </div>
    </div>

    <!-- Sparklines -->
    <div class="spark-section">
      <div class="spark-row">
        <span class="spark-label">CPU FREE %</span>
        <svg id="spark-cpu" class="sparkline" viewBox="0 0 280 36" preserveAspectRatio="none"></svg>
      </div>
      <div class="spark-row">
        <span class="spark-label">RAM FREE GB</span>
        <svg id="spark-ram" class="sparkline" viewBox="0 0 280 36" preserveAspectRatio="none"></svg>
      </div>
      <div class="spark-row">
        <span class="spark-label">SWAP FREE</span>
        <svg id="spark-swap" class="sparkline" viewBox="0 0 280 36" preserveAspectRatio="none"></svg>
      </div>
      <div id="h-nodata" style="display:none; font-size:10px; color:var(--vscode-descriptionForeground); text-align:center; padding:12px 0;">
        no data collected yet
      </div>
    </div>

    <!-- Stats table -->
    <table class="h-stats" id="h-stats">
      <thead><tr><th></th><th>MIN</th><th>AVG</th><th>MAX</th></tr></thead>
      <tbody>
        <tr id="stat-cpu"><td class="ptitle">CPU free</td><td>–</td><td>–</td><td>–</td></tr>
        <tr id="stat-ram"><td class="ptitle">RAM free</td><td>–</td><td>–</td><td>–</td></tr>
        <tr id="stat-swap"><td class="ptitle">Swap free</td><td>–</td><td>–</td><td>–</td></tr>
      </tbody>
    </table>

    <!-- Session log -->
    <div class="h-section-title">SESSIONS</div>
    <div id="h-sessions" class="h-log"></div>

    <!-- Process activity -->
    <details id="h-procs-details">
      <summary class="h-section-title" style="cursor:pointer">PROCESS ACTIVITY</summary>
      <div id="h-procs" class="h-log"></div>
    </details>

    <!-- Loading state -->
    <div id="h-loading" style="font-size:10px; color:var(--vscode-descriptionForeground); text-align:center; padding:12px;">
      loading…
    </div>
  </div>
```

**c)** Add History tab CSS to the `<style>` block:

```css
  /* ── History tab ── */
  #tab-history { flex: 1; min-height: 0; }

  .h-controls {
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .h-range, .h-interval { display: flex; align-items: center; gap: 3px; }

  .h-btn {
    background: none;
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.08));
    border-radius: 2px;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.5));
    font-family: var(--vscode-font-family, monospace);
    font-size: 9px;
    letter-spacing: 0.1em;
    cursor: pointer;
    padding: 2px 6px;
  }

  .h-btn.active {
    color: var(--vscode-foreground, #c0c8e0);
    border-color: var(--vscode-focusBorder, rgba(150,175,220,0.4));
    background: var(--vscode-editor-background, rgba(0,0,0,0.18));
  }

  .spark-section { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }

  .spark-row { display: flex; align-items: center; gap: 8px; }

  .spark-label {
    font-size: 8px;
    letter-spacing: 0.12em;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.4));
    width: 70px;
    flex-shrink: 0;
    text-transform: uppercase;
  }

  .sparkline { flex: 1; height: 36px; overflow: visible; }

  .spark-ok   { color: var(--vscode-charts-green,  #6aaa6a); }
  .spark-warn { color: var(--vscode-charts-yellow, #b89040); }
  .spark-crit { color: var(--vscode-charts-red,    #b85555); }

  .h-stats {
    width: 100%;
    border-collapse: collapse;
    font-size: 10px;
    flex-shrink: 0;
  }

  .h-stats th, .h-stats td {
    text-align: right;
    padding: 2px 6px;
    color: var(--vscode-foreground, #c0c8e0);
  }

  .h-stats th { color: var(--vscode-descriptionForeground, rgba(192,200,232,0.45)); font-weight: normal; }
  .h-stats td:first-child { text-align: left; }

  .h-section-title {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.45));
    flex-shrink: 0;
    margin-top: 4px;
  }

  .h-log {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 10px;
    flex-shrink: 0;
  }

  .h-log-row {
    display: flex;
    gap: 8px;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.55));
  }

  .h-log-row .ts { color: var(--vscode-descriptionForeground, rgba(192,200,232,0.35)); min-width: 45px; }
  .h-log-row.crit { color: var(--vscode-charts-red, #b85555); }
  .h-log-row .dur { margin-left: auto; }
```

- [ ] **Step 3: Add the History tab JS to the `<script>` block**

Add after the existing `window.addEventListener('message', ...)` handler:

```js
  // ── Tab switching ──────────────────────────────────────────────────────────
  var vscode = acquireVsCodeApi();
  var currentRange = '24h';

  function switchTab(name) {
    document.getElementById('tab-live').style.display    = name === 'live'    ? '' : 'none';
    document.getElementById('tab-history').style.display = name === 'history' ? 'flex' : 'none';
    document.getElementById('btn-live').classList.toggle('active',    name === 'live');
    document.getElementById('btn-history').classList.toggle('active', name === 'history');
    if (name === 'history') {
      document.getElementById('h-loading').style.display = 'block';
      vscode.postMessage({ type: 'loadHistory', range: currentRange });
    }
  }

  function setRange(r) {
    currentRange = r;
    ['24h','7d'].forEach(function(id) {
      document.getElementById('range-' + id).classList.toggle('active', id === r);
    });
    vscode.postMessage({ type: 'setRange', range: r });
  }

  function setLogInterval(s) {
    [0, 30, 60, 300].forEach(function(v) {
      var el = document.getElementById('li-' + v);
      if (el) el.classList.toggle('active', v === s);
    });
    vscode.postMessage({ type: 'setLogInterval', seconds: s });
  }

  // ── History rendering ──────────────────────────────────────────────────────
  function fmtTs(ts) {
    var d = new Date(ts);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  }

  function fmtDur(ms) {
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
  }

  function computeStats(records, fn) {
    if (!records.length) return { min: null, avg: null, max: null };
    var vals = records.map(fn);
    var sum  = vals.reduce(function(a, b) { return a + b; }, 0);
    return { min: Math.min.apply(null, vals), avg: sum / vals.length, max: Math.max.apply(null, vals) };
  }

  function renderSparkline(svgId, records, valueFn, maxVal, colorClass) {
    var svg = document.getElementById(svgId);
    if (!svg) return;
    if (!records.length) { svg.innerHTML = ''; return; }
    var W = 280, H = 36;
    var minTs = records[0].ts, maxTs = records[records.length - 1].ts;
    var tsSpan = maxTs - minTs || 1;
    var pts = records.map(function(r) {
      var x = ((r.ts - minTs) / tsSpan) * W;
      var y = H - Math.min(valueFn(r), maxVal) / maxVal * H;
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var finalVal = valueFn(records[records.length - 1]);
    var pct = (finalVal / maxVal) * 100;
    var cls = pct < 15 ? 'spark-crit' : pct < 30 ? 'spark-warn' : 'spark-ok';
    svg.innerHTML = '<polyline points="' + pts + '" fill="none" stroke="currentColor" stroke-width="1.5" class="' + cls + '"/>';
  }

  function renderStatsRow(rowId, stats, fmtFn) {
    var row = document.getElementById(rowId);
    if (!row || stats.min === null) return;
    var tds = row.querySelectorAll('td');
    tds[1].textContent = fmtFn(stats.min);
    tds[2].textContent = fmtFn(stats.avg);
    tds[3].textContent = fmtFn(stats.max);
  }

  function renderSessions(sessions) {
    var el = document.getElementById('h-sessions');
    if (!el) return;
    el.innerHTML = '';
    sessions.forEach(function(r) {
      var row = document.createElement('div');
      row.className = 'h-log-row' + (r.t === 'session_crash' ? ' crit' : '');
      var label = r.t === 'session_start' ? 'started'
                : r.t === 'session_end'   ? 'ended'
                : 'CRASH';
      var dur = r.duration_ms ? '<span class="dur">' + fmtDur(r.duration_ms) + '</span>' : '';
      row.innerHTML = '<span class="ts">' + fmtTs(r.ts) + '</span><span>' + label + '</span>' + dur;
      el.appendChild(row);
    });
    if (!sessions.length) el.textContent = 'no sessions in this range';
  }

  function renderProcessActivity(processes) {
    var el = document.getElementById('h-procs');
    if (!el) return;

    // Pair proc_start / proc_end by pid; accumulate by name
    var starts = {}, byName = {};
    processes.forEach(function(r) {
      if (r.t === 'proc_start') {
        starts[r.pid] = r;
        if (!byName[r.name]) byName[r.name] = { name: r.name, totalMs: 0, first: r.ts, last: r.ts };
      } else if (r.t === 'proc_end') {
        if (!byName[r.name]) byName[r.name] = { name: r.name, totalMs: 0, first: r.ts, last: r.ts };
        byName[r.name].totalMs += r.duration_ms || 0;
        byName[r.name].last = Math.max(byName[r.name].last, r.ts);
        delete starts[r.pid];
      }
    });
    // Still-running: count from first seen to "now"
    var now = Date.now();
    Object.keys(starts).forEach(function(pid) {
      var s = starts[pid];
      if (!byName[s.name]) byName[s.name] = { name: s.name, totalMs: 0, first: s.ts, last: now };
      byName[s.name].totalMs += now - s.ts;
      byName[s.name].last = Math.max(byName[s.name].last, now);
    });

    var sorted = Object.values(byName).sort(function(a, b) { return b.totalMs - a.totalMs; });
    el.innerHTML = '';
    sorted.slice(0, 20).forEach(function(p) {
      var row = document.createElement('div');
      row.className = 'h-log-row';
      row.innerHTML =
        '<span class="proc-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + p.name + '</span>' +
        '<span class="dur">' + fmtDur(p.totalMs) + '</span>' +
        '<span class="ts" style="margin-left:8px">' + fmtTs(p.first) + '–' + fmtTs(p.last) + '</span>';
      el.appendChild(row);
    });
    var details = document.getElementById('h-procs-details');
    if (details) details.querySelector('summary').textContent = 'PROCESS ACTIVITY (' + sorted.length + ')';
    if (!sorted.length) el.textContent = 'no process data in this range';
  }

  // Handle historyData message
  window.addEventListener('message', function(e) {
    if (e.data.type === 'stats') { updateAll(e.data.data); return; }  // existing handler

    if (e.data.type === 'historyData') {
      var d = e.data;
      document.getElementById('h-loading').style.display = 'none';

      var hasData = d.records.length > 0;
      document.getElementById('h-nodata').style.display    = hasData ? 'none'  : 'block';
      document.getElementById('spark-cpu').style.display   = hasData ? ''      : 'none';
      document.getElementById('spark-ram').style.display   = hasData ? ''      : 'none';
      document.getElementById('spark-swap').style.display  = hasData ? ''      : 'none';
      document.getElementById('h-stats').style.display     = hasData ? ''      : 'none';

      // Sparklines
      var maxRam  = d.records.length ? Math.max.apply(null, d.records.map(function(r){ return r.ram_total_gb; })) : 16;
      var maxSwap = d.records.length ? Math.max.apply(null, d.records.map(function(r){ return r.swap_total_gb; })) || 8 : 8;
      renderSparkline('spark-cpu',  d.records, function(r){ return r.cpu_free; },      100,    'spark-ok');
      renderSparkline('spark-ram',  d.records, function(r){ return r.ram_free_gb; },   maxRam, 'spark-ok');
      renderSparkline('spark-swap', d.records, function(r){ return r.swap_free_gb; },  maxSwap,'spark-ok');

      // Stats table
      var cpuStats  = computeStats(d.records, function(r){ return r.cpu_free; });
      var ramStats  = computeStats(d.records, function(r){ return r.ram_free_gb; });
      var swapStats = computeStats(d.records, function(r){ return r.swap_free_gb; });
      renderStatsRow('stat-cpu',  cpuStats,  function(v){ return v.toFixed(1) + '%'; });
      renderStatsRow('stat-ram',  ramStats,  function(v){ return v.toFixed(1) + ' GB'; });
      renderStatsRow('stat-swap', swapStats, function(v){ return v.toFixed(1) + ' GB'; });

      // Session log & process activity
      renderSessions(d.sessions);
      renderProcessActivity(d.processes);

      // Reflect active log interval
      var li = d.logInterval || 0;
      [0, 30, 60, 300].forEach(function(v) {
        var el = document.getElementById('li-' + v);
        if (el) el.classList.toggle('active', v === li);
      });
    }
  });
```

- [ ] **Step 4: Remove the duplicate `window.addEventListener('message', ...)` call**

The existing handler at the bottom of the `<script>` block handles `stats`. The new handler above now also handles `stats` via the `if (e.data.type === 'stats')` branch. Remove the old standalone handler to avoid double-processing:

Find and delete:
```js
  window.addEventListener('message', function(e) {
    if (e.data.type === 'stats') updateAll(e.data.data);
  });
```

- [ ] **Step 5: Verify the full feature in Extension Development Host**

Press **F5** to launch the Extension Development Host.

1. Open the SYS_MONITOR panel — confirm `LIVE | HISTORY` tab bar appears.
2. `LIVE` tab: confirm existing CPU/RAM panels still update every 2s.
3. Click `HISTORY` — confirm `loading…` appears briefly then disappears.
4. If the collector has been running for at least 30s, sparklines should render.
5. If less than 30s of data: confirm `no data collected yet` message appears correctly.
6. Click `7d` range button — confirm it highlights and re-fetches.
7. Click `1m` log interval — confirm the button highlights; check that `~/.sys-monitor-vscode/metrics.jsonl` continues to receive records at roughly 60s intervals.
8. Expand `PROCESS ACTIVITY` — confirm processes are listed with durations.
9. Close the dev host window — confirm a `session_end` record appears in the log file.

- [ ] **Step 6: Commit**

```bash
git add extension.js
git commit -m "feat: add History tab with sparklines, stats table, and process activity"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|---|---|
| Swap metric in `collectStats()` | Task 3 |
| Collector spawned from `activate()`, stopped in `deactivate()` | Task 3 |
| Crash safety via stdin-close detection | Task 1 |
| `session_start` / `session_end` / `session_crash` records | Task 1 |
| `metrics` records with cpu_free, ram_free, swap_free | Task 1 |
| Process lifecycle tracking (`proc_start` / `proc_end`) | Task 2 |
| Seed initial processes at session start | Task 2 |
| 7-day prune on session start | Task 1 |
| `loadHistory` / `setLogInterval` / `setRange` message handlers | Task 4 |
| Tab bar with LIVE and HISTORY tabs | Task 5 |
| SVG sparklines for CPU free, RAM free, Swap free | Task 5 |
| Stats table (min/avg/max) | Task 5 |
| Session log | Task 5 |
| Process activity (collapsed `<details>`) | Task 5 |
| `historyData` message protocol | Tasks 4 & 5 |
| Log interval control (Off / 30s / 1m / 5m) | Task 5 |
| Loading state while `historyData` is in flight | Task 5 |
| No-data state when log is empty | Task 5 |

All spec sections covered. No TBDs or placeholders in any task. Type names are consistent across tasks (`proc_start`, `proc_end`, `session_start`, `session_end`, `session_crash`, `metrics`, `historyData`, `loadHistory`, `setLogInterval`, `setRange`). The `acquireVsCodeApi()` call in Task 5 is required for `vscode.postMessage` — this is valid inside a VS Code webview.

**One addition flagged during review:** The `#tab-history` div uses `style="display:none; flex:1; display:none; flex-direction:column"` — the duplicate `display:none` is redundant but harmless; `switchTab` controls visibility via JS. The initial CSS correctly hides it on load.

---

## Execution Options

Plan complete and saved to `docs/superpowers/plans/2026-07-01-history-logging.md`.

**1. Subagent-Driven (recommended)** — Fresh subagent per task, review between tasks, fast iteration via `superpowers:subagent-driven-development`

**2. Inline Execution** — Execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints

Which approach?
