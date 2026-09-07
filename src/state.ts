import { join } from "node:path";

export type ShareState = {
  pid: number;
  port: number;
  url: string | null;
  cwd: string;
  /** Interactive session id passed by /share. */
  sourceSessionId: string;
  /** Session the web chat writes to. Equals sourceSessionId in --live mode. */
  chatSessionId: string | null;
  live: boolean;
  /** global = everyone shares one chat; private = one chat (and one fork) per login. */
  mode: "global" | "private";
  passwordHash: string;
  startedAt: string;
};

export const shareDir = (cwd: string) => join(cwd, ".share");
export const statePath = (cwd: string) => join(shareDir(cwd), "state.json");

export async function readState(cwd: string): Promise<ShareState | null> {
  const f = Bun.file(statePath(cwd));
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as ShareState;
  } catch {
    return null;
  }
}

export async function writeState(cwd: string, s: ShareState): Promise<void> {
  await Bun.write(statePath(cwd), JSON.stringify(s, null, 2));
}
