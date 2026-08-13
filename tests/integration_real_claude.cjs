// integration_real_claude.cjs — direct WS integration test against a RUNNING
// mcli-companion v1.1.0 with the REAL `@anthropic-ai/claude-code` binary.
// Bypasses the browser entirely. Bring your own running companion on :8127.
//
// Phases:
//   P1 hello                    — verify version + pty capability
//   P2 seed_credentials         — should return action=unchanged (token match)
//   P3 pty_spawn claude         — measure first-byte latency (claude startup)
//   P4 slash commands           — /help /model /cost each measured
//   P5 pty_resize               — verify no error
//   P6 Ctrl-C (0x03)            — interrupt indicator
//   P7 pty_kill                 — expect pty_exit
//   E1 concurrent sessions      — two pty_spawn in parallel, no cross-talk
//
// Auto-install path (P0) only fires if `claude` is missing at startup. We
// detect that up front and report whether the path was exercised.

'use strict';
const WebSocket = require('ws');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const URL = 'ws://127.0.0.1:8127';
const ORIGIN = 'https://mcli.mobilecli.com';
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

const results = [];
function record(phase, ok, detail) {
  results.push({ phase, ok, detail });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${phase}${detail ? ' — ' + detail : ''}`);
}

function b64(s) { return Buffer.from(s, 'utf8').toString('base64'); }
function unb64(s) { return Buffer.from(s, 'base64').toString('utf8'); }
function snippet(s, n = 200) {
  const flat = s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
  return flat.length > n ? flat.slice(0, n) + '…' : flat;
}
function ms(t0) { return (Date.now() - t0) + 'ms'; }

function openWs() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL, { headers: { origin: ORIGIN } });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMsg(ws, filter, timeoutMs = 5000, onEvery) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error(`timeout waiting for ${filter.toString()}`)); }, timeoutMs);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (onEvery) onEvery(m);
      if (filter(m)) { clearTimeout(t); ws.off('message', h); resolve(m); }
    };
    ws.on('message', h);
  });
}

function collectPtyData(ws, sessionId, opts) {
  const { untilRegex, timeoutMs = 60000 } = opts;
  return new Promise((resolve) => {
    let buf = '';
    let firstByteAt = null;
    const t0 = Date.now();
    const timer = setTimeout(() => { ws.off('message', h); resolve({ buf, firstByteAt, elapsed: Date.now() - t0, matched: false, reason: 'timeout' }); }, timeoutMs);
    const h = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'pty_data' && m.id === sessionId) {
        if (firstByteAt === null) firstByteAt = Date.now() - t0;
        buf += unb64(m.data);
        if (untilRegex && untilRegex.test(buf)) {
          clearTimeout(timer); ws.off('message', h);
          resolve({ buf, firstByteAt, elapsed: Date.now() - t0, matched: true });
        }
      } else if (m.type === 'pty_exit' && m.id === sessionId) {
        clearTimeout(timer); ws.off('message', h);
        resolve({ buf, firstByteAt, elapsed: Date.now() - t0, matched: false, reason: 'pty_exit', exit: m });
      }
    };
    ws.on('message', h);
  });
}

async function readExistingToken() {
  const raw = fs.readFileSync(CRED_PATH, 'utf8');
  const j = JSON.parse(raw);
  const o = j.claudeAiOauth;
  if (!o?.accessToken) throw new Error('no accessToken');
  return o;
}

(async () => {
  console.log('== mcli-companion v1.1.0 REAL claude integration ==');
  console.log('URL:', URL);

  // Pre-flight: is claude on PATH?
  let claudePresent = false;
  try { execSync('command -v claude', { stdio: 'ignore' }); claudePresent = true; } catch {}
  console.log('claude on PATH:', claudePresent, '(auto-install path will', claudePresent ? 'NOT' : '', 'fire)');

  const ws = await openWs();
  ws.on('error', e => console.error('ws error:', e.message));

  // ---------------- P1: hello ----------------
  const tHello = Date.now();
  const hello = await nextMsg(ws, m => m.type === 'hello', 5000);
  record('P1 hello', hello.pty === true && hello.version === '1.1.0',
    `v${hello.version} pty=${hello.pty} caps=[${hello.capabilities.join(',')}] (${ms(tHello)})`);

  // ---------------- P2: seed_credentials (should be unchanged) ----------------
  let seedElapsed = 0;
  try {
    const oauth = await readExistingToken();
    const tSeed = Date.now();
    ws.send(JSON.stringify({ type: 'seed_credentials', id: 'seed1', provider: 'anthropic', credentials: { claudeAiOauth: oauth } }));
    const res = await nextMsg(ws, m => m.id === 'seed1' && (m.type === 'credentials_seeded' || m.type === 'error'), 3000);
    seedElapsed = Date.now() - tSeed;
    record('P2 seed_credentials', res.type === 'credentials_seeded' && res.action === 'unchanged',
      `action=${res.action} path=${res.path} (${seedElapsed}ms)`);
  } catch (e) { record('P2 seed_credentials', false, e.message); }

  // ---------------- P3: pty_spawn claude ----------------
  const spawnId = 'claude1';
  const tSpawn = Date.now();
  ws.send(JSON.stringify({ type: 'pty_spawn', id: spawnId, bin: 'claude', args: [], cols: 120, rows: 30 }));

  // Watch for install_progress in parallel
  let installLines = [];
  const installWatch = (m) => { if (m.type === 'install_progress' && m.id === spawnId) installLines.push(m.line); };
  ws.on('message', raw => { try { installWatch(JSON.parse(raw)); } catch {} });

  const spawned = await nextMsg(ws, m => m.id === spawnId && (m.type === 'pty_spawned' || m.type === 'error'), 90000);
  if (spawned.type === 'error') { record('P3 pty_spawn', false, spawned.error); ws.close(); process.exit(1); }
  const spawnRt = Date.now() - tSpawn;
  record('P3 pty_spawn', true, `pid=${spawned.pid} spawn_ack=${spawnRt}ms install_lines=${installLines.length}`);
  if (installLines.length) console.log('  install output (first 5):', installLines.slice(0, 5));

  // ---------------- P3b: first pty_data byte (claude startup) ----------------
  const startup = await collectPtyData(ws, spawnId, {
    untilRegex: /(claude|Claude|>|\?|model|Try|help|Welcome|Anthropic)/,
    timeoutMs: 60000,
  });
  record('P3b startup', startup.matched, `first_byte=${startup.firstByteAt}ms match_at=${startup.elapsed}ms bytes=${startup.buf.length}`);
  console.log('  startup snippet:', snippet(startup.buf, 300));

  // Small pause to let claude fully render prompt
  await new Promise(r => setTimeout(r, 1500));

  // ---------------- P4: slash commands ----------------
  async function trySlash(cmd, label, untilRegex, timeoutMs = 15000) {
    const t0 = Date.now();
    ws.send(JSON.stringify({ type: 'pty_write', id: spawnId, data: b64(cmd + '\r') }));
    const r = await collectPtyData(ws, spawnId, { untilRegex, timeoutMs });
    record('P4 ' + label, r.matched, `first_byte=${r.firstByteAt}ms elapsed=${r.elapsed}ms bytes=${r.buf.length}`);
    console.log('  ' + label + ' snippet:', snippet(r.buf, 200));
    return r;
  }
  await trySlash('/help', '/help', /(help|Commands|Available|Usage|Slash)/i, 12000);
  await new Promise(r => setTimeout(r, 800));
  await trySlash('/model', '/model', /(model|Sonnet|Opus|Haiku|claude-)/i, 12000);
  await new Promise(r => setTimeout(r, 800));
  await trySlash('/cost', '/cost', /(cost|token|usage|\$|Total|session)/i, 12000);
  await new Promise(r => setTimeout(r, 500));

  // ---------------- P5: pty_resize ----------------
  const tResize = Date.now();
  ws.send(JSON.stringify({ type: 'pty_resize', id: spawnId, cols: 100, rows: 40 }));
  const resizeErr = await Promise.race([
    nextMsg(ws, m => m.id === spawnId && m.type === 'error', 1500).catch(() => null),
    new Promise(r => setTimeout(() => r(null), 1500)),
  ]);
  record('P5 pty_resize', resizeErr === null, `no error in 1.5s (${ms(tResize)})`);

  // ---------------- P6: Ctrl-C (byte 0x03) ----------------
  const tCtrlC = Date.now();
  ws.send(JSON.stringify({ type: 'pty_write', id: spawnId, data: Buffer.from([0x03]).toString('base64') }));
  const ctrlc = await collectPtyData(ws, spawnId, { untilRegex: /(\^C|Interrupt|cancel|aborted|>|\?)/i, timeoutMs: 4000 });
  record('P6 Ctrl-C', ctrlc.matched || ctrlc.buf.length > 0, `first_byte=${ctrlc.firstByteAt}ms bytes=${ctrlc.buf.length}`);
  console.log('  ctrl-c snippet:', snippet(ctrlc.buf, 150));

  // ---------------- P7: pty_kill ----------------
  const tKill = Date.now();
  ws.send(JSON.stringify({ type: 'pty_kill', id: spawnId, sig: 'SIGTERM' }));
  const exited = await Promise.race([
    nextMsg(ws, m => m.id === spawnId && m.type === 'pty_exit', 5000).catch(e => ({ error: e.message })),
    new Promise(r => setTimeout(() => r({ error: 'no exit in 5s' }), 5000)),
  ]);
  record('P7 pty_kill', exited && exited.type === 'pty_exit',
    exited?.type === 'pty_exit' ? `code=${exited.code} sig=${exited.sig} (${ms(tKill)})` : exited?.error);

  // ---------------- E1: concurrent pty_spawn ----------------
  // Use bash for concurrency check (faster startup, deterministic output).
  console.log('\n== E1: concurrent bash sessions ==');
  const idA = 'concA', idB = 'concB';
  const tConc = Date.now();
  ws.send(JSON.stringify({ type: 'pty_spawn', id: idA, bin: 'bash', args: ['-c', 'echo AAA-marker; sleep 0.3; echo AAA-done'], cols: 80, rows: 24 }));
  ws.send(JSON.stringify({ type: 'pty_spawn', id: idB, bin: 'bash', args: ['-c', 'echo BBB-marker; sleep 0.3; echo BBB-done'], cols: 80, rows: 24 }));

  const [rA, rB] = await Promise.all([
    collectPtyData(ws, idA, { untilRegex: /AAA-done/, timeoutMs: 5000 }),
    collectPtyData(ws, idB, { untilRegex: /BBB-done/, timeoutMs: 5000 }),
  ]);
  const noCrossTalk = !rA.buf.includes('BBB') && !rB.buf.includes('AAA');
  record('E1 concurrent', rA.matched && rB.matched && noCrossTalk,
    `A=${rA.buf.length}b B=${rB.buf.length}b noCrossTalk=${noCrossTalk} (${ms(tConc)})`);

  // ---------------- summary ----------------
  console.log('\n== SUMMARY ==');
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  console.log(`pass=${pass} fail=${fail}`);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.phase} — ${r.detail}`);

  ws.close();
  setTimeout(() => process.exit(fail === 0 ? 0 : 1), 300);
})().catch(e => { console.error('TEST CRASHED:', e); process.exit(2); });
