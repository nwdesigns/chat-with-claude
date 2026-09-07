# chat-with-claude

Share a running Claude Code session as a web chat. A co-worker opens a
`trycloudflare.com` URL, enters a one-time password, and talks to Claude
with the same tool access as your interactive session.

CAUTION: the chat runs with `--permission-mode bypassPermissions`. Anyone with
the password can run any command on your machine as your user. Share the
password over a private channel and run `/unshare` when done.

## Use

Inside Claude Code:

- `/share` — starts the server and tunnel, prints URL + password. The web chat
  works on a **fork** of the current session (`--fork-session`). Your
  interactive transcript is not touched.
- `/share --live` — the web chat writes into the real session. Messages interleave.
- `/share --private` — every login gets its own private chat and its own fork.
  Participants cannot read each other's messages. Default is one **shared** chat
  where everyone sees every message, labelled with the author's name.
- `/share --port 8888` — change the local port (default 7777).
- `/unshare` — stops everything.

Each participant enters a name and the password at login. Claude is told who
is writing. `--live` and `--private` cannot be combined.

Manual:

```bash
bun run src/cli.ts start --session <id> --cwd <project dir> [--live] [--private] [--port N]
bun run src/cli.ts status --cwd <project dir>
bun run src/cli.ts stop --cwd <project dir>
```

## How it works

```
browser ──HTTPS──▶ trycloudflare.com ──▶ cloudflared ──▶ bun server 127.0.0.1:7777
                                                          │ cookie session (password)
                                                          │ uploads → <cwd>/.share/uploads/<turn>/
                                                          ▼
                                            claude -p --resume <id> [--fork-session]
                                              --input-format stream-json --output-format stream-json
                                              --permission-mode bypassPermissions
```

One `claude -p` child per turn. One turn at a time. Images (png/jpg/gif/webp) go
to Claude as base64 image blocks. Other files (video, PDF, docs, max 200 MB) are
saved to disk and their absolute paths are appended to the prompt. Claude reads
them with its tools.

## Security

- Server binds `127.0.0.1` only. Only `cloudflared` reaches it.
- Password: 8 random chars, printed once, stored as SHA-256 in `.share/state.json`.
- 5 wrong passwords → 60 s lock. Cookie is `HttpOnly; SameSite=Lax; Secure`.
- Upload names are sanitized and stored under a per-turn directory. Nothing is executed.
- `.share/` is gitignored.
- Private mode separates what participants **see in the browser**. It is not a
  security boundary: every room runs Claude as the same user with
  `bypassPermissions`, so a participant can ask Claude to read another room's
  transcript or uploads on disk. Share the password only with people you trust.
- Login tokens, rooms and histories live in memory until `/unshare`. Fine for a
  working day, not for a permanent service.

## Dev

```bash
bun install
bun run typecheck
```
