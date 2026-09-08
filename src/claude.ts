// Spawn `claude -p` for one turn and stream its stream-json events.
// Parse logic adapted from claude-code-slack-chat/src/claude/client.ts.

export type ImageAttachment = {
  name: string;
  mediaType: string;
  base64: string;
};

export type TurnOptions = {
  cwd: string;
  /** Session id to resume. null = start a new session (no transcript exists yet). */
  sessionId: string | null;
  /** true = --fork-session (co-worker gets a copy). false = write into the real session. */
  fork: boolean;
  images?: ImageAttachment[];
  /** Absolute paths of non-image uploads. Appended to the prompt. */
  files?: string[];
  /** Display name of the person writing. Told to Claude in the system prompt. */
  userName?: string;
};

export type TurnEvent =
  | { type: "init"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; text: string }
  | { type: "result"; sessionId: string; text: string; isError: boolean }
  | { type: "error"; message: string }
  | {
      type: "user";
      text: string;
      attachments: string[];
      name?: string;
      id?: string;
      /** Set when the message came from a recorded voice note: the transcript. */
      voice?: string;
    }
  | { type: "done" };

function buildUserMessage(prompt: string, opts: TurnOptions): string {
  let text = prompt;
  if (opts.files && opts.files.length > 0) {
    text +=
      "\n\nAttached files (read them with your tools):\n" +
      opts.files.map((f) => `- ${f}`).join("\n");
  }
  const content: unknown[] = [];
  for (const img of opts.images ?? []) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.base64 },
    });
  }
  content.push({ type: "text", text });
  return (
    JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n"
  );
}

/** Run one turn. Yields events as the CLI emits them. */
export async function* runTurn(
  prompt: string,
  opts: TurnOptions,
): AsyncGenerator<TurnEvent> {
  const args = [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    // The web chat is used by co-workers who may write in Italian or other languages.
    "--append-system-prompt",
    "You are answering through a web chat. Always reply in the language of the user's latest message. If the user writes in Italian, answer in Italian." +
      (opts.userName ? ` The person writing now is ${opts.userName}.` : ""),
  ];
  if (opts.sessionId) args.push("--resume", opts.sessionId);
  if (opts.sessionId && opts.fork) args.push("--fork-session");

  const proc = Bun.spawn(args, {
    cwd: opts.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "true" },
  });
  proc.stdin.write(buildUserMessage(prompt, opts));
  await proc.stdin.end();
  // Drain stderr concurrently: a full stderr pipe would block the child before stdout ends.
  const stderrText = new Response(proc.stderr).text();

  const decoder = new TextDecoder();
  let buf = "";
  let gotResult = false;
  let emptyError = false; // result with is_error and no text: the reason is on stderr
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "system" && ev.subtype === "init") {
        yield { type: "init", sessionId: ev.session_id };
      } else if (ev.type === "assistant" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "text") yield { type: "text", text: block.text };
          else if (block.type === "tool_use")
            yield { type: "tool_use", name: block.name, input: block.input };
        }
      } else if (ev.type === "user" && ev.message?.content) {
        for (const block of ev.message.content) {
          if (block.type === "tool_result") {
            const c = block.content;
            const text =
              typeof c === "string"
                ? c
                : Array.isArray(c)
                  ? c
                      .filter((x: any) => x.type === "text")
                      .map((x: any) => x.text)
                      .join("\n")
                  : "";
            yield { type: "tool_result", text: text.slice(0, 2000) };
          }
        }
      } else if (ev.type === "result") {
        gotResult = true;
        const isError = ev.is_error === true || ev.subtype !== "success";
        const text = ev.result ?? "";
        emptyError = isError && !text;
        yield { type: "result", sessionId: ev.session_id, text, isError };
      }
    }
  }
  const stderr = await stderrText;
  const code = await proc.exited;
  if (!gotResult || emptyError)
    yield {
      type: "error",
      message: stderr.trim() || `claude exited with code ${code}`,
    };
}
