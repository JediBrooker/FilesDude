"use client";

import { ChevronRight, CircleAlert, FolderOpen, LoaderCircle, PieChart, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { visibleText } from "@/lib/activity-text";
import type { FolderSize } from "@/lib/folder-size";
import { gatherSmall, squarify } from "@/lib/treemap";
import type { FileEntry } from "@/lib/types";
import { encodePath, formatBytes, Modal, requestJson } from "./file-manager";

// Where a folder's space goes, as a map: each file and folder inside is a block in proportion to its
// size (folders by everything in them, counted by the server), and a folder's block opens it.

// Items smaller than this share of the folder are drawn together as one block.
const SMALL_SHARE = 0.004;
// A block shows its name and size inside only when there's room for them (in pixels).
const LABEL_WIDTH = 72;
const LABEL_HEIGHT = 38;
// Counting is shared with the Size column (two per account at once): a busy reply is tried again.
const RETRY_DELAYS = [300, 1000, 2000];

type Kind = "folder" | "video" | "image" | "audio" | "archive" | "document" | "other" | "rest";
type Block = { kind: Kind; name: string; path: string | null; bytes: number; files?: number };
type MapData = { folder: string; blocks: Block[]; total: number; complete: boolean; uncounted: string[] };

const VIDEO = /\.(mp4|m4v|mkv|mov|avi|webm|wmv|mpg|mpeg|ts|m2ts|flv)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|raw|cr2|nef|arw|dng)$/i;
const AUDIO = /\.(mp3|m4a|m4b|flac|wav|ogg|opus|aac|wma|alac)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|iso|img)$/i;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|txt|md|csv|epub)$/i;

function kindOf(entry: FileEntry): Kind {
  if (entry.type === "directory") return "folder";
  return VIDEO.test(entry.name) ? "video" : IMAGE.test(entry.name) ? "image" : AUDIO.test(entry.name) ? "audio" : ARCHIVE.test(entry.name) ? "archive" : DOCUMENT.test(entry.name) ? "document" : "other";
}

const KIND_LABELS: Record<Kind, string> = { folder: "Folder", video: "Video", image: "Picture", audio: "Audio", archive: "Archive", document: "Document", other: "File", rest: "Smaller items" };
const LEGEND: Array<[Kind, string]> = [["folder", "Folders"], ["video", "Video"], ["image", "Pictures"], ["audio", "Audio"], ["archive", "Archives and disk images"], ["document", "Documents"], ["other", "Other files"]];

const busy = (error: unknown) => (error as { status?: number }).status === 503;
const wait = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = window.setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
});

