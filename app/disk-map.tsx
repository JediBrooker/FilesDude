"use client";

import { ChevronRight, CircleAlert, FolderOpen, LoaderCircle, PieChart } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { FolderSize } from "@/lib/folder-size";
import { gatherSmall, squarify } from "@/lib/treemap";
import type { FileEntry } from "@/lib/types";
import { encodePath, formatBytes, Modal, requestJson } from "./file-manager";

// Where a folder's space goes, as a map: each file and folder inside is a block in proportion to its
// size (folders by everything in them, counted by the server), and a folder's block opens it.

const WIDTH = 1000;
const HEIGHT = 560;
// Items smaller than this share of the folder are drawn together as one block.
const SMALL_SHARE = 0.004;

type Block = { kind: "folder" | "video" | "image" | "audio" | "archive" | "document" | "other" | "rest"; name: string; path: string | null; bytes: number; files?: number; count?: number };
type MapData = { folder: string; blocks: Block[]; total: number; complete: boolean; uncounted: number };

const VIDEO = /\.(mp4|m4v|mkv|mov|avi|webm|wmv|mpg|mpeg|ts|m2ts|flv)$/i;
const IMAGE = /\.(jpe?g|png|gif|webp|avif|heic|heif|tiff?|bmp|raw|cr2|nef|arw|dng)$/i;
const AUDIO = /\.(mp3|m4a|m4b|flac|wav|ogg|opus|aac|wma|alac)$/i;
const ARCHIVE = /\.(zip|tar|gz|tgz|bz2|xz|zst|7z|rar|iso|img)$/i;
const DOCUMENT = /\.(pdf|docx?|xlsx?|pptx?|odt|ods|txt|md|csv|epub)$/i;

function kindOf(entry: FileEntry): Block["kind"] {
  if (entry.type === "directory") return "folder";
  return VIDEO.test(entry.name) ? "video" : IMAGE.test(entry.name) ? "image" : AUDIO.test(entry.name) ? "audio" : ARCHIVE.test(entry.name) ? "archive" : DOCUMENT.test(entry.name) ? "document" : "other";
}

const LEGEND: Array<[Block["kind"], string]> = [["folder", "Folders"], ["video", "Video"], ["image", "Pictures"], ["audio", "Audio"], ["archive", "Archives and disk images"], ["document", "Documents"], ["other", "Other files"]];

