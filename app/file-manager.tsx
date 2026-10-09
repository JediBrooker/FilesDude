"use client";

import {
  ArrowDownToLine,
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUpNarrowWide,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  ChevronUp,
  CircleAlert,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FilePenLine,
  FileText,
  FileVideo,
  Folder,
  Files,
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Info,
  KeyRound,
  LayoutGrid,
  Link2,
  List,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  PackageOpen,
  Pencil,
  Plus,
  RefreshCw,
  History,
  RotateCcw,
  Scissors,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Undo2,
  Upload,
  UserRoundCog,
  Users,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { moveCursor, selectionRange } from "@/lib/selection";
import { INITIAL_DIRECTION, nextSort, parseSort, sortEntries, type SortKey, type SortState } from "@/lib/sort";
import type { ContentSearchHit, ContentSearchResult, ShareLink } from "@/lib/types";
import type { ArchiveFormat, BulkRenameRule, DeleteResult, DiskInfo, FileEntry, JobState, TransferResult, IdentityOption, LargestFilesProgress, LargestFilesReady, LargestFilesResult, OwnershipPair, RenamePreview, TrashItem, TrashListing, TrashRestoreResult, UploadOwnershipOptions, UploadOwnershipPreference } from "@/lib/types";

type Role = "owner" | "editor" | "viewer";
type AuthState = {
  loading: boolean;
  authenticated: boolean;
  configured: boolean;
  username: string | null;
  role: Role | null;
  /** The folder the account is confined to; "" for the whole root. */
  root: string | null;
  configurationIssues: string[];
};
type ManagedUser = { id: string; username: string; role: "editor" | "viewer"; root: string; createdAt: string; updatedAt: string; twoFactor: boolean };
type TwoFactorStatus = { enabled: boolean; enabledAt: string | null; recoveryCodesLeft: number };

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", editor: "Editor", viewer: "Viewer" };

type DialogState =
  | { kind: "upload"; files: File[] }
  | { kind: "storage" }
  | { kind: "trash" }
  | { kind: "compress" }
  | { kind: "share"; entry: FileEntry }
  | { kind: "shares" }
  | { kind: "users" }
  | { kind: "new" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete" }
  | { kind: "permissions" }
  | { kind: "ownership" }
  | { kind: "transfer"; mode: "copy" | "move" }
  | { kind: "bulk" }
  | { kind: "preview"; entry: FileEntry }
  | { kind: "edit"; entry: FileEntry }
  | { kind: "preferences" }
  | { kind: "twoFactor" }
  | { kind: "snapshots" }
  | { kind: "duplicates" }
  | { kind: "versions"; entry: FileEntry }
  | { kind: "details"; entry: FileEntry }
  | null;

type ViewMode = "list" | "grid";
type SnapshotInfo = { name: string; createdAt: string; used?: number; kind: "auto" | "manual" | "other" };
type SnapshotSchedule = { frequency: "off" | "hourly" | "daily"; keep: number };
type SnapshotAccess = "owner" | "editors" | "everyone";
type SnapshotEntry = { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number; modified: string; mime: string };
type SnapshotVersion = { snapshot: string; snapshotCreatedAt: string; type: SnapshotEntry["type"]; size: number; modified: string };
const SNAPSHOT_KIND_LABELS: Record<SnapshotInfo["kind"], string> = { auto: "Scheduled", manual: "Manual", other: "Other" };

type EntryAction = "versions" | "open" | "edit" | "download" | "favorite" | "rename" | "cut" | "clipboard" | "paste" | "copy" | "move" | "compress" | "extract" | "share" | "permissions" | "ownership" | "details" | "delete";
type FavoriteLocation = { path: string; name: string; createdAt: string };
type SelectOptions = { additive?: boolean; range?: boolean };
type MenuPosition = { top: number; left: number };
type MenuState = ({ kind: "entry"; entry: FileEntry } | { kind: "background" }) & MenuPosition;
type BackgroundChoice = "new" | "upload" | "paste" | "selectAll" | "refresh";
type UndoAction = { done: string; run: () => Promise<void> };
type ClipboardState = { mode: "cut" | "copy"; paths: string[] };
// Drop targets carry their destination folder in data-drop-path and share these handlers.
type DropHandlers = Required<Pick<React.HTMLAttributes<HTMLElement>, "onDragOver" | "onDragLeave" | "onDrop">>;
// Everything list and grid items need for menus, the clipboard, and drag-and-drop.
type EntryInteractions = {
  menuPath: string | null;
  cutPaths: Set<string>;
  sharedPaths: Set<string>;
  canWrite: boolean;
  dropTarget: string | null;
  dropHandlers: DropHandlers;
  onMenuButton: (entry: FileEntry, trigger: DOMRect) => void;
  onContextMenu: (entry: FileEntry, event: React.MouseEvent) => void;
  onDragStart: (entry: FileEntry, event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

const DRAG_TYPE = "application/x-filesdude-paths";
const MENU_WIDTH = 224;
const MULTI_ITEM_ACTIONS: EntryAction[] = ["cut", "clipboard", "copy", "move", "compress", "permissions", "ownership", "delete"];
const ARCHIVE_NAME = /\.(zip|tar\.gz|tgz|tar)$/i;
// Mirrors lib/thumbnails.ts: which images the server makes thumbnails for.
const THUMBNAIL_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/avif"]);
const MAX_THUMBNAIL_SOURCE_BYTES = 64 * 1024 * 1024;
// Properties hashes files up to this size straight away; larger ones wait for a click.
const AUTO_CHECKSUM_BYTES = 64 * 1024 * 1024;

// Baked in at build time by next.config.ts.
const APP_VERSION = process.env.NEXT_PUBLIC_FILESDUDE_VERSION || "dev";
const APP_COMMIT = process.env.NEXT_PUBLIC_FILESDUDE_COMMIT || "";
const APP_BUILT_AT = process.env.NEXT_PUBLIC_FILESDUDE_BUILT_AT || "";

const SORT_LABELS: Record<SortKey, string> = { name: "Name", size: "Size", owner: "Owner", mode: "Permissions", modified: "Modified" };
const SORT_STORAGE_KEY = "filesdude-sort";

function storedSort() {
  try {
    return parseSort(window.localStorage.getItem(SORT_STORAGE_KEY));
  } catch {
    return parseSort(null);
  }
}

const initialAuth: AuthState = {
  loading: true,
  authenticated: false,
  configured: true,
  username: null,
  role: null,
  root: null,
  configurationIssues: [],
};

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value === 0) return value === 0 ? "0 B" : "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : value / 1024 ** index >= 10 ? 1 : 2)} ${units[index]}`;
}

function formatGigabytes(value: number) {
  if (value > 0 && value < 0.01 * 1024 ** 3) return "<0.01 GB";
  return `${(value / 1024 ** 3).toFixed(value >= 10 * 1024 ** 3 ? 1 : 2)} GB`;
}

function csvCell(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function formatDate(value: string) {
  const date = new Date(value);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay
    ? { hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" }
  ).format(date);
}

function encodePath(value: string) {
  return encodeURIComponent(value);
}

function buildUrl(pathValue: string) {
  const params = new URLSearchParams(window.location.search);
  if (pathValue) params.set("path", pathValue);
  else params.delete("path");
  const query = params.toString();
  return `${window.location.pathname}${query ? `?${query}` : ""}`;
}

function ownershipKey(pair: Pick<OwnershipPair, "uid" | "gid">) {
  return `${pair.uid}:${pair.gid}`;
}

function extension(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index + 1).toUpperCase() : "FILE";
}

function isEditable(entry: FileEntry) {
  const textType = entry.mime.startsWith("text/") || entry.mime.includes("json") || entry.mime.includes("javascript") || entry.mime.includes("typescript");
  return entry.type === "file" && textType && entry.size <= 2 * 1024 * 1024;
}

function fileIcon(entry: Pick<FileEntry, "type" | "mime">, size = 20) {
  if (entry.type === "directory") return <Folder size={size} strokeWidth={1.8} />;
  if (entry.mime.startsWith("image/")) return <FileImage size={size} strokeWidth={1.8} />;
  if (entry.mime.startsWith("video/")) return <FileVideo size={size} strokeWidth={1.8} />;
  if (entry.mime.startsWith("audio/")) return <FileAudio size={size} strokeWidth={1.8} />;
  if (entry.mime.includes("zip") || entry.mime.includes("tar") || entry.mime.includes("gzip")) return <FileArchive size={size} strokeWidth={1.8} />;
  if (entry.mime.startsWith("text/") || entry.mime.includes("json")) return <FileCode2 size={size} strokeWidth={1.8} />;
  if (entry.mime === "application/pdf") return <FileText size={size} strokeWidth={1.8} />;
  return <File size={size} strokeWidth={1.8} />;
}

// navigator.clipboard only exists on HTTPS or localhost, so plain-HTTP LAN access falls back to
// the older copy command.
async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the fallback.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  return copied;
}

function shareAddress(link: ShareLink) {
  return `${window.location.origin}${link.url}`;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function isArchive(entry: Pick<FileEntry, "type" | "name">) {
  return entry.type === "file" && ARCHIVE_NAME.test(entry.name);
}

function jobProgressText(job: JobState) {
  const { done, total, unit } = job.progress;
  if (!done) return "Starting…";
  if (unit === "entries") return total ? `${done.toLocaleString()} of ${total.toLocaleString()} entries` : `${done.toLocaleString()} entries`;
  return total ? `${formatBytes(done)} of ${formatBytes(total)}` : formatBytes(done);
}

// Downloads go through a temporary link, which saves the file and leaves the page as it is.
function startDownload(pathValue: string) {
  downloadFrom(`/api/fs/download?path=${encodePath(pathValue)}`);
}

function downloadFrom(url: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

function parentOf(pathValue: string) {
  return pathValue.split("/").slice(0, -1).join("/");
}

function itemCount(count: number) {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

function folderLabel(pathValue: string) {
  return pathValue ? `/${pathValue}` : "Root";
}

function modifierLabel() {
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
}

// Nothing can go into itself or its own subfolders, and moving into the folder it is already in does nothing.
function canDropInto(destination: string, paths: string[], copy: boolean) {
  return paths.length > 0 && paths.every((item) => item !== destination && !destination.startsWith(`${item}/`) && (copy || parentOf(item) !== destination));
}

// Keeps a menu on screen, opening it above the pointer (or at flipY) when there is no room below.
function menuPosition(x: number, y: number, height: number, flipY = y): MenuPosition {
  return {
    left: Math.max(10, Math.min(x, window.innerWidth - MENU_WIDTH - 10)),
    top: y + height > window.innerHeight - 10 ? Math.max(10, flipY - height) : y,
  };
}

// Shortcuts must not fire while someone is typing in a field.
function isTypingTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("input:not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]:not([contenteditable=false])"));
}

// Space and Enter on a focused control should activate that control, not run a shortcut.
function isActivationTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("button, a[href], input, label, select"));
}

function gridColumns() {
  const grid = document.querySelector(".file-grid");
  return grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length) : 1;
}

function formatRemaining(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  if (seconds < 60) return `about ${Math.max(1, Math.round(seconds))}s left`;
  if (seconds < 3600) return `about ${Math.round(seconds / 60)} min left`;
  return `about ${(seconds / 3600).toFixed(1)} h left`;
}

// fetch() cannot report upload progress, so single-file uploads go through XMLHttpRequest.
function uploadFile<T>(url: string, file: File, onProgress: (loaded: number) => void, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    // Progress events count multipart overhead too, so scale them to the file's own size.
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total) onProgress(Math.min(file.size, file.size * (event.loaded / event.total))); };
    xhr.onload = () => {
      settle();
      let data: { error?: string; code?: string } = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch {
        // Non-JSON error pages fall back to the status message below.
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(Object.assign(new Error(data.error || `Request failed (${xhr.status})`), { status: xhr.status, code: data.code }));
    };
    xhr.onerror = () => { settle(); reject(new Error("The connection was interrupted during the upload")); };
    xhr.onabort = () => { settle(); reject(new DOMException("The upload was cancelled", "AbortError")); };
    xhr.open("POST", url);
    xhr.setRequestHeader("x-filedude-request", "1");
    const form = new FormData();
    form.append("files", file);
    xhr.send(form);
  });
}

async function requestJson<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== "GET") headers.set("x-filedude-request", "1");
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  const response = await fetch(url, { ...options, headers, credentials: "same-origin", cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    Object.assign(error, { status: response.status, code: data.code });
    throw error;
  }
  return data as T;
}

