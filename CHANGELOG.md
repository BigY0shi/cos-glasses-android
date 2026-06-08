# Changelog

## 6.0.0

The server now ships **inside** this package — `npx @gotcos/glasses-server` runs
it directly, with no second repository to clone.

- **Bundled server.** Previous versions cloned a separate app repo at runtime;
  the standalone server is now part of the package tarball.
- **Standalone-first.** Glasses + your local Claude Code CLI. No API key is
  pasted into the phone for chat.
- **Local voice.** Transcription runs on whisper.cpp (free); OpenAI API is an
  optional fallback.
- **Phone reachability.** Defaults `BIND_HOST=0.0.0.0` so the glasses' phone app
  can reach the server over your mesh/LAN. The IP allowlist blocks public traffic.
- **Persistent config** at `~/.cos-glasses/.env`.
- Requires Node.js 20.11+.
