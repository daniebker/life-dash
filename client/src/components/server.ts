import type { Me } from "../../../shared/api.ts";

/* What the panels need from the app in server mode. null in static mode. */
export interface ServerCtx {
  me: Me;
  updateMe: (patch: Partial<Pick<Me, "oura" | "mindwtr">>) => void;
  reload: () => Promise<void>;
  signedOut: () => void;
}

export interface Note { tone: "" | "ok" | "err"; text: string }
export const noNote: Note = { tone: "", text: "" };
