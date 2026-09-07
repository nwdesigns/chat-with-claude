export type Tunnel = { url: string; proc: ReturnType<typeof Bun.spawn> };

/** Start a Cloudflare quick tunnel and resolve when the public URL appears. */
export async function startTunnel(port: number, logPath: string, timeoutMs = 30_000): Promise<Tunnel> {
  const log = Bun.file(logPath).writer();
  const proc = Bun.spawn(["cloudflared", "--config", "/dev/null", "tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("cloudflared: no URL within timeout")), timeoutMs);
    const scan = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      for await (const chunk of stream) {
        log.write(chunk); log.flush();
        const m = re.exec(dec.decode(chunk));
        if (m) { clearTimeout(timer); resolve(m[0]); }
      }
    };
    scan(proc.stderr as ReadableStream<Uint8Array>).catch(() => {});
    scan(proc.stdout as ReadableStream<Uint8Array>).catch(() => {});
    proc.exited.then((code) => { clearTimeout(timer); reject(new Error(`cloudflared exited with ${code}`)); });
  });
  return { url, proc };
}
