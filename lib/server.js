// mcli-companion — local WebSocket server that hosts the real Claude / Codex / Gemini
// CLIs on the user's own machine, so the mcli.mobilecli.com browser tab can drive them
// with the user's own subscription. All process spawning happens under the user's UID
// with the user's HOME. No secrets ever leave the machine.

'use strict';

const { WebSocketServer } = require('ws');
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.MCLI_COMPANION_PORT || 8127);
const HOST = process.env.MCLI_COMPANION_HOST || '127.0.0.1';
const VERSION = require('../package.json').version;

// node-pty is loaded lazily so the module can run in tests / environments
// where the native binding isn't built. If require fails we degrade
// gracefully — pty_* messages return a clear error instead of crashing.
let _pty = null;
function getPty() {
  if (_pty !== null) return _pty;
  try { _pty = require('node-pty'); }
  catch (e) { _pty = { __err: e.message }; }
  return _pty;
}
// Test-hook override: tests inject a mock by calling __setPtyForTests().
function __setPtyForTests(mock) { _pty = mock; }

const ALLOWED_ORIGINS = new Set([
  'https://mcli.mobilecli.com',
  'https://www.mcli.mobilecli.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'null',
]);

// Only these binaries can be spawned. This is the security boundary.
const ALLOWED_BINS = {
  claude:  { cmd: 'claude',  desc: 'Anthropic Claude Code CLI' },
  codex:   { cmd: 'codex',   desc: 'OpenAI Codex CLI' },
  gemini:  { cmd: 'gemini',  desc: 'Google Gemini CLI' },
  grok:    { cmd: 'grok',    desc: 'xAI Grok CLI' },
  bash:    { cmd: 'bash',    desc: 'Bash shell' },
  sh:      { cmd: 'sh',      desc: 'POSIX shell' },
  node:    { cmd: 'node',    desc: 'Node.js runtime' },
  python:  { cmd: 'python3', desc: 'Python 3' },
  git:     { cmd: 'git',     desc: 'Git' },
};

// Pinned Claude Code version — Robert's hardline rule. 2.1.113+ breaks on Termux
// (GH #50270). Only bumped after in-terminal verification.
const CLAUDE_PINNED_VERSION = '2.1.112';
const CLAUDE_NPM_PKG = `@anthropic-ai/claude-code@${CLAUDE_PINNED_VERSION}`;

function log(...a) {
  const t = new Date().toISOString().slice(11, 19);
  console.log(`[${t}]`, ...a);
}

function detectInstalled() {
  const results = {};
  for (const [name, info] of Object.entries(ALLOWED_BINS)) {
    try {
      require('node:child_process').execSync(`command -v ${info.cmd}`, { stdio: 'ignore' });
      results[name] = true;
    } catch { results[name] = false; }
  }
  return results;
}

function whichBin(cmd) {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  if (r.status === 0) return (r.stdout || '').trim();
  return '';
}

function start() {
  const installed = detectInstalled();
  const wss = new WebSocketServer({ host: HOST, port: PORT });
  const sessions = new Map();

  wss.on('listening', () => {
    log(`mcli-companion v${VERSION} listening on ws://${HOST}:${PORT}`);
    log('Available CLIs:', Object.entries(installed).filter(([, v]) => v).map(([k]) => k).join(', ') || '(none — run: npm i -g @anthropic-ai/claude-code)');
    log('Open https://mcli.mobilecli.com — it will connect automatically.');
  });

  wss.on('connection', (ws, req) => {
    const origin = req.headers.origin || 'null';
    if (!ALLOWED_ORIGINS.has(origin)) {
      log(`[reject] origin=${origin}`);
      ws.close(1008, 'origin not allowed');
      return;
    }
    log(`[connect] origin=${origin}`);

    const pty = getPty();
    ws.send(JSON.stringify({
      type: 'hello',
      version: VERSION,
      home: os.homedir(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      installed,
      capabilities: Object.keys(ALLOWED_BINS).filter(k => installed[k]),
      pty: !pty.__err,
      pty_error: pty.__err || null,
    }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handle(ws, msg, sessions);
    });

    ws.on('close', () => {
      for (const [id, s] of sessions) {
        if (s.ws === ws) {
          try {
            if (s.pty) s.pty.kill();
            else if (s.proc) s.proc.kill('SIGTERM');
          } catch {}
          sessions.delete(id);
        }
      }
      log(`[disconnect] origin=${origin}`);
    });
  });

  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`mcli-companion: port ${PORT} already in use.`);
      console.error(`   another instance is probably running. that's fine.`);
      process.exit(0);
    }
    console.error('mcli-companion error:', e);
    process.exit(1);
  });

  process.on('SIGINT', () => { log('shutting down'); wss.close(); process.exit(0); });
  process.on('SIGTERM', () => { log('shutting down'); wss.close(); process.exit(0); });
}

