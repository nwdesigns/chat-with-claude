import { timingSafeEqual, randomBytes, createHash } from "node:crypto";

const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(len = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

export const hashPassword = (pw: string) =>
  createHash("sha256").update(pw).digest("hex");

export function passwordMatches(pw: string, hash: string): boolean {
  const a = Buffer.from(hashPassword(pw), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const MAX_FAILS = 5;
const LOCK_MS = 60_000;

/** `id` is a short non-secret handle derived from the token, safe to show to other participants. */
export type Participant = { token: string; id: string; name: string };

export class Auth {
  /** token → participant. In memory only: a server restart logs everyone out. */
  private tokens = new Map<string, Participant>();
  private fails = 0;
  private lockedUntil = 0;
  constructor(private hash: string) {}

  get locked(): number {
    return Math.max(0, this.lockedUntil - Date.now());
  }

  /** Returns a session token or null. `name` is the display name chosen at login. */
  login(pw: string, name: string): string | null {
    if (this.locked > 0) return null;
    if (!passwordMatches(pw, this.hash)) {
      this.fails += 1;
      if (this.fails >= MAX_FAILS) {
        this.lockedUntil = Date.now() + LOCK_MS;
        this.fails = 0;
      }
      return null;
    }
    this.fails = 0;
    const tok = randomBytes(32).toString("hex");
    const id = createHash("sha256").update(tok).digest("hex").slice(0, 8);
    this.tokens.set(tok, { token: tok, id, name });
    return tok;
  }

  /** The participant behind the request's cookie, or null. */
  participant(req: Request): Participant | null {
    const cookie = req.headers.get("cookie") ?? "";
    const m = /(?:^|;\s*)cwc=([a-f0-9]{64})/.exec(cookie);
    return (m && this.tokens.get(m[1]!)) || null;
  }

  check(req: Request): boolean {
    return this.participant(req) !== null;
  }

  cookie(tok: string, secure: boolean): string {
    return `cwc=${tok}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${secure ? "; Secure" : ""}`;
  }
}
