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

Listens on `ws://127.0.0.1:8127` for connections from `https://mcli.mobilecli.com`. When the browser tab sends a `spawn` message, the companion runs the corresponding CLI as a subprocess under your user account and pipes stdio back over the WebSocket.

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

## Environment

- `MCLI_COMPANION_PORT` — port to listen on (default `8127`)
- `MCLI_COMPANION_HOST` — bind address (default `127.0.0.1`, don't change unless you know what you're doing)

## License

MIT
