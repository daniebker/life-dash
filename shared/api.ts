/* Request and response shapes of the server API, shared by the server and the dashboard. */
import type { FileKind, Sources } from "./parsers.ts";

export interface OuraStatus {
  configured: boolean;
  connected: boolean;
  status: "active" | "needs_reauth" | null;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  nextSyncAt: number | null;
  records: number;
}

export interface MindwtrStatus {
  connected: boolean;
  url: string | null;
  username: string | null;
  syncing: boolean;
  lastSyncAt: number | null;
  lastError: string | null;
  nextSyncAt: number | null;
  tasks: number;
  projects: number;
}

export interface Me { user: { username: string }; oura: OuraStatus; mindwtr: MindwtrStatus }
/* GET /api/me when signed out (HTTP 401) */
export interface SignedOut { error: string; setupRequired: boolean; setupCodeRequired: boolean }

export type DataResponse = Sources;

export interface UploadRow {
  id: number; filename: string; kind: FileKind; size: number; created_at: number;
  added: number; updated: number; unchanged: number;
}
export interface UploadResult { duplicate: boolean; upload: UploadRow }

export interface Counts { added: number; updated: number; unchanged: number; removed: number }

export interface OuraSyncResult { skipped?: boolean; added?: number; updated?: number; unchanged?: number; from?: string; error?: string; reauth?: boolean }
export interface MindwtrSyncResult { skipped?: boolean; unchanged?: boolean; added?: number; updated?: number; removed?: number; error?: string }
export interface MindwtrConnectResult extends Counts { url: string }

export interface ApiError { error: string }
