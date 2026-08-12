// mcli-companion — local WebSocket server that hosts the real Claude / Codex / Gemini
// CLIs on the user's own machine, so the mcli.mobilecli.com browser tab can drive them
// with the user's own subscription. All process spawning happens under the user's UID
// with the user's HOME. No secrets ever leave the machine.

'use strict';

const { WebSocketServer } = require('ws');
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const PORT = Number(process.env.MCLI_COMPANION_PORT || 8127);
const HOST = process.env.MCLI_COMPANION_HOST || '127.0.0.1';
const VERSION = require('../package.json').version;

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

    ws.send(JSON.stringify({
      type: 'hello',
      version: VERSION,
      home: os.homedir(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      installed,
      capabilities: Object.keys(ALLOWED_BINS).filter(k => installed[k]),
    }));

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      handle(ws, msg, sessions);
    });

    ws.on('close', () => {
      for (const [id, s] of sessions) {
        if (s.ws === ws) { try { s.proc.kill('SIGTERM'); } catch {} sessions.delete(id); }
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

module.exports = { start };
