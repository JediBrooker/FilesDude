"use client";

import { ChevronRight, CircleAlert, Download, File, FileArchive, Folder, Link2, LoaderCircle, PackageOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ArchiveItem, ArchiveListing } from "@/lib/archive-browse";
import type { FileEntry, JobState } from "@/lib/types";
import { CheckBox, formatBytes, formatDate, Modal, requestJson } from "./file-manager";

// Looks inside an archive without extracting it: its folders, a preview of a file, downloading one
// file, and extracting just the items chosen (into a new folder beside the archive).

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const AUDIO = /\.(mp3|m4a|ogg|flac|wav)$/i;
const VIDEO = /\.(mp4|webm)$/i;
const TEXT = /\.(txt|md|markdown|log|csv|tsv|json|xml|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|py|rb|js|mjs|cjs|ts|tsx|jsx|css|scss|html?|svg|c|h|cpp|hpp|java|kt|go|rs|php|sql|srt|vtt|nfo)$/i;
const MAX_TEXT_PREVIEW = 1024 * 1024;
const MAX_MEDIA_PREVIEW = 64 * 1024 * 1024;

const entryUrl = (archive: string, entry: string, download = false) => `/api/fs/archive-entry?${new URLSearchParams({ path: archive, entry, ...(download ? { download: "1" } : {}) })}`;

function ItemIcon({ item }: { item: ArchiveItem }) {
  if (item.type === "directory") return <Folder size={16} />;
  if (item.type === "link") return <Link2 size={16} />;
  return <File size={16} />;
}

function Preview({ archive, item }: { archive: string; item: ArchiveItem }) {
  const [text, setText] = useState<{ path: string; value: string } | null>(null);
  const [failed, setFailed] = useState<{ path: string; message: string } | null>(null);
  const kind = IMAGE.test(item.name) ? "image" : AUDIO.test(item.name) ? "audio" : VIDEO.test(item.name) ? "video" : TEXT.test(item.name) ? "text" : null;
  const tooLarge = kind === "text" ? item.size > MAX_TEXT_PREVIEW : item.size > MAX_MEDIA_PREVIEW;

  useEffect(() => {
    if (kind !== "text" || tooLarge || item.encrypted) return;
    const controller = new AbortController();
    fetch(entryUrl(archive, item.path), { signal: controller.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || "It couldn't be read");
        setText({ path: item.path, value: await response.text() });
      })
      .catch((error: Error) => { if (!controller.signal.aborted) setFailed({ path: item.path, message: error.message }); });
    return () => controller.abort();
  }, [archive, item, kind, tooLarge]);

  const body = item.encrypted
    ? <div className="snapshot-empty"><CircleAlert size={20} /><span>This file is encrypted, so it can&apos;t be shown.</span></div>
    : !kind || tooLarge
      ? <div className="snapshot-empty"><File size={22} /><strong>{item.name}</strong><span>{tooLarge ? "Too large to preview here." : "No preview for this kind of file."} Download it to open it.</span></div>
      : kind === "image" ? <img className="archive-preview-image" src={entryUrl(archive, item.path)} alt={item.name} /> // eslint-disable-line @next/next/no-img-element -- a file inside an archive, served by FilesDude
        : kind === "audio" ? <audio controls src={entryUrl(archive, item.path)} />
          : kind === "video" ? <video controls src={entryUrl(archive, item.path)} />
            : failed?.path === item.path ? <div className="form-error"><CircleAlert size={16} />{failed.message}</div>
              : text?.path === item.path ? <pre className="archive-preview-text">{text.value}</pre>
                : <div className="snapshot-empty"><LoaderCircle className="spin" size={20} /></div>;
  return (
    <div className="archive-preview">
      <div className="archive-preview-head"><strong title={item.path}>{item.name}</strong><span className="muted">{formatBytes(item.size)}{item.modified ? ` · ${formatDate(item.modified)}` : ""}</span></div>
      {body}
      {!item.encrypted && <a className="button secondary" href={entryUrl(archive, item.path, true)} download={item.name}><Download size={15} /> Download</a>}
    </div>
  );
}

