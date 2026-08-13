// tests/pty.test.cjs — end-to-end tests for the PTY + credentials-seeding
// message protocol. Uses a mock node-pty so nothing real gets spawned, and
// a real WebSocketServer + ws client so the JSON-over-WS wire format is
// exercised for real.
//
// Zero test framework — just plain assertions. Run with `node tests/pty.test.cjs`
// (or `npm test`). Exit code 0 = all pass; 1 = any failure.

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const WebSocket = require('ws');

const server = require('../lib/server.js');

// ---------- test infra ------------------------------------------------------

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); }
}

// A mock pty term that quacks like node-pty's IPty. Records everything so
// tests can assert on write/resize/kill calls. .onData/.onExit expose EE-shape
// hooks that node-pty uses.
function makeMockTerm() {
  const em = new EventEmitter();
  const term = {
    pid: 12345,
    writes: [], resizes: [], kills: [],
    write(d) { this.writes.push(d); em.emit('data', `echo:${d}`); },
    resize(cols, rows) { this.resizes.push({ cols, rows }); },
    kill(sig) { this.kills.push(sig || null); em.emit('exit', { exitCode: 0, signal: sig ? 15 : 0 }); },
    onData(cb) { em.on('data', cb); },
    onExit(cb) { em.on('exit', cb); },
    _emit(ev, arg) { em.emit(ev, arg); },
  };
  return term;
}

function makeMockPty(spawnCalls) {
  return {
    spawn(bin, args, opts) {
      const t = makeMockTerm();
      spawnCalls.push({ bin, args, opts, term: t });
      return t;
    },
  };
}

// Spin up a real WS server that runs the handler under test. Returns
// { url, sessions, close } — sessions is the shared Map so tests can peek
// inside for state assertions.
function makeServer() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const sessions = new Map();
    wss.on('connection', (ws, req) => {
      ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        server.__handle(ws, msg, sessions);
      });
    });
    wss.on('listening', () => {
      const { port } = wss.address();
      resolve({
        url: `ws://127.0.0.1:${port}`,
        sessions,
        close: () => new Promise(r => wss.close(r)),
      });
    });
  });
}

// Connect a client, run fn(client, msgs), close. msgs auto-fills with
// every JSON message the server sends. Awaits close before resolving.
function withClient(url, fn) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { origin: 'https://mcli.mobilecli.com' } });
    const msgs = [];
    ws.on('message', raw => { try { msgs.push(JSON.parse(raw)); } catch {} });
    ws.on('open', async () => {
      try {
        await fn(ws, msgs);
        ws.close();
      } catch (e) { ws.close(); reject(e); }
    });
    ws.on('close', () => resolve());
    ws.on('error', reject);
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Wait until pred(msgs) is truthy or timeout. Polls every 20 ms.
async function waitFor(msgs, pred, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred(msgs)) return;
    await sleep(20);
  }
  throw new Error(`waitFor timeout after ${timeoutMs}ms — msgs: ${JSON.stringify(msgs)}`);
}

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

// ---------- tests -----------------------------------------------------------

