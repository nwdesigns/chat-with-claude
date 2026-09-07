import { join, basename } from "node:path";
import { mkdir } from "node:fs/promises";
import { Auth, type Participant } from "./auth";
import { runTurn, type ImageAttachment, type TurnEvent } from "./claude";
import { readState, writeState, shareDir, type ShareState } from "./state";

const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_FILE = 200 * 1024 * 1024;
const PUBLIC = join(import.meta.dir, "..", "public");

/** Claude stores transcripts at ~/.claude/projects/<cwd with / and . replaced by ->/<id>.jsonl */
async function transcriptExists(
  cwd: string,
  sessionId: string,
): Promise<boolean> {
  const slug = cwd.replace(/[\/.]/g, "-");
  return Bun.file(
    join(
      process.env.HOME ?? "",
      ".claude",
      "projects",
      slug,
      `${sessionId}.jsonl`,
    ),
  ).exists();
}

const sanitize = (name: string) =>
  basename(name)
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 120) || "file";

type ServerOptions = {
  cwd: string;
  port: number;
  state: ShareState;
  secure: boolean;
};

/**
 * One chat. Global mode has a single room shared by everyone.
 * Private mode has one room per login token, each with its own forked session.
 */
class Room {
  busy = false;
  /** In-memory transcript for the browser (replayed on reload). */
  history: TurnEvent[] = [];
  listeners = new Set<() => void>();
  /** Claude session this room writes to. null until the first turn adopts one. */
  chatSessionId: string | null;
  constructor(
    public id: string,
    chatSessionId: string | null,
  ) {
    this.chatSessionId = chatSessionId;
  }
  emit(ev: TurnEvent) {
    this.history.push(ev);
    for (const l of this.listeners) l();
  }
}