export function FileManager() {
  const [auth, setAuth] = useState<AuthState>(initialAuth);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [favorites, setFavorites] = useState<FavoriteLocation[]>([]);
  const [sharedPaths, setSharedPaths] = useState<Set<string>>(new Set());
  const [disk, setDisk] = useState<DiskInfo | null>(null);
  const [currentPath, setCurrentPath] = useState(() => (typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("path") || "" : ""));
  const [history, setHistory] = useState<string[]>(() => [currentPath]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // The cursor is the item keyboard navigation moves from; the anchor is where shift-selection starts.
  const [cursor, setCursor] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [search, setSearch] = useState("");
  const [activeSearch, setActiveSearch] = useState("");
  const [searchMode, setSearchMode] = useState<"names" | "contents">("names");
  const [matchCase, setMatchCase] = useState(false);
  // Bumped on every search submit, so pressing Enter again re-runs the same content search.
  const [searchRun, setSearchRun] = useState(0);
  const [contentSearch, setContentSearch] = useState<{ status: "running" | "done" | "error"; result?: ContentSearchResult; error?: string } | null>(null);
  const contentControllerRef = useRef<AbortController | null>(null);
  const [view, setView] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortState>(() => (typeof window !== "undefined" ? storedSort() : parseSort(null)));
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<{ message: string; tone?: "error"; undo?: UndoAction } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // Background jobs started from this browser (or found running after a reload), oldest first.
  const [jobs, setJobs] = useState<JobState[]>([]);
  // Whether the root is on ZFS, so earlier versions can be browsed in snapshots.
  const [snapshotsAvailable, setSnapshotsAvailable] = useState(false);
  const finishedJobsRef = useRef<Set<string>>(new Set());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const uploadRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const undoRef = useRef<UndoAction | null>(null);
  const dragPathsRef = useRef<string[]>([]);
  const sortedEntries = useMemo(() => sortEntries(entries, sort), [entries, sort]);
  // What the signed-in account may do. The server enforces all of this; the UI just hides what
  // would be refused.
  const home = auth.root ?? "";
  const canWrite = auth.role !== "viewer";
  const isOwner = auth.role === "owner";
  const withinHome = (pathValue: string) => !home || pathValue === home || pathValue.startsWith(`${home}/`);
  const cutPaths = useMemo(() => new Set(clipboard?.mode === "cut" ? clipboard.paths : []), [clipboard]);

  // An undo is only offered while its own toast is showing: any newer message, or the toast
  // expiring, withdraws it, so Cmd/Ctrl+Z can never reverse something stale.
  const notify = useCallback((message: string, tone?: "error", undo?: UndoAction) => {
    window.clearTimeout(toastTimerRef.current);
    undoRef.current = undo ?? null;
    setToast({ message, tone, undo });
    toastTimerRef.current = window.setTimeout(() => {
      if (undoRef.current === undo) undoRef.current = null;
      setToast(null);
    }, undo ? 8000 : 3600);
  }, []);

  const refreshAuth = useCallback(async () => {
    try {
      const result = await requestJson<Omit<AuthState, "loading">>("/api/auth/status");
      setAuth({ ...result, loading: false });
    } catch {
      setAuth((previous) => ({ ...previous, loading: false }));
    }
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem("filesdude-theme");
    const next = stored === "dark" || (!stored && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    const frame = window.requestAnimationFrame(() => setTheme(next));
    const timer = window.setTimeout(() => void refreshAuth(), 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [refreshAuth]);

  const loadDirectory = useCallback(async (pathValue = currentPath, query = activeSearch) => {
    if (!auth.authenticated) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ path: pathValue, hidden: String(showHidden) });
      // A content search shows its own results; the folder listing underneath stays unfiltered.
      if (query && searchMode === "names") params.set("search", query);
      const result = await requestJson<{ entries: FileEntry[]; path: string; disk: DiskInfo }>(`/api/fs?${params}`);
      setEntries(result.entries);
      setDisk(result.disk);
      setSelected(new Set());
      setCursor(null);
      anchorRef.current = null;
    } catch (error) {
      const typed = error as Error & { status?: number };
      if (typed.status === 401) await refreshAuth();
      else notify(typed.message, "error");
    } finally {
      setLoading(false);
    }
  }, [activeSearch, auth.authenticated, currentPath, notify, refreshAuth, searchMode, showHidden]);

  // Runs a content search whenever its inputs change, cancelling any search still in progress.
  useEffect(() => {
    contentControllerRef.current?.abort();
    if (!auth.authenticated || searchMode !== "contents" || !activeSearch) return;
    const controller = new AbortController();
    contentControllerRef.current = controller;
    const timer = window.setTimeout(async () => {
      setContentSearch({ status: "running" });
      try {
        const params = new URLSearchParams({ path: currentPath, q: activeSearch, hidden: String(showHidden) });
        if (matchCase) params.set("case", "1");
        const result = await requestJson<ContentSearchResult>(`/api/fs/search-content?${params}`, { signal: controller.signal });
        if (!controller.signal.aborted) setContentSearch({ status: "done", result });
      } catch (error) {
        if ((error as Error).name !== "AbortError") setContentSearch({ status: "error", error: (error as Error).message });
      }
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [auth.authenticated, searchMode, activeSearch, currentPath, showHidden, matchCase, searchRun]);

  const loadFavorites = useCallback(async () => {
    if (!auth.authenticated) return;
    try {
      const result = await requestJson<{ favorites: FavoriteLocation[] }>("/api/favorites");
      setFavorites(result.favorites);
      // Shared links follow renames and moves too, so they refresh alongside favourites. Only the
      // owner manages them; other accounts would be refused.
      if (auth.role === "owner") {
        const { shares } = await requestJson<{ shares: ShareLink[] }>("/api/shares");
        setSharedPaths(new Set(shares.map((share) => share.path)));
      }
    } catch (error) {
      const typed = error as Error & { status?: number };
      if (typed.status === 401) await refreshAuth();
      else notify(typed.message, "error");
    }
  }, [auth.authenticated, auth.role, notify, refreshAuth]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (auth.authenticated && withinHome(currentPath)) void loadDirectory(currentPath, activeSearch);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated, activeSearch, currentPath, showHidden, searchMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // An account confined to a folder starts there and can't wander above it.
  useEffect(() => {
    if (!auth.authenticated || withinHome(currentPath)) return;
    const timer = window.setTimeout(() => {
      setCurrentPath(home);
      window.history.replaceState({ path: home, index: historyIndex }, "", buildUrl(home));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated, currentPath, home]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (auth.authenticated) void loadFavorites();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated, loadFavorites]);

  useEffect(() => {
    window.history.replaceState({ path: currentPath, index: 0 }, "", buildUrl(currentPath));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the path present at mount should seed the initial history entry
  }, []);

  useEffect(() => {
    function onPopState(event: PopStateEvent) {
      const state = event.state as { path: string; index: number } | null;
      if (!state) return;
      setCurrentPath(state.path);
      setHistoryIndex(state.index);
      setActiveSearch("");
      setSearch("");
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath: string, record = true) => {
    setCurrentPath(nextPath);
    setActiveSearch("");
    setSearch("");
    if (record) {
      const nextHistory = history.slice(0, historyIndex + 1);
      nextHistory.push(nextPath);
      const nextIndex = nextHistory.length - 1;
      setHistory(nextHistory);
      setHistoryIndex(nextIndex);
      window.history.pushState({ path: nextPath, index: nextIndex }, "", buildUrl(nextPath));
    }
  }, [history, historyIndex]);

  const changeHistory = (direction: -1 | 1) => {
    const nextIndex = historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= history.length) return;
    window.history.go(direction);
  };

  const openEntry = (entry: FileEntry) => {
    if (entry.type === "directory") navigate(entry.path);
    else if (!entry.symlinkBlocked) setDialog({ kind: "preview", entry });
  };

  const selectEntry = (entry: FileEntry, { additive = false, range = false }: SelectOptions = {}) => {
    const order = sortedEntries.map((item) => item.path);
    if (range && anchorRef.current && order.includes(anchorRef.current)) {
      const span = selectionRange(order, anchorRef.current, entry.path);
      setSelected((previous) => new Set(additive ? [...previous, ...span] : span));
    } else {
      anchorRef.current = entry.path;
      setSelected((previous) => {
        const next = additive ? new Set(previous) : new Set<string>();
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
    }
    setCursor(entry.path);
  };

  const postJson = <T,>(url: string, body: Record<string, unknown>) => requestJson<T>(url, { method: "POST", body: JSON.stringify(body) });

  const refreshListing = async () => {
    await loadDirectory();
    await loadFavorites();
  };

  // Builds the reversal of an action from the server's report of what it changed.
  const undoFor = (body: Record<string, unknown>, result: unknown): UndoAction | null => {
    switch (body.action) {
      case "rename": {
        const renamed = result as FileEntry | undefined;
        const original = String(body.path);
        if (!renamed?.path || renamed.path === original) return null;
        return { done: "Rename undone", run: async () => { await postJson("/api/fs", { action: "rename", path: renamed.path, name: original.split("/").at(-1) }); } };
      }
      case "move": {
        const moved = (result as TransferResult[] | undefined) ?? [];
        if (!moved.length) return null;
        return {
          done: `Moved ${itemCount(moved.length)} back`,
          run: async () => {
            const byFolder = new Map<string, string[]>();
            for (const item of moved) byFolder.set(parentOf(item.source), [...(byFolder.get(parentOf(item.source)) ?? []), item.path]);
            for (const [destination, paths] of byFolder) await postJson("/api/fs", { action: "move", paths, destination });
          },
        };
      }
      case "copy": {
        const copies = (result as TransferResult[] | undefined) ?? [];
        if (!copies.length) return null;
        return { done: `Moved ${copies.length === 1 ? "the copy" : `${copies.length} copies`} to trash`, run: async () => { await postJson("/api/fs", { action: "delete", paths: copies.map((item) => item.path), requireTrash: true }); } };
      }
      case "delete": {
        const trashed = (result as DeleteResult | undefined)?.trashed ?? [];
        if (!trashed.length) return null;
        return { done: `Restored ${itemCount(trashed.length)}`, run: async () => { await postJson("/api/fs/trash", { action: "restore", ids: trashed.map((item) => item.id) }); } };
      }
      default:
        return null;
    }
  };

  const runAction = async (body: Record<string, unknown>, success: string) => {
    try {
      const response = await postJson<{ result: unknown }>("/api/fs", body);
      setDialog(null);
      notify(success, undefined, undoFor(body, response.result) ?? undefined);
      await refreshListing();
      return true;
    } catch (error) {
      notify((error as Error).message, "error");
      return false;
    }
  };

  const runUndo = async (undo: UndoAction) => {
    if (undoRef.current === undo) undoRef.current = null;
    window.clearTimeout(toastTimerRef.current);
    setToast(null);
    try {
      await undo.run();
      notify(undo.done);
    } catch (error) {
      notify(`Couldn't undo: ${(error as Error).message}`, "error");
    }
    await refreshListing();
  };

  // Reports a finished job once (polls can overlap), offering an undo where one makes sense.
  const finishJob = async (job: JobState) => {
    if (finishedJobsRef.current.has(job.id)) return;
    finishedJobsRef.current.add(job.id);
    if (job.kind === "restore") {
      const restored = job.transferred?.[0];
      if (job.status === "done" && restored) {
        notify(`Restored as /${restored.path}`, undefined, undoFor({ action: "copy" }, job.transferred) ?? undefined);
      } else if (job.status === "failed") {
        notify(job.error || "The restore failed", "error");
      } else {
        notify("Restore cancelled");
      }
    } else if (job.kind === "copy" || job.kind === "move") {
      const items = job.transferred ?? [];
      const copy = job.kind === "copy";
      if (job.status === "done") {
        const destination = items.length ? parentOf(items[0].path) : "";
        const leftBehind = items.some((item) => item.leftBehind) ? " · some items changed during the move and were left in the original folder" : "";
        notify(`${itemCount(items.length)} ${copy ? "copied" : "moved"} to ${folderLabel(destination)}${leftBehind}`, undefined, undoFor({ action: job.kind }, items) ?? undefined);
      } else if (job.status === "failed") {
        notify(job.error || `The ${job.kind} failed`, "error");
      } else {
        notify(`${copy ? "Copy" : "Move"} cancelled${items.length ? ` after ${itemCount(items.length)}` : ""}`);
      }
    } else {
      const result = job.result;
      if (job.status === "done" && result) {
        const name = result.path.split("/").at(-1);
        const compressed = job.kind === "compress";
        const skipped = result.skipped ? ` · ${result.skipped} ${result.skipped === 1 ? "link or duplicate was" : "links or duplicates were"} skipped` : "";
        notify(compressed ? `Created ${name} (${formatBytes(result.bytes)})` : `Extracted ${itemCount(result.entries)} into ${name}${skipped}`, undefined, {
          done: compressed ? "Moved the archive to trash" : "Moved the extracted folder to trash",
          run: async () => { await postJson("/api/fs", { action: "delete", paths: [result.path], requireTrash: true }); },
        });
      } else if (job.status === "failed") {
        notify(job.error || "The archive job failed", "error");
      } else {
        notify(job.kind === "compress" ? "Compression cancelled" : "Extraction cancelled");
      }
    }
    await refreshListing();
  };

  // Shows a newly started job, or reports it at once if it already finished.
  const trackJob = async (job: JobState) => {
    if (job.status === "running") setJobs((current) => [...current.filter((item) => item.id !== job.id), job]);
    else await finishJob(job);
    return job.status !== "failed";
  };

  const startArchiveJob = async (body: Record<string, unknown>) => {
    try {
      return await trackJob((await postJson<{ job: JobState }>("/api/fs/archive", body)).job);
    } catch (error) {
      notify((error as Error).message, "error");
      return false;
    }
  };

  const cancelJob = async (job: JobState) => {
    try {
      const { job: updated } = await postJson<{ job: JobState }>("/api/fs/jobs", { action: "cancel", id: job.id });
      setJobs((current) => current.map((item) => (item.id === updated.id ? updated : item)));
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  // Polls running jobs each second, reporting each one as it finishes. Jobs started while a poll
  // is in flight are kept.
  useEffect(() => {
    if (!jobs.length) return;
    const polled = new Set(jobs.map((job) => job.id));
    const timer = window.setTimeout(async () => {
      const updated = await Promise.all(jobs.map(async (job) => {
        try {
          return (await requestJson<{ job: JobState }>(`/api/fs/jobs?id=${encodeURIComponent(job.id)}`)).job;
        } catch (error) {
          notify((error as Error).message, "error");
          return null;
        }
      }));
      const byId = new Map(updated.flatMap((job) => (job ? [[job.id, job] as const] : [])));
      setJobs((current) => current.flatMap((job) => {
        if (!polled.has(job.id)) return [job];
        const latest = byId.get(job.id);
        return latest?.status === "running" ? [latest] : [];
      }));
      for (const job of updated) if (job && job.status !== "running") await finishJob(job);
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Snapshots are offered only when the root is on ZFS.
  useEffect(() => {
    if (!auth.authenticated) return;
    const controller = new AbortController();
    requestJson<{ available: boolean }>("/api/fs/snapshots", { signal: controller.signal })
      .then((result) => setSnapshotsAvailable(result.available))
      .catch(() => setSnapshotsAvailable(false));
    return () => controller.abort();
  }, [auth.authenticated]);

  // Pick up this account's jobs still running from before a reload.
  useEffect(() => {
    if (!auth.authenticated) return;
    const timer = window.setTimeout(async () => {
      try {
        const { jobs: listed } = await requestJson<{ jobs: JobState[] }>("/api/fs/jobs");
        const running = listed.filter((job) => job.status === "running" && job.own);
        if (running.length) setJobs((current) => [...current, ...running.filter((job) => !current.some((item) => item.id === job.id))]);
      } catch {
        // The listing works without job progress.
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated]);

  // Copies and moves run as background jobs; quick ones come back already finished.
  const transferEntries = async (mode: "copy" | "move", paths: string[], destination: string) => {
    try {
      const { job } = await postJson<{ job: JobState }>("/api/fs/jobs", { action: mode, paths, destination });
      setDialog(null);
      return await trackJob(job);
    } catch (error) {
      notify((error as Error).message, "error");
      return false;
    }
  };

  const clip = (mode: ClipboardState["mode"], paths: string[]) => {
    if (!paths.length) return;
    setClipboard({ mode, paths });
    notify(`${itemCount(paths.length)} ${mode === "cut" ? "cut" : "copied"} · paste with ${modifierLabel()}V`);
  };

  const pasteInto = async (destination: string) => {
    if (!clipboard) return;
    const copy = clipboard.mode === "copy";
    if (!canDropInto(destination, clipboard.paths, copy)) {
      const alreadyHere = !copy && clipboard.paths.some((item) => parentOf(item) === destination);
      notify(alreadyHere ? "Those items are already in this folder" : "You can't paste a folder into itself or one of its subfolders", "error");
      return;
    }
    const pasted = await transferEntries(copy ? "copy" : "move", clipboard.paths, destination);
    // Cut items have moved, so they can only be pasted once.
    if (pasted && !copy) setClipboard(null);
  };

  const startDrag = (entry: FileEntry, event: React.DragEvent<HTMLElement>) => {
    const paths = selected.has(entry.path) ? sortedEntries.filter((item) => selected.has(item.path)).map((item) => item.path) : [entry.path];
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      anchorRef.current = entry.path;
    }
    setCursor(entry.path);
    dragPathsRef.current = paths;
    event.dataTransfer.effectAllowed = "copyMove";
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths));
    if (paths.length > 1) {
      const ghost = document.createElement("div");
      ghost.className = "drag-ghost";
      ghost.textContent = itemCount(paths.length);
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 14, 14);
      window.setTimeout(() => ghost.remove(), 0);
    }
  };

  const endDrag = () => {
    dragPathsRef.current = [];
    setDropTarget(null);
  };

  // Dropping moves the dragged items into the target folder; holding Option/Alt copies them instead.
  const dropHandlers: DropHandlers = {
    onDragOver: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      const destination = event.currentTarget.dataset.dropPath ?? "";
      const copy = event.altKey;
      // Only drags that started in this tab are accepted, so another site cannot supply paths.
      const allowed = canDropInto(destination, dragPathsRef.current, copy);
      event.dataTransfer.dropEffect = allowed ? (copy ? "copy" : "move") : "none";
      setDropTarget(allowed ? destination : null);
    },
    onDragLeave: (event) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      const destination = event.currentTarget.dataset.dropPath ?? "";
      setDropTarget((current) => (current === destination ? null : current));
    },
    onDrop: (event) => {
      if (!event.dataTransfer.types.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      const destination = event.currentTarget.dataset.dropPath ?? "";
      const paths = dragPathsRef.current;
      setDropTarget(null);
      if (canDropInto(destination, paths, event.altKey)) void transferEntries(event.altKey ? "copy" : "move", paths, destination);
    },
  };

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const closeOnKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    const closeOnViewportChange = () => setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", closeOnViewportChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", closeOnViewportChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
    };
  }, [menu]);

  // Menu actions apply to the whole selection when the item is part of it, otherwise to the item alone.
  const menuTargets = (entry: FileEntry) => (selected.has(entry.path) ? sortedEntries.filter((item) => selected.has(item.path)) : [entry]);

  const openEntryMenu = (entry: FileEntry, x: number, y: number, flipY?: number) => {
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      anchorRef.current = entry.path;
    }
    setCursor(entry.path);
    setMenu({ kind: "entry", entry, ...menuPosition(x, y, 440, flipY) });
  };

  const openBackgroundMenu = (event: React.MouseEvent) => {
    if ((event.target as HTMLElement).closest("[data-path], button, a, input, label")) return;
    event.preventDefault();
    setMenu({ kind: "background", ...menuPosition(event.clientX, event.clientY, 250) });
  };

  const chooseBackground = (choice: BackgroundChoice) => {
    setMenu(null);
    if (choice === "new") setDialog({ kind: "new" });
    if (choice === "upload") uploadRef.current?.click();
    if (choice === "paste") void pasteInto(currentPath);
    if (choice === "selectAll") setSelected(new Set(sortedEntries.map((entry) => entry.path)));
    if (choice === "refresh") void loadDirectory();
  };

  const interactions: EntryInteractions = {
    menuPath: menu?.kind === "entry" ? menu.entry.path : null,
    cutPaths,
    sharedPaths,
    canWrite,
    dropTarget,
    dropHandlers,
    onMenuButton: (entry, trigger) => openEntryMenu(entry, trigger.right - MENU_WIDTH, trigger.bottom + 6, trigger.top - 6),
    onContextMenu: (entry, event) => {
      event.preventDefault();
      event.stopPropagation();
      openEntryMenu(entry, event.clientX, event.clientY);
    },
    onDragStart: startDrag,
    onDragEnd: endDrag,
  };

  const queueUpload = (files: FileList | File[]) => {
    const queued = Array.from(files);
    if (!queued.length) return;
    setDialog({ kind: "upload", files: queued });
    if (uploadRef.current) uploadRef.current.value = "";
  };

  const downloadSelected = () => {
    const chosen = entries.filter((entry) => selected.has(entry.path));
    if (chosen.length !== 1) return;
    startDownload(chosen[0].path);
  };

  const toggleFavorite = async (folderPath: string) => {
    const active = favorites.some((favorite) => favorite.path === folderPath);
    try {
      const result = await requestJson<{ favorites: FavoriteLocation[] }>("/api/favorites", {
        method: "POST",
        body: JSON.stringify({ action: active ? "remove" : "add", path: folderPath }),
      });
      setFavorites(result.favorites);
      notify(active ? "Removed from favourites" : "Added to favourites");
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };

  const handleEntryAction = (action: EntryAction, entry: FileEntry) => {
    const targets = menuTargets(entry);
    if (!(targets.length > 1 && MULTI_ITEM_ACTIONS.includes(action))) {
      setSelected(new Set([entry.path]));
      anchorRef.current = entry.path;
    }
    setCursor(entry.path);
    switch (action) {
      case "open":
        openEntry(entry);
        break;
      case "edit":
        setDialog({ kind: "edit", entry });
        break;
      case "download":
        startDownload(entry.path);
        break;
      case "favorite":
        void toggleFavorite(entry.path);
        break;
      case "rename":
        setDialog({ kind: "rename", entry });
        break;
      case "cut":
      case "clipboard":
        clip(action === "cut" ? "cut" : "copy", targets.map((item) => item.path));
        break;
      case "paste":
        void pasteInto(entry.path);
        break;
      case "compress":
        setDialog({ kind: "compress" });
        break;
      case "extract":
        void startArchiveJob({ action: "extract", path: entry.path });
        break;
      case "share":
        setDialog({ kind: "share", entry });
        break;
      case "copy":
      case "move":
        setDialog({ kind: "transfer", mode: action });
        break;
      case "permissions":
        setDialog({ kind: "permissions" });
        break;
      case "ownership":
        setDialog({ kind: "ownership" });
        break;
      case "details":
        setDialog({ kind: "details", entry });
        break;
      case "versions":
        setDialog({ kind: "versions", entry });
        break;
      case "delete":
        setDialog({ kind: "delete" });
        break;
    }
  };

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const modifier = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (modifier && key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (dialog || menu || isTypingTarget(event.target)) return;
      if (!canWrite && (key === "delete" || key === "f2" || (modifier && ["z", "v", "c", "x", "backspace"].includes(key)))) return;
      if (modifier && !event.shiftKey && key === "z") {
        if (undoRef.current) {
          event.preventDefault();
          void runUndo(undoRef.current);
        }
        return;
      }
      if (modifier && key === "v") {
        if (clipboard) {
          event.preventDefault();
          void pasteInto(currentPath);
        }
        return;
      }
      // Leave Cmd/Ctrl+C alone when page text is highlighted so ordinary copying still works.
      if (modifier && (key === "c" || key === "x") && selected.size && !window.getSelection()?.toString()) {
        event.preventDefault();
        clip(key === "x" ? "cut" : "copy", sortedEntries.filter((entry) => selected.has(entry.path)).map((entry) => entry.path));
        return;
      }
      if (modifier && key === "a") {
        if (!sortedEntries.length) return;
        event.preventDefault();
        setSelected(new Set(sortedEntries.map((entry) => entry.path)));
        anchorRef.current = cursor ?? sortedEntries[0].path;
        return;
      }
      if (event.key === "Escape" && selected.size) {
        setSelected(new Set());
        return;
      }

      const grid = view === "grid";
      const current = sortedEntries.findIndex((entry) => entry.path === cursor);
      const nextIndex = modifier || event.altKey ? null : moveCursor(current, sortedEntries.length, event.key, { grid, columns: grid ? gridColumns() : 1 });
      if (nextIndex !== null) {
        event.preventDefault();
        const target = sortedEntries[nextIndex];
        const order = sortedEntries.map((entry) => entry.path);
        if (event.shiftKey) {
          if (!anchorRef.current || !order.includes(anchorRef.current)) anchorRef.current = sortedEntries[current]?.path ?? target.path;
          setSelected(new Set(selectionRange(order, anchorRef.current, target.path)));
        } else {
          anchorRef.current = target.path;
          setSelected(new Set([target.path]));
        }
        setCursor(target.path);
        document.querySelector(`[data-path="${CSS.escape(target.path)}"]`)?.scrollIntoView({ block: "nearest" });
        return;
      }

      if (!selected.size || ((event.key === " " || event.key === "Enter") && isActivationTarget(event.target))) return;
      const single = selected.size === 1 ? sortedEntries.find((entry) => selected.has(entry.path)) : undefined;
      if (event.key === "Enter") {
        const entry = sortedEntries.find((item) => item.path === cursor && selected.has(item.path)) ?? single;
        if (entry) {
          event.preventDefault();
          openEntry(entry);
        }
      }
      if (event.key === "Delete" || event.key === "Backspace" && modifier) {
        event.preventDefault();
        setDialog({ kind: "delete" });
      }
      if (event.key === "F2" && single) {
        event.preventDefault();
        setDialog({ kind: "rename", entry: single });
      }
      if (event.key === " " && single?.type === "file") {
        event.preventDefault();
        setDialog({ kind: "preview", entry: single });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const logout = async () => {
    await requestJson("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    setFavorites([]);
    setAuth(initialAuth);
    await refreshAuth();
  };

  const applySort = (next: SortState) => {
    setSort(next);
    try {
      window.localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Sorting still works for this visit when storage is unavailable.
    }
  };

  const toggleTheme = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    window.localStorage.setItem("filesdude-theme", next);
  };

  const crumbs = useMemo(() => {
    const below = home && currentPath.startsWith(home) ? currentPath.slice(home.length).replace(/^\//, "") : currentPath;
    const parts = below ? below.split("/") : [];
    return [{ label: home ? "Home" : "Root", path: home }, ...parts.map((part, index) => ({ label: part, path: [home, ...parts.slice(0, index + 1)].filter(Boolean).join("/") }))];
  }, [currentPath, home]);

  const selectedEntries = entries.filter((entry) => selected.has(entry.path));
  const favoritePaths = new Set(favorites.map((favorite) => favorite.path));
  const allSelected = entries.length > 0 && selected.size === entries.length;
  const diskPercent = disk?.total ? Math.round((disk.used / disk.total) * 100) : 0;

  if (auth.loading) return <AppLoading />;
  if (!auth.authenticated) return <LoginScreen auth={auth} onSuccess={refreshAuth} theme={theme} onToggleTheme={toggleTheme} />;

  return (
    <div className="app-shell" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes(DRAG_TYPE)) event.dataTransfer.dropEffect = "none"; }} onDrop={(event) => { event.preventDefault(); if (canWrite && !event.dataTransfer.types.includes(DRAG_TYPE)) queueUpload(event.dataTransfer.files); }}>
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><FolderOpen size={21} /></div>
          <div><strong>FilesDude</strong><span>Proxmox explorer</span></div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>

        <nav className="primary-nav" aria-label="File locations">
          <button className={`nav-item ${currentPath === home ? "active" : ""} ${dropTarget === home ? "drop-target" : ""}`} data-drop-path={home} {...(canWrite ? dropHandlers : {})} onClick={() => { navigate(home); setSidebarOpen(false); }}><Home size={18} /><span>{home ? "My files" : "All files"}</span><ChevronRight size={15} /></button>
          <button className="nav-item" onClick={() => { setShowHidden(true); navigate(home); setSidebarOpen(false); }}><Eye size={18} /><span>Hidden files</span></button>
          {canWrite && <button className="nav-item" onClick={() => { setDialog({ kind: "trash" }); setSidebarOpen(false); }}><Trash2 size={18} /><span>Trash</span></button>}
          {isOwner && <button className="nav-item" onClick={() => { setDialog({ kind: "shares" }); setSidebarOpen(false); }}><Link2 size={18} /><span>Shared links</span>{sharedPaths.size > 0 && <em className="nav-count">{sharedPaths.size}</em>}</button>}
          {snapshotsAvailable && <button className="nav-item" onClick={() => { setDialog({ kind: "snapshots" }); setSidebarOpen(false); }}><History size={18} /><span>Snapshots</span></button>}
          {isOwner && <button className="nav-item" onClick={() => { setDialog({ kind: "duplicates" }); setSidebarOpen(false); }}><Files size={18} /><span>Duplicates</span></button>}
          {isOwner && <button className="nav-item" onClick={() => { setDialog({ kind: "users" }); setSidebarOpen(false); }}><Users size={18} /><span>Users</span></button>}
        </nav>

        <div className="sidebar-section favorites-section">
          <p className="eyebrow">FAVOURITES</p>
          {favorites.length ? <div className="favorite-list">{favorites.map((favorite) => <div key={favorite.path} className={`favorite-item ${currentPath === favorite.path ? "active" : ""} ${dropTarget === favorite.path ? "drop-target" : ""}`} data-drop-path={favorite.path} {...dropHandlers}><button title={`/${favorite.path}`} onClick={() => { navigate(favorite.path); setSidebarOpen(false); }}><Star size={15} fill="currentColor" /><span>{favorite.name}</span></button><button className="favorite-remove" aria-label={`Remove ${favorite.name} from favourites`} title="Remove from favourites" onClick={() => void toggleFavorite(favorite.path)}><X size={13} /></button></div>)}</div> : <p className="favorites-empty"><Star size={14} /> Star folders to pin them here.</p>}
        </div>

        <div className="sidebar-section">
          <p className="eyebrow">SERVER</p>
          <div className="server-card">
            <div className="server-card-icon"><Server size={19} /></div>
            <div><strong>Local filesystem</strong><span>Connected securely</span></div>
            <span className="live-dot" title="Connected" />
          </div>
        </div>

        <button type="button" className={`storage-card ${isOwner ? "" : "static"}`} title={isOwner ? "Find the largest files" : undefined} aria-label={isOwner ? "Storage usage. Open the largest-files scanner" : "Storage usage"} disabled={!isOwner} onClick={() => setDialog({ kind: "storage" })}>
          <div className="storage-heading"><span><HardDrive size={16} /> Storage</span><strong>{diskPercent}%</strong></div>
          <div className="storage-track"><span style={{ width: `${diskPercent}%` }} /></div>
          <p>{disk ? `${formatBytes(disk.used)} of ${formatBytes(disk.total)} used` : "Calculating…"}</p>
          <small>{disk ? `${formatBytes(disk.available)} available` : ""}</small>
          {isOwner && <span className="storage-action">Click to find and manage largest files <ChevronRight size={12} /></span>}
        </button>

        <div className="sidebar-footer">
          <button className="user-chip" title="Open preferences" onClick={() => setDialog({ kind: "preferences" })}><span className="avatar">{auth.username?.slice(0, 1).toUpperCase()}</span><span><strong>{auth.username}</strong><small>{auth.role ? ROLE_LABELS[auth.role] : ""}</small></span></button>
          <button className="icon-button" aria-label="Preferences" title="Preferences" onClick={() => setDialog({ kind: "preferences" })}><Settings2 size={17} /></button>
          <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void logout()}><LogOut size={17} /></button>
        </div>
        <p className="app-version" title={APP_BUILT_AT ? `Built ${new Date(APP_BUILT_AT).toLocaleString()}` : undefined}>FilesDude v{APP_VERSION}{APP_COMMIT ? ` · ${APP_COMMIT}` : ""}</p>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button>
          <div className="history-buttons">
            <button className="icon-button" aria-label="Back" disabled={historyIndex === 0} onClick={() => changeHistory(-1)}><ArrowLeft size={18} /></button>
            <button className="icon-button" aria-label="Forward" disabled={historyIndex >= history.length - 1} onClick={() => changeHistory(1)}><ArrowRight size={18} /></button>
          </div>
          <div className="breadcrumb" aria-label="Current path">
            {crumbs.map((crumb, index) => (
              <span key={crumb.path || "root"}>
                {index > 0 && <ChevronRight size={14} />}
                <button className={dropTarget === crumb.path ? "drop-target" : ""} data-drop-path={crumb.path} {...dropHandlers} onClick={() => navigate(crumb.path)}>{crumb.label}</button>
              </span>
            ))}
          </div>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Toggle theme" onClick={toggleTheme}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
            <button className="icon-button" aria-label="Refresh files" onClick={() => void loadDirectory()}><RefreshCw size={18} className={loading ? "spin" : ""} /></button>
          </div>
        </header>

        <section className="workspace">
          <div className="workspace-heading">
            <div>
              <div className="heading-kicker"><span className="status-dot" /> LIVE FILESYSTEM</div>
              <h1>{currentPath ? currentPath.split("/").at(-1) : "All files"}</h1>
              <p>{activeSearch && searchMode === "contents" ? (contentSearch?.result ? `${itemCount(contentSearch.result.hits.length).replace("item", "file")} containing “${contentSearch.result.query}”` : "Searching file contents…") : activeSearch ? `${entries.length} search results` : `${entries.length} ${entries.length === 1 ? "item" : "items"}`}{showHidden ? " · hidden files shown" : ""}</p>
            </div>
            <div className="primary-actions">
              <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => event.target.files && queueUpload(event.target.files)} />
              {currentPath && <button className={`button secondary favorite-location ${favoritePaths.has(currentPath) ? "active" : ""}`} title={favoritePaths.has(currentPath) ? "Remove this folder from favourites" : "Add this folder to favourites"} onClick={() => void toggleFavorite(currentPath)}><Star size={16} fill={favoritePaths.has(currentPath) ? "currentColor" : "none"} /> <span>{favoritePaths.has(currentPath) ? "Favourited" : "Favourite"}</span></button>}
              {canWrite && clipboard && <div className="clipboard-chip"><button className="button secondary" title={`Paste into ${folderLabel(currentPath)} (${modifierLabel()}V)`} onClick={() => void pasteInto(currentPath)}><ClipboardPaste size={16} /> <span>Paste {itemCount(clipboard.paths.length)}</span></button><button className="icon-button" aria-label="Clear clipboard" title="Clear clipboard" onClick={() => setClipboard(null)}><X size={15} /></button></div>}
              {canWrite && <button className="button secondary" onClick={() => uploadRef.current?.click()}><Upload size={17} /> Upload</button>}
              {canWrite && <button className="button primary" onClick={() => setDialog({ kind: "new" })}><Plus size={17} /> New <ChevronDown size={14} /></button>}
            </div>
          </div>

          <div className="file-toolbar">
            <form className="search-field" onSubmit={(event) => { event.preventDefault(); setActiveSearch(search.trim()); setSearchRun((run) => run + 1); }}>
              <Search size={17} />
              <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={searchMode === "contents" ? "Search text inside files…" : "Search names in this folder…"} aria-label="Search files" />
              {search && <button type="button" aria-label="Clear search" onClick={() => { setSearch(""); setActiveSearch(""); }}><X size={15} /></button>}
              <kbd>⌘K</kbd>
            </form>
            <div className="search-mode" role="group" aria-label="Search in">
              <button type="button" className={searchMode === "names" ? "active" : ""} aria-pressed={searchMode === "names"} onClick={() => setSearchMode("names")}>Names</button>
              <button type="button" className={searchMode === "contents" ? "active" : ""} aria-pressed={searchMode === "contents"} onClick={() => setSearchMode("contents")}>Contents</button>
              {searchMode === "contents" && <button type="button" className={`match-case ${matchCase ? "active" : ""}`} aria-pressed={matchCase} title="Match case" aria-label="Match case" onClick={() => setMatchCase(!matchCase)}>Aa</button>}
            </div>
            <div className="toolbar-spacer" />
            <div className={`sort-control ${view === "grid" ? "grid-mode" : ""}`}>
              <select aria-label="Sort by" value={sort.key} onChange={(event) => { const key = event.target.value as SortKey; applySort({ key, direction: INITIAL_DIRECTION[key] }); }}>
                {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => <option key={key} value={key}>{SORT_LABELS[key]}</option>)}
              </select>
              <button className="icon-button" title={sort.direction === "asc" ? "Ascending" : "Descending"} aria-label={`Sort ${sort.direction === "asc" ? "descending" : "ascending"} instead`} onClick={() => applySort({ ...sort, direction: sort.direction === "asc" ? "desc" : "asc" })}>{sort.direction === "asc" ? <ArrowUpNarrowWide size={16} /> : <ArrowDownWideNarrow size={16} />}</button>
            </div>
            <button className={`toolbar-button ${showHidden ? "active" : ""}`} onClick={() => setShowHidden(!showHidden)} title="Show hidden files">{showHidden ? <Eye size={17} /> : <EyeOff size={17} />}<span>Hidden</span></button>
            <div className="view-switch" role="group" aria-label="View style">
              <button className={view === "list" ? "active" : ""} aria-label="List view" onClick={() => setView("list")}><List size={17} /></button>
              <button className={view === "grid" ? "active" : ""} aria-label="Grid view" onClick={() => setView("grid")}><LayoutGrid size={17} /></button>
            </div>
          </div>

          {selected.size > 0 && (
            <div className="selection-bar">
              <div><span className="selection-count">{selected.size}</span><strong>{selected.size === 1 ? "item" : "items"} selected</strong></div>
              <div className="selection-actions">
                {selected.size === 1 && <button onClick={() => openEntry(selectedEntries[0])}><Eye size={16} /> Open</button>}
                {canWrite && selected.size === 1 && isEditable(selectedEntries[0]) && <button onClick={() => setDialog({ kind: "edit", entry: selectedEntries[0] })}><FilePenLine size={16} /> Edit</button>}
                {selected.size === 1 && <button onClick={downloadSelected}><Download size={16} /> Download</button>}
                {selected.size === 1 && selectedEntries[0].type === "directory" && <button onClick={() => void toggleFavorite(selectedEntries[0].path)}><Star size={16} fill={favoritePaths.has(selectedEntries[0].path) ? "currentColor" : "none"} /> {favoritePaths.has(selectedEntries[0].path) ? "Unfavourite" : "Favourite"}</button>}
                {canWrite && selected.size === 1 && <button onClick={() => setDialog({ kind: "rename", entry: selectedEntries[0] })}><Pencil size={16} /> Rename</button>}
                {canWrite && <button onClick={() => setDialog({ kind: "transfer", mode: "copy" })}><Copy size={16} /> Copy</button>}
                {canWrite && <button onClick={() => setDialog({ kind: "transfer", mode: "move" })}><FolderInput size={16} /> Move</button>}
                {isOwner && <button onClick={() => setDialog({ kind: "permissions" })}><KeyRound size={16} /> Permissions</button>}
                {isOwner && <button onClick={() => setDialog({ kind: "ownership" })}><UserRoundCog size={16} /> Ownership</button>}
                {canWrite && <button onClick={() => setDialog({ kind: "compress" })}><FileArchive size={16} /> Compress</button>}
                {canWrite && selected.size > 1 && <button onClick={() => setDialog({ kind: "bulk" })}><Sparkles size={16} /> Bulk rename</button>}
                {selected.size === 1 && <button onClick={() => setDialog({ kind: "details", entry: selectedEntries[0] })}><Info size={16} /> Properties</button>}
                {canWrite && <button className="danger-action" onClick={() => setDialog({ kind: "delete" })}><Trash2 size={16} /> Delete</button>}
                <button className="icon-button" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={16} /></button>
              </div>
            </div>
          )}

          <div className={`files-surface ${view === "grid" ? "grid-mode" : ""}`} onContextMenu={openBackgroundMenu}>
            {searchMode === "contents" && activeSearch ? (
              <ContentResults
                state={contentSearch}
                matchCase={matchCase}
                onCancel={() => { contentControllerRef.current?.abort(); setActiveSearch(""); setSearch(""); setContentSearch(null); }}
                onOpen={(hit) => setDialog({ kind: "preview", entry: hitEntry(hit) })}
                onEdit={(hit) => setDialog({ kind: "edit", entry: hitEntry(hit) })}
                onReveal={(hit) => navigate(parentOf(hit.path))}
              />
            ) : loading && !entries.length ? <FileSkeleton /> : entries.length === 0 ? (
              <EmptyState searching={Boolean(activeSearch)} onUpload={() => uploadRef.current?.click()} onNew={() => setDialog({ kind: "new" })} />
            ) : view === "list" ? (
              <FileTable
                entries={sortedEntries}
                sort={sort}
                onSort={(key) => applySort(nextSort(sort, key))}
                selected={selected}
                cursor={cursor}
                interactions={interactions}
                allSelected={allSelected}
                onToggleAll={() => setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.path)))}
                onToggle={selectEntry}
                onOpen={openEntry}
              />
            ) : (
              <FileGrid entries={sortedEntries} selected={selected} cursor={cursor} interactions={interactions} onToggle={selectEntry} onOpen={openEntry} />
            )}
          </div>
          <div className="drop-hint"><Upload size={15} /> Drop files anywhere to upload to this folder</div>
        </section>
      </main>

      {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
      {dialog && (
        <DialogHost
          dialog={dialog}
          selected={selectedEntries}
          currentPath={currentPath}
          onClose={() => setDialog(null)}
          onRun={runAction}
          notify={notify}
          onRefresh={() => loadDirectory()}
          onStartJob={startArchiveJob}
          onTransfer={transferEntries}
          onJob={trackJob}
          canWrite={canWrite}
          role={auth.role ?? "viewer"}
          home={home}
          onSharesChanged={() => loadFavorites()}
          username={auth.username || ""}
          onCredentialsUpdated={async () => { setDialog(null); await refreshAuth(); notify("Account preferences updated"); }}
          onTwoFactor={() => setDialog({ kind: "twoFactor" })}
          onReveal={(entry) => { setDialog(null); navigate(entry.path.split("/").slice(0, -1).join("/")); }}
          onPreview={(entry) => setDialog({ kind: "preview", entry })}
        />
      )}
      {menu && createPortal(menu.kind === "entry"
        ? <FileActionMenu entry={menu.entry} targets={menuTargets(menu.entry)} position={{ top: menu.top, left: menu.left }} menuRef={menuRef} favoritePaths={favoritePaths} canWrite={canWrite} isOwner={isOwner} snapshots={snapshotsAvailable} canPaste={canWrite && Boolean(clipboard) && menu.entry.type === "directory"} onAction={(action, entry) => { setMenu(null); handleEntryAction(action, entry); }} />
        : <BackgroundMenu canWrite={canWrite} position={{ top: menu.top, left: menu.left }} menuRef={menuRef} folder={currentPath ? currentPath.split("/").at(-1) || "" : "All files"} clipboardCount={clipboard?.paths.length ?? 0} canSelectAll={sortedEntries.length > 0} onChoose={chooseBackground} />,
      document.body)}
      {jobs.length > 0 && <div className="job-panels">{jobs.map((job) => <JobPanel key={job.id} job={job} onCancel={() => void cancelJob(job)} />)}</div>}
      {toast && <div className={`toast ${toast.tone === "error" ? "toast-error" : ""}`} role="status">{toast.tone === "error" ? <CircleAlert size={18} /> : <Check size={18} />}<span>{toast.message}</span>{toast.undo && <button className="toast-action" onClick={() => void runUndo(toast.undo!)}><Undo2 size={14} /> Undo</button>}</div>}
    </div>
  );
}

function AppLoading() {
  return <div className="app-loading"><div className="brand-mark large"><FolderOpen size={27} /></div><LoaderCircle className="spin" size={22} /><span>Opening FilesDude…</span></div>;
}

function LoginScreen({ auth, onSuccess, theme, onToggleTheme }: { auth: AuthState; onSuccess: () => Promise<void>; theme: "light" | "dark"; onToggleTheme: () => void }) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Set once the password is right for an account with two-factor sign-in; a code is then needed.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      const result = await requestJson<{ twoFactorRequired?: boolean; challenge?: string }>("/api/auth/login", { method: "POST", body: JSON.stringify(challenge ? { challenge, code } : { username, password }) });
      if (result.twoFactorRequired && result.challenge) {
        setChallenge(result.challenge);
        setPassword("");
        return;
      }
      await onSuccess();
    } catch (caught) {
      const typed = caught as Error & { code?: string };
      // An expired challenge (or too many wrong codes) starts the sign-in over.
      if (typed.code === "CHALLENGE_EXPIRED") {
        setChallenge(null);
        setCode("");
      }
      setError(typed.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-page">
      <button className="login-theme icon-button" aria-label="Toggle theme" onClick={onToggleTheme}>{theme === "light" ? <Moon size={18} /> : <Sun size={18} />}</button>
      <div className="login-orb orb-one" /><div className="login-orb orb-two" />
      <section className="login-card">
        <div className="login-brand"><div className="brand-mark large"><FolderOpen size={26} /></div><div><strong>FilesDude</strong><span>Proxmox file manager</span></div></div>
        <div className="login-copy"><p className="eyebrow"><ShieldCheck size={14} /> SECURE SERVER ACCESS</p><h1>Welcome back.</h1><p>Sign in to browse and manage your server files.</p></div>
        {!auth.configured ? (
          <div className="configuration-warning"><CircleAlert size={20} /><div><strong>Setup required</strong>{auth.configurationIssues.map((issue) => <p key={issue}>{issue}</p>)}</div></div>
        ) : (
          challenge ? (
            <form onSubmit={submit} className="login-form">
              <label><span>Code from your authenticator app</span><div className="login-input"><Smartphone size={17} /><input autoComplete="one-time-code" inputMode="text" value={code} onChange={(event) => setCode(event.target.value)} maxLength={16} placeholder="123456" required autoFocus /></div></label>
              <p className="login-hint">Lost your phone? Enter one of your recovery codes instead.</p>
              {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
              <button className="button primary login-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={18} /> : <ShieldCheck size={17} />} Verify and sign in</button>
              <button type="button" className="button secondary" onClick={() => { setChallenge(null); setCode(""); setError(""); }}>Back</button>
            </form>
          ) : <form onSubmit={submit} className="login-form">
            <label><span>Username</span><div className="login-input"><Server size={17} /><input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></div></label>
            <label><span>Password</span><div className="login-input"><LockKeyhole size={17} /><input type={showPassword ? "text" : "password"} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required autoFocus /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div></label>
            {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
            <button className="button primary login-button" disabled={submitting}>{submitting ? <LoaderCircle className="spin" size={18} /> : <LockKeyhole size={17} />} Sign in securely</button>
          </form>
        )}
        <div className="login-foot"><ShieldCheck size={15} /><span>Credentials stay on your server. Sessions use secure, HTTP-only cookies.</span></div>
      </section>
      <p className="login-meta"><span className="status-dot" /> Self-hosted · No third-party storage</p>
    </main>
  );
}

// Drag, drop, context-menu, and clipboard props shared by list rows and grid cards.
function entryItemProps(entry: FileEntry, interactions: EntryInteractions) {
  const onContextMenu = (event: React.MouseEvent) => interactions.onContextMenu(entry, event);
  // Read-only accounts can't drag items around.
  if (!interactions.canWrite) return { draggable: false, onContextMenu };
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => interactions.onDragStart(entry, event),
    onDragEnd: interactions.onDragEnd,
    onContextMenu,
    ...(entry.type === "directory" ? { "data-drop-path": entry.path, ...interactions.dropHandlers } : {}),
  };
}

function entryStateClasses(entry: FileEntry, interactions: EntryInteractions) {
  return `${interactions.cutPaths.has(entry.path) ? "cut" : ""} ${interactions.dropTarget === entry.path ? "drop-target" : ""}`;
}

function FileTable({ entries, sort, onSort, selected, cursor, interactions, allSelected, onToggleAll, onToggle, onOpen }: {
  entries: FileEntry[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  selected: Set<string>;
  cursor: string | null;
  interactions: EntryInteractions;
  allSelected: boolean;
  onToggleAll: () => void;
  onToggle: (entry: FileEntry, options?: SelectOptions) => void;
  onOpen: (entry: FileEntry) => void;
}) {
  const sortHeader = (key: SortKey) => {
    const active = sort.key === key;
    const ascending = sort.direction === "asc";
    return (
      <div role="columnheader" aria-sort={active ? (ascending ? "ascending" : "descending") : "none"}>
        <button type="button" className={`sort-header ${active ? "active" : ""}`} title={`Sort by ${SORT_LABELS[key].toLowerCase()}`} onClick={() => onSort(key)}>
          {SORT_LABELS[key]}{active ? (ascending ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : <ChevronsUpDown size={12} />}
        </button>
      </div>
    );
  };

  return (
    <div className="file-table" role="table" aria-label="Files">
      <div className="file-row file-header" role="row">
        <div role="columnheader"><CheckBox checked={allSelected} onChange={onToggleAll} label="Select all" /></div>
        {sortHeader("name")}{sortHeader("size")}{sortHeader("owner")}{sortHeader("mode")}{sortHeader("modified")}<div role="columnheader" />
      </div>
      {entries.map((entry) => {
        const isSelected = selected.has(entry.path);
        return (
          <div key={entry.path} data-path={entry.path} aria-selected={isSelected} className={`file-row ${isSelected ? "selected" : ""} ${cursor === entry.path ? "cursor" : ""} ${entryStateClasses(entry, interactions)}`} role="row" {...entryItemProps(entry, interactions)} onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }} onDoubleClick={(event) => { if (!(event.target as HTMLElement).closest("button,input,label")) onOpen(entry); }} onClick={(event) => { if ((event.target as HTMLElement).closest("button,input,label")) return; onToggle(entry, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey }); }}>
            <div role="cell"><CheckBox checked={isSelected} onChange={(event) => onToggle(entry, { additive: true, range: event.shiftKey })} label={`Select ${entry.name}`} /></div>
            <div className="file-name-cell" role="cell"><span className={`file-icon ${entry.type}`}>{fileIcon(entry)}</span><button className="file-name" onClick={() => onOpen(entry)}>{entry.name}</button>{interactions.sharedPaths.has(entry.path) && <span className="shared-badge" title="Shared by link"><Link2 size={13} /></span>}{entry.symlinkBlocked && <span className="warning-badge" title="This link points outside the allowed root"><CircleAlert size={13} /></span>}</div>
            <div className="muted" role="cell">{entry.type === "directory" ? "—" : formatBytes(entry.size)}</div>
            <div className="owner-cell" role="cell"><span className="mini-avatar">{entry.owner.slice(0, 1).toUpperCase()}</span><span>{entry.owner}:{entry.group}</span></div>
            <div role="cell"><code className="mode-chip">{entry.mode}</code></div>
            <div className="muted" role="cell">{formatDate(entry.modified)}</div>
            <div className="row-actions" role="cell">
              <button className={`icon-button row-action overflow-trigger ${interactions.menuPath === entry.path ? "active" : ""}`} aria-label={`More actions for ${entry.name}`} aria-haspopup="menu" aria-expanded={interactions.menuPath === entry.path} onClick={(event) => interactions.onMenuButton(entry, event.currentTarget.getBoundingClientRect())}><MoreHorizontal size={17} /></button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FileActionMenu({ entry, targets, position, menuRef, favoritePaths, canWrite, isOwner, snapshots, canPaste, onAction }: {
  entry: FileEntry;
  targets: FileEntry[];
  position: MenuPosition;
  menuRef: React.RefObject<HTMLDivElement | null>;
  favoritePaths: Set<string>;
  canWrite: boolean;
  isOwner: boolean;
  snapshots: boolean;
  canPaste: boolean;
  onAction: (action: EntryAction, entry: FileEntry) => void;
}) {
  const multiple = targets.length > 1;
  const item = (action: EntryAction, label: string, icon: ReactNode, options: { danger?: boolean; disabled?: boolean } = {}) => (
    <button role="menuitem" className={options.danger ? "menu-danger" : ""} disabled={options.disabled} onClick={() => onAction(action, entry)}>{icon}<span>{label}</span></button>
  );
  return (
    <div ref={menuRef} className="file-action-menu" role="menu" aria-label={multiple ? `Actions for ${itemCount(targets.length)}` : `Actions for ${entry.name}`} style={position}>
      {multiple
        ? <div className="file-menu-heading"><span className="file-icon"><ListChecks size={17} /></span><div><strong>{itemCount(targets.length)} selected</strong><span>Actions apply to every selected item</span></div></div>
        : <div className="file-menu-heading"><span className={`file-icon ${entry.type}`}>{fileIcon(entry, 17)}</span><div><strong>{entry.name}</strong><span>{entry.type === "directory" ? "Folder" : `${extension(entry.name)} · ${formatBytes(entry.size)}`}</span></div></div>}
      {!multiple && <div className="file-menu-section">
        {item("open", entry.type === "directory" ? "Open" : "Preview", entry.type === "directory" ? <FolderOpen size={16} /> : <Eye size={16} />)}
        {canWrite && entry.type === "file" && item("edit", "Edit", <FilePenLine size={16} />, { disabled: !isEditable(entry) })}
        {item("download", "Download", <Download size={16} />)}
      </div>}
      <div className="file-menu-section">
        {canWrite && !multiple && item("rename", "Rename", <Pencil size={16} />)}
        {!multiple && entry.type === "directory" && item("favorite", favoritePaths.has(entry.path) ? "Remove from favourites" : "Add to favourites", <Star size={16} fill={favoritePaths.has(entry.path) ? "currentColor" : "none"} />)}
        {canWrite && item("cut", "Cut", <Scissors size={16} />)}
        {canWrite && item("clipboard", "Copy", <ClipboardCopy size={16} />)}
        {!multiple && canPaste && item("paste", "Paste into folder", <ClipboardPaste size={16} />)}
        {canWrite && item("copy", "Copy to…", <Copy size={16} />)}
        {canWrite && item("move", "Move to…", <FolderInput size={16} />)}
      </div>
      {canWrite && <div className="file-menu-section">
        {item("compress", multiple ? `Compress ${itemCount(targets.length)}…` : "Compress…", <FileArchive size={16} />)}
        {!multiple && isArchive(entry) && item("extract", "Extract here", <PackageOpen size={16} />)}
      </div>}
      <div className="file-menu-section">
        {isOwner && item("permissions", "Change permissions", <KeyRound size={16} />)}
        {isOwner && item("ownership", "Change ownership", <UserRoundCog size={16} />)}
        {isOwner && !multiple && (entry.type === "file" || entry.type === "directory") && item("share", "Share link…", <Link2 size={16} />)}
        {snapshots && !multiple && (entry.type === "file" || entry.type === "directory") && item("versions", "Previous versions", <History size={16} />)}
        {!multiple && item("details", "Properties", <Info size={16} />)}
      </div>
      {canWrite && <div className="file-menu-section">
        {item("delete", multiple ? `Delete ${itemCount(targets.length)}` : "Delete", <Trash2 size={16} />, { danger: true })}
      </div>}
    </div>
  );
}

function BackgroundMenu({ canWrite, position, menuRef, folder, clipboardCount, canSelectAll, onChoose }: {
  canWrite: boolean;
  position: MenuPosition;
  menuRef: React.RefObject<HTMLDivElement | null>;
  folder: string;
  clipboardCount: number;
  canSelectAll: boolean;
  onChoose: (choice: BackgroundChoice) => void;
}) {
  const item = (choice: BackgroundChoice, label: string, icon: ReactNode, disabled = false) => (
    <button role="menuitem" disabled={disabled} onClick={() => onChoose(choice)}>{icon}<span>{label}</span></button>
  );
  return (
    <div ref={menuRef} className="file-action-menu" role="menu" aria-label="Folder actions" style={position}>
      <div className="file-menu-heading"><span className="file-icon directory"><FolderOpen size={17} /></span><div><strong>{folder}</strong><span>This folder</span></div></div>
      {canWrite && <div className="file-menu-section">
        {item("new", "New folder or file", <FolderPlus size={16} />)}
        {item("upload", "Upload files", <Upload size={16} />)}
        {item("paste", clipboardCount ? `Paste ${itemCount(clipboardCount)}` : "Paste", <ClipboardPaste size={16} />, !clipboardCount)}
      </div>}
      <div className="file-menu-section">
        {item("selectAll", "Select all", <ListChecks size={16} />, !canSelectAll)}
        {item("refresh", "Refresh", <RefreshCw size={16} />)}
      </div>
    </div>
  );
}

function FileGrid({ entries, selected, cursor, interactions, onToggle, onOpen }: { entries: FileEntry[]; selected: Set<string>; cursor: string | null; interactions: EntryInteractions; onToggle: (entry: FileEntry, options?: SelectOptions) => void; onOpen: (entry: FileEntry) => void }) {
  return <div className="file-grid">{entries.map((entry) => <article key={entry.path} data-path={entry.path} className={`file-card ${selected.has(entry.path) ? "selected" : ""} ${cursor === entry.path ? "cursor" : ""} ${entryStateClasses(entry, interactions)}`} {...entryItemProps(entry, interactions)} onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }} onClick={(event) => { if ((event.target as HTMLElement).closest("button,input,label")) return; onToggle(entry, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey }); }} onDoubleClick={() => onOpen(entry)}><CheckBox checked={selected.has(entry.path)} onChange={(event) => onToggle(entry, { additive: true, range: event.shiftKey })} label={`Select ${entry.name}`} /><GridPreview entry={entry} onOpen={onOpen} /><button className="grid-name" onClick={() => onOpen(entry)}>{entry.name}</button><span>{entry.type === "directory" ? "Folder" : `${extension(entry.name)} · ${formatBytes(entry.size)}`}</span></article>)}</div>;
}

// A thumbnail for images the server can preview, falling back to the type icon if it can't.
function GridPreview({ entry, onOpen }: { entry: FileEntry; onOpen: (entry: FileEntry) => void }) {
  const [failed, setFailed] = useState(false);
  const thumbnail = !failed && entry.type === "file" && THUMBNAIL_MIME.has(entry.mime) && entry.size <= MAX_THUMBNAIL_SOURCE_BYTES;
  return (
    <button className={`grid-icon ${entry.type} ${thumbnail ? "has-thumbnail" : ""}`} onClick={() => onOpen(entry)} aria-label={`Open ${entry.name}`}>
      {thumbnail
        // The server already makes a small WebP thumbnail, so next/image would only optimize it twice.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img src={`/api/fs/thumbnail?path=${encodePath(entry.path)}&v=${encodeURIComponent(`${entry.modified}-${entry.size}`)}`} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
        : fileIcon(entry, 34)}
    </button>
  );
}

function CheckBox({ checked, onChange, label }: { checked: boolean; onChange: (event: { shiftKey: boolean }) => void; label: string }) {
  // React fires a checkbox's change from its click event, which carries the shift key.
  return <label className="checkbox"><input type="checkbox" checked={checked} onChange={(event) => onChange({ shiftKey: (event.nativeEvent as MouseEvent).shiftKey === true })} aria-label={label} /><span>{checked && <Check size={12} strokeWidth={3} />}</span></label>;
}

// Enough of a FileEntry for the preview and editor dialogs.
function hitEntry(hit: ContentSearchHit): FileEntry {
  return { name: hit.name, path: hit.path, type: "file", size: hit.size, modified: hit.modified, created: hit.modified, mode: "", uid: 0, gid: 0, owner: "", group: "", mime: hit.mime, hidden: hit.name.startsWith(".") };
}

// Marks each occurrence using the same literal, Unicode-aware match as the server.
function highlight(text: string, query: string, matchCase: boolean): ReactNode[] {
  if (!query) return [text];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), matchCase ? "gu" : "giu");
  const parts: ReactNode[] = [];
  let from = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > from) parts.push(text.slice(from, found.index));
    parts.push(<mark key={found.index}>{found[0]}</mark>);
    from = found.index + found[0].length;
  }
  parts.push(text.slice(from));
  return parts;
}

const SEARCH_STOP_REASONS: Record<NonNullable<ContentSearchResult["stoppedBy"]>, string> = {
  results: "Showing 200 of the matching files.",
  files: "Stopped after searching 20,000 files.",
  bytes: "Stopped after reading 256 MB.",
  time: "Stopped after 15 seconds.",
};

function ContentResults({ state, matchCase, onCancel, onOpen, onEdit, onReveal }: {
  state: { status: "running" | "done" | "error"; result?: ContentSearchResult; error?: string } | null;
  matchCase: boolean;
  onCancel: () => void;
  onOpen: (hit: ContentSearchHit) => void;
  onEdit: (hit: ContentSearchHit) => void;
  onReveal: (hit: ContentSearchHit) => void;
}) {
  if (!state || state.status === "running") {
    return <div className="storage-scan-state content-search-state"><LoaderCircle className="spin" size={25} /><strong>Searching inside files…</strong><span>Text files under this folder, up to 15 seconds.</span><button className="button secondary" onClick={onCancel}>Cancel</button></div>;
  }
  if (state.status === "error" || !state.result) {
    return <div className="storage-scan-state error content-search-state"><CircleAlert size={25} /><strong>The search didn&apos;t finish</strong><span>{state.error}</span></div>;
  }
  const { result } = state;
  const summary = `Searched ${result.scannedFiles.toLocaleString()} text ${result.scannedFiles === 1 ? "file" : "files"} (${formatBytes(result.scannedBytes)}) in ${(result.durationMs / 1000).toFixed(1)} s${result.skippedFiles ? ` · ${result.skippedFiles.toLocaleString()} skipped (binary, over 5 MB, or unreadable)` : ""}.`;
  return (
    <div className="content-results">
      {result.hits.length === 0
        ? <div className="empty-state"><div className="empty-icon"><Search size={27} /></div><h2>No files contain “{result.query}”</h2><p>{matchCase ? "Try turning off Match case, or search another folder." : "Try different words, or search another folder."}</p></div>
        : result.hits.map((hit) => {
          const entry = hitEntry(hit);
          return (
            <article key={hit.path} className="content-hit">
              <header>
                <span className="file-icon file">{fileIcon(entry, 17)}</span>
                <div><button className="file-name" title={`/${hit.path}`} onClick={() => onOpen(hit)}>{hit.name}</button><small>{folderLabel(parentOf(hit.path))} · {hit.matchCount} matching {hit.matchCount === 1 ? "line" : "lines"}</small></div>
                {isEditable(entry) && <button className="icon-button" title="Edit" aria-label={`Edit ${hit.name}`} onClick={() => onEdit(hit)}><FilePenLine size={15} /></button>}
                <button className="icon-button" title="Open containing folder" aria-label={`Open folder containing ${hit.name}`} onClick={() => onReveal(hit)}><FolderOpen size={15} /></button>
              </header>
              <ol>{hit.matches.map((match) => <li key={match.line}><span>{match.line}</span><code>{highlight(match.text, result.query, matchCase)}</code></li>)}</ol>
            </article>
          );
        })}
      <p className="content-summary">{summary}{result.stoppedBy ? ` ${SEARCH_STOP_REASONS[result.stoppedBy]} Search a smaller folder to see everything.` : ""}</p>
    </div>
  );
}

function EmptyState({ searching, onUpload, onNew }: { searching: boolean; onUpload: () => void; onNew: () => void }) {
  return <div className="empty-state"><div className="empty-icon">{searching ? <Search size={27} /> : <FolderOpen size={29} />}</div><h2>{searching ? "No matching files" : "This folder is empty"}</h2><p>{searching ? "Try another name or clear your search." : "Upload files or create a folder to get started."}</p>{!searching && <div><button className="button secondary" onClick={onUpload}><Upload size={16} /> Upload</button><button className="button primary" onClick={onNew}><Plus size={16} /> New</button></div>}</div>;
}

function FileSkeleton() {
  return <div className="file-skeleton">{Array.from({ length: 6 }).map((_, index) => <div key={index}><span /><span /><span /><span /></div>)}</div>;
}

function JobPanel({ job, onCancel }: { job: JobState; onCancel: () => void }) {
  const icons: Record<JobState["kind"], ReactNode> = { compress: <FileArchive size={17} />, extract: <PackageOpen size={17} />, copy: <Copy size={17} />, move: <FolderInput size={17} />, restore: <History size={17} /> };
  const percent = job.progress.total ? Math.min(100, (job.progress.done / job.progress.total) * 100) : undefined;
  return (
    <div className="job-panel" role="status" aria-live="polite">
      <div className="job-panel-head"><span className="file-icon">{icons[job.kind]}</span><div><strong title={job.label}>{job.label}</strong><small>{job.status === "running" ? jobProgressText(job) : "Finishing…"}</small></div>{job.status === "running" && <button className="icon-button" aria-label={`Cancel ${job.label}`} title="Cancel" onClick={onCancel}><X size={16} /></button>}</div>
      <div className={`job-panel-track ${percent === undefined ? "indeterminate" : ""}`} role="progressbar" aria-label={job.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === undefined ? undefined : Math.round(percent)}><span style={percent === undefined ? undefined : { width: `${percent}%` }} /></div>
    </div>
  );
}

function DialogHost({ dialog, selected, currentPath, username, role, home, onClose, onRun, notify, onRefresh, onStartJob, onTransfer, onJob, canWrite, onSharesChanged, onCredentialsUpdated, onTwoFactor, onReveal, onPreview }: {
  dialog: NonNullable<DialogState>;
  selected: FileEntry[];
  currentPath: string;
  username: string;
  role: Role;
  home: string;
  onClose: () => void;
  onRun: (body: Record<string, unknown>, success: string) => Promise<boolean>;
  notify: (message: string, tone?: "error") => void;
  onRefresh: () => Promise<void>;
  onStartJob: (body: Record<string, unknown>) => Promise<boolean>;
  onTransfer: (mode: "copy" | "move", paths: string[], destination: string) => Promise<boolean>;
  onJob: (job: JobState) => Promise<boolean>;
  canWrite: boolean;
  onSharesChanged: () => Promise<void>;
  onCredentialsUpdated: () => Promise<void>;
  onTwoFactor: () => void;
  onReveal: (entry: FileEntry) => void;
  onPreview: (entry: FileEntry) => void;
}) {
  if (dialog.kind === "upload") return <UploadDialog files={dialog.files} currentPath={currentPath} chooseOwnership={role === "owner"} onClose={onClose} notify={notify} onComplete={onRefresh} />;
  if (dialog.kind === "users") return <UsersDialog onClose={onClose} notify={notify} />;
  if (dialog.kind === "duplicates") return <DuplicatesDialog startPath={currentPath} onClose={onClose} notify={notify} onRefresh={onRefresh} onReveal={onReveal} />;
  if (dialog.kind === "storage") return <StorageDialog onClose={onClose} onReveal={onReveal} onPreview={onPreview} notify={notify} />;
  if (dialog.kind === "trash") return <TrashDialog onClose={onClose} notify={notify} onRefresh={onRefresh} />;
  if (dialog.kind === "compress") return <CompressDialog entries={selected} currentPath={currentPath} onClose={onClose} onStart={onStartJob} />;
  if (dialog.kind === "share") return <ShareDialog entry={dialog.entry} onClose={onClose} notify={notify} onChanged={onSharesChanged} />;
  if (dialog.kind === "shares") return <SharesDialog onClose={onClose} notify={notify} onChanged={onSharesChanged} />;
  if (dialog.kind === "new") return <NewDialog path={currentPath} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "rename") return <RenameDialog entry={dialog.entry} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "delete") return <DeleteDialog entries={selected} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "permissions") return <PermissionsDialog entries={selected} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "ownership") return <OwnershipDialog entries={selected} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "transfer") return <TransferDialog mode={dialog.mode} entries={selected} startPath={currentPath} home={home} onClose={onClose} onTransfer={onTransfer} />;
  if (dialog.kind === "bulk") return <BulkRenameDialog entries={selected} onClose={onClose} notify={notify} onRefresh={onRefresh} />;
  if (dialog.kind === "preview") return <PreviewDialog entry={dialog.entry} onClose={onClose} />;
  if (dialog.kind === "edit") return <EditDialog entry={dialog.entry} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "twoFactor") return <TwoFactorDialog onClose={onClose} notify={notify} />;
  if (dialog.kind === "snapshots") return <SnapshotsDialog isOwner={role === "owner"} canWrite={canWrite} home={home} onClose={onClose} notify={notify} onJob={onJob} />;
  if (dialog.kind === "versions") return <VersionsDialog entry={dialog.entry} canWrite={canWrite} isOwner={role === "owner"} onClose={onClose} notify={notify} onJob={onJob} />;
  if (dialog.kind === "preferences") return role === "owner"
    ? <PreferencesDialog username={username} onClose={onClose} onUpdated={onCredentialsUpdated} onTwoFactor={onTwoFactor} />
    : <AccountPasswordDialog username={username} role={role} home={home} onClose={onClose} onUpdated={onCredentialsUpdated} onTwoFactor={onTwoFactor} />;
  return <DetailsDialog entry={dialog.entry} onClose={onClose} />;
}

