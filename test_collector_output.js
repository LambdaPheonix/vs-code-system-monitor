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
