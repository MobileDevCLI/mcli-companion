// tests/static.test.cjs — verifies the new v1.2.0 self-hosted browser terminal
// surface: GET / serves the terminal HTML, GET /assets/* serves vendored xterm,
// token auth gates the routes when MCLI_COMPANION_TOKEN is set, and gh is in
// ALLOWED_BINS.
//
// Zero framework — plain assertions. `node tests/static.test.cjs`.

'use strict';

const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const child = require('node:child_process');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log(`  ok   ${name}`); },
    (e) => { failed++; console.log(`  FAIL ${name}\n       ${e.stack || e.message}`); }
  );
}

function get(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(new Error('timeout')); });
  });
}

async function withServer(env, fn) {
  const port = 18120 + Math.floor(Math.random() * 500);
  const proc = child.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mcli-companion.js')], {
    env: { ...process.env, ...env, MCLI_COMPANION_PORT: String(port), MCLI_COMPANION_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (b) => { stderr += b.toString(); });
  // Wait for listening line on stdout
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('server never listened\nstderr:\n' + stderr)); }, 4000);
    proc.stdout.on('data', (b) => {
      if (b.toString().includes('listening on')) { clearTimeout(timer); resolve(); }
    });
    proc.on('exit', (c) => { clearTimeout(timer); reject(new Error(`server exited early code=${c}\nstderr:\n` + stderr)); });
  });
  try { await fn(port); }
  finally { proc.kill('SIGTERM'); await new Promise(r => setTimeout(r, 50)); proc.kill('SIGKILL'); }
}

(async () => {
  await test('GET / serves the terminal HTML (no token → open)', async () => {
    await withServer({ MCLI_COMPANION_TOKEN: '' }, async (port) => {
      const r = await get(`http://127.0.0.1:${port}/`);
      assert.equal(r.status, 200);
      assert.ok(/<title>MobileCLI Terminal<\/title>/.test(r.body.toString()), 'HTML title missing');
      assert.ok(/attachMobileInput/.test(r.body.toString()), 'mobile-input handler missing');
    });
  });

  await test('GET /assets/xterm.js serves vendored bundle', async () => {
    await withServer({ MCLI_COMPANION_TOKEN: '' }, async (port) => {
      const r = await get(`http://127.0.0.1:${port}/assets/xterm.js`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'application/javascript; charset=utf-8');
      assert.ok(r.body.length > 50000, `xterm.js unexpectedly small: ${r.body.length}`);
    });
  });

  await test('GET /assets/xterm.css serves', async () => {
    await withServer({}, async (port) => {
      const r = await get(`http://127.0.0.1:${port}/assets/xterm.css`);
      assert.equal(r.status, 200);
      assert.ok(r.headers['content-type'].startsWith('text/css'));
    });
  });

  await test('GET /assets/../lib/server.js is blocked (path traversal)', async () => {
    // Node's http client normalizes .. before sending, so we need a raw TCP
    // socket to actually test the guard. Send an unnormalized path in the
    // request line and confirm the server never leaks server.js contents.
    await withServer({}, async (port) => {
      const net = require('node:net');
      const body = await new Promise((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        let buf = '';
        s.on('connect', () => s.write('GET /assets/../lib/server.js HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
        s.on('data', (b) => { buf += b.toString(); });
        s.on('end', () => resolve(buf));
        s.on('error', reject);
        setTimeout(() => { s.destroy(); reject(new Error('raw socket timeout')); }, 3000);
      });
      assert.ok(!/tokenOk/.test(body), 'server.js source leaked via ..');
      assert.ok(!/ALLOWED_BINS/.test(body), 'server.js constants leaked via ..');
    });
  });

  await test('Token gate: no token → 401 on GET /, valid token → 200', async () => {
    const token = 'abcd1234deadbeef1234abcd1234deadbeef1234abcd1234deadbeef1234abcd';
    await withServer({ MCLI_COMPANION_TOKEN: token }, async (port) => {
      const r1 = await get(`http://127.0.0.1:${port}/`);
      assert.equal(r1.status, 401);
      const r2 = await get(`http://127.0.0.1:${port}/?t=${token}`);
      assert.equal(r2.status, 200);
    });
  });

  await test('Token gate: wrong token → 401', async () => {
    const token = 'a'.repeat(64);
    await withServer({ MCLI_COMPANION_TOKEN: token }, async (port) => {
      const r = await get(`http://127.0.0.1:${port}/?t=${'b'.repeat(64)}`);
      assert.equal(r.status, 401);
    });
  });

  await test('gh CLI is in ALLOWED_BINS', async () => {
    const { __constants } = require('../lib/server.js');
    assert.ok(__constants.ALLOWED_BINS.gh, 'gh missing from ALLOWED_BINS');
    assert.equal(__constants.ALLOWED_BINS.gh.cmd, 'gh');
  });

  await test('grok CLI is in ALLOWED_BINS', async () => {
    const { __constants } = require('../lib/server.js');
    assert.ok(__constants.ALLOWED_BINS.grok, 'grok missing');
  });

  console.log(`\n${passed} pass, ${failed} fail`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(2); });
