import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const int = (v: string | undefined, d: number): number => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : d; };

export interface OuraConfig {
  clientId: string;
  clientSecret: string;
  scopes: string;
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  redirectUri: string;
  syncIntervalMinutes: number;
  backfillDays: number;
  overlapDays: number;
  configured: boolean;
}

export interface Config {
  port: number;
  host: string;
  publicUrl: string;
  dbPath: string;
  clientDir: string;
  secretKey: string;
  cookieSecure: boolean;
  trustProxy: boolean;
  sessionDays: number;
  maxUploadBytes: number;
  setupCode: string;
  oura: OuraConfig;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const publicUrl = (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 8080)}`).replace(/\/+$/, "");
  const clientId = env.OURA_CLIENT_ID || "", clientSecret = env.OURA_CLIENT_SECRET || "";
  return {
    port: int(env.PORT, 8080),
    host: env.HOST || "127.0.0.1",
    publicUrl,
    dbPath: resolve(env.DB_PATH || resolve(ROOT, "var/life-dash.db")),
    clientDir: resolve(env.CLIENT_DIR || resolve(ROOT, "dist")),
    secretKey: env.SECRET_KEY || "",
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : publicUrl.startsWith("https://"),
    trustProxy: env.TRUST_PROXY === "true",
    sessionDays: int(env.SESSION_DAYS, 30),
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 20) * 1024 * 1024,
    setupCode: env.SETUP_CODE || "",
    oura: {
      clientId,
      clientSecret,
      scopes: env.OURA_SCOPES || "personal daily",
      authorizeUrl: env.OURA_AUTHORIZE_URL || "https://cloud.ouraring.com/oauth/authorize",
      tokenUrl: env.OURA_TOKEN_URL || "https://api.ouraring.com/oauth/token",
      apiBase: (env.OURA_API_BASE || "https://api.ouraring.com/v2/usercollection").replace(/\/+$/, ""),
      redirectUri: `${publicUrl}/api/oura/callback`,
      syncIntervalMinutes: int(env.SYNC_INTERVAL_MINUTES, 60),
      backfillDays: int(env.OURA_BACKFILL_DAYS, 90),
      overlapDays: 3,
      configured: Boolean(clientId && clientSecret),
    },
  };
}

export function assertConfig(cfg: Config): void {
  if (!cfg.secretKey || cfg.secretKey.length < 16) {
    throw new Error("SECRET_KEY must be set to a random string of at least 16 characters (it encrypts stored Oura tokens). Generate one with: openssl rand -hex 32");
  }
}