export function DiskMapDialog({ startPath, home, onClose, onOpenFolder }: { startPath: string; home: string; onClose: () => void; onOpenFolder: (path: string) => void }) {
  const [folder, setFolder] = useState(startPath);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<{ folder: string; message: string } | null>(null);
  const [hovered, setHovered] = useState<{ folder: string; block: Block } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLDivElement | null>(null);

  // The map is laid out in the canvas's own pixels, so blocks stay square and labels fit.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.round(entry.contentRect.width), height: Math.round(entry.contentRect.height) }));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const sizesOf = async () => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await requestJson<{ sizes: Record<string, FolderSize>; complete: boolean }>(`/api/fs/folder-size?path=${encodePath(folder)}&children=1`, { signal: controller.signal });
        } catch (caught) {
          if (!busy(caught) || attempt >= RETRY_DELAYS.length || controller.signal.aborted) throw caught;
          await wait(RETRY_DELAYS[attempt], controller.signal);
        }
      }
    };
    // The folder's own items, and how much each folder in it holds (both kept to the account's folder).
    Promise.all([
      requestJson<{ entries: FileEntry[] }>(`/api/fs?path=${encodePath(folder)}&hidden=true`, { signal: controller.signal }),
      sizesOf(),
    ]).then(([listing, sizes]) => {
      const uncounted: string[] = [];
      const blocks: Block[] = [];
      for (const entry of listing.entries) {
        if (entry.type === "symlink") continue;
        if (entry.type === "directory") {
          // Only the folder's own count, and only a real number of bytes.
          const counted = Object.hasOwn(sizes.sizes, entry.name) ? sizes.sizes[entry.name] : undefined;
          if (!counted || !Number.isFinite(counted.bytes)) {
            uncounted.push(entry.name);
            continue;
          }
          blocks.push({ kind: "folder", name: entry.name, path: entry.path, bytes: counted.bytes, files: counted.files });
        } else if (Number.isFinite(entry.size)) blocks.push({ kind: kindOf(entry), name: entry.name, path: entry.path, bytes: entry.size });
      }
      setData({ folder, blocks, total: blocks.reduce((sum, block) => sum + block.bytes, 0), complete: sizes.complete, uncounted });
      setError(null);
      // After opening a folder, keyboard users carry on in its map.
      window.setTimeout(() => canvasRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true }), 0);
    }).catch((caught: Error) => { if (!controller.signal.aborted) setError({ folder, message: busy(caught) ? "Other folders are still being counted; try again in a moment" : caught.message }); });
    return () => controller.abort();
  }, [folder, reload]);

  const shown = data?.folder === folder ? data : null;
  const rects = useMemo(() => {
    if (!shown || !size.width || !size.height) return [];
    const gathered = gatherSmall(shown.blocks.map((block) => ({ value: block.bytes, data: block })), SMALL_SHARE, (count, value): Block => ({ kind: "rest", name: `${count.toLocaleString()} smaller items`, path: null, bytes: value }));
    return squarify(gathered, size.width, size.height);
  }, [shown, size]);

  const open = (target: string) => {
    setHovered(null);
    setFolder(target);
  };
  const base = home ? home.split("/") : [];
  const parts = folder ? folder.split("/") : [];
  const crumbs = [{ label: home ? base.at(-1)! : "All files", path: home }, ...parts.slice(base.length).map((part, index) => ({ label: part, path: parts.slice(0, base.length + index + 1).join("/") }))];
  const focus = hovered?.folder === folder ? hovered.block : null;
  const describe = (block: Block) => `${KIND_LABELS[block.kind]}, ${visibleText(block.name)}, ${formatBytes(block.bytes)}${shown?.total ? `, ${((block.bytes / shown.total) * 100).toFixed(1)}%` : ""}`;
  return (
    <Modal title="Disk usage" subtitle="Each block is in proportion to the space it takes; open a folder's block to look inside" icon={<PieChart size={19} />} onClose={onClose} wide>
      <div className="storage-browser disk-map">
        <div className="disk-map-head">
          <nav className="snapshot-crumbs" aria-label="Folder">
            {crumbs.map((crumb, index) => <span key={crumb.path || "root"}>{index > 0 && <ChevronRight size={13} />}<button onClick={() => open(crumb.path)}><bdi>{visibleText(crumb.label)}</bdi></button></span>)}
          </nav>
          <button className="button secondary" onClick={() => onOpenFolder(folder)}><FolderOpen size={15} /> Open in the file list</button>
        </div>
        {error?.folder === folder && <div className="form-error"><CircleAlert size={16} />{error.message}<button type="button" className="button secondary" onClick={() => { setError(null); setReload((count) => count + 1); }}><RefreshCw size={14} /> Try again</button></div>}
        <div className="disk-map-summary muted" aria-live="polite">
          {shown ? <span>{formatBytes(shown.total)} in {shown.blocks.length.toLocaleString()} {shown.blocks.length === 1 ? "item" : "items"}{shown.uncounted.length ? ` · not counted (too large to count, or unreadable): ${shown.uncounted.slice(0, 5).map(visibleText).join(", ")}${shown.uncounted.length > 5 ? ` and ${(shown.uncounted.length - 5).toLocaleString()} more` : ""}` : !shown.complete ? " · counting stopped early, so some folders may be larger" : ""}</span> : !error ? "Counting…" : ""}
          {focus && <strong className="disk-map-focus"><bdi>{visibleText(focus.name)}</bdi> · {formatBytes(focus.bytes)}{shown?.total ? ` · ${((focus.bytes / shown.total) * 100).toFixed(1)}%` : ""}{focus.files !== undefined ? ` · ${focus.files.toLocaleString()} ${focus.files === 1 ? "file" : "files"}` : ""}</strong>}
        </div>
        <div ref={canvasRef} className="disk-map-canvas" role="list" aria-label="Space taken" onMouseLeave={() => setHovered(null)}>
          {!shown && !error && <div className="snapshot-empty"><LoaderCircle className="spin" size={22} /><span>Counting what&apos;s in this folder…</span></div>}
          {shown && !rects.length && size.width > 0 && <div className="snapshot-empty"><span>Nothing here takes any space.</span></div>}
          {rects.map((rect, index) => {
            const block = rect.data;
            const style = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
            const content = rect.width >= LABEL_WIDTH && rect.height >= LABEL_HEIGHT && <span className="disk-map-label" aria-hidden><bdi>{visibleText(block.name)}</bdi><small>{formatBytes(block.bytes)}</small></span>;
            const hover = () => setHovered({ folder, block });
            const leave = () => setHovered(null);
            return (
              <div key={block.path ?? `rest-${index}`} role="listitem" className={`disk-map-block map-${block.kind}`} style={style} title={describe(block)} onMouseEnter={hover}>
                {block.kind === "folder"
                  ? <button type="button" aria-label={`${describe(block)}. Open`} onFocus={hover} onBlur={leave} onClick={() => block.path !== null && open(block.path)}>{content}</button>
                  : <span className="disk-map-file" aria-label={describe(block)} tabIndex={0} onFocus={hover} onBlur={leave}>{content}</span>}
              </div>
            );
          })}
        </div>
        <div className="disk-map-legend">{LEGEND.map(([kind, label]) => <span key={kind}><i className={`map-${kind}`} />{label}</span>)}</div>
      </div>
    </Modal>
  );
}
