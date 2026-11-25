/* Typed client for the Life Dash server. Every call sends X-Life-Dash, which the server requires on writes. */
import type {
  Me, SignedOut, DataResponse, UploadRow, UploadResult, OuraStatus, OuraSyncResult,
  MindwtrStatus, MindwtrSyncResult, MindwtrConnectResult,
} from "../../../shared/api.ts";

export interface ApiResult<T> { status: number; ok: boolean; json: T | null; error: string | null }

async function call<T>(path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> {
  const res = await fetch(path, { method: init.method ?? "GET", body: init.body, credentials: "same-origin", headers: { "X-Life-Dash": "1", ...init.headers } });
  let json: unknown = null;
  if ((res.headers.get("content-type") || "").includes("json")) json = await res.json().catch(() => null);
  const error = !res.ok && json && typeof json === "object" && "error" in json ? String((json as { error: unknown }).error) : null;
  return { status: res.status, ok: res.ok, json: res.ok ? json as T : null, error: res.ok ? null : error ?? `HTTP ${res.status}` };
}
const postJson = <T>(path: string, body?: object) =>
  call<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

export type Probe = { kind: "signed-in"; me: Me } | { kind: "signed-out"; info: SignedOut } | { kind: "none" };

/* Is there a Life Dash server behind this page? Static hosting, file:// and previews answer "none". */
export async function probe(): Promise<Probe> {
  try {
    const res = await fetch("/api/me", { credentials: "same-origin", headers: { "X-Life-Dash": "1" } });
    if (!(res.headers.get("content-type") || "").includes("json")) return { kind: "none" };
    const body = await res.json() as Me | SignedOut;
    if (res.ok && "user" in body) return { kind: "signed-in", me: body };
    if (res.status === 401 && "setupRequired" in body) return { kind: "signed-out", info: body };
  } catch { /* no server */ }
  return { kind: "none" };
}

export const getMe = () => call<Me>("/api/me");
export const getData = () => call<DataResponse>("/api/data");
export const getUploads = () => call<UploadRow[]>("/api/uploads");
export const login = (username: string, password: string) => postJson<{ user: { username: string } }>("/api/login", { username, password });
export const setup = (username: string, password: string, code?: string) => postJson<{ user: { username: string } }>("/api/setup", { username, password, code });
export const logout = () => postJson<{ ok: true }>("/api/logout");

export const upload = (file: File) => call<UploadResult>("/api/uploads", {
  method: "POST",
  body: file,
  headers: {
    "Content-Type": "application/octet-stream",
    "X-Filename": encodeURIComponent(file.name),
    "X-Last-Modified": String(file.lastModified || ""),
    "X-Tz-Offset": String(-new Date().getTimezoneOffset() * 60),
  },
});

export const ouraSync = () => postJson<OuraSyncResult & { oura: OuraStatus }>("/api/oura/sync");
export const ouraDisconnect = () => postJson<{ oura: OuraStatus }>("/api/oura/disconnect");

export const mindwtrConnect = (url: string, username: string, password: string) =>
  postJson<MindwtrConnectResult & { mindwtr: MindwtrStatus }>("/api/mindwtr/connect", { url, username, password });
export const mindwtrSync = () => postJson<MindwtrSyncResult & { mindwtr: MindwtrStatus }>("/api/mindwtr/sync");
export const mindwtrDisconnect = () => postJson<{ mindwtr: MindwtrStatus }>("/api/mindwtr/disconnect");
