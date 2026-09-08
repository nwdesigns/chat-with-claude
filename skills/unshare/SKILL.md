---
name: unshare
description: Stop the shared web chat started by /share — kills the bun server and the cloudflared tunnel, deletes .share/state.json. Use on "/unshare", "stop sharing", "kill the share link".
user-invocable: true
---

# /unshare

Run, with the same cwd that `/share` used:

```bash
bun run /Users/disconnesso/Documents/Projects/chat-with-claude/src/cli.ts stop --cwd "$CWD"
```

Then check that no process remains:

```bash
pgrep -fl "cloudflared tunnel|src/cli.ts start" || echo clean
```

If a process remains, `kill` it by pid and delete `$CWD/.share/state.json`. Report "share stopped" to the user.

Before stopping, run `status` (same command with `status` instead of `stop`) and include the forked session ids in the report: `chatSessionId` (shared chat) and `rooms` (private chats, one per login). Stopping the share does not delete those transcripts. They stay under `~/.claude/projects/<slug>/` and can be reopened with `claude --resume <id>` from `$CWD`. In `--live` mode there is no fork: everything was written into the interactive session.
