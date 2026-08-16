# mcli-companion

Runs the real `claude`, `codex`, `gemini`, `grok`, `gh`, `bash` CLIs on your machine and exposes them as a **real terminal in the browser** — either same-device at `http://localhost:8127/` or from any device on the internet via a cloudflared tunnel.

Your subscription, your IP, your files. Nothing leaves your machine except the bytes you type and the bytes the CLI prints back.

## Run — self-hosted browser terminal (new in v1.2.0)

```bash
npx mcli-companion@latest             # legacy: WebSocket-only, drive from mcli.mobilecli.com
npx -p mcli-companion mcli-term       # NEW: local terminal at http://localhost:8127/
npx -p mcli-companion mcli-term claude # auto-spawn claude on connect
npx -p mcli-companion mcli-term --tunnel claude  # + public HTTPS via cloudflared
```

`mcli-term` starts the companion AND serves a self-contained xterm.js UI (all assets vendored). Open the URL it prints in any browser on any device. `--tunnel` requires `cloudflared` on `PATH` and prints a `https://*.trycloudflare.com` URL that works on iPhone Safari, Android Chrome, laptops, borrowed computers — anything with a browser. Token auth is force-enabled when `--tunnel` is passed.

Stop everything: `mcli-term --stop`.

## Legacy — PWA companion (unchanged)

```bash
npx mcli-companion@latest
```

Then open `https://mcli.mobilecli.com`. The PWA detects the companion on `ws://127.0.0.1:8127` and routes real-CLI spawns through it.

## What it does

- **Self-hosted browser terminal** at `GET /` — vendored xterm.js + fit addon, mobile-IME-safe (Wetty `contenteditable` pattern + `beforeinput` listener — see notes below). Same origin as the WebSocket, so zero CORS / PNA / mixed-content issues.
- **WebSocket** at `ws://127.0.0.1:8127` for the legacy PWA path (`mcli.mobilecli.com`).
- **PTY spawning** of allow-listed CLIs (`claude`, `codex`, `gemini`, `grok`, `gh`, `bash`, `sh`, `node`, `python`, `git`) via `node-pty`.
- **Auto-install** of `@anthropic-ai/claude-code@2.1.112` on first `claude` spawn if the binary isn't on `PATH`.
- **Credential seeding** — writes `~/.claude/.credentials.json` from a browser-supplied OAuth token so the real `claude` CLI picks it up.
- **HTTP proxy** — forwards browser requests to an allow-listed set of AI provider hosts with a CLI-shaped `User-Agent` and no browser Origin header.
- **Bearer-token auth** via `MCLI_COMPANION_TOKEN` (auto-generated when `mcli-term --tunnel` is used) — required on every request when set.

## What it doesn't do

- Binds to `127.0.0.1` by default. Only accepts external connections if you set `MCLI_COMPANION_HOST=0.0.0.0` (LAN) or expose it via cloudflared/tailscale (which terminates on your machine).
- Rejects any WebSocket Origin that isn't (a) whitelisted (`mcli.mobilecli.com`) or (b) same-origin as the request host. Combined with token auth, that's the security boundary for tunneled exposure.
- Doesn't collect data, doesn't phone home, doesn't log any user input to disk (only the standard `[connect]/[disconnect]` audit lines).
- Doesn't touch any files you don't ask it to.
- Doesn't run any binary that isn't on its allow-list.

## Mobile IME (why typing now works on Android + iOS)

xterm.js #5108: on Android GBoard the default helper `<textarea>` (1×1, opacity 0) is treated as "not really an editor" — text buffers until double-Enter. On iOS Safari the tiny off-screen textarea causes autozoom and focus loss. The bundled terminal fixes this with the proven Wetty pattern:

1. Full-viewport transparent overlay over xterm (`opacity:0`, `pointer-events:auto`, `z-index:5`, `font-size:16px` — the last stops iOS autozoom).
2. `.xterm-screen` set to `contenteditable="true"` — GBoard now sees a real editor.
3. `beforeinput` listener catches per-keystroke events, `compositionstart`/`compositionend` handle IME predictive text without double-fire, `input` is the fallback.
4. Data routed through `term._core.coreService.triggerDataEvent()` — same call xterm's own `CompositionHelper` uses.

Sources: [Wetty mobile.ts](https://github.com/butlerx/wetty/blob/main/src/client/wetty/mobile.ts), [xterm.js #5108](https://github.com/xtermjs/xterm.js/issues/5108).

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
- `MCLI_COMPANION_HOST` — bind address (default `127.0.0.1`; set to `0.0.0.0` for LAN)
- `MCLI_COMPANION_TOKEN` — if set, required on every HTTP + WS request as `?t=<token>`. `mcli-term --tunnel` auto-generates and persists a 64-char hex token in `~/.mcli-term/token`.

## Any-device access via tunnel

The cleanest way to reach your terminal from any device:

```bash
mcli-term --tunnel claude
# → local:  http://127.0.0.1:8127/?bin=claude&t=<hex>
# → public: https://<random>.trycloudflare.com/?bin=claude&t=<hex>
```

Bookmark the public URL on your iPhone / laptop / borrowed computer. The `?t=<hex>` token gates every hit — anyone without it gets a 401. The tunnel terminates on your machine, so your subscription, your files, your `~/.claude/` config are the ones running the CLI.

Requires [cloudflared](https://github.com/cloudflare/cloudflared/releases) on `PATH`. On Termux: `pkg install cloudflared`. Alternative tunnels (ngrok, tailscale funnel) work identically — just point them at `http://127.0.0.1:8127` and re-use the token.

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
