---
name: share
description: Share this Claude Code session as a password-protected web chat over a Cloudflare quick tunnel. Use on "/share", "share this session", "give a co-worker a chat link". Args — `--live` writes into the real session instead of a fork, `--private` gives each login its own private chat and fork (default is one shared chat), `--port N` changes the local port (default 7777).
user-invocable: true
---

# /share [--live] [--private] [--port N]

Project: `/Users/disconnesso/Documents/Projects/chat-with-claude`

CAUTION: The web chat runs with `bypassPermissions`. A person with the password can run any command on this Mac as this user. Say this in one line when you print the URL.

## Steps

1. Run the start command in the background. Pass the current session id and the current working directory. Forward `--live`, `--private` and `--port` if given. `--live` and `--private` cannot be combined.

```bash
mkdir -p "$CWD/.share"
nohup bun run /Users/disconnesso/Documents/Projects/chat-with-claude/src/cli.ts start --session "$CLAUDE_CODE_SESSION_ID" --cwd "$CWD" $ARGS > "$CWD/.share/start.log" 2>&1 &
```

   `$CWD` is the project directory of the interactive session (the `Bash` tool's `pwd`), not the chat-with-claude project. Use the absolute path to `cli.ts` shown above. Do not copy the password to the clipboard.

2. Wait up to 40 s. Poll `.share/start.log` under the cwd until it contains a JSON line with `"url"`. If `url` is `null`, the tunnel failed. Report the stderr lines above the JSON.

3. Print to the user, in this form:

```
URL:      https://xxxx.trycloudflare.com
Password: abcd1234
Mode:     forked session (or LIVE — writes into this session)
Chat:     shared (everyone sees the same chat) or private (one chat per login)
CAUTION:  anyone with the password has the same tool access as this session.
```

Each participant types a name at login. Take `mode` from the JSON line for the Chat row.

4. Do not store the password anywhere. It exists only in the log line and the user's terminal. Delete `.share/start.log` after printing.

## Stop

Use `/unshare`.