function Modal({ title, subtitle, icon, onClose, children, wide = false }: { title: string; subtitle?: string; icon?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className={`modal ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><div className="modal-title">{icon && <span>{icon}</span>}<div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={18} /></button></header>{children}</section></div>;
}

function ModalActions({ onClose, submitLabel, danger = false, busy = false, disabled = false }: { onClose: () => void; submitLabel: string; danger?: boolean; busy?: boolean; disabled?: boolean }) {
  return <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className={`button ${danger ? "danger" : "primary"}`} disabled={busy || disabled}>{busy && <LoaderCircle className="spin" size={16} />}{submitLabel}</button></div>;
}

function StorageDialog({ onClose, onReveal, onPreview, notify }: { onClose: () => void; onReveal: (entry: FileEntry) => void; onPreview: (entry: FileEntry) => void; notify: (message: string, tone?: "error") => void }) {
  const [result, setResult] = useState<LargestFilesReady | null>(null);
  const [scanProgress, setScanProgress] = useState<LargestFilesProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageSize, setPageSize] = useState(100);
  const [minimumGb, setMinimumGb] = useState("0");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteTargets, setDeleteTargets] = useState<FileEntry[] | null>(null);
  const [permanent, setPermanent] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const nextOffsetRef = useRef(0);
  const minBytesRef = useRef(0);
  const pageSizeRef = useRef(100);

  const load = useCallback(async ({ refresh = false, append = false, minBytes = minBytesRef.current, limit = pageSizeRef.current }: { refresh?: boolean; append?: boolean; minBytes?: number; limit?: number } = {}) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const offset = append ? nextOffsetRef.current : 0;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset), minBytes: String(minBytes) });
      if (refresh) params.set("refresh", "true");
      let value = await requestJson<LargestFilesResult>(`/api/fs/largest?${params}`, { signal: controller.signal });
      while (value.status === "scanning") {
        if (requestRef.current !== controller) return;
        setScanProgress(value.progress);
        value = await requestJson<LargestFilesResult>(`/api/fs/largest?${params}`, { signal: controller.signal });
      }
      if (requestRef.current !== controller) return;
      setScanProgress(null);
      nextOffsetRef.current = value.nextOffset;
      minBytesRef.current = minBytes;
      setResult((previous) => {
        if (!append || !previous) return value;
        const paths = new Set(previous.entries.map((entry) => entry.path));
        return { ...value, entries: [...previous.entries, ...value.entries.filter((entry) => !paths.has(entry.path))] };
      });
      if (!append) setSelected(new Set());
    } catch (caught) {
      if ((caught as Error).name !== "AbortError") setError((caught as Error).message);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [load]);

  const applyMinimum = (event: FormEvent) => {
    event.preventDefault();
    const value = Math.max(0, Number(minimumGb) || 0);
    const minBytes = Math.floor(value * 1024 ** 3);
    minBytesRef.current = minBytes;
    nextOffsetRef.current = 0;
    void load({ minBytes, limit: pageSize });
  };

  const toggleSelected = (path: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const allLoadedSelected = Boolean(result?.entries.length) && result!.entries.every((entry) => selected.has(entry.path));
  const selectedEntries = result?.entries.filter((entry) => selected.has(entry.path)) || [];

  const exportCurrentList = () => {
    if (!result?.entries.length) return;
    const header = ["Rank", "Name", "Path", "Size (GB)", "Size (bytes)", "Owner", "Group", "Added"];
    const rows = result.entries.map((entry, index) => [
      index + 1,
      entry.name,
      `/${entry.path}`,
      (entry.size / 1024 ** 3).toFixed(4),
      entry.size,
      entry.owner,
      entry.group,
      entry.created,
    ]);
    const csv = `\uFEFF${[header, ...rows].map((row) => row.map((value) => csvCell(value)).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `filesdude-largest-files-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const deleteFiles = async () => {
    if (!deleteTargets?.length) return;
    setDeleting(true);
    setError("");
    try {
      for (let start = 0; start < deleteTargets.length; start += 100) {
        await requestJson("/api/fs", {
          method: "POST",
          body: JSON.stringify({ action: "delete", paths: deleteTargets.slice(start, start + 100).map((entry) => entry.path), permanent }),
        });
      }
      notify(permanent ? `${deleteTargets.length} files permanently deleted` : `${deleteTargets.length} files moved to protected trash`);
      setDeleteTargets(null);
      setPermanent(false);
      setSelected(new Set());
      nextOffsetRef.current = 0;
      await load({ refresh: true, minBytes: minBytesRef.current, limit: pageSizeRef.current });
    } catch (caught) {
      const message = (caught as Error).message;
      notify(message, "error");
      nextOffsetRef.current = 0;
      await load({ refresh: true, minBytes: minBytesRef.current, limit: pageSizeRef.current });
    } finally {
      setDeleteTargets(null);
      setPermanent(false);
      setDeleting(false);
    }
  };

  const remaining = result ? Math.max(0, result.totalMatching - result.entries.length) : 0;
  const nextCount = Math.min(pageSize, remaining);

  return (
    <Modal title="Largest files" subtitle="Find, export, and remove files across the entire directory tree" icon={<HardDrive size={19} />} onClose={onClose} wide>
      <div className="storage-browser">
        <div className="storage-scan-bar">
          <div>{scanProgress ? <><strong>Scanning…</strong><span>Scanned {scanProgress.scannedFiles.toLocaleString()} files in {scanProgress.scannedDirectories.toLocaleString()} folders · {(scanProgress.elapsedMs / 1000).toFixed(0)}s so far</span></> : result ? <><strong>{result.totalMatching.toLocaleString()} matching files · {formatBytes(result.matchingBytes)}</strong><span>Showing {result.entries.length.toLocaleString()} · scanned {result.scannedFiles.toLocaleString()} files in {result.scannedDirectories.toLocaleString()} folders · {(result.durationMs / 1000).toFixed(1)}s{result.cached ? " · cached" : ""}</span></> : <><strong>Whole-tree storage scan</strong><span>Every accessible folder under the configured root</span></>}</div>
          <div className="storage-scan-actions"><button className="button secondary" disabled={!result?.entries.length} onClick={exportCurrentList}><ArrowDownToLine size={15} /> Export CSV</button><button className="button secondary" disabled={loading} onClick={() => void load({ refresh: true, minBytes: minBytesRef.current, limit: pageSizeRef.current })}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</button></div>
        </div>
        <form className="storage-filter" onSubmit={applyMinimum}>
          <label><span>Minimum file size</span><div><input type="number" min="0" step="0.1" value={minimumGb} onChange={(event) => setMinimumGb(event.target.value)} /><strong>GB</strong></div></label>
          <label><span>Load at a time</span><select value={pageSize} onChange={(event) => { const value = Number(event.target.value); setPageSize(value); pageSizeRef.current = value; }}><option value="100">100 files</option><option value="250">250 files</option><option value="500">500 files</option></select></label>
          <button className="button primary" disabled={loading}>Apply filter</button>
        </form>
        {selected.size > 0 && <div className="storage-selection-bar"><div><span>{selected.size}</span><strong>{selected.size === 1 ? "file" : "files"} selected</strong></div><div><button className="button danger" onClick={() => setDeleteTargets(selectedEntries)}><Trash2 size={15} /> Delete selected</button><button className="button secondary" onClick={() => setSelected(new Set())}>Clear</button></div></div>}
        {loading && !result ? <div className="storage-scan-state"><LoaderCircle className="spin" size={25} /><strong>Finding the largest files…</strong><span>Large directory trees can take a little while on the first scan.</span></div> : error && !result ? <div className="storage-scan-state error"><CircleAlert size={25} /><strong>Unable to scan storage</strong><span>{error}</span><button className="button secondary" onClick={() => void load({ refresh: true })}>Try again</button></div> : result && <>
          <div className="largest-file-table" role="table" aria-label="Largest files">
            <div className="largest-file-row largest-file-header" role="row"><div role="columnheader"><CheckBox checked={allLoadedSelected} onChange={() => setSelected(allLoadedSelected ? new Set() : new Set(result.entries.map((entry) => entry.path)))} label="Select all loaded files" /></div><div role="columnheader">#</div><div role="columnheader">Name</div><div role="columnheader">Location</div><div role="columnheader">Size (GB)</div><div role="columnheader">Added</div><div role="columnheader" /></div>
            {result.entries.map((entry, index) => <div className={`largest-file-row ${selected.has(entry.path) ? "selected" : ""}`} role="row" key={entry.path}><div role="cell"><CheckBox checked={selected.has(entry.path)} onChange={() => toggleSelected(entry.path)} label={`Select ${entry.name}`} /></div><div className="largest-rank" role="cell">{index + 1}</div><div className="largest-name" role="cell"><span className={`file-icon ${entry.type}`}>{fileIcon(entry, 17)}</span><button title={entry.name} onClick={() => onPreview(entry)}>{entry.name}</button></div><div className="largest-location" role="cell" title={`/${entry.path}`}><span>/</span>{entry.path.split("/").slice(0, -1).join("/") || "Root"}</div><div className="largest-size" role="cell" title={formatBytes(entry.size)}>{formatGigabytes(entry.size)}</div><div className="muted" role="cell">{formatDate(entry.created)}</div><div className="largest-actions" role="cell"><button className="icon-button" title="Open containing folder" aria-label={`Open folder containing ${entry.name}`} onClick={() => onReveal(entry)}><FolderOpen size={16} /></button><a className="icon-button" title="Download" aria-label={`Download ${entry.name}`} href={`/api/fs/download?path=${encodePath(entry.path)}`}><Download size={16} /></a><button className="icon-button delete" title="Delete" aria-label={`Delete ${entry.name}`} onClick={() => setDeleteTargets([entry])}><Trash2 size={16} /></button></div></div>)}
            {!result.entries.length && <div className="storage-no-results"><Search size={23} /><strong>No files match this size</strong><span>Lower the minimum size and apply the filter again.</span></div>}
          </div>
          {result.hasMore && <div className="storage-show-more"><span>Showing {result.entries.length.toLocaleString()} of {result.totalMatching.toLocaleString()}</span><button className="button secondary" disabled={loading} onClick={() => void load({ append: true, minBytes: minBytesRef.current, limit: pageSizeRef.current })}>{loading ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Show {nextCount.toLocaleString()} more</button></div>}
          {error && <div className="storage-scan-note error"><CircleAlert size={15} /> Request failed: {error}</div>}
          {result.skippedEntries > 0 && <div className="storage-scan-note"><Info size={15} /> {result.skippedEntries.toLocaleString()} inaccessible or changed {result.skippedEntries === 1 ? "entry was" : "entries were"} skipped.</div>}
          {deleteTargets && <div className="storage-delete-confirm" role="alert"><div><Trash2 size={19} /><span><strong>Delete {deleteTargets.length} {deleteTargets.length === 1 ? "file" : "files"}?</strong><small>{permanent ? "This cannot be undone." : "Files will be moved to FilesDude’s protected trash."}</small></span></div><label className="switch-row compact"><input type="checkbox" checked={permanent} disabled={deleting} onChange={(event) => setPermanent(event.target.checked)} /><span className="switch" /><div><strong>Delete permanently</strong><small>Bypass protected trash</small></div></label><div><button className="button secondary" disabled={deleting} onClick={() => { setDeleteTargets(null); setPermanent(false); }}>Cancel</button><button className="button danger" disabled={deleting} onClick={() => void deleteFiles()}>{deleting && <LoaderCircle className="spin" size={15} />}{permanent ? "Delete permanently" : "Move to trash"}</button></div></div>}
          <div className="storage-scan-foot"><span>Scanned {new Date(result.generatedAt).toLocaleString()} · results cached for five minutes</span><button className="button primary" onClick={onClose}>Done</button></div>
        </>}
      </div>
    </Modal>
  );
}

type TrashConfirmation = { kind: "delete"; items: TrashItem[] } | { kind: "empty" };

const SHARE_EXPIRY_OPTIONS = [{ hours: 1, label: "1 hour" }, { hours: 24, label: "1 day" }, { hours: 168, label: "7 days" }, { hours: 720, label: "30 days" }];
const SHARE_LIMIT_OPTIONS = [{ value: "none", label: "No limit" }, { value: "1", label: "1 download (single use)" }, { value: "5", label: "5 downloads" }, { value: "25", label: "25 downloads" }];

function useShareLinks(notify: (message: string, tone?: "error") => void, onChanged: () => Promise<void>) {
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const load = useCallback(async () => {
    try {
      const result = await requestJson<{ enabled: boolean; shares: ShareLink[] }>("/api/shares");
      setEnabled(result.enabled);
      setLinks(result.shares);
    } catch (error) {
      notify((error as Error).message, "error");
      setLinks([]);
    }
  }, [notify]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const copy = async (link: ShareLink) => notify(await copyText(shareAddress(link)) ? "Link copied" : "Couldn't copy automatically; select the link and copy it", undefined);
  const revoke = async (link: ShareLink) => {
    try {
      await requestJson("/api/shares", { method: "POST", body: JSON.stringify({ action: "revoke", id: link.id }) });
      setLinks((current) => current?.filter((item) => item.id !== link.id) ?? null);
      notify(`Link to ${link.name} revoked`);
      await onChanged();
    } catch (error) {
      notify((error as Error).message, "error");
    }
  };
  return { links, setLinks, enabled, copy, revoke };
}

function ShareLinkRow({ link, showLocation, onCopy, onRevoke }: { link: ShareLink; showLocation?: boolean; onCopy: (link: ShareLink) => void; onRevoke: (link: ShareLink) => void }) {
  return (
    <div className="share-link-row">
      <div className="share-link-info">
        {showLocation && <strong title={`/${link.path}`}>{link.type === "directory" ? <Folder size={14} /> : <File size={14} />}{link.name}<small>{folderLabel(parentOf(link.path))}</small></strong>}
        <span>Expires {formatDateTime(link.expiresAt)} · {link.maxDownloads === null ? `${link.downloads} ${link.downloads === 1 ? "download" : "downloads"}` : `${link.downloads} of ${link.maxDownloads} downloads used`}</span>
      </div>
      <div className="share-link-actions">
        <input readOnly value={shareAddress(link)} aria-label={`Link to ${link.name}`} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="button secondary" onClick={() => onCopy(link)}><Copy size={14} /> Copy</button>
        <button type="button" className="button secondary danger-text" onClick={() => onRevoke(link)}><X size={14} /> Revoke</button>
      </div>
    </div>
  );
}

function ShareDialog({ entry, onClose, notify, onChanged }: { entry: FileEntry; onClose: () => void; notify: (message: string, tone?: "error") => void; onChanged: () => Promise<void> }) {
  const { links, setLinks, enabled, copy, revoke } = useShareLinks(notify, onChanged);
  const [hours, setHours] = useState(168);
  const [limit, setLimit] = useState("none");
  const [busy, setBusy] = useState(false);
  const mine = links?.filter((link) => link.path === entry.path) ?? [];
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const { share } = await requestJson<{ share: ShareLink }>("/api/shares", { method: "POST", body: JSON.stringify({ action: "create", path: entry.path, hours, maxDownloads: limit === "none" ? null : Number(limit) }) });
      setLinks((current) => [share, ...(current ?? [])]);
      notify(await copyText(shareAddress(share)) ? "Link created and copied" : "Link created");
      await onChanged();
    } catch (error) {
      notify((error as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Share ${entry.name}`} subtitle="Anyone with the link can download it without signing in" icon={<Link2 size={19} />} onClose={onClose} wide>
      <form onSubmit={create}>
        {!enabled && <div className="warning-box"><CircleAlert size={17} /> Sharing is turned off on this server (FILEDUDE_SHARING_ENABLED=false).</div>}
        <div className="field-pair">
          <FormField label="Link expires after"><select value={hours} onChange={(event) => setHours(Number(event.target.value))} disabled={!enabled}>{SHARE_EXPIRY_OPTIONS.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}</select></FormField>
          <FormField label="Downloads allowed"><select value={limit} onChange={(event) => setLimit(event.target.value)} disabled={!enabled}>{SHARE_LIMIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></FormField>
        </div>
        <div className="info-box"><Info size={17} /> {entry.type === "directory" ? "The folder downloads as a ZIP file of its current contents." : "The file always downloads; it never opens in the browser."} Links use this address ({typeof window === "undefined" ? "" : window.location.host}), so people can only open them if they can reach FilesDude here.</div>
        {links === null ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Loading links…</div> : mine.length > 0 && <div className="share-links"><p className="share-links-title">Active links to this {entry.type === "directory" ? "folder" : "file"}</p>{mine.map((link) => <ShareLinkRow key={link.id} link={link} onCopy={copy} onRevoke={revoke} />)}</div>}
        <ModalActions onClose={onClose} submitLabel={mine.length ? "Create another link" : "Create link"} busy={busy} disabled={!enabled} />
      </form>
    </Modal>
  );
}

function SharesDialog({ onClose, notify, onChanged }: { onClose: () => void; notify: (message: string, tone?: "error") => void; onChanged: () => Promise<void> }) {
  const { links, enabled, copy, revoke } = useShareLinks(notify, onChanged);
  return (
    <Modal title="Shared links" subtitle="Everything currently downloadable without signing in" icon={<Link2 size={19} />} onClose={onClose} wide>
      <div className="storage-browser">
        {!enabled && <div className="warning-box"><CircleAlert size={17} /> Sharing is turned off on this server, so no links work.</div>}
        {links === null ? <div className="storage-scan-state"><LoaderCircle className="spin" size={25} /><strong>Loading links…</strong></div>
          : links.length === 0 ? <div className="storage-scan-state"><Link2 size={25} /><strong>Nothing is shared</strong><span>Right-click a file or folder and choose Share link to create one.</span></div>
          : <div className="share-links">{links.map((link) => <ShareLinkRow key={link.id} link={link} showLocation onCopy={copy} onRevoke={revoke} />)}</div>}
        <div className="storage-scan-foot"><span>Expired and used-up links are removed automatically.</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

const snapshotDownloadUrl = (snapshot: string, itemPath: string) => `/api/fs/snapshots/download?snapshot=${encodeURIComponent(snapshot)}&path=${encodePath(itemPath)}`;

async function startRestore(snapshot: string, itemPath: string, onJob: (job: JobState) => Promise<boolean>, notify: (message: string, tone?: "error") => void) {
  try {
    const { job } = await requestJson<{ job: JobState }>("/api/fs/snapshots", { method: "POST", body: JSON.stringify({ action: "restore", snapshot, path: itemPath }) });
    await onJob(job);
  } catch (caught) {
    notify((caught as Error).message, "error");
  }
}

function SnapshotsDialog({ isOwner, canWrite, home, onClose, notify, onJob }: { isOwner: boolean; canWrite: boolean; home: string; onClose: () => void; notify: (message: string, tone?: "error") => void; onJob: (job: JobState) => Promise<boolean> }) {
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [schedule, setSchedule] = useState<SnapshotSchedule>({ frequency: "off", keep: 24 });
  const [savedSchedule, setSavedSchedule] = useState<SnapshotSchedule | null>(null);
  const [access, setAccess] = useState<SnapshotAccess | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [browsePath, setBrowsePath] = useState(home);
  const [entries, setEntries] = useState<SnapshotEntry[] | null>(null);
  const [removing, setRemoving] = useState<SnapshotInfo | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ available: boolean; snapshots?: SnapshotInfo[]; schedule?: SnapshotSchedule; access?: SnapshotAccess }>("/api/fs/snapshots", { signal: controller.signal })
      .then((result) => {
        setSnapshots(result.snapshots ?? []);
        if (result.access) setAccess(result.access);
        if (result.schedule) {
          setSchedule(result.schedule);
          setSavedSchedule(result.schedule);
        }
      })
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!chosen) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setEntries(null);
      requestJson<{ entries: SnapshotEntry[] }>(`/api/fs/snapshots?view=browse&snapshot=${encodeURIComponent(chosen)}&path=${encodePath(browsePath)}`, { signal: controller.signal })
        .then((result) => setEntries(result.entries))
        .catch((caught) => {
          if ((caught as Error).name === "AbortError") return;
          setEntries([]);
          setError((caught as Error).message);
        });
    }, 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [chosen, browsePath]);

  const send = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ snapshots: SnapshotInfo[]; schedule?: SnapshotSchedule; access?: SnapshotAccess }>("/api/fs/snapshots", { method: "POST", body: JSON.stringify(body) });
      setSnapshots(result.snapshots);
      if (result.schedule) setSavedSchedule(result.schedule);
      if (result.access) setAccess(result.access);
      setRemoving(null);
      notify(success);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const open = (name: string) => {
    setChosen(name);
    setBrowsePath(home);
    setError("");
  };
  const crumbs = browsePath === home ? [] : browsePath.slice(home ? home.length + 1 : 0).split("/");
  const scheduleChanged = savedSchedule !== null && (schedule.frequency !== savedSchedule.frequency || schedule.keep !== savedSchedule.keep);
  const chosenSnapshot = snapshots?.find((snapshot) => snapshot.name === chosen);

  return (
    <Modal title="Snapshots" subtitle="Earlier versions of your files, kept by ZFS" icon={<History size={19} />} onClose={onClose} wide>
      <div className="storage-browser snapshots-dialog">
        {isOwner && <div className="snapshot-controls">
          <div className="snapshot-schedule">
            <FormField label="Automatic snapshots"><select value={schedule.frequency} onChange={(event) => setSchedule({ frequency: event.target.value as SnapshotSchedule["frequency"], keep: event.target.value === "daily" && schedule.keep === 24 ? 14 : event.target.value === "hourly" && schedule.keep === 14 ? 24 : schedule.keep })} disabled={savedSchedule === null}><option value="off">Off</option><option value="hourly">Every hour</option><option value="daily">Every day</option></select></FormField>
            {schedule.frequency !== "off" && <FormField label="Keep the newest"><input type="number" min={1} max={1000} value={schedule.keep} onChange={(event) => setSchedule({ ...schedule, keep: Number(event.target.value) })} /></FormField>}
            {scheduleChanged && <button className="button primary" disabled={busy} onClick={() => void send({ action: "schedule", schedule }, schedule.frequency === "off" ? "Automatic snapshots turned off" : "Snapshot schedule saved · the next snapshot is taken within 5 minutes")}>Save</button>}
            <FormField label="Who can see snapshots"><select value={access ?? "owner"} disabled={access === null || busy} onChange={(event) => void send({ action: "access", access: event.target.value }, event.target.value === "owner" ? "Only you can see snapshots now" : "Snapshot access updated")}><option value="owner">Only me</option><option value="editors">Editors and me</option><option value="everyone">Everyone</option></select></FormField>
          </div>
          <button className="button secondary" disabled={busy || snapshots === null} onClick={() => void send({ action: "create" }, "Snapshot taken")}>{busy ? <LoaderCircle className="spin" size={15} /> : <Camera size={15} />} Take snapshot now</button>
        </div>}
        {isOwner && access !== null && access !== "owner" && <div className="storage-scan-note trash-note"><Info size={15} /> Shared accounts see their own folder in each snapshot as it was then, including anything since moved out of it. Delete a snapshot to remove what it holds.</div>}
        {removing && <div className="storage-delete-confirm trash-confirm" role="alert"><div><Trash2 size={19} /><span><strong>Delete the snapshot from {formatDateTime(removing.createdAt)}?</strong><small>The earlier versions it holds can no longer be restored. Current files aren&apos;t affected.</small></span></div><div><button className="button secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button className="button danger" disabled={busy} onClick={() => void send({ action: "delete", name: removing.name }, "Snapshot deleted")}>Delete snapshot</button></div></div>}
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        <div className="snapshots-layout">
          <div className="snapshot-list" role="list" aria-label="Snapshots">
            {snapshots === null ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Loading…</div>
              : snapshots.length === 0 ? <div className="snapshot-empty"><History size={22} /><strong>No snapshots yet</strong><span>{isOwner ? "Take one now, or turn on automatic snapshots above." : "The owner hasn't taken any snapshots yet."}</span></div>
                : snapshots.map((snapshot) => (
                  <div key={snapshot.name} role="listitem" className={`snapshot-row ${snapshot.name === chosen ? "active" : ""}`}>
                    <button className="snapshot-open" onClick={() => open(snapshot.name)}><strong>{formatDateTime(snapshot.createdAt)}</strong><small>{SNAPSHOT_KIND_LABELS[snapshot.kind]}{snapshot.used !== undefined ? ` · ${formatBytes(snapshot.used)} unique` : ""}</small></button>
                    {isOwner && snapshot.kind !== "other" && <button className="icon-button delete" title="Delete snapshot" aria-label={`Delete the snapshot from ${formatDateTime(snapshot.createdAt)}`} disabled={busy} onClick={() => setRemoving(snapshot)}><Trash2 size={15} /></button>}
                  </div>
                ))}
          </div>
          <div className="snapshot-browser">
            {!chosenSnapshot ? <div className="snapshot-empty"><FolderOpen size={22} /><strong>Choose a snapshot</strong><span>Browse your files as they were, then download or restore what you need.</span></div> : <>
              <div className="snapshot-crumbs"><button onClick={() => setBrowsePath(home)}>Home</button>{crumbs.map((part, index) => <span key={index}><ChevronRight size={13} /><button onClick={() => setBrowsePath([home, ...crumbs.slice(0, index + 1)].filter(Boolean).join("/"))}>{part}</button></span>)}</div>
              {entries === null ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Loading…</div>
                : entries.length === 0 ? <div className="snapshot-empty"><span>This folder was empty.</span></div>
                  : <div className="snapshot-entries" role="table" aria-label="Items in the snapshot">{entries.map((entry) => (
                    <div key={entry.path} className="snapshot-entry" role="row">
                      <span className={`file-icon ${entry.type}`}>{fileIcon({ type: entry.type === "directory" ? "directory" : entry.type === "symlink" ? "symlink" : "file", mime: entry.mime }, 16)}</span>
                      {entry.type === "directory" ? <button className="snapshot-entry-name" role="cell" onClick={() => setBrowsePath(entry.path)}>{entry.name}</button> : <span className="snapshot-entry-name" role="cell" title={entry.name}>{entry.name}</span>}
                      <span className="muted" role="cell">{entry.type === "directory" ? "—" : formatBytes(entry.size)}</span>
                      <span className="muted" role="cell">{formatDate(entry.modified)}</span>
                      <span className="largest-actions" role="cell">
                        {(entry.type === "file" || entry.type === "directory") && <button className="icon-button" title={entry.type === "directory" ? "Download as ZIP" : "Download"} aria-label={`Download ${entry.name}`} onClick={() => downloadFrom(snapshotDownloadUrl(chosenSnapshot.name, entry.path))}><ArrowDownToLine size={15} /></button>}
                        {canWrite && entry.type !== "other" && <button className="icon-button" title="Restore next to the current version" aria-label={`Restore ${entry.name}`} onClick={() => void startRestore(chosenSnapshot.name, entry.path, onJob, notify)}><RotateCcw size={15} /></button>}
                      </span>
                    </div>
                  ))}</div>}
            </>}
          </div>
        </div>
        <div className="storage-scan-foot"><span className="muted">{canWrite ? "Restoring never replaces anything: an item whose name is taken comes back as “name (restored …)”." : "You can download earlier versions; an editor or the owner can restore them."}</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

function VersionsDialog({ entry, canWrite, isOwner, onClose, notify, onJob }: { entry: FileEntry; canWrite: boolean; isOwner: boolean; onClose: () => void; notify: (message: string, tone?: "error") => void; onJob: (job: JobState) => Promise<boolean> }) {
  const [versions, setVersions] = useState<SnapshotVersion[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ versions: SnapshotVersion[] }>(`/api/fs/snapshots?view=versions&path=${encodePath(entry.path)}`, { signal: controller.signal })
      .then((result) => setVersions(result.versions))
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => controller.abort();
  }, [entry.path]);
  return (
    <Modal title="Previous versions" subtitle={entry.name} icon={<History size={19} />} onClose={onClose} wide>
      <div className="storage-browser">
        {error ? <div className="form-error"><CircleAlert size={16} />{error}</div>
          : versions === null ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Looking through snapshots…</div>
            : versions.length === 0 ? <div className="snapshot-empty"><History size={22} /><strong>No earlier versions</strong><span>{entry.type === "directory" ? "This folder isn't in any snapshot yet." : "No snapshot holds a different version of this file."} {isOwner ? "Take a snapshot or turn on automatic snapshots under Snapshots." : ""}</span></div>
              : <div className="snapshot-entries" role="table" aria-label="Earlier versions">
                <div className="snapshot-entry snapshot-entry-header" role="row"><span /><span role="columnheader">Snapshot</span><span role="columnheader">Size</span><span role="columnheader">Modified</span><span /></div>
                {versions.map((version) => (
                  <div key={version.snapshot} className="snapshot-entry" role="row">
                    <span className={`file-icon ${version.type}`}><History size={16} /></span>
                    <span className="snapshot-entry-name" role="cell">{formatDateTime(version.snapshotCreatedAt)}</span>
                    <span className="muted" role="cell">{version.type === "directory" ? "—" : formatBytes(version.size)}</span>
                    <span className="muted" role="cell" title={new Date(version.modified).toLocaleString()}>{formatDate(version.modified)}</span>
                    <span className="largest-actions" role="cell">
                      {(version.type === "file" || version.type === "directory") && <button className="icon-button" title="Download this version" aria-label={`Download the version from ${formatDateTime(version.snapshotCreatedAt)}`} onClick={() => downloadFrom(snapshotDownloadUrl(version.snapshot, entry.path))}><ArrowDownToLine size={15} /></button>}
                      {canWrite && <button className="icon-button" title="Restore next to the current version" aria-label={`Restore the version from ${formatDateTime(version.snapshotCreatedAt)}`} onClick={() => void startRestore(version.snapshot, entry.path, onJob, notify)}><RotateCcw size={15} /></button>}
                    </span>
                  </div>
                ))}
              </div>}
        <div className="storage-scan-foot"><span className="muted">{canWrite ? "A restored version is saved beside the current one as “name (restored …)”." : "You can download earlier versions."}</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

type DuplicateCopy = { path: string; modified: string; inode: string; links: number };
type DuplicateGroup = { size: number; copies: DuplicateCopy[]; wastedBytes: number };
type DuplicateReport = { folder: string; minBytes: number; generatedAt: string; durationMs: number; filesSeen: number; skipped: number; groups: DuplicateGroup[]; totalGroups: number; wastedBytes: number };
type DuplicateProgress = { phase: "listing" | "comparing" | "hashing"; folder: string; filesSeen: number; directoriesSeen: number; candidates: number; bytesToHash: number; bytesHashed: number; elapsedMs: number };
type DuplicateStatus = { scanning: DuplicateProgress | null; report: DuplicateReport | null; error: string | null };
const DUPLICATE_MINIMUMS = [[1024 * 1024, "1 MB"], [10 * 1024 * 1024, "10 MB"], [100 * 1024 * 1024, "100 MB"], [1024 * 1024 * 1024, "1 GB"]] as const;

function duplicateProgressText(progress: DuplicateProgress) {
  if (progress.phase === "listing") return `Listing files · ${progress.filesSeen.toLocaleString()} files in ${progress.directoriesSeen.toLocaleString()} folders`;
  if (progress.phase === "comparing") return `Comparing ${progress.candidates.toLocaleString()} files of matching sizes`;
  return `Checking contents · ${formatBytes(progress.bytesHashed)} of ${formatBytes(progress.bytesToHash)}`;
}

function DuplicatesDialog({ startPath, onClose, notify, onRefresh, onReveal }: { startPath: string; onClose: () => void; notify: (message: string, tone?: "error") => void; onRefresh: () => Promise<void>; onReveal: (entry: FileEntry) => void }) {
  const [status, setStatus] = useState<DuplicateStatus | null>(null);
  const [folder, setFolder] = useState(startPath);
  const [minBytes, setMinBytes] = useState<number>(DUPLICATE_MINIMUMS[1][0]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (offset = 0) => {
    const next = await requestJson<DuplicateStatus>(`/api/fs/duplicates?offset=${offset}&limit=200`);
    setStatus((current) => (offset && current?.report && next.report ? { ...next, report: { ...next.report, groups: [...current.report.groups, ...next.report.groups] } } : next));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load().catch((caught) => setError((caught as Error).message)), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // While a scan runs, its progress is checked every second and a half.
  useEffect(() => {
    if (!status?.scanning) return;
    const timer = window.setTimeout(() => void load().catch(() => undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [status, load]);

  const post = async (body: Record<string, unknown>) => requestJson<DuplicateStatus>("/api/fs/duplicates", { method: "POST", body: JSON.stringify(body) });
  const startScan = async () => {
    setBusy(true);
    setError("");
    try {
      setSelected(new Set());
      setStatus(await post({ action: "scan", path: folder, minBytes }));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancelScan = async () => {
    await post({ action: "cancel" }).catch(() => undefined);
    await load().catch(() => undefined);
  };

  const report = status?.report ?? null;
  const groups = report?.groups ?? [];
  // Every group keeps at least one copy: a box can't be ticked if it would select a group's last one.
  const remainingIn = (group: DuplicateGroup) => group.copies.filter((copy) => !selected.has(copy.path)).length;
  const toggle = (group: DuplicateGroup, copy: DuplicateCopy) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(copy.path)) next.delete(copy.path);
      else if (remainingIn(group) > 1) next.add(copy.path);
      return next;
    });
  };
  const keepOne = (which: "oldest" | "newest") => {
    const next = new Set<string>();
    for (const group of groups) {
      const keep = which === "oldest" ? group.copies[0] : group.copies[group.copies.length - 1];
      for (const copy of group.copies) if (copy.inode !== keep.inode) next.add(copy.path);
    }
    setSelected(next);
  };
  // Space freed: each file all of whose selected paths go (a hard-linked file with paths left keeps its space).
  const freed = groups.reduce((total, group) => {
    const inodes = new Set(group.copies.map((copy) => copy.inode));
    let freedHere = 0;
    for (const inode of inodes) {
      const paths = group.copies.filter((copy) => copy.inode === inode);
      if (paths.every((copy) => selected.has(copy.path)) && paths[0].links <= paths.length) freedHere += group.size;
    }
    return total + freedHere;
  }, 0);

  const trashSelected = async () => {
    setBusy(true);
    setError("");
    try {
      const paths = [...selected];
      let trashed = 0;
      let changed = 0;
      for (let start = 0; start < paths.length; start += 500) {
        const response = await requestJson<DuplicateStatus & { result: { trashed: unknown[]; changed: unknown[] } }>("/api/fs/duplicates", { method: "POST", body: JSON.stringify({ action: "trash", paths: paths.slice(start, start + 500) }) });
        setStatus(response);
        trashed += response.result.trashed.length;
        changed += response.result.changed.length;
      }
      notify(`${itemCount(trashed)} moved to the trash${changed ? ` · ${itemCount(changed)} changed since the scan and ${changed === 1 ? "was" : "were"} left alone` : ""}`, changed ? "error" : undefined);
      setSelected(new Set());
      await onRefresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const scanning = status?.scanning ?? null;
  const percent = scanning?.phase === "hashing" && scanning.bytesToHash ? Math.min(100, (scanning.bytesHashed / scanning.bytesToHash) * 100) : undefined;
  return (
    <Modal title="Duplicate files" subtitle="Find files with identical contents and keep one copy of each" icon={<Files size={19} />} onClose={onClose} wide>
      <div className="storage-browser duplicates-dialog">
        <div className="snapshot-controls">
          <div className="snapshot-schedule">
            <FormField label="Folder to scan"><div className="path-input"><span>/</span><input value={folder} onChange={(event) => setFolder(event.target.value.replace(/^\/+/, ""))} placeholder="Everything" disabled={Boolean(scanning)} /></div></FormField>
            <FormField label="Ignore files smaller than"><select value={minBytes} onChange={(event) => setMinBytes(Number(event.target.value))} disabled={Boolean(scanning)}>{DUPLICATE_MINIMUMS.map(([bytes, label]) => <option key={bytes} value={bytes}>{label}</option>)}</select></FormField>
          </div>
          {scanning ? <button className="button secondary" onClick={() => void cancelScan()}><X size={15} /> Cancel scan</button> : <button className="button primary" disabled={busy || status === null} onClick={() => void startScan()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Search size={15} />} {report ? "Scan again" : "Scan for duplicates"}</button>}
        </div>
        {scanning && <div className="duplicate-progress" role="status"><div><LoaderCircle className="spin" size={15} /> {duplicateProgressText(scanning)}</div><div className={`job-panel-track ${percent === undefined ? "indeterminate" : ""}`}><span style={percent === undefined ? undefined : { width: `${percent}%` }} /></div><small className="muted">Scanning /{scanning.folder} · {Math.round(scanning.elapsedMs / 1000)}s so far. You can close this window; the scan keeps going.</small></div>}
        {(error || status?.error) && <div className="form-error"><CircleAlert size={16} />{error || status?.error}</div>}
        {!scanning && !report && status !== null && <div className="snapshot-empty"><Files size={22} /><strong>No scan yet</strong><span>Scanning reads files of the same size to compare them, so large folders take a while. Duplicates are moved to the trash, never deleted outright, and one copy of each is always kept.</span></div>}
        {report && <>
          <div className="storage-scan-note"><Info size={15} /> {report.totalGroups ? `${report.totalGroups.toLocaleString()} ${report.totalGroups === 1 ? "set" : "sets"} of duplicates in /${report.folder} · ${formatBytes(report.wastedBytes)} taken by extra copies` : `No duplicates of ${formatBytes(report.minBytes)} or more in /${report.folder}`} · {report.filesSeen.toLocaleString()} files checked {formatDateTime(report.generatedAt)}{report.skipped ? ` · ${report.skipped.toLocaleString()} skipped (unreadable or changed)` : ""}</div>
          {groups.length > 0 && <div className="duplicate-actions"><span className="muted">Select:</span><button className="button secondary" onClick={() => keepOne("oldest")}>All but the oldest</button><button className="button secondary" onClick={() => keepOne("newest")}>All but the newest</button>{selected.size > 0 && <button className="button secondary" onClick={() => setSelected(new Set())}>Clear</button>}<span className="duplicate-actions-gap" />{selected.size > 0 && <button className="button danger" disabled={busy} onClick={() => void trashSelected()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />} Move {itemCount(selected.size)} to trash{freed ? ` (${formatBytes(freed)})` : ""}</button>}</div>}
          <div className="duplicate-groups">
            {groups.map((group) => (
              <div key={group.copies[0].path} className="duplicate-group">
                <div className="duplicate-group-head"><strong>{lastSegment(group.copies[0].path)}</strong><span className="muted">{group.copies.length} copies · {formatBytes(group.size)} each · {formatBytes(group.wastedBytes)} extra</span></div>
                {group.copies.map((copy) => {
                  const parent = parentOf(copy.path);
                  const lastLeft = !selected.has(copy.path) && remainingIn(group) <= 1;
                  return (
                    <div key={copy.path} className={`duplicate-copy ${selected.has(copy.path) ? "selected" : ""}`}>
                      <CheckBox checked={selected.has(copy.path)} onChange={() => toggle(group, copy)} label={lastLeft ? `Keep ${copy.path}: the last copy` : `Select ${copy.path}`} />
                      <button className="duplicate-path" title={`Show /${parent || ""} in the file list`} onClick={() => onReveal({ path: copy.path } as FileEntry)}><span className="muted">/{parent ? `${parent}/` : ""}</span>{lastSegment(copy.path)}</button>
                      {copy.links > 1 && <span className="two-factor-badge" title="This file has other hard links, so removing this path frees no space by itself">hard-linked</span>}
                      <span className="muted" title={new Date(copy.modified).toLocaleString()}>{formatDate(copy.modified)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {groups.length < report.totalGroups && <div className="storage-show-more"><span>Showing {groups.length.toLocaleString()} of {report.totalGroups.toLocaleString()} sets</span><button className="button secondary" onClick={() => void load(groups.length)}><Plus size={15} /> Show more</button></div>}
        </>}
        <div className="storage-scan-foot"><span className="muted">Removing a copy a torrent client is still seeding will break that torrent.</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}

const lastSegment = (value: string) => value.split("/").at(-1) ?? value;

// How long until an item is removed by trash retention.
function expiryLabel(deletedAt: string, retentionDays: number) {
  const daysLeft = Math.ceil((Date.parse(deletedAt) + retentionDays * 86_400_000 - Date.now()) / 86_400_000);
  if (daysLeft <= 0) return "Removed within the hour";
  return daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
}

function TrashDialog({ onClose, notify, onRefresh }: { onClose: () => void; notify: (message: string, tone?: "error") => void; onRefresh: () => Promise<void> }) {
  const [listing, setListing] = useState<TrashListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<TrashConfirmation | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const value = await requestJson<TrashListing>("/api/fs/trash");
      setListing(value);
      setSelected((current) => new Set(value.items.filter((item) => current.has(item.id)).map((item) => item.id)));
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const postInChunks = async (action: "restore" | "delete", items: TrashItem[]) => {
    const restored: TrashRestoreResult[] = [];
    for (let start = 0; start < items.length; start += 100) {
      const response = await requestJson<{ result: TrashRestoreResult[] }>("/api/fs/trash", {
        method: "POST",
        body: JSON.stringify({ action, ids: items.slice(start, start + 100).map((item) => item.id) }),
      });
      if (action === "restore") restored.push(...response.result);
    }
    return restored;
  };

  const restore = async (items: TrashItem[]) => {
    setBusy(true);
    try {
      const restored = await postInChunks("restore", items);
      const renamed = restored.filter((item) => item.renamed).length;
      notify(restored.length === 1
        ? `Restored to /${restored[0].path}`
        : `${restored.length} items restored${renamed ? ` · ${renamed} renamed to avoid overwriting` : ""}`);
    } catch (caught) {
      notify((caught as Error).message, "error");
    } finally {
      setBusy(false);
      await Promise.all([load(), onRefresh()]);
    }
  };

  const deleteForever = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "empty") {
        const response = await requestJson<{ result: { removed: number } }>("/api/fs/trash", { method: "POST", body: JSON.stringify({ action: "empty" }) });
        notify(`Trash emptied · ${response.result.removed} ${response.result.removed === 1 ? "item" : "items"} permanently deleted`);
      } else {
        await postInChunks("delete", confirm.items);
        notify(`${confirm.items.length} ${confirm.items.length === 1 ? "item" : "items"} permanently deleted`);
      }
    } catch (caught) {
      notify((caught as Error).message, "error");
    } finally {
      setConfirm(null);
      setBusy(false);
      await Promise.all([load(), onRefresh()]);
    }
  };

  const items = listing?.items || [];
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const selectedItems = items.filter((item) => selected.has(item.id));
  const sizeLabel = (bytes: number, complete: boolean) => `${complete ? "" : "≥ "}${formatBytes(bytes)}`;
  const totalLabel = listing ? sizeLabel(listing.totalBytes, items.every((item) => item.sizeComplete)) : "";
  const confirmCount = confirm?.kind === "delete" ? confirm.items.length : items.length;

  return (
    <Modal title="Trash" subtitle="Restore deleted items or remove them permanently" icon={<Trash2 size={19} />} onClose={onClose} wide>
      <div className="storage-browser">
        <div className="storage-scan-bar">
          <div>{listing ? <><strong>{items.length.toLocaleString()} {items.length === 1 ? "item" : "items"} · {totalLabel}</strong><span>{listing.retentionDays ? `Items are deleted forever ${listing.retentionDays} ${listing.retentionDays === 1 ? "day" : "days"} after they were deleted` : "Items stay here until you restore them or delete them forever"}</span></> : <><strong>Protected trash</strong><span>Loading deleted items…</span></>}</div>
          <div className="storage-scan-actions"><button className="button secondary" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</button><button className="button danger" disabled={!items.length || busy} onClick={() => setConfirm({ kind: "empty" })}><Trash2 size={15} /> Empty trash</button></div>
        </div>
        {listing && !listing.enabled && <div className="storage-scan-note trash-note"><Info size={15} /> Protected trash is turned off on this server, so new deletions are permanent.</div>}
        {selected.size > 0 && <div className="storage-selection-bar"><div><span>{selected.size}</span><strong>{selected.size === 1 ? "item" : "items"} selected</strong></div><div><button className="button primary" disabled={busy} onClick={() => void restore(selectedItems)}><RotateCcw size={15} /> Restore</button><button className="button danger" disabled={busy} onClick={() => setConfirm({ kind: "delete", items: selectedItems })}><Trash2 size={15} /> Delete forever</button><button className="button secondary" onClick={() => setSelected(new Set())}>Clear</button></div></div>}
        {loading && !listing ? <div className="storage-scan-state"><LoaderCircle className="spin" size={25} /><strong>Loading the trash…</strong></div> : error && !listing ? <div className="storage-scan-state error"><CircleAlert size={25} /><strong>Unable to open the trash</strong><span>{error}</span><button className="button secondary" onClick={() => void load()}>Try again</button></div> : listing && <>
          <div className="largest-file-table" role="table" aria-label="Deleted items">
            <div className="trash-row largest-file-header" role="row"><div role="columnheader"><CheckBox checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))} label="Select all deleted items" /></div><div role="columnheader">Name</div><div role="columnheader">Original location</div><div role="columnheader">Size</div><div role="columnheader">Deleted</div><div role="columnheader" /></div>
            {items.map((item) => {
              const parent = item.originalPath?.split("/").slice(0, -1).join("/") ?? "";
              return <div className={`trash-row ${selected.has(item.id) ? "selected" : ""}`} role="row" key={item.id}><div role="cell"><CheckBox checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} label={`Select ${item.name}`} /></div><div className="largest-name" role="cell"><span className={`file-icon ${item.type}`}>{fileIcon(item, 17)}</span><span className="trash-name" title={item.name}>{item.name}</span></div><div className="largest-location" role="cell" title={item.originalPath ? `/${item.originalPath}` : "Deleted before FilesDude recorded locations; restores to Root"}>{item.originalPath ? <><span>/</span>{parent || "Root"}</> : <>Root <span>(original unknown)</span></>}</div><div className="largest-size" role="cell">{sizeLabel(item.size, item.sizeComplete)}</div><div className="muted" role="cell" title={new Date(item.deletedAt).toLocaleString()}>{formatDate(item.deletedAt)}{listing.retentionDays ? <small className="trash-expiry">{expiryLabel(item.deletedAt, listing.retentionDays)}</small> : null}</div><div className="largest-actions" role="cell"><button className="icon-button" title="Restore" aria-label={`Restore ${item.name}`} disabled={busy} onClick={() => void restore([item])}><RotateCcw size={16} /></button><button className="icon-button delete" title="Delete forever" aria-label={`Delete ${item.name} forever`} disabled={busy} onClick={() => setConfirm({ kind: "delete", items: [item] })}><Trash2 size={16} /></button></div></div>;
            })}
            {!items.length && <div className="storage-no-results"><Trash2 size={23} /><strong>The trash is empty</strong><span>Deleted files and folders appear here so you can restore them.</span></div>}
          </div>
          {error && <div className="storage-scan-note error"><CircleAlert size={15} /> Request failed: {error}</div>}
          {confirm && <div className="storage-delete-confirm trash-confirm" role="alert"><div><Trash2 size={19} /><span><strong>{confirm.kind === "empty" ? "Empty the trash?" : `Delete ${confirmCount} ${confirmCount === 1 ? "item" : "items"} forever?`}</strong><small>{confirm.kind === "empty" ? `All ${confirmCount.toLocaleString()} ${confirmCount === 1 ? "item" : "items"} (${totalLabel}) will be permanently deleted. This cannot be undone.` : "This cannot be undone."}</small></span></div><div><button className="button secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button className="button danger" disabled={busy} onClick={() => void deleteForever()}>{busy && <LoaderCircle className="spin" size={15} />}{confirm.kind === "empty" ? "Empty trash" : "Delete forever"}</button></div></div>}
          <div className="storage-scan-foot"><span>Restored items return to their original folder and never overwrite existing files.</span><button className="button primary" onClick={onClose}>Done</button></div>
        </>}
      </div>
    </Modal>
  );
}

// Only the owner picks upload ownership; other accounts' uploads take the destination folder's owner.
function UploadDialog({ files, currentPath, chooseOwnership, onClose, notify, onComplete }: { files: File[]; currentPath: string; chooseOwnership: boolean; onClose: () => void; notify: (message: string, tone?: "error") => void; onComplete: () => Promise<void> }) {
  const [options, setOptions] = useState<UploadOwnershipOptions | null>(null);
  const [selectedOwnership, setSelectedOwnership] = useState("service");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [progress, setProgress] = useState<{ index: number; loaded: number; bytesPerSecond: number } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const totalBytes = files.reduce((total, file) => total + file.size, 0);

  // Closing the dialog mid-upload cancels the request in flight.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!chooseOwnership) return;
    const controller = new AbortController();
    requestJson<UploadOwnershipOptions>(`/api/fs/upload?path=${encodePath(currentPath)}`, { signal: controller.signal })
      .then((result) => {
        setOptions(result);
        if (!result.canChangeOwnership || result.preference.mode === "service") setSelectedOwnership("service");
        else if (result.preference.mode === "fixed") setSelectedOwnership(`${result.preference.uid}:${result.preference.gid}`);
        else setSelectedOwnership(ownershipKey(result.destination));
      })
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => controller.abort();
  }, [currentPath, chooseOwnership]);

  const ownershipPairs = useMemo(() => {
    if (!options) return [];
    const pairs = [...options.detected];
    if (options.defaultPair && !pairs.some((pair) => ownershipKey(pair) === ownershipKey(options.defaultPair!))) pairs.push(options.defaultPair);
    return pairs;
  }, [options]);

  const preferredKey = options
    ? options.preference.mode === "service"
      ? "service"
      : options.preference.mode === "fixed"
        ? `${options.preference.uid}:${options.preference.gid}`
        : ownershipKey(options.destination)
    : "service";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (chooseOwnership && !options) return;
    setBusy(true);
    setError("");
    const params = new URLSearchParams({ path: currentPath });
    if (selectedOwnership !== "service") {
      const [uid, gid] = selectedOwnership.split(":");
      params.set("uid", uid);
      params.set("gid", gid);
    }
    let completedCount = uploadedCount;
    const controller = new AbortController();
    controllerRef.current = controller;
    // Speed is measured over the last few seconds so it follows changes in throughput.
    const samples: { time: number; bytes: number }[] = [];
    const report = (index: number, loaded: number) => {
      const bytes = files.slice(0, index).reduce((total, file) => total + file.size, 0) + loaded;
      const time = performance.now();
      samples.push({ time, bytes });
      while (samples.length > 2 && time - samples[0].time > 4_000) samples.shift();
      const elapsed = (time - samples[0].time) / 1000;
      setProgress({ index, loaded, bytesPerSecond: elapsed >= 0.5 ? (bytes - samples[0].bytes) / elapsed : 0 });
    };
    try {
      for (let index = uploadedCount; index < files.length; index += 1) {
        report(index, 0);
        await uploadFile<{ uploaded: string[] }>(`/api/fs/upload?${params}`, files[index], (loaded) => report(index, loaded), controller.signal);
        completedCount = index + 1;
        setUploadedCount(completedCount);
      }
      notify(`${files.length} ${files.length === 1 ? "file" : "files"} uploaded`);
      onClose();
      await onComplete();
    } catch (caught) {
      await onComplete();
      const cancelled = (caught as Error).name === "AbortError";
      const summary = `${completedCount} of ${files.length} ${files.length === 1 ? "file" : "files"} uploaded`;
      if (!mountedRef.current) notify(cancelled ? `Upload cancelled · ${summary}` : `${summary}. ${(caught as Error).message}`, "error");
      else setError(cancelled ? `Upload cancelled. ${summary}; the interrupted file was discarded.` : `${completedCount ? `${summary}. ` : ""}${(caught as Error).message}`);
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setProgress(null);
      setBusy(false);
    }
  };

  const sentBytes = progress ? files.slice(0, progress.index).reduce((total, file) => total + file.size, 0) + progress.loaded : 0;
  const percent = progress ? (totalBytes ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 100) : 0;
  const currentFile = progress ? files[progress.index] : null;
  const progressPanel = progress && currentFile && <div className="upload-progress" role="status" aria-live="polite"><div className="upload-progress-head"><strong title={currentFile.name}>{progress.loaded >= currentFile.size ? "Finishing" : "Uploading"} {currentFile.name}</strong><span>File {progress.index + 1} of {files.length}</span></div><div className="upload-progress-track" role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${percent}%` }} /></div><div className="upload-progress-meta"><span>{formatBytes(sentBytes)} of {formatBytes(totalBytes)} · {percent}%</span><span>{progress.bytesPerSecond > 0 ? `${formatBytes(progress.bytesPerSecond)}/s · ${formatRemaining((totalBytes - sentBytes) / progress.bytesPerSecond) || "almost done"}` : "Measuring speed…"}</span></div></div>;

  return <Modal title={`Upload ${files.length} ${files.length === 1 ? "file" : "files"}`} subtitle={`Choose ownership before uploading to /${currentPath}`} icon={<Upload size={19} />} onClose={onClose}><form className="upload-form" onSubmit={submit}><div className="upload-file-summary"><div><Upload size={18} /><span><strong>{files.length} {files.length === 1 ? "file" : "files"}</strong><small>{formatBytes(files.reduce((total, file) => total + file.size, 0))} total{uploadedCount ? ` · ${uploadedCount} uploaded` : ""}</small></span></div><div className="upload-file-list">{files.slice(0, 4).map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}{files.length > 4 && <span>and {files.length - 4} more…</span>}</div></div>{progressPanel}{chooseOwnership && <><div className="ownership-heading"><div><UserRoundCog size={17} /><span><strong>Owner and group</strong><small>Detected from this folder and its contents</small></span></div>{options?.truncated && <small>Based on the first 2,000 items</small>}</div>{!options && !error ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Detecting ownership…</div> : options && <div className="ownership-options"><label className={`ownership-option ${selectedOwnership === "service" ? "active" : ""}`}><input type="radio" name="upload-ownership" value="service" checked={selectedOwnership === "service"} onChange={(event) => setSelectedOwnership(event.target.value)} /><span className="ownership-radio" /><span><strong>Keep FilesDude service ownership</strong><small>{options.service.owner}:{options.service.group} · {options.service.uid}:{options.service.gid}</small></span>{preferredKey === "service" && <em>Default</em>}</label>{ownershipPairs.map((pair) => { const key = ownershipKey(pair); const destination = key === ownershipKey(options.destination); return <label key={key} className={`ownership-option ${selectedOwnership === key ? "active" : ""} ${!options.canChangeOwnership ? "disabled" : ""}`}><input type="radio" name="upload-ownership" value={key} checked={selectedOwnership === key} disabled={!options.canChangeOwnership} onChange={(event) => setSelectedOwnership(event.target.value)} /><span className="ownership-radio" /><span><strong>{pair.owner}:{pair.group}</strong><small>{pair.uid}:{pair.gid}{destination ? " · destination folder" : pair.source === "default" ? " · saved default" : ` · ${pair.count || 0} existing ${pair.count === 1 ? "item" : "items"}`}</small></span>{preferredKey === key && <em>Default</em>}</label>; })}</div>}{options && !options.canChangeOwnership && <div className="warning-box"><CircleAlert size={17} /> Ownership changes require FilesDude&apos;s systemd service to run as root. This upload will keep <code>{options.service.uid}:{options.service.gid}</code>.</div>}</>}<div className="info-box"><Info size={17} /> Uploaded files use mode <code>640</code>. Owner/group selection does not change those read and write permissions.</div>{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}{busy ? <div className="modal-actions"><button type="button" className="button danger" onClick={() => controllerRef.current?.abort()}><X size={16} /> Cancel upload</button></div> : <ModalActions onClose={onClose} submitLabel={uploadedCount ? "Upload remaining files" : `Upload ${files.length === 1 ? "file" : "files"}`} busy={chooseOwnership && !options} />}</form></Modal>;
}

function CompressDialog({ entries, currentPath, onClose, onStart }: { entries: FileEntry[]; currentPath: string; onClose: () => void; onStart: (body: Record<string, unknown>) => Promise<boolean> }) {
  const suggested = entries.length === 1
    ? (entries[0].type === "directory" || entries[0].name.lastIndexOf(".") <= 0 ? entries[0].name : entries[0].name.slice(0, entries[0].name.lastIndexOf(".")))
    : currentPath.split("/").at(-1) || "Archive";
  const [name, setName] = useState(suggested);
  const [format, setFormat] = useState<ArchiveFormat>("zip");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    if (await onStart({ action: "compress", paths: entries.map((entry) => entry.path), destination: currentPath, name, format })) onClose();
    else setBusy(false);
  };
  const extension = format === "zip" ? ".zip" : ".tar.gz";
  return <Modal title={`Compress ${itemCount(entries.length)}`} subtitle={`The archive is saved in ${folderLabel(currentPath)}`} icon={<FileArchive size={19} />} onClose={onClose}><form onSubmit={submit}><div className="choice-cards"><button type="button" className={format === "zip" ? "active" : ""} onClick={() => setFormat("zip")}><FileArchive size={24} /><strong>ZIP</strong><span>Opens on any computer</span></button><button type="button" className={format === "tar.gz" ? "active" : ""} onClick={() => setFormat("tar.gz")}><Server size={24} /><strong>tar.gz</strong><span>Usual on Linux servers; keeps links as links</span></button></div><FormField label="Archive name" hint={`Saved as ${name.trim() || "…"}${extension}; an existing name gets a number added`}><input autoFocus value={name} onChange={(event) => setName(event.target.value)} required maxLength={200} /></FormField><ModalActions onClose={onClose} submitLabel="Compress" busy={busy} disabled={!name.trim() || entries.length === 0} /></form></Modal>;
}

function NewDialog({ path, onClose, onRun }: { path: string; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [type, setType] = useState<"directory" | "file">("directory");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); await onRun({ action: "create", path, name, type }, `${type === "directory" ? "Folder" : "File"} created`); setBusy(false); };
  return <Modal title="Create new" subtitle="Add an empty folder or file" icon={<Plus size={19} />} onClose={onClose}><form onSubmit={submit}><div className="choice-cards"><button type="button" className={type === "directory" ? "active" : ""} onClick={() => setType("directory")}><Folder size={24} /><strong>Folder</strong><span>Organize files</span></button><button type="button" className={type === "file" ? "active" : ""} onClick={() => setType("file")}><FileText size={24} /><strong>Empty file</strong><span>Start from scratch</span></button></div><FormField label="Name"><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={type === "directory" ? "New folder" : "notes.txt"} required /></FormField><ModalActions onClose={onClose} submitLabel={`Create ${type === "directory" ? "folder" : "file"}`} busy={busy} /></form></Modal>;
}

function RenameDialog({ entry, onClose, onRun }: { entry: FileEntry; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [name, setName] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); await onRun({ action: "rename", path: entry.path, name }, "Item renamed"); setBusy(false); };
  return <Modal title="Rename item" subtitle={`Choose a new name for ${entry.name}`} icon={<Pencil size={18} />} onClose={onClose}><form onSubmit={submit}><FormField label="New name"><input autoFocus value={name} onFocus={(event) => { const index = name.lastIndexOf("."); event.currentTarget.setSelectionRange(0, index > 0 ? index : name.length); }} onChange={(event) => setName(event.target.value)} required /></FormField><ModalActions onClose={onClose} submitLabel="Rename" busy={busy} /></form></Modal>;
}

function DeleteDialog({ entries, onClose, onRun }: { entries: FileEntry[]; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [permanent, setPermanent] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); await onRun({ action: "delete", paths: entries.map((entry) => entry.path), permanent }, permanent ? "Items permanently deleted" : "Items moved to protected trash"); setBusy(false); };
  return <Modal title={`Delete ${entries.length} ${entries.length === 1 ? "item" : "items"}?`} subtitle="Deleted items are protected by default" icon={<Trash2 size={19} />} onClose={onClose}><form onSubmit={submit}><div className="delete-list">{entries.slice(0, 4).map((entry) => <div key={entry.path}><span className={`file-icon ${entry.type}`}>{fileIcon(entry)}</span><span>{entry.name}</span></div>)}{entries.length > 4 && <p>and {entries.length - 4} more…</p>}</div><label className="switch-row"><input type="checkbox" checked={permanent} onChange={(event) => setPermanent(event.target.checked)} /><span className="switch" /><div><strong>Delete permanently</strong><small>This cannot be undone</small></div></label>{permanent && <div className="warning-box"><CircleAlert size={17} /> This bypasses FilesDude&apos;s protected trash.</div>}<ModalActions onClose={onClose} submitLabel={permanent ? "Delete permanently" : "Move to trash"} danger busy={busy} /></form></Modal>;
}

function PermissionsDialog({ entries, onClose, onRun }: { entries: FileEntry[]; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [mode, setMode] = useState(entries.length === 1 ? entries[0].mode : "755");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); await onRun({ action: "chmod", paths: entries.map((entry) => entry.path), mode }, "Permissions updated"); setBusy(false); };
  return <Modal title="Change permissions" subtitle={`Apply POSIX permissions to ${entries.length} ${entries.length === 1 ? "item" : "items"}`} icon={<KeyRound size={19} />} onClose={onClose}><form onSubmit={submit}><FormField label="Octal mode" hint="Common values: 644 for files, 755 for folders"><input value={mode} onChange={(event) => setMode(event.target.value)} inputMode="numeric" pattern="[0-7]{3,4}" maxLength={4} required /><code className="mode-preview">chmod {mode || "…"}</code></FormField><div className="preset-row"><span>Presets</span>{["644", "664", "700", "755", "775"].map((value) => <button type="button" key={value} className={mode === value ? "active" : ""} onClick={() => setMode(value)}>{value}</button>)}</div><ModalActions onClose={onClose} submitLabel="Apply permissions" busy={busy} /></form></Modal>;
}

function OwnershipDialog({ entries, onClose, onRun }: { entries: FileEntry[]; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [uid, setUid] = useState(entries.length === 1 ? String(entries[0].uid) : "");
  const [gid, setGid] = useState(entries.length === 1 ? String(entries[0].gid) : "");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); await onRun({ action: "chown", paths: entries.map((entry) => entry.path), uid: Number(uid), gid: Number(gid) }, "Ownership updated"); setBusy(false); };
  return <Modal title="Change ownership" subtitle={`Apply a numeric user and group id to ${entries.length} ${entries.length === 1 ? "item" : "items"}`} icon={<UserRoundCog size={19} />} onClose={onClose}><form onSubmit={submit}><div className="field-pair"><FormField label="User ID (UID)"><input value={uid} onChange={(event) => setUid(event.target.value)} type="number" min="0" required /></FormField><FormField label="Group ID (GID)"><input value={gid} onChange={(event) => setGid(event.target.value)} type="number" min="0" required /></FormField></div><div className="info-box"><Info size={17} /> Use IDs from the Proxmox host or container, such as <code>0:0</code> for root.</div><ModalActions onClose={onClose} submitLabel="Apply ownership" busy={busy} /></form></Modal>;
}

function TransferDialog({ mode, entries, startPath, home, onClose, onTransfer }: { mode: "copy" | "move"; entries: FileEntry[]; startPath: string; home: string; onClose: () => void; onTransfer: (mode: "copy" | "move", paths: string[], destination: string) => Promise<boolean> }) {
  const [destination, setDestination] = useState(startPath);
  const [busy, setBusy] = useState(false);
  const blockedDirectories = useMemo(() => entries.filter((entry) => entry.type === "directory").map((entry) => entry.path), [entries]);
  const blocked = blockedDirectories.some((dirPath) => destination === dirPath || destination.startsWith(`${dirPath}/`));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    setBusy(true);
    await onTransfer(mode, entries.map((entry) => entry.path), destination);
    setBusy(false);
  };
  return (
    <Modal title={`${mode === "copy" ? "Copy" : "Move"} ${entries.length} ${entries.length === 1 ? "item" : "items"}`} subtitle="Type a destination or browse the folder structure below" icon={mode === "copy" ? <Copy size={19} /> : <FolderInput size={19} />} onClose={onClose}>
      <form onSubmit={submit}>
        <FormField label="Destination folder" hint="Leave empty to use the root folder">
          <div className="path-input"><span>/</span><input autoFocus value={destination} onChange={(event) => setDestination(event.target.value.replace(/^\/+/, ""))} placeholder="media/archive" /></div>
        </FormField>
        <FolderPicker value={destination} onChange={setDestination} home={home} />
        {blocked && <div className="warning-box"><CircleAlert size={17} /> You can&apos;t {mode === "copy" ? "copy" : "move"} a folder into itself or one of its own subfolders.</div>}
        <ModalActions onClose={onClose} submitLabel={mode === "copy" ? "Copy here" : "Move here"} busy={busy} disabled={blocked} />
      </form>
    </Modal>
  );
}

type FolderListing = { browsePath: string; folders: FileEntry[]; filterPrefix: string | null };

function FolderPicker({ value, onChange, home = "" }: { value: string; onChange: (path: string) => void; home?: string }) {
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const requestRef = useRef(0);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const id = ++requestRef.current;
      setLoading(true);
      (async () => {
        const normalized = value.replace(/\/+$/, "");
        try {
          const result = await requestJson<{ entries: FileEntry[] }>(`/api/fs?path=${encodePath(normalized)}`);
          if (id !== requestRef.current) return;
          setListing({ browsePath: normalized, folders: result.entries.filter((entry) => entry.type === "directory"), filterPrefix: null });
          setError("");
        } catch {
          if (id !== requestRef.current) return;
          const segments = normalized.split("/").filter(Boolean);
          const parent = segments.slice(0, -1).join("/");
          const partial = segments.at(-1) ?? "";
          if (!partial) {
            setListing(null);
            setError("Folder not found");
            return;
          }
          try {
            const result = await requestJson<{ entries: FileEntry[] }>(`/api/fs?path=${encodePath(parent)}`);
            if (id !== requestRef.current) return;
            setListing({ browsePath: parent, folders: result.entries.filter((entry) => entry.type === "directory"), filterPrefix: partial });
            setError("");
          } catch {
            if (id !== requestRef.current) return;
            setListing(null);
            setError("Folder not found");
          }
        } finally {
          if (id === requestRef.current) setLoading(false);
        }
      })();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [value]);

  const visibleFolders = useMemo(() => {
    if (!listing) return [];
    if (!listing.filterPrefix) return listing.folders;
    const needle = listing.filterPrefix.toLowerCase();
    return listing.folders.filter((folder) => folder.name.toLowerCase().startsWith(needle));
  }, [listing]);

  const crumbs = useMemo(() => {
    const base = listing?.browsePath ?? home;
    const below = home && base.startsWith(home) ? base.slice(home.length).replace(/^\//, "") : base;
    const parts = below ? below.split("/") : [];
    return [{ label: home ? "Home" : "Root", path: home }, ...parts.map((part, index) => ({ label: part, path: [home, ...parts.slice(0, index + 1)].filter(Boolean).join("/") }))];
  }, [listing, home]);

  return (
    <div className="folder-picker">
      <div className="folder-picker-crumbs">
        {crumbs.map((crumb, index) => (
          <span key={crumb.path || "root"}>
            {index > 0 && <ChevronRight size={12} />}
            <button type="button" onClick={() => onChange(crumb.path)}>{crumb.label}</button>
          </span>
        ))}
      </div>
      <div className="folder-picker-list">
        {loading && !listing && <div className="folder-picker-empty"><LoaderCircle className="spin" size={16} /> Loading…</div>}
        {!loading && listing && visibleFolders.length === 0 && <div className="folder-picker-empty">No matching folders</div>}
        {error && <div className="folder-picker-empty"><CircleAlert size={14} />{error}</div>}
        {visibleFolders.map((folder) => (
          <button type="button" key={folder.path} className="folder-picker-row" onClick={() => onChange(folder.path)}>
            <Folder size={15} /><span>{folder.name}</span><ChevronRight size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}

function BulkRenameDialog({ entries, onClose, notify, onRefresh }: { entries: FileEntry[]; onClose: () => void; notify: (message: string, tone?: "error") => void; onRefresh: () => Promise<void> }) {
  const [rule, setRule] = useState<BulkRenameRule>({ find: "", replace: "", prefix: "", suffix: "", numbering: false, start: 1, pad: 2 });
  const [preview, setPreview] = useState<RenamePreview[]>([]);
  const [busy, setBusy] = useState(false);
  const paths = useMemo(() => entries.map((entry) => entry.path), [entries]);

  const updatePreview = useCallback(async (nextRule = rule) => {
    try {
      const response = await requestJson<{ result: RenamePreview[] }>("/api/fs", { method: "POST", body: JSON.stringify({ action: "bulkRename", paths, rule: nextRule, apply: false }) });
      setPreview(response.result);
    } catch (error) { notify((error as Error).message, "error"); }
  }, [notify, paths, rule]);

  useEffect(() => { const timer = window.setTimeout(() => void updatePreview(), 180); return () => window.clearTimeout(timer); }, [rule]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true);
    try {
      await requestJson("/api/fs", { method: "POST", body: JSON.stringify({ action: "bulkRename", paths, rule, apply: true }) });
      notify(`${entries.length} items renamed`); onClose(); await onRefresh();
    } catch (error) { notify((error as Error).message, "error"); }
    finally { setBusy(false); }
  };
  const conflict = preview.some((item) => item.error);
  return <Modal title="Bulk rename" subtitle={`Preview changes across ${entries.length} selected items`} icon={<Sparkles size={19} />} onClose={onClose} wide><form onSubmit={submit}><div className="bulk-layout"><div className="bulk-rules"><div className="field-pair"><FormField label="Find"><input value={rule.find} onChange={(event) => setRule({ ...rule, find: event.target.value })} placeholder="old-text" /></FormField><FormField label="Replace with"><input value={rule.replace} onChange={(event) => setRule({ ...rule, replace: event.target.value })} placeholder="new-text" /></FormField></div><div className="field-pair"><FormField label="Prefix"><input value={rule.prefix} onChange={(event) => setRule({ ...rule, prefix: event.target.value })} placeholder="2026-" /></FormField><FormField label="Suffix"><input value={rule.suffix} onChange={(event) => setRule({ ...rule, suffix: event.target.value })} placeholder="-final" /></FormField></div><label className="switch-row compact"><input type="checkbox" checked={Boolean(rule.regex)} onChange={(event) => setRule({ ...rule, regex: event.target.checked })} /><span className="switch" /><div><strong>Regular expression</strong><small>Use advanced pattern matching</small></div></label><label className="switch-row compact"><input type="checkbox" checked={Boolean(rule.caseSensitive)} onChange={(event) => setRule({ ...rule, caseSensitive: event.target.checked })} /><span className="switch" /><div><strong>Case sensitive</strong></div></label><label className="switch-row compact"><input type="checkbox" checked={Boolean(rule.numbering)} onChange={(event) => setRule({ ...rule, numbering: event.target.checked })} /><span className="switch" /><div><strong>Add sequential numbers</strong></div></label>{rule.numbering && <div className="field-pair small"><FormField label="Start"><input type="number" value={rule.start} onChange={(event) => setRule({ ...rule, start: Number(event.target.value) })} /></FormField><FormField label="Padding"><input type="number" min="1" max="8" value={rule.pad} onChange={(event) => setRule({ ...rule, pad: Number(event.target.value) })} /></FormField></div>}</div><div className="rename-preview"><div className="preview-heading"><strong>Live preview</strong><span>{preview.filter((item) => item.changed).length} changes</span></div><div className="preview-list">{preview.map((item) => <div key={item.source} className={item.error ? "conflict" : ""}><span title={item.from}>{item.from}</span><ArrowRight size={14} /><strong title={item.to}>{item.to}</strong>{item.error && <small><CircleAlert size={12} />{item.error}</small>}</div>)}</div></div></div>{conflict && <div className="warning-box"><CircleAlert size={17} /> Resolve name conflicts before applying these changes.</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || conflict || !preview.some((item) => item.changed)}>{busy && <LoaderCircle className="spin" size={16} />}Apply {preview.filter((item) => item.changed).length} changes</button></div></form></Modal>;
}

function EditDialog({ entry, onClose, onRun }: { entry: FileEntry; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const url = `/api/fs/stream?path=${encodePath(entry.path)}`;

  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { signal: controller.signal, cache: "no-store" })
      .then((response) => { if (!response.ok) throw new Error("Unable to open this file for editing"); return response.text(); })
      .then(setContent)
      .catch((caught) => { if (caught.name !== "AbortError") setError(caught.message); });
    return () => controller.abort();
  }, [url]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (content === null) return;
    setBusy(true);
    await onRun({ action: "write", path: entry.path, content }, "File saved");
    setBusy(false);
  };

  return <Modal title="Edit file" subtitle={`${entry.name} · ${formatBytes(new Blob([content || ""]).size)}`} icon={<FilePenLine size={19} />} onClose={onClose} wide><form className="edit-form" onSubmit={submit}>{error ? <div className="editor-loading editor-error"><CircleAlert size={22} /><p>{error}</p></div> : content === null ? <div className="editor-loading"><LoaderCircle className="spin" size={22} /><p>Opening file…</p></div> : <textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} aria-label={`Edit ${entry.name}`} autoFocus />}<div className="editor-foot"><span>UTF-8 text · maximum 2 MB</span><div><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || content === null}>{busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Save changes</button></div></div></form></Modal>;
}

const RETENTION_CHOICES = [7, 30, 90, 365];

// Opens the two-factor dialog from an account dialog; it shows whether two-factor sign-in is on.
function TwoFactorSummary({ onOpen }: { onOpen: () => void }) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requestJson<TwoFactorStatus>("/api/auth/two-factor", { signal: controller.signal }).then(setStatus).catch(() => undefined);
    return () => controller.abort();
  }, []);
  return <div className="settings-section"><div className="settings-section-title"><span><Smartphone size={16} /></span><div><strong>Two-factor sign-in</strong><small>{status === null ? "Checking…" : status.enabled ? `On · ${status.recoveryCodesLeft} recovery ${status.recoveryCodesLeft === 1 ? "code" : "codes"} left` : "Off · ask for a code from an authenticator app as well as your password"}</small></div><button type="button" className="button secondary" onClick={onOpen}>{status?.enabled ? "Manage" : "Set up"}</button></div></div>;
}

function TwoFactorDialog({ onClose, notify }: { onClose: () => void; notify: (message: string, tone?: "error") => void }) {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [step, setStep] = useState<"overview" | "scan" | "codes">("overview");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [setup, setSetup] = useState<{ secret: string; qr: string; setupToken: string } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await requestJson<TwoFactorStatus>("/api/auth/two-factor"));
    } catch (caught) {
      setError((caught as Error).message);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const post = <T,>(body: Record<string, unknown>) => requestJson<T>("/api/auth/two-factor", { method: "POST", body: JSON.stringify(body) });
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const showCodes = (codes: string[]) => {
    setRecoveryCodes(codes);
    setStep("codes");
    setPassword("");
    setCode("");
  };

  const begin = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      setSetup(await post<{ secret: string; qr: string; setupToken: string }>({ action: "setup", currentPassword: password }));
      setPassword("");
      setCode("");
      setStep("scan");
    });
  };
  const enable = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const result = await post<{ recoveryCodes: string[] }>({ action: "enable", setupToken: setup?.setupToken, code });
      setSetup(null);
      showCodes(result.recoveryCodes);
      notify("Two-factor sign-in is on · your other sessions were signed out");
      await load();
    });
  };
  const manage = (action: "disable" | "recovery-codes") => (event: FormEvent | React.MouseEvent) => {
    event.preventDefault();
    if (!password || !code) {
      setError("Enter your password and a code from your authenticator app");
      return;
    }
    void run(async () => {
      const result = await post<{ recoveryCodes?: string[] }>({ action, currentPassword: password, code });
      if (action === "recovery-codes") showCodes(result.recoveryCodes ?? []);
      else {
        setPassword("");
        setCode("");
        notify("Two-factor sign-in is off");
      }
      await load();
    });
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`FilesDude recovery codes\nEach code works once.\n\n${recoveryCodes.join("\n")}\n`], { type: "text/plain" }));
    link.download = "filesdude-recovery-codes.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const passwordField = <FormField label="Current password"><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></FormField>;
  const codeField = (label: string) => <FormField label={label}><input value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" inputMode="text" maxLength={16} placeholder="123456" required /></FormField>;
  let body: ReactNode;
  if (step === "codes") {
    body = <div className="preferences-form"><div className="info-box"><Info size={17} /> Save these recovery codes somewhere safe. Each one signs you in once if you lose your authenticator app. They won&apos;t be shown again.</div><ol className="recovery-codes">{recoveryCodes.map((item) => <li key={item}><code>{item}</code></li>)}</ol><div className="modal-actions"><button type="button" className="button secondary" onClick={() => void copyText(recoveryCodes.join("\n")).then((copied) => notify(copied ? "Recovery codes copied" : "Couldn't copy; select the codes instead", copied ? undefined : "error"))}><Copy size={15} /> Copy</button><button type="button" className="button secondary" onClick={download}><Download size={15} /> Download</button><button type="button" className="button primary" onClick={() => setStep("overview")}><Check size={15} /> I&apos;ve saved them</button></div></div>;
  } else if (step === "scan" && setup) {
    body = <form className="preferences-form" onSubmit={enable}><div className="two-factor-qr">
      {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, not an optimisable image */}
      <img src={setup.qr} alt="QR code for your authenticator app" width={176} height={176} />
      <div><strong>Scan with your authenticator app</strong><span>Or enter this key by hand:</span><code className="two-factor-secret">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code></div></div>{codeField("Code from the app")}{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => { setSetup(null); setStep("overview"); setError(""); }}>Back</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Turn on</button></div></form>;
  } else if (!status) {
    body = error ? <div className="form-error"><CircleAlert size={16} />{error}</div> : <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Loading…</div>;
  } else if (status.enabled) {
    body = <form className="preferences-form" onSubmit={manage("recovery-codes")}><div className="info-box"><ShieldCheck size={17} /> On since {status.enabledAt ? formatDateTime(status.enabledAt) : "setup"} · {status.recoveryCodesLeft} recovery {status.recoveryCodesLeft === 1 ? "code" : "codes"} left.</div>{passwordField}{codeField("Code from the app (or a recovery code)")}{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button danger" disabled={busy} onClick={manage("disable")}>Turn off</button><button className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}New recovery codes</button></div></form>;
  } else {
    body = <form className="preferences-form" onSubmit={begin}><p className="muted">Signing in will also need a 6-digit code from an authenticator app on your phone, such as 1Password, Google Authenticator, or Authy. Turning it on signs out your other sessions.</p>{passwordField}{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Smartphone size={16} />}Set up</button></div></form>;
  }
  return <Modal title="Two-factor sign-in" subtitle="A code from your phone as well as your password" icon={<Smartphone size={19} />} onClose={onClose}>{body}</Modal>;
}

function PreferencesDialog({ username: initialUsername, onClose, onUpdated, onTwoFactor }: { username: string; onClose: () => void; onUpdated: () => Promise<void>; onTwoFactor: () => void }) {
  const [username, setUsername] = useState(initialUsername);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadOwnershipPreference["mode"]>("destination");
  const [fixedUid, setFixedUid] = useState("0");
  const [fixedGid, setFixedGid] = useState("0");
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  const [users, setUsers] = useState<IdentityOption[]>([]);
  const [groups, setGroups] = useState<IdentityOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ username: string; uploadOwnership: UploadOwnershipPreference; trashRetentionDays: number | null; identities: { users: IdentityOption[]; groups: IdentityOption[] } }>("/api/auth/preferences", { signal: controller.signal })
      .then((result) => {
        setUsername(result.username);
        setUploadMode(result.uploadOwnership.mode);
        setRetentionDays(result.trashRetentionDays);
        setUsers(result.identities.users);
        setGroups(result.identities.groups);
        if (result.uploadOwnership.mode === "fixed") {
          setFixedUid(String(result.uploadOwnership.uid));
          setFixedGid(String(result.uploadOwnership.gid));
        } else {
          setFixedUid(String(result.identities.users.find((item) => item.id === 0)?.id ?? result.identities.users[0]?.id ?? 0));
          setFixedGid(String(result.identities.groups.find((item) => item.id === 0)?.id ?? result.identities.groups[0]?.id ?? 0));
        }
        setLoaded(true);
      })
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => controller.abort();
  }, []);

  const credentialsChanged = username !== initialUsername || Boolean(newPassword);
  const uploadOwnership: UploadOwnershipPreference = uploadMode === "fixed"
    ? { mode: "fixed", uid: Number(fixedUid), gid: Number(fixedGid) }
    : { mode: uploadMode };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword && newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    if (uploadMode === "fixed" && (!fixedUid || !fixedGid)) {
      setError("Choose both a default owner and group");
      return;
    }
    setBusy(true);
    try {
      await requestJson("/api/auth/preferences", {
        method: "POST",
        body: JSON.stringify({ currentPassword: currentPassword || undefined, username, newPassword: newPassword || undefined, uploadOwnership, trashRetentionDays: retentionDays }),
      });
      await onUpdated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <Modal title="Preferences" subtitle="Account, sign-in security, and upload defaults" icon={<Settings2 size={19} />} onClose={onClose}><form className="preferences-form" onSubmit={submit}><div className="preferences-intro"><div className="avatar large-avatar">{initialUsername.slice(0, 1).toUpperCase()}</div><div><strong>Administrator account</strong><span>Account changes invalidate other signed-in sessions.</span></div></div><div className="settings-section"><div className="settings-section-title"><span><Upload size={16} /></span><div><strong>Default upload ownership</strong><small>This choice is preselected for confirmation before every upload</small></div></div><FormField label="Default owner and group"><select value={uploadMode} onChange={(event) => setUploadMode(event.target.value as UploadOwnershipPreference["mode"])} disabled={!loaded}><option value="destination">Match the destination folder</option><option value="service">Keep FilesDude service ownership</option><option value="fixed">Use a fixed owner and group</option></select></FormField>{uploadMode === "fixed" && <div className="field-pair preference-identity-pair"><FormField label="Owner"><select value={fixedUid} onChange={(event) => setFixedUid(event.target.value)} required>{!users.some((user) => String(user.id) === fixedUid) && <option value={fixedUid}>UID {fixedUid}</option>}{users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.id})</option>)}</select></FormField><FormField label="Group"><select value={fixedGid} onChange={(event) => setFixedGid(event.target.value)} required>{!groups.some((group) => String(group.id) === fixedGid) && <option value={fixedGid}>GID {fixedGid}</option>}{groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.id})</option>)}</select></FormField></div>}<div className="info-box"><Info size={17} /> FilesDude still shows the detected owner/group choices each time, so unusual folders can be handled safely.</div></div><div className="settings-section"><div className="settings-section-title"><span><Trash2 size={16} /></span><div><strong>Trash</strong><small>How long deleted items can be restored before they are removed for good</small></div></div><FormField label="Keep deleted items" hint={retentionDays ? `Items deleted more than ${retentionDays} ${retentionDays === 1 ? "day" : "days"} ago are removed automatically, for every account` : "Items stay until someone restores them, deletes them forever, or empties the trash"}><select value={retentionDays ?? ""} onChange={(event) => setRetentionDays(event.target.value ? Number(event.target.value) : null)} disabled={!loaded}><option value="">Until removed by hand</option>{retentionDays !== null && !RETENTION_CHOICES.includes(retentionDays) && <option value={retentionDays}>{retentionDays} days</option>}{RETENTION_CHOICES.map((days) => <option key={days} value={days}>{days === 365 ? "1 year" : `${days} days`}</option>)}</select></FormField></div><div className="settings-section"><div className="settings-section-title"><span><UserRoundCog size={16} /></span><div><strong>Username</strong><small>Used on the FilesDude sign-in screen</small></div></div><FormField label="Username"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} pattern="[A-Za-z0-9._-]+" required /></FormField></div><div className="settings-section"><div className="settings-section-title"><span><LockKeyhole size={16} /></span><div><strong>Password</strong><small>Only required when changing the username or password</small></div></div><FormField label="Current password" hint={credentialsChanged ? "Required to save account changes" : "Not needed for upload preferences"}><div className="password-field"><input type={showPasswords ? "text" : "password"} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required={credentialsChanged} /><LockKeyhole size={15} /></div></FormField><div className="field-pair preferences-passwords"><FormField label="New password"><input type={showPasswords ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={newPassword ? 12 : undefined} placeholder="At least 12 characters" /></FormField><FormField label="Confirm new password"><input type={showPasswords ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="Repeat new password" /></FormField></div><label className="show-passwords"><input type="checkbox" checked={showPasswords} onChange={(event) => setShowPasswords(event.target.checked)} />{showPasswords ? <EyeOff size={15} /> : <Eye size={15} />} Show passwords</label></div><TwoFactorSummary onOpen={onTwoFactor} />{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !loaded}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Save preferences</button></div></form></Modal>;
}

function AccountPasswordDialog({ username, role, home, onClose, onUpdated, onTwoFactor }: { username: string; role: Role; home: string; onClose: () => void; onUpdated: () => Promise<void>; onTwoFactor: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (newPassword !== confirmPassword) {
      setError("New passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await requestJson("/api/auth/preferences", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      await onUpdated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Modal title="Your account" subtitle="Change your password" icon={<Settings2 size={19} />} onClose={onClose}><form className="preferences-form" onSubmit={submit}><div className="preferences-intro"><div className="avatar large-avatar">{username.slice(0, 1).toUpperCase()}</div><div><strong>{username} · {ROLE_LABELS[role]}</strong><span>{role === "viewer" ? "Can view and download" : "Can view and change"} files in {folderLabel(home)}. The owner manages your access.</span></div></div><FormField label="Current password"><input type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required /></FormField><div className="field-pair preferences-passwords"><FormField label="New password"><input type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={12} placeholder="At least 12 characters" required /></FormField><FormField label="Confirm new password"><input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" required /></FormField></div><div className="info-box"><Info size={17} /> Changing your password signs you out on your other devices.</div><TwoFactorSummary onOpen={onTwoFactor} />{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<ModalActions onClose={onClose} submitLabel="Change password" busy={busy} /></form></Modal>;
}

function UsersDialog({ onClose, notify }: { onClose: () => void; notify: (message: string, tone?: "error") => void }) {
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [editing, setEditing] = useState<ManagedUser | "new" | null>(null);
  const [removing, setRemoving] = useState<ManagedUser | null>(null);
  const [form, setForm] = useState({ username: "", password: "", role: "editor" as ManagedUser["role"], root: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ users: ManagedUser[] }>("/api/users", { signal: controller.signal })
      .then((result) => setUsers(result.users))
      .catch((caught) => { if ((caught as Error).name !== "AbortError") setError((caught as Error).message); });
    return () => controller.abort();
  }, []);

  const startEditing = (user: ManagedUser | "new") => {
    setError("");
    setRemoving(null);
    setEditing(user);
    setForm(user === "new" ? { username: "", password: "", role: "editor", root: "" } : { username: user.username, password: "", role: user.role, root: user.root });
  };

  const send = async (body: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ users: ManagedUser[] }>("/api/users", { method: "POST", body: JSON.stringify(body) });
      setUsers(result.users);
      setEditing(null);
      setRemoving(null);
      notify(success);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (editing === "new") void send({ action: "create", ...form }, `${form.username} can now sign in`);
    else if (editing) void send({ action: "update", id: editing.id, role: form.role, root: form.root, password: form.password || undefined }, `${editing.username} updated and signed out`);
  };

  return (
    <Modal title="Users" subtitle="Accounts that can sign in, each limited to one folder" icon={<Users size={19} />} onClose={onClose} wide>
      <div className="storage-browser users-dialog">
        <div className="user-row owner-row"><span className="avatar"><ShieldCheck size={15} /></span><div><strong>You</strong><small>Owner · all files · manages users, sharing, and permissions</small></div></div>
        {users === null ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Loading accounts…</div>
          : users.map((user) => (
            <div key={user.id} className="user-row">
              <span className="avatar">{user.username.slice(0, 1).toUpperCase()}</span>
              <div><strong>{user.username}{user.twoFactor && <span className="two-factor-badge" title="Signs in with a code from an authenticator app"><Smartphone size={11} /> 2FA</span>}</strong><small>{ROLE_LABELS[user.role]} · {folderLabel(user.root)}</small></div>
              {user.twoFactor && <button className="button secondary" disabled={busy} title="For a lost phone: they sign in with just their password and can set it up again" onClick={() => void send({ action: "resetTwoFactor", id: user.id }, `Two-factor sign-in reset for ${user.username}; they were signed out`)}><Smartphone size={14} /> Reset 2FA</button>}
              <button className="button secondary" disabled={busy} onClick={() => startEditing(user)}><Pencil size={14} /> Edit</button>
              <button className="button secondary danger-text" disabled={busy} onClick={() => { setEditing(null); setRemoving(user); }}><Trash2 size={14} /> Remove</button>
            </div>
          ))}
        {removing && <div className="storage-delete-confirm trash-confirm" role="alert"><div><Trash2 size={19} /><span><strong>Remove {removing.username}?</strong><small>They are signed out straight away. Their files stay where they are.</small></span></div><div><button className="button secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</button><button className="button danger" disabled={busy} onClick={() => void send({ action: "delete", id: removing.id }, `${removing.username} removed`)}>Remove account</button></div></div>}
        {editing ? (
          <form className="user-form" onSubmit={save}>
            <strong>{editing === "new" ? "Add an account" : `Edit ${editing.username}`}</strong>
            <div className="field-pair">
              <FormField label="Username"><input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} disabled={editing !== "new"} autoComplete="off" minLength={3} maxLength={64} pattern="[A-Za-z0-9._-]+" required /></FormField>
              <FormField label={editing === "new" ? "Password" : "New password"} hint={editing === "new" ? "At least 12 characters" : "Leave blank to keep the current one"}><input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} autoComplete="new-password" minLength={form.password || editing === "new" ? 12 : undefined} required={editing === "new"} /></FormField>
            </div>
            <FormField label="Role"><select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as ManagedUser["role"] })}><option value="editor">Editor — can view, upload, and change files</option><option value="viewer">Viewer — can only view and download</option></select></FormField>
            <FormField label="Folder" hint="The account sees only this folder and what's inside it"><div className="path-input"><span>/</span><input value={form.root} onChange={(event) => setForm({ ...form, root: event.target.value.replace(/^\/+/, "") })} placeholder="home/name" /></div></FormField>
            <FolderPicker value={form.root} onChange={(root) => setForm({ ...form, root })} />
            {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
            <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setEditing(null)}>Cancel</button><button className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}{editing === "new" ? "Add account" : "Save changes"}</button></div>
          </form>
        ) : (
          <>
            {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
            <div className="storage-scan-foot"><button className="button secondary" onClick={() => startEditing("new")}><Plus size={15} /> Add account</button><button className="button primary" onClick={onClose}>Done</button></div>
          </>
        )}
      </div>
    </Modal>
  );
}

function PreviewDialog({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const url = `/api/fs/stream?path=${encodePath(entry.path)}`;
  const isText = entry.mime.startsWith("text/") || entry.mime.includes("json") || entry.mime.includes("javascript") || entry.mime.includes("typescript");
  useEffect(() => { if (isText) fetch(url).then((response) => { if (!response.ok) throw new Error("Unable to preview file"); return response.text(); }).then((value) => setText(value.slice(0, 2_000_000))).catch((caught) => setError(caught.message)); }, [isText, url]);
  let preview: ReactNode;
  if (error) preview = <div className="preview-message"><CircleAlert size={24} /><p>{error}</p></div>;
  else if (isText) preview = text === null ? <div className="preview-message"><LoaderCircle className="spin" size={24} /><p>Loading preview…</p></div> : <pre className="text-preview">{text}</pre>;
  else if (entry.mime.startsWith("image/")) preview = <div className="image-preview"><img src={url} alt={entry.name} /></div>; // eslint-disable-line @next/next/no-img-element
  else if (entry.mime.startsWith("video/")) preview = <video src={url} controls autoPlay />;
  else if (entry.mime.startsWith("audio/")) preview = <div className="audio-preview"><FileAudio size={54} /><strong>{entry.name}</strong><audio src={url} controls autoPlay /></div>;
  else if (entry.mime === "application/pdf") preview = <iframe src={url} title={`Preview of ${entry.name}`} />;
  else preview = <div className="preview-message"><File size={42} /><h3>Preview unavailable</h3><p>This file type can still be downloaded.</p></div>;
  return <div className="preview-overlay"><section className="preview-modal" role="dialog" aria-modal="true" aria-label={`Preview ${entry.name}`}><header><div><span className={`file-icon ${entry.type}`}>{fileIcon(entry)}</span><div><strong>{entry.name}</strong><span>{extension(entry.name)} · {formatBytes(entry.size)}</span></div></div><div><a className="button secondary" href={`/api/fs/download?path=${encodePath(entry.path)}`}><ArrowDownToLine size={16} /> Download</a><button className="icon-button" aria-label="Close preview" onClick={onClose}><X size={19} /></button></div></header><div className="preview-body">{preview}</div></section></div>;
}

type Checksums = { sha256: string; md5: string };

function ChecksumPanel({ entry }: { entry: FileEntry }) {
  const [state, setState] = useState<{ status: "idle" | "running" | "done" | "error"; sums?: Checksums; error?: string }>({ status: "idle" });
  const [expected, setExpected] = useState("");
  const [copied, setCopied] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  const calculate = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ status: "running" });
    try {
      const sums = await requestJson<Checksums>(`/api/fs/checksum?path=${encodePath(entry.path)}`, { signal: controller.signal });
      setState({ status: "done", sums });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setState({ status: "error", error: (error as Error).message });
    }
  }, [entry.path]);

  // Small files are hashed straight away; closing the dialog stops any hashing in progress.
  useEffect(() => {
    const timer = window.setTimeout(() => { if (entry.size <= AUTO_CHECKSUM_BYTES) void calculate(); }, 0);
    return () => {
      window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [calculate, entry.size]);

  const copy = async (label: string, value: string) => {
    if (await copyText(value)) setCopied(label);
  };
  const wanted = expected.trim().toLowerCase();
  const match = state.sums && wanted ? (wanted === state.sums.sha256 ? "SHA-256" : wanted === state.sums.md5 ? "MD5" : null) : undefined;

  return (
    <section className="checksum-panel" aria-label="Checksums">
      <div className="checksum-heading"><strong>Checksums</strong>{state.status === "running" && <button type="button" className="text-button" onClick={() => { controllerRef.current?.abort(); setState({ status: "idle" }); }}>Cancel</button>}</div>
      {state.status === "idle" && <button type="button" className="button secondary" onClick={() => void calculate()}>Calculate SHA-256 and MD5 ({formatBytes(entry.size)})</button>}
      {state.status === "running" && <p className="checksum-note"><LoaderCircle className="spin" size={14} /> Reading {formatBytes(entry.size)}…</p>}
      {state.status === "error" && <p className="checksum-note error"><CircleAlert size={14} /> {state.error} <button type="button" className="text-button" onClick={() => void calculate()}>Try again</button></p>}
      {state.status === "done" && state.sums && <>
        {([["SHA-256", state.sums.sha256], ["MD5", state.sums.md5]] as const).map(([label, value]) => (
          <div key={label} className="checksum-row"><span>{label}</span><code title={value}>{value}</code><button type="button" className="icon-button" aria-label={`Copy ${label}`} title={copied === label ? "Copied" : `Copy ${label}`} onClick={() => void copy(label, value)}>{copied === label ? <Check size={14} /> : <Copy size={14} />}</button></div>
        ))}
        <label className="checksum-compare"><span>Compare with</span><input value={expected} onChange={(event) => setExpected(event.target.value)} placeholder="Paste an expected SHA-256 or MD5" spellCheck={false} /></label>
        {match !== undefined && <p className={`checksum-note ${match ? "match" : "error"}`}>{match ? <><Check size={14} /> Matches the {match} checksum</> : <><CircleAlert size={14} /> Doesn&apos;t match either checksum</>}</p>}
      </>}
    </section>
  );
}

function DetailsDialog({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const rows = [["Type", entry.type === "directory" ? "Folder" : entry.mime], ["Size", entry.type === "directory" ? "—" : `${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)`], ["Location", `/${entry.path}`], ["Owner", `${entry.owner}:${entry.group} (${entry.uid}:${entry.gid})`], ["Permissions", entry.mode], ["Modified", new Date(entry.modified).toLocaleString()], ["Created", new Date(entry.created).toLocaleString()]];
  return <Modal title="Item details" subtitle={entry.name} icon={<Info size={19} />} onClose={onClose}><div className="details-hero"><span className={`file-icon ${entry.type}`}>{fileIcon(entry, 32)}</span><div><strong>{entry.name}</strong><span>{entry.type === "directory" ? "Folder" : extension(entry.name)}</span></div></div><dl className="details-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "Permissions" ? <code className="mode-chip">{value}</code> : value}</dd></div>)}</dl>{entry.type === "file" && <ChecksumPanel entry={entry} />}<div className="modal-actions"><button className="button primary" onClick={onClose}>Done</button></div></Modal>;
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
