# STATE — chat-with-claude

Updated: 2026-09-07 11:15 CEST.

## Status: working end to end on desktop and phone. Not committed (no git repo yet).

## Fixes 2026-09-07 (user report "still not working")
- Root cause 1: a fresh interactive session has no transcript file under `~/.claude/projects/<slug>/` until its first message, so `claude -p --resume <id>` failed with "No conversation found" and the empty error text showed nothing in the browser. Fix: `server.ts transcriptExists()`; when missing, `claude.ts` starts a new session (no `--resume`) and the returned id is adopted. Also covers `--live`.
- Root cause 2 (phone screenshot): `.screen { display:flex }` beat the `hidden` attribute, so the login card stayed above the chat. Fix: `.screen[hidden] { display:none }`.
- Codex review fixes: `busy` lock taken before the first await in `/api/send` (409 race); stderr drained concurrently (pipe stall); session id adopted only from `init` and a successful `result`.
- `claude.ts` emits an `error` event with stderr when `result` is an error with empty text.
- `/share` skill: absolute path to `cli.ts`, `.share/` under the shared project's cwd, no clipboard.
- Verified: fresh-session turn (FRESH-OK), alexanderkraft.com share via herdr pane `w8:p1` (AK-OK, MOBILE-OK at 400 px), Pi verification pane `w1A:p3`.

## Features 2026-09-07 (requests from Elena via the user)
- Activity bubble (`app.js showActivity/hideActivity`, `.msg.activity` + `.dots`): "Thinking" → "Running <tool>" → "Elaborating", phrases rotate every 6 s, reduced-motion fallback.
- Language: `claude.ts` passes `--append-system-prompt` "reply in the language of the user's latest message". Verified in Italian. Needs a server restart on running shares.
- Branding: nwdesigns.it tokens in `style.css` (source `nwdesigns.it/frontend/src/app/globals.css`), Mulish + Space Mono from Google Fonts, monogram `public/logo.svg` (letter recolored #2B2B2B), `public/favicon.svg`. Aktiv Grotesk not used (Typekit kit is domain-bound).
- Screenshots moved to `.share/shots/`.

## Features 2026-09-07 afternoon: names and chat modes
- Login takes a display name (sanitized to letters, digits, space, `.'-`, max 40, fallback "Guest"). `Auth.participant(req)` → `{token, id, name}`, `id` = sha256(token)[0:8], non-secret.
- `Room` class in `server.ts`: history, busy, listeners, chatSessionId. `--private` → one room per token (own fork). Default global → one room "global" whose session id is persisted to state.json. `--live` + `--private` is rejected by cli.ts.
- Global mode: prompt is prefixed `Name: text`, system prompt says who writes. User events carry `name` and `id`; app.js styles other people's messages left with an author label, ownership by `id`.
- Codex fixes: upload errors release the busy lock; live mode with a missing transcript emits an error instead of a new session; names cannot carry newlines.
- Known limits (README): private mode is a UI separation, not a security boundary (same user, bypassPermissions); tokens/rooms/histories are in memory until `/unshare`.
- Verified: `scratchpad/modes.sh` (private isolation ANNA-OK/BOB-OK; shared chat "Teal, said by Anna."), Pi verification on port 7780.
- The nwdesigns.it share on port 7778 kept running throughout (old server process, new static files, still compatible).

Verified today:
- Text turn + image turn via `--input-format stream-json` (image block accepted, "Red").
- Fork: first web turn uses `--fork-session`, later turns resume the forked id.
- Login lockout: 5 wrong → 60 s lock (401 + lockedMs).
- Through the tunnel (browser, Playwright): login, text turn, tool badge, markdown, PDF upload read by Claude ("PELICAN").
- `cli.ts stop` leaves no bun/cloudflared process and deletes `.share/state.json`.

## Decisions taken during the build
- `cloudflared --config /dev/null`: the user's `~/.cloudflared/config.yml` (named tunnel `localdev`) hijacks quick tunnels → edge 404.
- SSE replaced by long-polling (`/api/poll?since=N`, 20 s hold): Cloudflare buffers SSE bodies (0 bytes in 40 s, QUIC and http2 both).
- Bash hooks block commands whose text contains a password + URL. Test scripts live in `.share/*.sh` (gitignored).

## Open / next
- Optional: `git init` + first commit.
- Playwright screenshots `after-turn.png`, `mobile-after-login.png` in the project root: delete or gitignore.
- `.share/` holds test scripts, probe files, and cloudflared logs. Safe to delete.
