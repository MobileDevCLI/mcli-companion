// smoke_bash_pty.cjs — end-to-end verification that a REAL bash PTY works.
// Boots the full server, connects a WS client from an allowed origin,
// spawns bash, writes `echo hello-pty`, expects that string to come back.

'use strict';
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const proc = spawn(process.execPath, ['bin/mcli-companion.js'], {
  cwd: __dirname + '/..',
  env: { ...process.env, MCLI_COMPANION_PORT: '18127' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
proc.stdout.on('data', d => process.stdout.write('[srv] ' + d));
proc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

setTimeout(() => {
  const ws = new WebSocket('ws://127.0.0.1:18127', { headers: { origin: 'https://mcli.mobilecli.com' } });
  let got = '';
  let done = false;
  const finish = (ok, msg) => { if (done) return; done = true; console.log(ok ? 'PASS' : 'FAIL', msg || ''); try { ws.close(); } catch {} proc.kill('SIGTERM'); setTimeout(() => process.exit(ok ? 0 : 1), 200); };

  ws.on('message', raw => {
    const m = JSON.parse(raw);
    if (m.type === 'hello') {
      console.log('server hello:', { version: m.version, pty: m.pty });
      ws.send(JSON.stringify({ type: 'pty_spawn', id: 's1', bin: 'bash', args: ['-c', 'echo hello-pty && sleep 0.2 && exit 0'], cols: 80, rows: 24 }));
    } else if (m.type === 'pty_spawned') {
      console.log('spawned pid=' + m.pid);
    } else if (m.type === 'pty_data') {
      got += Buffer.from(m.data, 'base64').toString('utf8');
    } else if (m.type === 'pty_exit') {
      console.log('exit code=' + m.code + ' output=' + JSON.stringify(got));
      finish(got.includes('hello-pty'), 'saw hello-pty in output');
    } else if (m.type === 'error') {
      finish(false, 'server error: ' + m.error);
    }
  });
  ws.on('error', e => finish(false, 'ws err: ' + e.message));
  setTimeout(() => finish(false, 'timeout waiting for bash exit'), 5000);
}, 400);