export function DiskMapDialog({ startPath, home, onClose, onOpenFolder }: { startPath: string; home: string; onClose: () => void; onOpenFolder: (path: string) => void }) {
  const [folder, setFolder] = useState(startPath);
  const [data, setData] = useState<MapData | null>(null);
  const [error, setError] = useState<{ folder: string; message: string } | null>(null);
  const [hovered, setHovered] = useState<Block | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    // The folder's own items, and how much each folder in it holds (both kept to the account's folder).
    Promise.all([
      requestJson<{ entries: FileEntry[] }>(`/api/fs?path=${encodePath(folder)}&hidden=true`, { signal: controller.signal }),
      requestJson<{ sizes: Record<string, FolderSize>; complete: boolean }>(`/api/fs/folder-size?path=${encodePath(folder)}&children=1`, { signal: controller.signal }),
    ]).then(([listing, sizes]) => {
      let uncounted = 0;
      const blocks: Block[] = [];
      for (const entry of listing.entries) {
        if (entry.type === "symlink") continue;
        if (entry.type === "directory") {
          const size = sizes.sizes[entry.name];
          if (!size) {
            uncounted += 1;
            continue;
          }
          blocks.push({ kind: "folder", name: entry.name, path: entry.path, bytes: size.bytes, files: size.files });
        } else blocks.push({ kind: kindOf(entry), name: entry.name, path: entry.path, bytes: entry.size });
      }
      setData({ folder, blocks, total: blocks.reduce((sum, block) => sum + block.bytes, 0), complete: sizes.complete, uncounted });
      setError(null);
    }).catch((caught: Error) => { if (!controller.signal.aborted) setError({ folder, message: caught.message }); });
    return () => controller.abort();
  }, [folder]);

  const shown = data?.folder === folder ? data : null;
  const rects = useMemo(() => {
    if (!shown) return [];
    const gathered = gatherSmall(shown.blocks.map((block) => ({ value: block.bytes, data: block })), SMALL_SHARE, (count): Block => ({ kind: "rest", name: `${count.toLocaleString()} smaller items`, path: null, bytes: 0, count }));
    // The gathered block's size is the sum it stands for.
    return squarify(gathered.map((item) => ({ value: item.value, data: item.data.kind === "rest" ? { ...item.data, bytes: item.value } : item.data })), WIDTH, HEIGHT);
  }, [shown]);

  const base = home ? home.split("/") : [];
  const parts = folder ? folder.split("/") : [];
  const crumbs = [{ label: home ? base.at(-1)! : "All files", path: home }, ...parts.slice(base.length).map((part, index) => ({ label: part, path: parts.slice(0, base.length + index + 1).join("/") }))];
  const focus = hovered ?? null;
  return (
    <Modal title="Disk usage" subtitle="Each block is in proportion to the space it takes; open a folder's block to look inside" icon={<PieChart size={19} />} onClose={onClose} wide>
      <div className="storage-browser disk-map">
        <div className="disk-map-head">
          <nav className="snapshot-crumbs" aria-label="Folder">
            {crumbs.map((crumb, index) => <span key={crumb.path || "root"}>{index > 0 && <ChevronRight size={13} />}<button onClick={() => setFolder(crumb.path)}><bdi>{crumb.label}</bdi></button></span>)}
          </nav>
          <button className="button secondary" onClick={() => onOpenFolder(folder)}><FolderOpen size={15} /> Open in the file list</button>
        </div>
        {error?.folder === folder && <div className="form-error"><CircleAlert size={16} />{error.message}</div>}
        <div className="disk-map-summary muted">
          {shown ? <>{formatBytes(shown.total)} in {shown.blocks.length.toLocaleString()} {shown.blocks.length === 1 ? "item" : "items"}{!shown.complete || shown.uncounted ? ` · counting stopped early, so ${shown.uncounted ? `${shown.uncounted.toLocaleString()} ${shown.uncounted === 1 ? "folder isn't" : "folders aren't"} shown` : "some folders may be larger"}` : ""}</> : !error ? "Counting…" : ""}
          {focus && <strong className="disk-map-focus"><bdi>{focus.name}</bdi> · {formatBytes(focus.bytes)}{shown?.total ? ` · ${((focus.bytes / shown.total) * 100).toFixed(1)}%` : ""}{focus.files !== undefined ? ` · ${focus.files.toLocaleString()} ${focus.files === 1 ? "file" : "files"}` : ""}</strong>}
        </div>
        <div className="disk-map-canvas" role="list" aria-label="Space taken" onMouseLeave={() => setHovered(null)}>
          {!shown && !error && <div className="snapshot-empty"><LoaderCircle className="spin" size={22} /><span>Counting what&apos;s in this folder…</span></div>}
          {shown && !rects.length && <div className="snapshot-empty"><span>Nothing here takes any space.</span></div>}
          {rects.map((rect, index) => {
            const block = rect.data;
            const big = rect.width > 90 && rect.height > 44;
            const style = { left: `${(rect.x / WIDTH) * 100}%`, top: `${(rect.y / HEIGHT) * 100}%`, width: `${(rect.width / WIDTH) * 100}%`, height: `${(rect.height / HEIGHT) * 100}%` };
            const label = `${block.name}, ${formatBytes(block.bytes)}`;
            const content = big && <span className="disk-map-label"><bdi>{block.name}</bdi><small>{formatBytes(block.bytes)}</small></span>;
            return block.kind === "folder"
              ? <button key={block.path ?? index} role="listitem" className="disk-map-block map-folder" style={style} title={`${label} — open`} aria-label={`${label}. Open`} onMouseEnter={() => setHovered(block)} onFocus={() => setHovered(block)} onClick={() => block.path !== null && setFolder(block.path)}>{content}</button>
              : <div key={block.path ?? `rest-${index}`} role="listitem" className={`disk-map-block map-${block.kind}`} style={style} title={label} aria-label={label} onMouseEnter={() => setHovered(block)}>{content}</div>;
          })}
        </div>
        <div className="disk-map-legend">{LEGEND.map(([kind, label]) => <span key={kind}><i className={`map-${kind}`} />{label}</span>)}</div>
      </div>
    </Modal>
  );
}
