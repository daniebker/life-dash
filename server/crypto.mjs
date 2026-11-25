import { scrypt as _scrypt, randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(_scrypt);
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

// A fixed hash to compare against when the user doesn't exist, so timing doesn't reveal valid usernames.
const DUMMY = "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(KEYLEN).toString("base64");

export async function verifyPassword(password, stored) {
  const [alg, n, r, p, salt, hash] = (stored || DUMMY).split("$");
  if (alg !== "scrypt") return false;
  const expected = Buffer.from(hash, "base64");
  const got = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: +n, r: +r, p: +p });
  return timingSafeEqual(got, expected) && Boolean(stored);
}

// Readable one-time code, e.g. "K7QX-M2PD" (no 0/O/1/I to avoid misreading)
export function setupCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = randomBytes(8);
  const s = [...b].map(x => alphabet[x % alphabet.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normCode = c => String(c || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const codesMatch = (a, b) => {
  const x = Buffer.from(normCode(a)), y = Buffer.from(normCode(b));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};

export const USERNAME_RE = /^[A-Za-z0-9._@-]{1,64}$/;
export function passwordProblem(p) {
  if (typeof p !== "string" || p.length < 10) return "Use a password of at least 10 characters.";
  if (p.length > 1024) return "That password is too long.";
  return null;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sha256 = data => createHash("sha256").update(data).digest("hex");

/* AES-256-GCM for Oura tokens at rest. The key is derived from SECRET_KEY. */
export function makeBox(secret) {
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
