'use strict';

const vscode      = require('vscode');
const os          = require('os');
const fs          = require('fs');
const { execSync } = require('child_process');
const { spawn }   = require('child_process');
const path        = require('path');

let collectorProc = null;

const VIEW_TYPE = 'sysMonitor.view';

// ─── Stats collection (pure Node.js, no npm deps) ───────────────────────────

let prevCpuTimes = null;

function primeCpu() {
    prevCpuTimes = os.cpus().map(c => ({ ...c.times }));
}

function getCpuUsage() {
    const cpus = os.cpus();
    if (!prevCpuTimes) {
        prevCpuTimes = cpus.map(c => ({ ...c.times }));
        return { total: 0, perCore: cpus.map(() => 0) };
    }

    const perCore = cpus.map((cpu, i) => {
        const curr  = cpu.times;
        const prev  = prevCpuTimes[i] || curr;
        const pTotal = prev.user + prev.nice + prev.sys + prev.idle + prev.irq;
        const cTotal = curr.user + curr.nice + curr.sys + curr.idle + curr.irq;
        const totalDiff = cTotal - pTotal;
        const idleDiff  = curr.idle - prev.idle;
        if (totalDiff === 0) return 0;
        return Math.min(100, Math.max(0, ((totalDiff - idleDiff) / totalDiff) * 100));
    });

    prevCpuTimes = cpus.map(c => ({ ...c.times }));

    const total = perCore.length > 0
        ? perCore.reduce((a, b) => a + b, 0) / perCore.length
        : 0;

    return { total, perCore };
}

function getMemCachedBytes() {
    try {
        const raw   = fs.readFileSync('/proc/meminfo', 'utf8');
        const match = raw.match(/^Cached:\s+(\d+)/m);
        return match ? parseInt(match[1], 10) * 1024 : 0;
    } catch (e) {
        return 0;
    }
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

function getTopProcesses() {
    try {
        const raw = execSync(
            "ps -eo pcpu,rss,comm --no-headers --sort=-pcpu 2>/dev/null | head -12",
            { encoding: 'utf8', timeout: 1500 }
        );
        return raw.trim().split('\n')
            .map(line => {
                const p = line.trim().split(/\s+/);
                if (p.length < 3) return null;
                return {
                    name: p.slice(2).join(' ').replace(/.*\//, '').substring(0, 16),
                    cpu:  parseFloat(p[0]) || 0,
                    rss:  parseInt(p[1], 10) * 1024   // KB -> bytes
                };
            })
            .filter(p => p !== null && p.name && p.name !== 'ps');
    } catch (e) {
        return [];
    }
}

function collectStats() {
    const cpus = os.cpus();
    const { total, perCore } = getCpuUsage();
    const totalMem  = os.totalmem();
    const freeMem   = os.freemem();
    const usedMem   = totalMem - freeMem;
    const cachedMem = getMemCachedBytes();
    const { swap_total, swap_free, swap_used } = getSwapBytes();
    const swap_pct = swap_total > 0 ? (swap_used / swap_total) * 100 : 0;
    const procs     = getTopProcesses();

    return {
        cpu_percent: total,
        per_cpu:     perCore,
        cpu_count:   cpus.length,
        cpu_freq:    cpus.length > 0 ? cpus[0].speed : null,
        ram_percent: (usedMem / totalMem) * 100,
        ram_total:   totalMem  / 1e9,
        ram_used:    usedMem   / 1e9,
        ram_free:    freeMem   / 1e9,
        ram_cached:  cachedMem / 1e9,
        swap_total_gb: swap_total / 1e9,
        swap_free_gb:  swap_free  / 1e9,
        swap_pct:      swap_pct,
        uptime:      os.uptime(),
        hostname:    os.hostname(),
        top_cpu:     procs.slice(0, 5),
        top_ram:     [...procs].sort((a, b) => b.rss - a.rss).slice(0, 5),
    };
}

// ─── Webview Provider ────────────────────────────────────────────────────────

class SysMonitorViewProvider {
    constructor(extensionUri, context) {
        this._extensionUri = extensionUri;
        this._context      = context;
        this._view         = undefined;
        this._interval     = undefined;
    }

    resolveWebviewView(webviewView, _context, _token) {
        this._view = webviewView;

        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html    = this._buildHtml();

        // Short delay so the webview JS is ready before first push
        setTimeout(() => this._push(), 700);
        this._startPolling();

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
                const logInterval = this._context.globalState.get('logInterval', 30);
                webviewView.webview.postMessage({ type: 'historyData', records, sessions, processes, logInterval });
            }

            if (msg.type === 'setLogInterval') {
                const seconds = msg.seconds;
                this._context.globalState.update('logInterval', seconds);
                if (collectorProc && seconds > 0) {
                    try {
                        collectorProc.stdin.write(JSON.stringify({ type: 'setInterval', seconds }) + '\n');
                    } catch (_) {}
                }
            }
        });

        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._push();
                this._startPolling();
            } else {
                this._stopPolling();
            }
        });

        webviewView.onDidDispose(() => {
            this._stopPolling();
            this._view = undefined;
        });
    }

    _startPolling() {
        this._stopPolling();
        this._interval = setInterval(() => this._push(), 2000);
    }

    _stopPolling() {
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = undefined;
        }
    }

    _push() {
        if (!this._view || !this._view.visible) return;
        try {
            this._view.webview.postMessage({ type: 'stats', data: collectStats() });
        } catch (e) {
            console.error('[SysMonitor]', e);
        }
    }

    _buildHtml() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src 'unsafe-inline' https://fonts.googleapis.com;
               font-src https://fonts.gstatic.com;
               script-src 'unsafe-inline';">
