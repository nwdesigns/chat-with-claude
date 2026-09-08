# chat-with-claude

Share a running Claude Code session as a web chat. A co-worker opens a
`trycloudflare.com` URL, enters a one-time password, and talks to Claude
with the same tool access as your interactive session.

CAUTION: the chat runs with `--permission-mode bypassPermissions`. Anyone with
the password can run any command on your machine as your user. Share the
password over a private channel and run `/unshare` when done.

## Install

Requires [Bun](https://bun.sh), `cloudflared` (`brew install cloudflared`) and a
logged-in Claude Code CLI. Voice messages also need `ffmpeg` and `whisper-cpp`
(`brew install ffmpeg whisper-cpp`, then `whisper-cli --download-model small`).

```bash
git clone git@github.com:nwdesigns/chat-with-claude.git
cd chat-with-claude && bun install
# expose /share and /unshare to every Claude Code session on this machine
cp -R skills/share skills/unshare ~/.claude/skills/
```

The skills in `skills/` call `cli.ts` by absolute path. If the clone lives
somewhere other than `~/Documents/Projects/chat-with-claude`, edit the path in
both `SKILL.md` files after copying.

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

`/share` prints:

```
URL:      https://xxxx.trycloudflare.com
Password: abcd1234
Session:  FORK of <id> — the web chat gets its own session id at its first message
Chat:     shared (or private)
CAUTION:  anyone with the password has the same tool access as this session.
```

## Sessions: what talks to what

| Share command       | Web chat writes to                                   | Your interactive session |
| ------------------- | ---------------------------------------------------- | ------------------------ |
| `/share`            | one fork of your session, shared by all participants | untouched                |
| `/share --private`  | one fork per login                                   | untouched                |
| `/share --live`     | your session itself                                  | gets the web messages    |

A fork is a copy of your conversation so far. Claude in the web chat knows
everything you discussed up to `/share`, but nothing you say afterwards, and
you do not see the web messages in your terminal. The fork gets its own id at
the web chat's first message. Later web turns resume that id, so the web chat
keeps its own memory.

Where the ids live, and how to reopen a chat later:

```bash
bun run src/cli.ts status --cwd <project dir>
# {"sourceSessionId": "...", "chatSessionId": "<shared fork>", "rooms": {"5c218e89": {"name": "Anna", "chatSessionId": "<Anna's fork>"}}}
claude --resume <id>     # from the same project dir
```

`/unshare` stops the server but keeps the transcripts under
`~/.claude/projects/<slug>/`.

A running share keeps its server process. After you update this repo, run
`/unshare` and `/share` again to pick up server-side changes. The page files in
`public/` are served fresh on every request.

## The chat page

- nwdesigns.it branding: tokens from the site's `globals.css`, Mulish and Space
  Mono from Google Fonts, monogram and favicon in `public/`.
- Claude replies in the language of the latest message (system prompt addition).
- An activity bubble shows "Thinking", "Running <tool>" and "Elaborating" while
  a turn runs. Tool calls appear as small badges. Markdown is rendered with
  `marked` and sanitized with DOMPurify.
- Shared chat: other people's messages sit on the left with an author label,
  your own on the right. A second message while a turn runs gets a 409 and an
  error bubble. Private chat: each login has its own history and can send at
  any time.
- Files: drag and drop, paste, or the paperclip. Images go to Claude as image
  blocks, everything else is saved under `.share/uploads/` and read with tools.
- Voice messages: the microphone button records until you press it again. The
  recording is sent as a file named `voice-*.webm` (or `.m4a` on Safari). The
  server converts it with `ffmpeg` and transcribes it with `whisper-cli`
  (whisper.cpp, language auto-detected, model `~/.cache/whisper-cpp/ggml-small.bin`
  or the bundled tiny model). Claude receives the transcript as text. The
  bubble shows the transcript with a "voice message" label. Recording needs
  HTTPS or localhost, so it works through the tunnel.
- Reload keeps the chat: history is replayed from the server. A server restart
  logs everyone out.

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

One `claude -p` child per turn. One turn at a time per room. Images
(png/jpg/gif/webp) go to Claude as base64 image blocks. Other files (video, PDF,
docs, max 200 MB) are saved to disk and their absolute paths are appended to the
prompt. Claude reads them with its tools.

Notes learned the hard way:

- A fresh interactive session has no transcript file under
  `~/.claude/projects/<slug>/` until its first message, and `--resume` then
  fails. The server checks for the file and starts a new session instead. In
  `--live` mode it reports an error and asks for one interactive message first.
- `--fork-session` yields a new id on every use, so only the first turn forks.
  Later turns resume the forked id (`chatSessionId` in `.share/state.json` for
  the shared room, in memory for private rooms).
- Cloudflare buffers Server-Sent Events, so the page long-polls `/api/poll`
  with a 20 s hold. Bun's `idleTimeout` is raised to 60 s for that.
- `cloudflared` runs with `--config /dev/null`, or a named tunnel in
  `~/.cloudflared/config.yml` hijacks the quick tunnel.

Files: `src/cli.ts` (start/stop/status, tunnel, state), `src/server.ts`
(routes, rooms, uploads), `src/claude.ts` (spawn and stream-json parsing),
`src/auth.ts` (password, tokens, lockout), `src/transcribe.ts` (voice notes),
`src/tunnel.ts`, `src/state.ts`,
`public/` (page), `skills/` (Claude Code skills to copy into `~/.claude/skills/`).

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
