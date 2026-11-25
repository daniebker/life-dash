import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Logger } from "../server/log.ts";

/* Response of the test HTTP helpers. json is loosely typed on purpose: tests assert on its contents. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Resp { status: number; headers: Headers; json: any }

export async function toResp(res: Response): Promise<Resp> {
  const type = res.headers.get("content-type") || "";
  return { status: res.status, headers: res.headers, json: type.includes("json") ? await res.json() : null };
}

/* A stand-in for the built dashboard, so server tests don't depend on `npm run build`. */
export function fixtureClientDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "life-dash-client-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Life Dash</title><div id=root></div>");
  return dir;
}

export const quiet: Logger = { info() {}, warn() {}, error: (...a: unknown[]) => console.error(...a) };

export const listen = (server: Server): Promise<string> =>
  new Promise(r => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
