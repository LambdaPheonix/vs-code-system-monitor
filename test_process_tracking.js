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