export function ArchiveBrowserDialog({ entry, canWrite, onClose, onJob, notify }: {
  entry: FileEntry;
  canWrite: boolean;
  onClose: () => void;
  onJob: (job: JobState) => Promise<boolean>;
  notify: (message: string, tone?: "error") => void;
}) {
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<ArchiveListing | null>(null);
  const [error, setError] = useState("");
  // Chosen items belong to the folder they were chosen in.
  const [chosen, setChosen] = useState<{ folder: string; paths: Set<string> }>({ folder: "", paths: new Set() });
  const [previewing, setPreviewing] = useState<ArchiveItem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<ArchiveListing>(`/api/fs/archive-browse?${new URLSearchParams({ path: entry.path, folder })}`, { signal: controller.signal })
      .then((next) => {
        setListing(next);
        setError("");
      })
      .catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message); });
    return () => controller.abort();
  }, [entry.path, folder]);

  const shown = listing?.folder === folder ? listing : null;
  const selected = chosen.folder === folder ? chosen.paths : new Set<string>();
  const extractable = useMemo(() => (shown?.items ?? []).filter((item) => item.type === "file" || item.type === "directory"), [shown]);
  const toggle = (item: ArchiveItem) => {
    const next = new Set(selected);
    if (next.has(item.path)) next.delete(item.path);
    else next.add(item.path);
    setChosen({ folder, paths: next });
  };
  const allChosen = extractable.length > 0 && extractable.every((item) => selected.has(item.path));
  const open = (item: ArchiveItem) => {
    if (item.type === "directory") {
      setFolder(item.path);
      setPreviewing(null);
    } else if (item.type === "file") setPreviewing(item);
  };
  const extract = async (paths: string[] | null) => {
    setBusy(true);
    try {
      const { job } = await requestJson<{ job: JobState }>("/api/fs/archive", { method: "POST", body: JSON.stringify({ action: "extract", path: entry.path, ...(paths ? { select: paths } : {}) }) });
      await onJob(job);
      onClose();
    } catch (caught) {
      notify((caught as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  const crumbs = folder ? folder.split("/") : [];
  const stem = entry.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, "");
  return (
    <Modal title={entry.name} subtitle={shown ? `${shown.format === "zip" ? "Zip" : shown.format === "tar" ? "Tar" : "Gzipped tar"} archive · ${shown.entries.toLocaleString()} ${shown.entries === 1 ? "item" : "items"}` : "Reading the archive…"} icon={<FileArchive size={19} />} onClose={onClose} wide>
      <div className="storage-browser archive-browser">
        <nav className="snapshot-crumbs" aria-label="Folder in the archive">
          <button onClick={() => { setFolder(""); setPreviewing(null); }}>{entry.name}</button>
          {crumbs.map((part, index) => <span key={index}><ChevronRight size={13} /><button onClick={() => { setFolder(crumbs.slice(0, index + 1).join("/")); setPreviewing(null); }}>{part}</button></span>)}
        </nav>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        {shown && (shown.unsafe > 0 || shown.truncated) && <div className="storage-scan-note"><CircleAlert size={15} /> {[shown.unsafe ? `${shown.unsafe.toLocaleString()} ${shown.unsafe === 1 ? "item has" : "items have"} unsafe names and ${shown.unsafe === 1 ? "isn't" : "aren't"} shown: the whole archive can't be extracted, only items you choose` : "", shown.truncated ? "Only part of this archive is shown: it's very large" : ""].filter(Boolean).join(" · ")}</div>}
        <div className={`archive-layout ${previewing ? "previewing" : ""}`}>
          <div className="snapshot-entries" role="table" aria-label="Archive contents">
            <div className="snapshot-entry snapshot-entry-header" role="row">
              {canWrite ? <CheckBox checked={allChosen} onChange={() => setChosen({ folder, paths: allChosen ? new Set() : new Set(extractable.map((item) => item.path)) })} label="Choose everything here" /> : <span />}
              <span>Name</span><span>Size</span><span>Modified</span><span />
            </div>
            {!shown && !error && <div className="snapshot-empty"><LoaderCircle className="spin" size={20} /><span>Reading the archive…</span></div>}
            {shown && !shown.items.length && <div className="snapshot-empty"><span>This folder is empty.</span></div>}
            {shown?.items.map((item) => {
              const usable = item.type === "file" || item.type === "directory";
              return (
                <div key={item.path} className={`snapshot-entry ${previewing?.path === item.path ? "active" : ""}`} role="row">
                  {canWrite && usable ? <CheckBox checked={selected.has(item.path)} onChange={() => toggle(item)} label={`Choose ${item.name}`} /> : <span />}
                  {usable
                    ? <button className="snapshot-entry-name archive-entry-name" onClick={() => open(item)} title={item.type === "directory" ? `Open ${item.name}` : `Preview ${item.name}`}><ItemIcon item={item} /><bdi>{item.name}</bdi></button>
                    : <span className="snapshot-entry-name archive-entry-name muted" title="Links and special files are never extracted"><ItemIcon item={item} /><bdi>{item.name}</bdi></span>}
                  <span className="muted">{item.type === "directory" ? `${(item.items ?? 0).toLocaleString()} ${item.items === 1 ? "item" : "items"}` : item.type === "file" ? formatBytes(item.size) : item.type === "link" ? "Link" : "Special"}</span>
                  <span className="muted">{item.modified ? formatDate(item.modified) : ""}</span>
                  {item.type === "file" && !item.encrypted ? <a className="icon-button" href={entryUrl(entry.path, item.path, true)} download={item.name} aria-label={`Download ${item.name}`} title="Download"><Download size={15} /></a> : <span />}
                </div>
              );
            })}
          </div>
          {previewing && <Preview archive={entry.path} item={previewing} />}
        </div>
        <div className="storage-scan-foot">
          <span className="muted">{canWrite ? `Extracting makes a new folder beside the archive ("${stem}")${selected.size ? `, with the ${selected.size === 1 ? "item" : `${selected.size} items`} you chose` : ""}.` : "Your account can look inside and download, but not extract."}</span>
          <div className="archive-actions">
            <button className="button secondary" onClick={onClose}>Done</button>
            {canWrite && selected.size > 0 && <button className="button secondary" disabled={busy} onClick={() => void extract([...selected])}>{busy ? <LoaderCircle className="spin" size={15} /> : <PackageOpen size={15} />} Extract {selected.size === 1 ? "1 item" : `${selected.size} items`}</button>}
            {canWrite && <button className="button primary" disabled={busy || !shown || shown.unsafe > 0} title={shown && shown.unsafe > 0 ? "This archive has unsafe names, so only items you choose can be extracted" : undefined} onClick={() => void extract(null)}><PackageOpen size={15} /> Extract all</button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