(async () => {
  console.log('\nmcli-companion tests\n');

  // ==== PTY tests: use mock so we don't shell out ==========================

  await test('pty_spawn emits pty_spawned + pty_data', async () => {
    const spawnCalls = [];
    server.__setPtyForTests(makeMockPty(spawnCalls));
    const srv = await makeServer();
    try {
      await withClient(srv.url, async (ws, msgs) => {
        send(ws, { type: 'pty_spawn', id: 'a1', bin: 'bash', args: ['-l'], cols: 100, rows: 30 });
        await waitFor(msgs, m => m.some(x => x.type === 'pty_spawned' && x.id === 'a1'));
        const spawned = msgs.find(m => m.type === 'pty_spawned');
        assert.strictEqual(spawned.pid, 12345);
        assert.strictEqual(spawned.cols, 100);
        assert.strictEqual(spawned.rows, 30);
        assert.strictEqual(spawnCalls.length, 1);
        assert.strictEqual(spawnCalls[0].bin, 'bash');
        assert.deepStrictEqual(spawnCalls[0].args, ['-l']);
        assert.strictEqual(spawnCalls[0].opts.name, 'xterm-color');
        assert.strictEqual(spawnCalls[0].opts.cols, 100);

        // Fire a data event on the mock — should surface as pty_data (b64).
        spawnCalls[0].term._emit('data', 'hello\r\n');
        await waitFor(msgs, m => m.some(x => x.type === 'pty_data' && x.id === 'a1'));
        const data = msgs.find(m => m.type === 'pty_data');
        assert.strictEqual(Buffer.from(data.data, 'base64').toString('utf8'), 'hello\r\n');
      });
    } finally { await srv.close(); }
  });

  await test('pty_write forwards base64-decoded bytes to term.write', async () => {
    const spawnCalls = [];
    server.__setPtyForTests(makeMockPty(spawnCalls));
    const srv = await makeServer();
    try {
      await withClient(srv.url, async (ws, msgs) => {
        send(ws, { type: 'pty_spawn', id: 'w1', bin: 'bash' });
        await waitFor(msgs, m => m.some(x => x.type === 'pty_spawned'));
        send(ws, { type: 'pty_write', id: 'w1', data: Buffer.from('ls -la\n').toString('base64') });
        // The mock echoes writes as data events, so waiting on pty_data guarantees the write landed.
        await waitFor(msgs, m => m.some(x => x.type === 'pty_data' && Buffer.from(x.data, 'base64').toString('utf8') === 'echo:ls -la\n'));
        assert.deepStrictEqual(spawnCalls[0].term.writes, ['ls -la\n']);
      });
    } finally { await srv.close(); }
  });

  await test('pty_resize calls term.resize with clamped cols/rows', async () => {
    const spawnCalls = [];
    server.__setPtyForTests(makeMockPty(spawnCalls));
    const srv = await makeServer();
    try {
      await withClient(srv.url, async (ws, msgs) => {
        send(ws, { type: 'pty_spawn', id: 'r1', bin: 'bash' });
        await waitFor(msgs, m => m.some(x => x.type === 'pty_spawned'));
        send(ws, { type: 'pty_resize', id: 'r1', cols: 132, rows: 50 });
        await sleep(60);
        assert.deepStrictEqual(spawnCalls[0].term.resizes, [{ cols: 132, rows: 50 }]);
        // Bogus values get clamped to at-least-1 rather than crashing.
        send(ws, { type: 'pty_resize', id: 'r1', cols: -5, rows: 0 });
        await sleep(60);
        assert.deepStrictEqual(spawnCalls[0].term.resizes[1], { cols: 1, rows: 1 });
      });
    } finally { await srv.close(); }
  });

  await test('pty_kill terminates + emits pty_exit', async () => {
    const spawnCalls = [];
    server.__setPtyForTests(makeMockPty(spawnCalls));
    const srv = await makeServer();
    try {
      await withClient(srv.url, async (ws, msgs) => {
        send(ws, { type: 'pty_spawn', id: 'k1', bin: 'bash' });
        await waitFor(msgs, m => m.some(x => x.type === 'pty_spawned'));
        send(ws, { type: 'pty_kill', id: 'k1', sig: 'SIGTERM' });
        await waitFor(msgs, m => m.some(x => x.type === 'pty_exit' && x.id === 'k1'));
        assert.deepStrictEqual(spawnCalls[0].term.kills, ['SIGTERM']);
      });
    } finally { await srv.close(); }
  });

  await test('pty_spawn rejects binaries not on ALLOW list', async () => {
    server.__setPtyForTests(makeMockPty([]));
    const srv = await makeServer();
    try {
      await withClient(srv.url, async (ws, msgs) => {
        send(ws, { type: 'pty_spawn', id: 'x1', bin: 'rm' });
        await waitFor(msgs, m => m.some(x => x.type === 'error' && x.id === 'x1'));
        const err = msgs.find(m => m.type === 'error');
        assert.match(err.error, /not allowed/);
      });
    } finally { await srv.close(); }
  });

  // ==== credentials seeding ================================================

  await test('seed_credentials writes ~/.claude/.credentials.json in correct shape', async () => {
    // Redirect $HOME to a temp dir so we never touch the real credentials.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcli-comp-test-'));
    const origHome = os.homedir;
    const origHOME = process.env.HOME;
    process.env.HOME = tmp;
    os.homedir = () => tmp;

    // Re-require server to pick up the mutated homedir in CREDENTIALS_PATHS.
    delete require.cache[require.resolve('../lib/server.js')];
    const fresh = require('../lib/server.js');

    try {
      const result = fresh.__seedCredentials('anthropic', {
        accessToken: 'sk-ant-oat01-TESTTOKEN',
        refreshToken: 'refresh-abc',
        expiresAt: 1234567890,
        scopes: ['user:inference'],
        subscriptionType: 'max',
      });
      const target = path.join(tmp, '.claude', '.credentials.json');
      assert.strictEqual(result.path, target);
      assert.strictEqual(result.action, 'created');
      const written = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.strictEqual(written.claudeAiOauth.accessToken, 'sk-ant-oat01-TESTTOKEN');
      assert.strictEqual(written.claudeAiOauth.refreshToken, 'refresh-abc');
      assert.strictEqual(written.claudeAiOauth.expiresAt, 1234567890);
      assert.deepStrictEqual(written.claudeAiOauth.scopes, ['user:inference']);
      assert.strictEqual(written.claudeAiOauth.subscriptionType, 'max');
      // File perms should be 0600.
      const mode = fs.statSync(target).mode & 0o777;
      assert.strictEqual(mode, 0o600);

      // Re-seed with same token → unchanged.
      const again = fresh.__seedCredentials('anthropic', { accessToken: 'sk-ant-oat01-TESTTOKEN' });
      assert.strictEqual(again.action, 'unchanged');

      // Different token → updated.
      const upd = fresh.__seedCredentials('anthropic', { accessToken: 'sk-ant-oat01-NEW' });
      assert.strictEqual(upd.action, 'updated');
      const w2 = JSON.parse(fs.readFileSync(target, 'utf8'));
      assert.strictEqual(w2.claudeAiOauth.accessToken, 'sk-ant-oat01-NEW');
    } finally {
      os.homedir = origHome;
      if (origHOME) process.env.HOME = origHOME; else delete process.env.HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
      // Restore original module for subsequent tests.
      delete require.cache[require.resolve('../lib/server.js')];
      require('../lib/server.js');
    }
  });

  await test('seed_credentials via WS message returns credentials_seeded', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcli-comp-test-'));
    const origHome = os.homedir;
    const origHOME = process.env.HOME;
    process.env.HOME = tmp;
    os.homedir = () => tmp;

    delete require.cache[require.resolve('../lib/server.js')];
    const fresh = require('../lib/server.js');
    // Wire mock pty so the fresh module has our pty override.
    fresh.__setPtyForTests(makeMockPty([]));

    // Build a WS server that uses the freshly-loaded module.
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const sessions = new Map();
    wss.on('connection', (ws, req) => {
      ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        fresh.__handle(ws, msg, sessions);
      });
    });
    await new Promise(r => wss.on('listening', r));
    const { port } = wss.address();

    try {
      await withClient(`ws://127.0.0.1:${port}`, async (ws, msgs) => {
        send(ws, {
          type: 'seed_credentials',
          id: 'c1',
          provider: 'anthropic',
          credentials: { accessToken: 'sk-ant-oat01-VIAWS', refreshToken: 'r', expiresAt: 1, scopes: [], subscriptionType: 'max' },
        });
        await waitFor(msgs, m => m.some(x => x.type === 'credentials_seeded' && x.id === 'c1'));
        const ok = msgs.find(m => m.type === 'credentials_seeded');
        assert.strictEqual(ok.action, 'created');
        assert.ok(ok.path.endsWith('.claude/.credentials.json'));
      });
    } finally {
      await new Promise(r => wss.close(r));
      os.homedir = origHome;
      if (origHOME) process.env.HOME = origHOME; else delete process.env.HOME;
      fs.rmSync(tmp, { recursive: true, force: true });
      delete require.cache[require.resolve('../lib/server.js')];
      require('../lib/server.js');
    }
  });

  await test('seed_credentials rejects missing accessToken', async () => {
    assert.throws(
      () => server.__seedCredentials('anthropic', {}),
      /accessToken required/,
    );
  });

  await test('seed_credentials rejects unknown provider', async () => {
    assert.throws(
      () => server.__seedCredentials('openai', { accessToken: 'x' }),
      /unsupported provider/,
    );
  });

  // ==== claude auto-install path ===========================================

  await test('claude auto-install: pty_spawn triggers npm install when claude missing', async () => {
    // Fresh module load so we can swap in a fake npm PATH.
    delete require.cache[require.resolve('../lib/server.js')];
    const fresh = require('../lib/server.js');

    // Mock pty. Also intercept child_process.spawn so `npm install -g ...`
    // resolves quickly with exit 0 instead of hitting the real registry.
    const spawnCalls = [];
    fresh.__setPtyForTests(makeMockPty(spawnCalls));

    const cp = require('node:child_process');
    const origSpawn = cp.spawn;
    const npmSpawnCalls = [];
    cp.spawn = function mockSpawn(cmd, args, opts) {
      if (cmd === 'npm') {
        npmSpawnCalls.push({ cmd, args, opts });
        // Return a fake child-process emitter that closes with code 0.
        const em = new EventEmitter();
        em.stdout = new EventEmitter();
        em.stderr = new EventEmitter();
        setImmediate(() => {
          em.stdout.emit('data', Buffer.from('added 1 package\n'));
          em.emit('exit', 0);
        });
        return em;
      }
      return origSpawn.apply(this, arguments);
    };

    // Also force whichBin('claude') to return '' by overriding execSync.
    // Not needed here — whichBin uses spawnSync + sh; on Termux `claude` is
    // typically absent so this returns '' naturally. We assert the npm call
    // happened regardless of local state by pre-checking.

    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    const sessions = new Map();
    wss.on('connection', ws => {
      ws.on('message', raw => {
        let msg; try { msg = JSON.parse(raw); } catch { return; }
        fresh.__handle(ws, msg, sessions);
      });
    });
    await new Promise(r => wss.on('listening', r));
    const { port } = wss.address();

    try {
      // Only meaningful when claude isn't already installed. If it is
      // (e.g. dev has it globally), skip the assertion but still verify
      // the pty_spawn succeeds.
      const claudeInstalled = !!fresh.__whichBin('claude');

      await withClient(`ws://127.0.0.1:${port}`, async (ws, msgs) => {
        send(ws, { type: 'pty_spawn', id: 'ci1', bin: 'claude' });
        await waitFor(msgs, m => m.some(x => x.type === 'pty_spawned' && x.id === 'ci1'), 4000);
        if (!claudeInstalled) {
          const progress = msgs.filter(m => m.type === 'install_progress');
          assert.ok(progress.length >= 2, 'expected install_progress events');
          assert.ok(progress.some(p => /claude not on PATH/.test(p.line)));
          assert.strictEqual(npmSpawnCalls.length, 1);
          assert.deepStrictEqual(npmSpawnCalls[0].args, ['install', '-g', fresh.__constants.CLAUDE_NPM_PKG]);
        }
      });
    } finally {
      cp.spawn = origSpawn;
      await new Promise(r => wss.close(r));
      delete require.cache[require.resolve('../lib/server.js')];
      require('../lib/server.js');
    }
  });

  // ==== summary ============================================================

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
