"use client";

import { CheckCircle2, CircleAlert, LoaderCircle, Upload, User } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { PIECES_ABOVE_BYTES, uploadInPieces } from "../../upload-pieces";

type Item = { id: number; file: File; status: "waiting" | "uploading" | "done" | "failed"; sent: number; error?: string };

function formatBytes(value: number) {
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function send(token: string, file: File, from: string, onProgress: (sent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const body = new FormData();
    if (from) body.append("from", from);
    body.append("file", file, file.name);
    const request = new XMLHttpRequest();
    request.open("POST", `/s/${encodeURIComponent(token)}/upload`);
    request.setRequestHeader("x-filedude-request", "1");
    request.upload.onprogress = (event) => onProgress(Math.min(event.loaded, file.size));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) return resolve();
      let message = "The upload failed";
      try {
        message = (JSON.parse(request.responseText) as { error?: string }).error || message;
      } catch {
        // Not JSON: keep the general message.
      }
      reject(new Error(message));
    };
    request.onerror = () => reject(new Error("The connection was lost"));
    request.send(body);
  });
}

/** The page someone with an upload link sees: choose or drop files and send them, one at a time. */
export function UploadDrop({ pieces, token, folderName, perFileBytes, roomBytes, roomFiles }: { pieces: boolean; token: string; folderName: string; perFileBytes: number; roomBytes: number; roomFiles: number | null }) {
  const [items, setItems] = useState<Item[]>([]);
  const [from, setFrom] = useState("");
  const [dragging, setDragging] = useState(false);
  const room = useRef({ bytes: roomBytes, files: roomFiles });
  const queue = useRef<Item[]>([]);
  const running = useRef(false);
  const nextId = useRef(1);

  const update = (id: number, change: Partial<Item>) => setItems((current) => current.map((item) => (item.id === id ? { ...item, ...change } : item)));

  const run = async () => {
    if (running.current) return;
    running.current = true;
    while (queue.current.length) {
      const item = queue.current.shift()!;
      if (item.file.size > perFileBytes) {
        update(item.id, { status: "failed", error: `Larger than the ${formatBytes(perFileBytes)} allowed per file` });
        continue;
      }
      if (room.current.files === 0 || item.file.size > room.current.bytes) {
        update(item.id, { status: "failed", error: room.current.files === 0 ? "This link takes no more files" : "Not enough room left on this link" });
        continue;
      }
      update(item.id, { status: "uploading" });
      try {
        const progress = (sent: number) => update(item.id, { sent });
        // Large files go in pieces, so they get through proxies with a request size limit.
        if (pieces && item.file.size > PIECES_ABOVE_BYTES) await uploadInPieces({ base: `/s/${encodeURIComponent(token)}/upload/pieces`, start: { from: from.trim() } }, item.file, progress, new AbortController().signal);
        else await send(token, item.file, from.trim(), progress);
        room.current = { bytes: room.current.bytes - item.file.size, files: room.current.files === null ? null : room.current.files - 1 };
        update(item.id, { status: "done", sent: item.file.size });
      } catch (error) {
        update(item.id, { status: "failed", error: (error as Error).message });
      }
    }
    running.current = false;
  };

  const add = (files: File[]) => {
    if (!files.length) return;
    const added = files.map((file) => ({ id: nextId.current++, file, status: "waiting" as const, sent: 0 }));
    queue.current.push(...added);
    setItems((current) => [...current, ...added]);
    void run();
  };

  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    // Folders can't be sent through a link; only the files dropped are.
    const files = Array.from(event.dataTransfer.items ?? [])
      .filter((item) => item.kind === "file" && !item.webkitGetAsEntry?.()?.isDirectory)
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));
    add(files.length || !event.dataTransfer.items ? files : Array.from(event.dataTransfer.files));
  };

  const done = items.filter((item) => item.status === "done");
  const busy = items.some((item) => item.status === "uploading" || item.status === "waiting");
  return (
    <div className="upload-drop">
      <label className="upload-from"><span>Your name (optional)</span><div className="login-input"><User size={17} /><input value={from} onChange={(event) => setFrom(event.target.value)} maxLength={64} placeholder="So they know who sent it" disabled={busy} /></div></label>
      <label className={`upload-zone ${dragging ? "dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={drop}>
        <Upload size={26} />
        <strong>Drop files here or choose them</strong>
        <span>Up to {formatBytes(perFileBytes)} per file · {formatBytes(roomBytes)}{roomFiles !== null ? ` and ${roomFiles} ${roomFiles === 1 ? "file" : "files"}` : ""} left on this link</span>
        <input type="file" multiple onChange={(event) => { add(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      </label>
      {items.length > 0 && <ul className="upload-list">{items.map((item) => (
        <li key={item.id} className={item.status}>
          <span className="upload-status">{item.status === "done" ? <CheckCircle2 size={16} /> : item.status === "failed" ? <CircleAlert size={16} /> : <LoaderCircle className={item.status === "uploading" ? "spin" : ""} size={16} />}</span>
          <div>
            <strong title={item.file.name}>{item.file.name}</strong>
            <small>{item.status === "failed" ? item.error : item.status === "done" ? `${formatBytes(item.file.size)} · sent` : item.status === "uploading" ? `${formatBytes(item.sent)} of ${formatBytes(item.file.size)}` : `${formatBytes(item.file.size)} · waiting`}</small>
            {item.status === "uploading" && <progress max={item.file.size || 1} value={item.sent} />}
          </div>
        </li>
      ))}</ul>}
      {done.length > 0 && !busy && <p className="share-meta"><CheckCircle2 size={14} /> {done.length} {done.length === 1 ? "file was" : "files were"} sent to {folderName}. You can close this page.</p>}
    </div>
  );
}
