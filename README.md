# mcli-companion

Local runtime for [mcli.mobilecli.com](https://mcli.mobilecli.com).

Runs the real `claude`, `codex`, `gemini`, `grok` CLIs on your machine and exposes them over a WebSocket the browser can drive. Your subscription, your IP, your files. Nothing leaves your machine.

## Run

```bash
npx mcli-companion@latest
```

That's it. Open `https://mcli.mobilecli.com` and the terminal will connect automatically.

To make it always-on, install globally:

```bash
npm i -g mcli-companion
mcli-companion
```

## What it does

Listens on `ws://127.0.0.1:8127` for connections from `https://mcli.mobilecli.com`. When the browser tab sends a `spawn` or `pty_spawn` message, the companion runs the corresponding CLI as a subprocess under your user account and pipes stdio (or full PTY bytes) back over the WebSocket.

## What it doesn't do

- Doesn't listen on any external interface (127.0.0.1 only)
- Doesn't accept connections from any origin except mcli.mobilecli.com
- Doesn't collect data, doesn't phone home, doesn't log anything to disk
- Doesn't touch any files you don't ask it to
- Doesn't run any binary that isn't on its allow-list (claude, codex, gemini, grok, bash, sh, node, python, git)

## Prereqs

Any subset of these installed globally on your `PATH`:

```bash
npm i -g @anthropic-ai/claude-code
npm i -g @openai/codex
npm i -g @google/gemini-cli
```

The companion will **auto-install** `@anthropic-ai/claude-code@2.1.112` (the pinned Termux-safe version) the first time the browser asks to spawn `claude` via a PTY. See "Auto-install" below.

## Environment

- `MCLI_COMPANION_PORT` — port to listen on (default `8127`)
- `MCLI_COMPANION_HOST` — bind address (default `127.0.0.1`, don't change unless you know what you're doing)

## Protocol

All messages are JSON over WebSocket, both directions. Binary is base64-encoded so a single text frame carries everything.

### Client → server

| Type | Purpose |
|------|---------|
| `ping` | Keep-alive |
| `spawn` | Legacy pipe-mode spawn (stdout/stderr as separate streams). Use when you don't need a TTY. |
| `stdin` | Feed bytes to a `spawn` subprocess |
| `kill` | Signal a `spawn` subprocess |
| `pty_spawn` | Spawn a binary attached to a pseudo-terminal. Full ANSI, cursor control, raw keys. **Use this for interactive CLIs like `claude`.** |
| `pty_write` | Feed keystrokes / bytes to a PTY session |
| `pty_resize` | Resize the PTY (e.g. when the xterm.js widget resizes) |
| `pty_kill` | Signal / terminate the PTY session |
| `seed_credentials` | Write `~/.claude/.credentials.json` so the real `claude` CLI picks up an OAuth token from the browser session |
| `read_file` / `write_file` / `list_dir` | Sandbox-less file I/O against the host machine |
| `http_request` | Proxy an HTTP call through the companion's network stack (CLI User-Agent, real IP, no browser Origin header) |

### Server → client

| Type | Purpose |
|------|---------|
| `hello` | Sent on connect. Includes `version`, `home`, `platform`, `arch`, `installed`, `pty` (bool). |
| `pong` | Reply to `ping` |
| `stdout` / `stderr` / `exit` | Pipe-mode subprocess I/O |
| `pty_spawned` | PTY started; includes `pid`, `cols`, `rows` |
| `pty_data` | Bytes from the PTY (base64) — feed straight into an xterm.js `.write()` |
| `pty_exit` | PTY closed; includes `code`, `sig` |
| `install_progress` | Streamed lines while auto-installing `claude` |
| `credentials_seeded` | Reply to `seed_credentials`; includes `path` and `action` (`created` / `updated` / `unchanged` / `repaired`) |
| `file_content` / `file_written` / `dir_listing` | File-op replies |
| `http_response_head` / `http_response_chunk` / `http_response_end` | Streamed HTTP proxy reply |
| `error` | Any failure; includes `id` and `error` string |

### PTY session example

```js
// Browser side (pseudo-code with xterm.js)
const ws = new WebSocket('ws://127.0.0.1:8127');
const term = new Terminal();
const id = crypto.randomUUID();

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.type === 'pty_data' && m.id === id) {
    term.write(atob(m.data));
  }
  if (m.type === 'install_progress') console.log('install:', m.line);
};
ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'pty_spawn',
    id, bin: 'claude', args: [],
    cols: term.cols, rows: term.rows,
    cwd: '/home/user/my-project',
  }));
};

term.onData(d => ws.send(JSON.stringify({
  type: 'pty_write', id, data: btoa(d),
})));
term.onResize(({ cols, rows }) => ws.send(JSON.stringify({
  type: 'pty_resize', id, cols, rows,
})));
```

### Credentials seeding

The real `claude` CLI reads OAuth from `~/.claude/.credentials.json`. If your browser tab already has the user's Anthropic Max token (from the mcli.mobilecli.com session), hand it to the companion **before** spawning `claude`:

```js
ws.send(JSON.stringify({
  type: 'seed_credentials',
  provider: 'anthropic',
  credentials: {
    accessToken: 'sk-ant-oat01-...',
    refreshToken: '...',
    expiresAt: 1791234567890,
    scopes: ['user:inference'],
    subscriptionType: 'max',
  },
}));
```

The companion writes the file with mode `0600` in the correct shape (`{"claudeAiOauth": {...}}`). If a file already exists with the same token, `action` returns `unchanged` (nothing is overwritten). If the token differs, `action` returns `updated`.

### Auto-install

On the first `pty_spawn` for `bin: 'claude'`, if `claude` isn't on `PATH`, the companion runs `npm install -g @anthropic-ai/claude-code@2.1.112` and streams each line back as `install_progress` events. Once install completes, the PTY spawn proceeds. Users never have to run a separate install command.

## Native module note

`node-pty` is a **native module**. On most systems `npm install mcli-companion` builds it automatically. If you see errors like `Cannot find module '.../pty.node'`, rebuild:

```bash
cd $(npm root -g)/mcli-companion
npm rebuild node-pty
```

Prereqs for the build: Python 3, a C++ toolchain (`build-essential` / Xcode CLT / MSVC Build Tools), and `node-gyp`. All standard `npm install` prereqs.

Compatibility notes:

- **macOS / Linux**: native `openpty(3)` — works out of the box once Python + a compiler are installed
- **Termux (Android ARM64)**: builds cleanly with `pkg install python build-essential`. Verified on `aarch64`
- **Windows**: uses ConPTY on Windows 10+ — Node.js 18+ ships with the needed APIs. Requires MSVC Build Tools

## Tests

```bash
npm test
```

Runs the WebSocket protocol tests (mock PTY) plus credentials-seeding tests. To smoke-test a real bash PTY end-to-end:

```bash
node tests/smoke_bash_pty.cjs
```

## License

MIT