<title>System Monitor</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@700&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }

  html, body { height: 100%; overflow: hidden; }

  body {
    background: var(--vscode-panel-background, #1e1e2e);
    font-family: var(--vscode-font-family, monospace);
    font-size: var(--vscode-font-size, 12px);
    color: var(--vscode-foreground, #c0c8e0);
  }

  /* ── Outer wrapper ── */
  .wrap {
    height: 100%;
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }

  /* ── Top bar ── */
  .topbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-bottom: 7px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.07));
    flex-shrink: 0;
  }

  .brand {
    font-family: 'Orbitron', monospace;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.2em;
    color: var(--vscode-focusBorder, rgba(150,175,220,0.85));
    opacity: 0.85;
  }

  .live-dot {
    width: 5px; height: 5px;
    border-radius: 50%;
    background: var(--vscode-charts-green, rgba(100,170,100,0.75));
    flex-shrink: 0;
    animation: pulse 4s ease-in-out infinite;
  }

  @keyframes pulse { 0%, 100% { opacity: 0.8; } 50% { opacity: 0.25; } }

  .host {
    font-size: 11px;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.45));
  }

  .topbar-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .uptime, .live-label {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.35));
    letter-spacing: 0.04em;
  }

  .live-label { animation: breathe 4s ease-in-out infinite; }

  @keyframes breathe { 0%, 100% { opacity: 0.3; } 50% { opacity: 0.7; } }

  /* ── Two-column grid ── */
  .cols {
    flex: 1;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    min-height: 0;
  }

  /* ── Metric panel ── */
  .mpanel {
    background: var(--vscode-editor-background, rgba(0,0,0,0.18));
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
    border-radius: 3px;
    padding: 9px 11px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-height: 0;
  }

  .phead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .ptitle {
    font-size: 9px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.45));
  }

  .psub {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.4));
  }

  /* Big percentage number — no glow */
  .pval {
    font-family: 'Orbitron', monospace;
    font-size: 26px;
    font-weight: 700;
    line-height: 1;
    transition: color 0.5s;
  }
  .pval.ok   { color: var(--vscode-charts-green,  #6aaa6a); }
  .pval.warn { color: var(--vscode-charts-yellow, #b89040); }
  .pval.crit { color: var(--vscode-charts-red,    #b85555); }

  /* Progress bar — no glow */
  .bar-track {
    height: 4px;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--vscode-panel-border, rgba(255,255,255,0.06));
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .bar-fill {
    height: 100%;
    border-radius: 2px;
    transition: width 0.6s ease, background 0.5s;
    opacity: 0.75;
  }
  .bar-fill.ok   { background: var(--vscode-charts-green,  #6aaa6a); }
  .bar-fill.warn { background: var(--vscode-charts-yellow, #b89040); }
  .bar-fill.crit { background: var(--vscode-charts-red,    #b85555); }

  /* ── Process list (replaces core bars + RAM chips) ── */
  .procs-list {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: space-evenly;
    min-height: 0;
    overflow: hidden;
    gap: 1px;
  }

  .proc-row {
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: center;
    gap: 8px;
    padding: 2px 5px;
    border-radius: 2px;
    font-size: 10px;
    /* subtle fill proportional to relative load — set via --fill in JS */
    background: linear-gradient(
      90deg,
      var(--proc-fill-color, rgba(120,150,200,0.07)) calc(var(--fill, 0) * 1%),
      transparent                                     calc(var(--fill, 0) * 1%)
    );
  }

  .proc-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--vscode-foreground, #c0c8e0);
    opacity: 0.7;
  }

  .proc-metric {
    font-size: 10px;
    color: var(--vscode-descriptionForeground, rgba(192,200,232,0.5));
    white-space: nowrap;
    text-align: right;
    min-width: 50px;
  }

  /* ── Alert banner ── */
  .alert {
    display: none;
    padding: 4px 10px;
    border: 1px solid;
    border-radius: 2px;
    font-size: 10px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
    opacity: 0.85;
  }
  .alert.warn { border-color: rgba(184,144,64,0.4);  background: rgba(184,144,64,0.06);  color: var(--vscode-charts-yellow, #b89040); }
  .alert.crit { border-color: rgba(184,85,85,0.4);   background: rgba(184,85,85,0.06);   color: var(--vscode-charts-red,    #b85555); }

  /* ── Tab / live wrapper ── */
  #tab-live {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 7px;
    min-height: 0;
  }

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
</style>
</head>
<body>
<div class="wrap">

  <!-- Top bar -->
  <div class="topbar">
    <span class="brand">SYS_MONITOR</span>
    <span class="live-dot"></span>
    <span class="host" id="hostname">--</span>
    <div class="topbar-right">
      <span class="uptime" id="uptime">UP: --</span>
      <span class="live-label">&#9679; LIVE &middot; 2s</span>
    </div>
  </div>

  <!-- Tab bar -->
  <div class="tabs">
    <button class="tab-btn active" id="btn-live"    onclick="switchTab('live')">LIVE</button>
    <button class="tab-btn"        id="btn-history" onclick="switchTab('history')">HISTORY</button>
  </div>

  <!-- Live tab -->
  <div id="tab-live">

    <!-- Two columns -->
    <div class="cols">

      <!-- CPU panel -->
      <div class="mpanel">
        <div class="phead">
          <span class="ptitle">CPU Usage</span>
          <span class="psub" id="cpu-freq">--</span>
        </div>
        <div class="pval ok" id="cpu-pct">--%</div>
        <div class="bar-track">
          <div class="bar-fill ok" id="cpu-bar" style="width:0%"></div>
        </div>
        <div class="procs-list" id="cpu-procs"></div>
      </div>

      <!-- RAM panel -->
      <div class="mpanel">
        <div class="phead">
          <span class="ptitle">RAM Usage</span>
          <span class="psub" id="ram-total">-- GB</span>
        </div>
        <div class="pval ok" id="ram-pct">--%</div>
        <div class="bar-track">
          <div class="bar-fill ok" id="ram-bar" style="width:0%"></div>
        </div>
        <div class="procs-list" id="ram-procs"></div>
      </div>

    </div>

    <!-- Alert banner -->
    <div class="alert" id="alert-banner"></div>

  </div>

  <!-- History tab -->
  <div id="tab-history" style="display:none; flex:1; flex-direction:column; gap:8px; overflow-y:auto; min-height:0;">

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

</div>

<script>
  var WARN = 70, CRIT = 90;

  function level(p) { return p >= CRIT ? 'crit' : p >= WARN ? 'warn' : 'ok'; }

  function fmt(gb) {
    return gb >= 1 ? gb.toFixed(1) + ' GB' : (gb * 1024).toFixed(0) + ' MB';
  }

  function fmtUp(s) {
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? d+'d '+h+'h '+m+'m' : h > 0 ? h+'h '+m+'m' : m+'m '+(s%60)+'s';
  }

  // Renders a list of process rows into containerId.
  // valueFn(p) → numeric value used for relative fill width.
  // labelFn(p) → string shown on the right.
  function renderProcs(containerId, procs, valueFn, labelFn) {
    var el = document.getElementById(containerId);
    if (!el || !procs || !procs.length) return;

    var maxVal = 1;
    procs.forEach(function(p) { var v = valueFn(p); if (v > maxVal) maxVal = v; });

    el.innerHTML = '';
    procs.forEach(function(p) {
      var row = document.createElement('div');
      row.className = 'proc-row';
      row.style.setProperty('--fill', (valueFn(p) / maxVal * 100).toFixed(1));
      row.innerHTML =
        '<span class="proc-name">' + p.name + '</span>' +
        '<span class="proc-metric">' + labelFn(p) + '</span>';
      el.appendChild(row);
    });
  }

  function updateAll(data) {
    // CPU
    var cp = data.cpu_percent, cl = level(cp);
    document.getElementById('cpu-pct').textContent = cp.toFixed(1) + '%';
    document.getElementById('cpu-pct').className   = 'pval ' + cl;
    document.getElementById('cpu-bar').style.width = cp + '%';
    document.getElementById('cpu-bar').className   = 'bar-fill ' + cl;
    document.getElementById('cpu-freq').textContent = data.cpu_freq
      ? (data.cpu_freq / 1000).toFixed(2) + ' GHz \u00b7 ' + data.cpu_count + ' cores'
      : data.cpu_count + ' cores';

    // CPU process list
    renderProcs('cpu-procs', data.top_cpu,
      function(p) { return p.cpu; },
      function(p) { return p.cpu.toFixed(1) + '%'; }
    );

    // RAM
    var rp = data.ram_percent, rl = level(rp);
    document.getElementById('ram-pct').textContent = rp.toFixed(1) + '%';
    document.getElementById('ram-pct').className   = 'pval ' + rl;
    document.getElementById('ram-bar').style.width = rp + '%';
    document.getElementById('ram-bar').className   = 'bar-fill ' + rl;
    document.getElementById('ram-total').textContent = fmt(data.ram_total) + ' total';

    // RAM process list
    renderProcs('ram-procs', data.top_ram,
      function(p) { return p.rss; },
      function(p) { return fmt(p.rss / 1e9); }
    );

    // Meta
    document.getElementById('uptime').textContent   = 'UP: ' + fmtUp(data.uptime);
    document.getElementById('hostname').textContent = data.hostname;

    // Alerts
    var banner = document.getElementById('alert-banner'), msgs = [];
    if      (cp >= CRIT) msgs.push('\u26a0 CPU CRITICAL: ' + cp.toFixed(1) + '%');
    else if (cp >= WARN) msgs.push('\u25b3 CPU HIGH: '     + cp.toFixed(1) + '%');
    if      (rp >= CRIT) msgs.push('\u26a0 RAM CRITICAL: ' + rp.toFixed(1) + '%');
    else if (rp >= WARN) msgs.push('\u25b3 RAM HIGH: '     + rp.toFixed(1) + '%');
    if (msgs.length) {
      banner.className     = 'alert ' + ((cp >= CRIT || rp >= CRIT) ? 'crit' : 'warn');
      banner.innerHTML     = msgs.join(' &nbsp;&nbsp; ');
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

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

  // ── Unified message handler ────────────────────────────────────────────────
  window.addEventListener('message', function(e) {
    if (e.data.type === 'stats') { updateAll(e.data.data); return; }

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
</script>
</body>
</html>`;
    }
}

// ─── Extension lifecycle ─────────────────────────────────────────────────────

function activate(context) {
    primeCpu(); // prime so first real poll has a valid diff to compare

    const provider = new SysMonitorViewProvider(context.extensionUri, context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            VIEW_TYPE,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    const collectorPath = path.join(context.extensionPath, 'collector.js');
    collectorProc = spawn(process.execPath, [collectorPath], {
        stdio: ['pipe', 'inherit', 'inherit'],
    });
    collectorProc.on('error', e => console.error('[SysMonitor] collector error:', e.message));
    collectorProc.on('exit',  c => console.log('[SysMonitor] collector exited with code', c));
}

function deactivate() {
    if (collectorProc) {
        try {
            collectorProc.stdin.write(JSON.stringify({ type: 'stop' }) + '\n');
            collectorProc.stdin.end();
        } catch (_) {}
        collectorProc = null;
    }
}

module.exports = { activate, deactivate };
