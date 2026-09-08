// bun run src/cli.ts start --session <id> [--owner NAME] [--cwd DIR] [--live] [--private] [--port N]
// bun run src/cli.ts stop|status [--cwd DIR]
import { mkdir, unlink } from "node:fs/promises";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { generatePassword, hashPassword } from "./auth";
import {
  readState,
  writeState,
  shareDir,
  statePath,
  type ShareState,
} from "./state";
import { startServer } from "./server";
import { startTunnel } from "./tunnel";

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (n: string) => argv.includes(n);
const cwd = flag("--cwd") ?? process.cwd();

async function newestSession(dir: string): Promise<string | null> {
  const slug = dir.replace(/[\/.]/g, "-");
  const projDir = join(process.env.HOME ?? "", ".claude", "projects", slug);
  try {
    const files = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
    let best: { f: string; m: number } | null = null;
    for (const f of files) {
      const m = (await stat(join(projDir, f))).mtimeMs;
      if (!best || m > best.m) best = { f, m };
    }
    return best ? best.f.replace(/\.jsonl$/, "") : null;
  } catch {
    return null;
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

if (cmd === "start") {
  const existing = await readState(cwd);
  if (existing && alive(existing.pid)) {
    console.error(`already running (pid ${existing.pid}): ${existing.url}`);
    process.exit(2);
  }
  const session =
    flag("--session") ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    (await newestSession(cwd));
  if (!session) {
    console.error("no session id: pass --session <id>");
    process.exit(1);
  }
  const port = Number(flag("--port") ?? 7777);
  // Name printed by ListAgents in the owner session. Optional: without it the handoff is file-only.
  const ownerName = flag("--owner");
  const live = has("--live");
  const mode = has("--private") ? "private" : "global";
  if (live && mode === "private") {
    console.error(
      "--live and --private cannot be combined: one real session cannot host separate private chats",
    );
    process.exit(1);
  }
  const password = generatePassword();
  await mkdir(shareDir(cwd), { recursive: true });
  const state: ShareState = {
    pid: process.pid,
    port,
    url: null,
    cwd,
    sourceSessionId: session,
    ownerName,
    chatSessionId: live ? session : null,
    live,
    mode,
    passwordHash: hashPassword(password),
    startedAt: new Date().toISOString(),
  };
  await writeState(cwd, state);
  startServer({ cwd, port, state, secure: true });
  let tunnelProc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const t = await startTunnel(port, join(shareDir(cwd), "cloudflared.log"));
    tunnelProc = t.proc;
    state.url = t.url;
    await writeState(cwd, state);
  } catch (e) {
    console.error(`tunnel failed: ${e instanceof Error ? e.message : e}`);
  }
  // Password is printed once, to stdout, and never stored in clear.
  console.log(
    JSON.stringify({ url: state.url, port, password, session, live, mode }),
  );
  const stop = async () => {
    tunnelProc?.kill();
    try {
      await unlink(statePath(cwd));
    } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} else if (cmd === "stop") {
  const s = await readState(cwd);
  if (!s) {
    console.log("not running");
    process.exit(0);
  }
  if (alive(s.pid)) process.kill(s.pid, "SIGTERM");
  // Server unlinks state on SIGTERM. Fall back after a short wait.
  await Bun.sleep(1500);
  try {
    await unlink(statePath(cwd));
  } catch {}
  console.log(`stopped pid ${s.pid}`);
} else if (cmd === "status") {
  const s = await readState(cwd);
  if (!s || !alive(s.pid)) {
    console.log("not running");
    process.exit(0);
  }
  console.log(
    JSON.stringify({
      pid: s.pid,
      url: s.url,
      port: s.port,
      live: s.live,
      mode: s.mode ?? "global",
      sourceSessionId: s.sourceSessionId,
      chatSessionId: s.chatSessionId,
      rooms: s.rooms ?? {},
      startedAt: s.startedAt,
    }),
  );
} else {
  console.error(
    "usage: cli.ts start|stop|status [--session ID] [--owner NAME] [--cwd DIR] [--live] [--private] [--port N]",
  );
  process.exit(1);
}