export function startServer(o: ServerOptions) {
  const auth = new Auth(o.state.passwordHash);
  const mode = o.state.mode ?? "global";
  const rooms = new Map<string, Room>();
  let turnCounter = 0;

  const roomFor = (p: Participant): Room => {
    const id = mode === "private" ? p.token : "global";
    let r = rooms.get(id);
    if (!r) {
      // Global mode persists its session id in state.json (shown by `cli.ts status`).
      r = new Room(id, id === "global" ? o.state.chatSessionId : null);
      rooms.set(id, r);
    }
    return r;
  };

  const json = (
    data: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: o.port,
    maxRequestBodySize: MAX_FILE * 4,
    // The /api/poll long-poll holds 20 s; Bun's default idleTimeout (10 s)
    // closed the socket mid-hold, which cloudflared reported as EOF.
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;

      if (p === "/api/login" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          password?: string;
          name?: string;
        };
        // The name reaches the prompt: keep it one line of plain characters.
        const name =
          String(body.name ?? "")
            .replace(/[^\p{L}\p{N} .'\-]/gu, "")
            .trim()
            .slice(0, 40) || "Guest";
        const tok = auth.login(String(body.password ?? ""), name);
        if (!tok) return json({ ok: false, lockedMs: auth.locked }, 401);
        return json({ ok: true, name }, 200, {
          "set-cookie": auth.cookie(tok, o.secure),
        });
      }

      // Static UI is public. Everything under /api needs a session.
      if (p.startsWith("/api/")) {
        const who = auth.participant(req);
        if (!who) return json({ error: "unauthorized" }, 401);
        const room = roomFor(who);

        if (p === "/api/state")
          return json({
            busy: room.busy,
            cwd: o.cwd,
            live: o.state.live,
            mode,
            name: who.name,
            id: who.id,
            history: room.history,
          });

        // Long-poll. Cloudflare buffers SSE bodies, so the browser polls with a 20 s hold.
        if (p === "/api/poll") {
          const since = Number(url.searchParams.get("since") ?? 0);
          if (room.history.length <= since) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                room.listeners.delete(wake);
                resolve();
              }, 20_000);
              const wake = () => {
                clearTimeout(timer);
                room.listeners.delete(wake);
                resolve();
              };
              room.listeners.add(wake);
              req.signal.addEventListener("abort", wake);
            });
          }
          return json({
            events: room.history.slice(since),
            next: room.history.length,
            busy: room.busy,
          });
        }

        if (p === "/api/send" && req.method === "POST") {
          if (room.busy)
            return json(
              { error: "A turn is already running. Wait for it to finish." },
              409,
            );
          // Take the lock before the first await so two concurrent sends cannot both pass the guard.
          room.busy = true;
          const reject = (data: unknown, status: number) => {
            room.busy = false;
            return json(data, status);
          };
          let form: FormData;
          try {
            form = await req.formData();
          } catch (e) {
            return reject(
              { error: `bad form data: ${e instanceof Error ? e.message : e}` },
              400,
            );
          }
          const text = String(form.get("text") ?? "").trim();
          const uploads = form
            .getAll("files")
            .filter((f): f is File => f instanceof File && f.size > 0);
          if (!text && uploads.length === 0)
            return reject({ error: "empty message" }, 400);
          for (const f of uploads)
            if (f.size > MAX_FILE)
              return reject({ error: `${f.name} exceeds 200 MB` }, 413);

          turnCounter += 1;
          const dir = join(
            shareDir(o.cwd),
            "uploads",
            String(turnCounter).padStart(4, "0"),
          );
          const images: ImageAttachment[] = [];
          const files: string[] = [];
          try {
            if (uploads.length) await mkdir(dir, { recursive: true });
            for (const f of uploads) {
              const path = join(dir, sanitize(f.name));
              await Bun.write(path, f);
              if (IMAGE_TYPES.has(f.type)) {
                images.push({
                  name: f.name,
                  mediaType: f.type,
                  base64: Buffer.from(await f.arrayBuffer()).toString("base64"),
                });
              } else {
                files.push(path);
              }
            }
          } catch (e) {
            // A failed upload must release the lock, or the room stays busy forever.
            return reject(
              { error: `upload failed: ${e instanceof Error ? e.message : e}` },
              500,
            );
          }

          room.emit({
            type: "user",
            text: text || "(attachments only)",
            attachments: uploads.map((f) => f.name),
            name: who.name,
            id: who.id,
          });
          (async () => {
            try {
              // Resume the room's adopted session, else the source session. A fresh interactive
              // session has no transcript until its first message, and `--resume` then fails
              // with "No conversation found", so in that case start a new session (null).
              const wanted = room.chatSessionId ?? o.state.sourceSessionId;
              const exists = await transcriptExists(o.cwd, wanted);
              if (!exists && o.state.live) {
                // Live mode must write into the real session. Do not silently create another one.
                room.emit({
                  type: "error",
                  message:
                    "The live session has no transcript yet. Send one message in the interactive Claude Code session first, then retry.",
                });
                return;
              }
              const sessionId = exists ? wanted : null;
              const fork = !o.state.live && !room.chatSessionId;
              // In the shared chat Claude sees who wrote each message.
              const prompt = text || "See the attached files.";
              const spoken =
                mode === "global" ? `${who.name}: ${prompt}` : prompt;
              for await (const ev of runTurn(spoken, {
                cwd: o.cwd,
                sessionId,
                fork,
                images,
                files,
                userName: who.name,
              })) {
                // Adopt the session id from init and from a successful result only.
                // A failed turn must not replace a working id.
                if (
                  ev.type === "init" ||
                  (ev.type === "result" && !ev.isError)
                ) {
                  if (ev.sessionId && ev.sessionId !== room.chatSessionId) {
                    room.chatSessionId = ev.sessionId;
                    if (room.id === "global") {
                      o.state.chatSessionId = ev.sessionId;
                      await writeState(o.cwd, o.state);
                    }
                  }
                }
                room.emit(ev);
              }
            } catch (e) {
              room.emit({
                type: "error",
                message: e instanceof Error ? e.message : String(e),
              });
            } finally {
              room.busy = false;
              room.emit({ type: "done" });
            }
          })();
          return json({ ok: true });
        }
        return json({ error: "not found" }, 404);
      }

      const file = p === "/" ? "index.html" : p.slice(1);
      if (!/^[\w.\-]+$/.test(file))
        return new Response("not found", { status: 404 });
      const f = Bun.file(join(PUBLIC, file));
      if (!(await f.exists()))
        return new Response("not found", { status: 404 });
      return new Response(f);
    },
  });
  return server;
}

// Allow `bun run src/server.ts` for a LAN test against an existing state.json.
if (import.meta.main) {
  const cwd = process.cwd();
  const state = await readState(cwd);
  if (!state) {
    console.error("no .share/state.json — use cli.ts start");
    process.exit(1);
  }
  startServer({ cwd, port: state.port, state, secure: false });
  console.log(`listening on http://127.0.0.1:${state.port}`);
}
