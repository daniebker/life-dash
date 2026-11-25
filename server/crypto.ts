import { scrypt as scryptCb, randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv, type BinaryLike, type ScryptOptions } from "node:crypto";

const scrypt = (password: BinaryLike, salt: BinaryLike, keylen: number, opts: ScryptOptions): Promise<Buffer> =>
  new Promise((ok, fail) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? fail(err) : ok(key))));
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// A fixed hash to compare against when the user doesn't exist, so timing doesn't reveal valid usernames.
const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(KEYLEN).toString("base64");

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = (stored || DUMMY).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(got, expected) && Boolean(stored);
}

const normCode = (c: unknown) => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const codesMatch = (a: unknown, b: unknown): boolean => {
  const x = Buffer.from(normCode(a)), y = Buffer.from(normCode(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

export const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== "string" || p.length < 10) return "Use a password of at least 10 characters.";
  if (p.length > 1024) return "That password is too long.";
  return null;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256 = (data: BinaryLike): string => createHash("sha256").update(data).digest("hex");

/* AES-256-GCM for tokens and passwords at rest. The key is derived from SECRET_KEY. */
export interface Box { seal(plain: string | null | undefined): string | null; open(sealed: string | null | undefined): string | null }
export function makeBox(secret: string): Box {
  const key = createHash("sha256").update("life-dash:tokens:" + secret).digest();
  return {
    seal(plain) {
      if (plain == null) return null;
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
      return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
    },
    open(sealed) {
      if (!sealed) return null;
      const [v, iv, tag, ct] = sealed.split(".");
      if (v !== "v1") throw new Error("Unknown token format");
      const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
      d.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
    },
  };
}
