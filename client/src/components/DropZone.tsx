import { useEffect, useState } from "react";
import type { UploadRow } from "../../../shared/api.ts";
import type { StoredFile } from "../lib/localFiles.ts";

export interface Message { tone: "" | "ok" | "err"; lines: string[] }
export const noMessage: Message = { tone: "", lines: [] };

/* "Add data files" button plus drag-and-drop anywhere on the page, and the list of loaded files. */
export function DropZone({ onFiles, uploads, files, onRemove, message, serverMode }: {
  onFiles: (files: File[]) => void;
  uploads?: UploadRow[];          // server mode
  files?: StoredFile[];           // static mode
  onRemove?: (index: number) => void;
  message: Message;
  serverMode: boolean;
}) {
  const [over, setOver] = useState(false);

  useEffect(() => {
    const enter = (e: DragEvent) => { e.preventDefault(); setOver(true); };
    const leave = (e: DragEvent) => { e.preventDefault(); if (!e.relatedTarget) setOver(false); };
    const drop = (e: DragEvent) => {
      e.preventDefault(); setOver(false);
      const list = e.dataTransfer?.files;
      if (list?.length) onFiles([...list]);
    };
    document.addEventListener("dragenter", enter);
    document.addEventListener("dragover", enter);
    document.addEventListener("dragleave", leave);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragenter", enter);
      document.removeEventListener("dragover", enter);
      document.removeEventListener("dragleave", leave);
      document.removeEventListener("drop", drop);
    };
  }, [onFiles]);

  const shown = uploads?.slice(0, 8) ?? [];
  return (
    <div className={`drop${over ? " over" : ""}`} id="drop">
      <label className="btn" htmlFor="file">Add data files</label>
      <input id="file" type="file" multiple accept=".csv,.txt,.dat,.json,text/csv,text/plain,application/octet-stream"
        onChange={e => { const l = e.target.files; if (l?.length) onFiles([...l]); e.target.value = ""; }} />
      <span className="sub">
        or drop them here. Time log (.csv), check-ins (.csv), habits (.dat), activity list (.txt), Oura data (.json) and Mindwtr's data.json are detected automatically.{" "}
        {serverMode ? "Uploads are saved to your account; records already stored are skipped." : "Files stay in this browser."}
      </span>
      <div className="chips" id="chips">
        {serverMode
          ? (uploads?.length
            ? <>
                {shown.map(u => (
                  <span key={u.id} className="chip" title={`Uploaded ${new Date(u.created_at * 1000).toLocaleString("en-GB")}`}>
                    <b>{u.kind}</b>{u.filename} <span className="note">+{u.added}{u.updated ? ` ~${u.updated}` : ""}</span>&nbsp;
                  </span>
                ))}
                {uploads.length > shown.length && <span className="sub">and {uploads.length - shown.length} earlier</span>}
              </>
            : <span className="sub">No uploads yet.</span>)
          : (files?.length
            ? files.map((f, i) => (
                <span key={f.kind + f.name} className="chip">
                  <b>{f.kind}</b>{f.name}{f.year ? ` · ${f.year}` : ""}
                  <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onRemove?.(i)}>×</button>
                </span>
              ))
            : <span className="sub">No files yet.</span>)}
      </div>
      <div className={`msg${message.tone ? " " + message.tone : ""}`} id="upMsg" role="status">
        {message.lines.map((l, i) => <div key={i}>{l}</div>)}
      </div>
    </div>
  );
}