function handle(ws, msg, sessions) {
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  const id = msg.id || crypto.randomBytes(4).toString('hex');

  switch (msg.type) {
    case 'ping':
      send({ type: 'pong', id, ts: Date.now() });
      break;

    case 'spawn': {
      const spec = ALLOWED_BINS[msg.bin];
      if (!spec) return send({ type: 'error', id, error: `bin '${msg.bin}' not allowed` });

      const args = Array.isArray(msg.args) ? msg.args : [];
      const cwd = safeCwd(msg.cwd);
      const env = { ...process.env, ...(msg.env && typeof msg.env === 'object' ? msg.env : {}) };

      let proc;
      try {
        proc = spawn(spec.cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return send({ type: 'error', id, error: e.message });
      }
      sessions.set(id, { ws, proc, bin: msg.bin });

      proc.stdout.on('data', d => send({ type: 'stdout', id, data: d.toString('base64') }));
      proc.stderr.on('data', d => send({ type: 'stderr', id, data: d.toString('base64') }));
      proc.on('exit', (code, sig) => { send({ type: 'exit', id, code, sig }); sessions.delete(id); });
      proc.on('error', (e) => { send({ type: 'error', id, error: e.message }); sessions.delete(id); });
      send({ type: 'spawned', id, pid: proc.pid, bin: msg.bin });
      break;
    }

    case 'stdin': {
      const s = sessions.get(msg.id);
      if (s?.proc) {
        try { s.proc.stdin.write(Buffer.from(msg.data || '', 'base64')); }
        catch (e) { send({ type: 'error', id: msg.id, error: e.message }); }
      }
      break;
    }

    case 'kill': {
      const s = sessions.get(msg.id);
      if (s?.proc) { try { s.proc.kill(msg.sig || 'SIGTERM'); } catch {} }
      break;
    }

    // ---- PTY (pseudo-terminal) branch ---------------------------------------
    // The real `claude` CLI (and codex/gemini/bash) needs a real TTY to render
    // ANSI colors, cursor moves, box-drawing, and to receive raw keystrokes
    // like Ctrl-C without the parent shell intercepting them. Pipe-mode stdio
    // strips all of that. PTY mode is the only way to get the desktop
    // terminal experience inside a browser tab.

    case 'pty_spawn': {
      handlePtySpawn(ws, msg, sessions, id, send).catch(e => {
        send({ type: 'error', id, error: e.message || String(e) });
      });
      break;
    }

    case 'pty_write': {
      const s = sessions.get(msg.id);
      if (s?.pty) {
        try { s.pty.write(Buffer.from(msg.data || '', 'base64').toString('utf8')); }
        catch (e) { send({ type: 'error', id: msg.id, error: e.message }); }
      }
      break;
    }

    case 'pty_resize': {
      const s = sessions.get(msg.id);
      if (s?.pty) {
        // Clamp to at least 1 to avoid xterm crashes. Bogus/missing values
        // become 80x24 defaults, but a caller that explicitly passes 0/-5
        // still gets clamped to 1 (not the default), so pty.resize never
        // receives an invalid dimension.
        const cN = Number(msg.cols); const rN = Number(msg.rows);
        const cols = Math.max(1, Number.isFinite(cN) ? cN : 80);
        const rows = Math.max(1, Number.isFinite(rN) ? rN : 24);
        try { s.pty.resize(cols, rows); }
        catch (e) { send({ type: 'error', id: msg.id, error: e.message }); }
      }
      break;
    }

    case 'pty_kill': {
      const s = sessions.get(msg.id);
      if (s?.pty) {
        try { s.pty.kill(msg.sig); } catch {}
      }
      break;
    }

    // ---- Credentials seeding ------------------------------------------------
    // Real `claude` CLI reads OAuth from ~/.claude/.credentials.json. When the
    // browser has already completed the Anthropic Max OAuth flow, we hand the
    // token to the companion so the CLI picks it up on next spawn. Safety:
    // never overwrite a good existing file unless the token actually differs.

    case 'seed_credentials': {
      try {
        const result = seedCredentials(msg.provider, msg.credentials);
        send({ type: 'credentials_seeded', id, ...result });
      } catch (e) {
        send({ type: 'error', id, error: e.message });
      }
      break;
    }

    case 'read_file': {
      try {
        const p = safePath(msg.path);
        const encoding = msg.encoding === 'base64' ? null : 'utf8';
        const data = fs.readFileSync(p, encoding);
        send({ type: 'file_content', id, path: p, data: encoding ? data : data.toString('base64'), encoding: encoding || 'base64' });
      } catch (e) { send({ type: 'error', id, error: e.message }); }
      break;
    }

    case 'write_file': {
      try {
        const p = safePath(msg.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const data = msg.encoding === 'base64' ? Buffer.from(msg.data, 'base64') : msg.data;
        fs.writeFileSync(p, data);
        send({ type: 'file_written', id, path: p });
      } catch (e) { send({ type: 'error', id, error: e.message }); }
      break;
    }

    case 'list_dir': {
      try {
        const p = safePath(msg.path);
        const entries = fs.readdirSync(p, { withFileTypes: true }).map(d => ({
          name: d.name,
          type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'symlink' : 'file',
        }));
        send({ type: 'dir_listing', id, path: p, entries });
      } catch (e) { send({ type: 'error', id, error: e.message }); }
      break;
    }

    case 'http_request': {
      // Proxy an HTTP request from the browser tab through this companion's
      // network stack. The companion runs on the user's machine → no browser
      // Origin header, real residential IP, User-Agent set to look like CLI.
      // This is what makes OAuth-Bearer requests to api.anthropic.com actually
      // work without a browser extension.
      handleHttp(ws, msg, send, id);
      break;
    }

    default:
      send({ type: 'error', id, error: `unknown type '${msg.type}'` });
  }
}

// ---- PTY spawn (with claude auto-install) ---------------------------------

async function handlePtySpawn(ws, msg, sessions, id, send) {
  const spec = ALLOWED_BINS[msg.bin];
  if (!spec) return send({ type: 'error', id, error: `bin '${msg.bin}' not allowed` });

  const pty = getPty();
  if (pty.__err) {
    return send({ type: 'error', id, error: `node-pty unavailable: ${pty.__err}. try 'npm rebuild node-pty' in the mcli-companion install dir.` });
  }

  // Auto-install claude on first pty_spawn for it. Users shouldn't have to
  // run a separate command — the companion is the "one thing to install"
  // and it should transparently pull in the pinned CLI it needs.
  if (msg.bin === 'claude' && !whichBin('claude')) {
    send({ type: 'install_progress', id, line: `claude not on PATH — installing ${CLAUDE_NPM_PKG}` });
    const ok = await installClaude(line => send({ type: 'install_progress', id, line }));
    if (!ok) return send({ type: 'error', id, error: `failed to install ${CLAUDE_NPM_PKG}` });
    send({ type: 'install_progress', id, line: 'install complete' });
  }

  const args = Array.isArray(msg.args) ? msg.args : [];
  const cwd = safeCwd(msg.cwd);
  const env = { ...process.env, ...(msg.env && typeof msg.env === 'object' ? msg.env : {}) };
  const cols = Math.max(1, Number(msg.cols) || 80);
  const rows = Math.max(1, Number(msg.rows) || 24);

  // Wrapper-first resolution — the real `claude` binary ships with a
  // `#!/usr/bin/env node` shebang that fails on Termux (no /usr/bin/env)
  // and other systems missing env. If a wrapper script exists on PATH
  // (Termux ships `claude-run` that bind-mounts /tmp + patches /bin/sh),
  // prefer it. Same policy for codex/gemini which may have their own
  // wrappers in future.
  const WRAPPER_PREFERENCE = {
    claude: ['claude-run', 'claude'],
    codex:  ['codex-run', 'codex'],
    gemini: ['gemini-run', 'gemini'],
    grok:   ['grok-run', 'grok'],
  };
  const preferred = WRAPPER_PREFERENCE[msg.bin] || [spec.cmd];
  let resolvedCmd = spec.cmd;
  for (const candidate of preferred) {
    if (whichBin(candidate)) { resolvedCmd = candidate; break; }
  }

  let term;
  try {
    term = pty.spawn(resolvedCmd, args, {
      name: 'xterm-color',
      cols, rows, cwd, env,
    });
  } catch (e) {
    return send({ type: 'error', id, error: e.message });
  }

  sessions.set(id, { ws, pty: term, bin: msg.bin });

  term.onData(d => send({ type: 'pty_data', id, data: Buffer.from(d, 'utf8').toString('base64') }));
  term.onExit(({ exitCode, signal }) => {
    send({ type: 'pty_exit', id, code: exitCode, sig: signal });
    sessions.delete(id);
  });

  send({ type: 'pty_spawned', id, pid: term.pid, bin: msg.bin, cols, rows });
}

// Runs `npm install -g @anthropic-ai/claude-code@<pinned>` and streams stdout
// + stderr lines to the browser as install_progress events. Returns bool.
function installClaude(onLine) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn('npm', ['install', '-g', CLAUDE_NPM_PKG], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      onLine(`spawn npm failed: ${e.message}`);
      return resolve(false);
    }
    const stream = (buf) => {
      const s = buf.toString('utf8');
      for (const line of s.split(/\r?\n/)) if (line) onLine(line);
    };
    proc.stdout.on('data', stream);
    proc.stderr.on('data', stream);
    proc.on('error', (e) => { onLine(`npm error: ${e.message}`); resolve(false); });
    proc.on('exit', (code) => resolve(code === 0));
  });
}

