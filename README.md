# COS Glasses Server

Self-hosted AI heads-up display for **Even G2 smart glasses**. Runs on your
**Windows, Linux, or macOS** machine, talks to your local **Claude Code** CLI,
and pushes answers, voice transcription, and notes to the lens — via the COS
Glasses app on your **Android or iOS** phone. Your data never leaves your
machine, and no API key is pasted into the phone for chat.

> This fork is the cross-platform port of
> [ukaoma/cos-glasses-server](https://github.com/ukaoma/cos-glasses-server)
> (originally Mac + iPhone only).

## Quick start

```bash
git clone https://github.com/BigY0shi/COS-glasses-android.git
cd COS-glasses-android
npm install
npm start
```

The launcher checks Node, finds your CLI, downloads the local voice model, writes
`~/.cos-glasses/.env`, and starts the server on `0.0.0.0:3141`. On boot it prints
an **API token** — paste that into the COS Glasses app.

## Requirements

- **Node.js 20.11+** — https://nodejs.org
- **Claude Code CLI** (Opus/Sonnet/Haiku) — https://claude.ai/download, then `claude login`
  _or_ **Codex CLI** (Codex High) — https://developers.openai.com/codex/, then `codex login`
- **Even G2 glasses** + the **COS Glasses** app from the Even Hub
- _Optional:_ **whisper.cpp** for free local voice (otherwise OpenAI API):
  - macOS / Linux: `brew install whisper-cpp`
  - Windows: grab a release build from https://github.com/ggml-org/whisper.cpp/releases and put it on your `PATH`
- _Optional:_ **Tailscale** so your phone reaches your computer from anywhere

> No `ANTHROPIC_API_KEY` is needed — chat runs through your installed CLI, billed
> to your existing Claude or Codex subscription. Pick either per query, or set a
> default with `COS_G2_DEFAULT_MODEL` (`opus`|`sonnet`|`haiku`|`codex-high`).
> Codex runs **sandboxed read-only** by default (`COS_CODEX_SANDBOX` to adjust).

## Connect your phone (the one gotcha)

The glasses app runs on your phone and must reach this server on your computer.

1. The launcher binds `0.0.0.0` (all interfaces) for you.
2. **Same WiFi (simplest):** find your computer's LAN IP
   (Windows: `ipconfig` · Linux: `ip addr` · macOS: System Settings > Wi-Fi > Details),
   and in the COS Glasses app enter `http://192.168.x.x:3141`.
3. **From anywhere:** install **Tailscale** on the computer + phone (same account),
   note the computer's `100.x` address, and enter `http://100.x.x.x:3141`.
4. Either way, paste the **API token** the server printed at boot.
5. **Windows only:** allow Node through Windows Defender Firewall when prompted on
   first run (or add an inbound rule for TCP 3141).

To restrict the server to localhost only, set `BIND_HOST=127.0.0.1` in `~/.cos-glasses/.env`.
The built-in IP allowlist blocks public-internet traffic regardless.

## What it does

- Ask anything, get a streamed answer on the lens (`/api/query`, `/v1/chat/completions`)
- Live voice capture + transcription during meetings
- Local whisper.cpp transcription (free) with OpenAI fallback (optional)
- Tasks / calendar / people context **if** you run the
  [COS Starter Kit](https://www.gotcos.com) (`COS_SCRIPTS_DIR`); otherwise it is
  glasses + AI only

## Configuration

Config lives at `~/.cos-glasses/.env` (created on first run; on Windows that is
`C:\Users\<you>\.cos-glasses\.env`). Every key is optional except an installed
CLI. Highlights: `BIND_HOST`, `PORT`, `COS_API_TOKEN` (auto if unset),
`OPENAI_API_KEY` (cloud voice fallback), `COS_SCRIPTS_DIR` (full pipeline).
Your name + transcription vocabulary live in `~/.cos-glasses/.cos-profile.json`
(see `.cos-profile.example.json`).

## Troubleshooting

- *Phone can't connect* — check `BIND_HOST=0.0.0.0`, the firewall rule (Windows), the same Tailscale account on both devices, and the correct `100.x` IP + token.
- *AI queries fail* — run `claude --version` / `codex --version`, then `claude login` / `codex login`.
- *Voice getting billed?* — install whisper.cpp for free local transcription (see Requirements).

## License

MIT. Based on COS Glasses Server — learn more at [gotcos.com](https://www.gotcos.com).
