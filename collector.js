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

function trackProcesses() {}

function seedInitialProcesses() {}

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
seedInitialProcesses();
startTimer();