// ---- Credentials seeding ---------------------------------------------------

// Map provider → target credentials file. Only anthropic is wired for now —
// codex/gemini use different auth mechanisms (device flow, gcloud SDK) so
// there's nothing to seed for them.
const CREDENTIALS_PATHS = {
  anthropic: path.join(os.homedir(), '.claude', '.credentials.json'),
};

function seedCredentials(provider, creds) {
  if (provider !== 'anthropic') {
    throw new Error(`unsupported provider '${provider}' — only 'anthropic' is wired`);
  }
  if (!creds || typeof creds !== 'object') {
    throw new Error('credentials object required');
  }
  const oauth = creds.claudeAiOauth || creds;
  if (!oauth.accessToken || typeof oauth.accessToken !== 'string') {
    throw new Error('accessToken required in credentials');
  }

  const target = CREDENTIALS_PATHS[provider];
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    claudeAiOauth: {
      accessToken:      oauth.accessToken,
      refreshToken:     oauth.refreshToken || '',
      expiresAt:        oauth.expiresAt || 0,
      scopes:           Array.isArray(oauth.scopes) ? oauth.scopes : [],
      subscriptionType: oauth.subscriptionType || 'max',
    },
  };

  // Safety: never overwrite an existing valid file with the same token.
  // Only rewrite when the token has actually changed. Prevents a stale
  // browser tab from clobbering a fresh CLI-side refresh.
  let action = 'created';
  if (fs.existsSync(target)) {
    try {
      const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
      const existingTok = existing?.claudeAiOauth?.accessToken;
      if (existingTok && existingTok === payload.claudeAiOauth.accessToken) {
        return { path: target, action: 'unchanged' };
      }
      action = 'updated';
    } catch {
      // Existing file is malformed — safe to overwrite.
      action = 'repaired';
    }
  }

  fs.writeFileSync(target, JSON.stringify(payload, null, 2), { mode: 0o600 });
  return { path: target, action };
}

// ---- HTTP proxy ------------------------------------------------------------

const CLI_UA = 'claude-cli/2.1.112 (external, cli)';
const HTTP_ALLOWED_HOSTS = new Set([
  'api.anthropic.com',
  'api.openai.com',
  'chatgpt.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
  'platform.claude.com',
  'console.anthropic.com',
]);

async function handleHttp(ws, msg, send, id) {
  try {
    const url = new URL(msg.url);
    if (!HTTP_ALLOWED_HOSTS.has(url.hostname)) {
      return send({ type: 'error', id, error: `host '${url.hostname}' not allowed` });
    }
    const headers = { ...(msg.headers || {}) };
    // Force CLI-shaped identity — companion is a Node.js process, not a browser
    if (!headers['user-agent'] && !headers['User-Agent']) headers['User-Agent'] = CLI_UA;
    delete headers['origin'];
    delete headers['referer'];

    // Body arrives as string (JSON/text) OR base64-encoded binary depending
    // on msg.encoding. Decode base64 so fetch gets the actual bytes.
    let body;
    if (msg.body == null) body = undefined;
    else if (msg.encoding === 'base64') body = Buffer.from(msg.body, 'base64');
    else body = msg.body;

    const res = await fetch(msg.url, {
      method: msg.method || 'GET',
      headers,
      body,
    });

    send({
      type: 'http_response_head',
      id,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
    });

    // 204 No Content / 304 Not Modified / HEAD responses have res.body === null.
    // Calling .getReader() on null throws TypeError — clean-close the stream instead.
    if (!res.body) { send({ type: 'http_response_end', id }); return; }

    // Stream the body chunks. Base64-encode so binary + SSE both work.
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      send({ type: 'http_response_chunk', id, data: Buffer.from(value).toString('base64') });
    }
    send({ type: 'http_response_end', id });
  } catch (e) {
    send({ type: 'error', id, error: e.message });
  }
}

function safeCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return os.homedir();
  const abs = path.resolve(cwd);
  return abs;
}

function safePath(p) {
  if (typeof p !== 'string' || !p) throw new Error('path required');
  return path.resolve(p);
}

module.exports = {
  start,
  // Test surface — not part of the public API.
  __setPtyForTests,
  __handle: handle,
  __seedCredentials: seedCredentials,
  __installClaude: installClaude,
  __whichBin: whichBin,
  __constants: { CLAUDE_NPM_PKG, CLAUDE_PINNED_VERSION, CREDENTIALS_PATHS, ALLOWED_BINS },
};
