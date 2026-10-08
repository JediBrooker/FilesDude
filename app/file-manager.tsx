"use client";

import {
  ArrowDownToLine,
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUpNarrowWide,
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
  FolderInput,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Home,
  Info,
  KeyRound,
  LayoutGrid,
  List,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Menu,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Undo2,
  Upload,
  UserRoundCog,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { moveCursor, selectionRange } from "@/lib/selection";
import { INITIAL_DIRECTION, nextSort, parseSort, sortEntries, type SortKey, type SortState } from "@/lib/sort";
import type { BulkRenameRule, DeleteResult, DiskInfo, FileEntry, TransferResult, IdentityOption, LargestFilesProgress, LargestFilesReady, LargestFilesResult, OwnershipPair, RenamePreview, TrashItem, TrashListing, TrashRestoreResult, UploadOwnershipOptions, UploadOwnershipPreference } from "@/lib/types";

type AuthState = {
  loading: boolean;
  authenticated: boolean;
  configured: boolean;
  username: string | null;
  configurationIssues: string[];
};

type DialogState =
  | { kind: "upload"; files: File[] }
  | { kind: "storage" }
  | { kind: "trash" }
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
  | { kind: "details"; entry: FileEntry }
  | null;

type ViewMode = "list" | "grid";
type EntryAction = "open" | "edit" | "download" | "favorite" | "rename" | "cut" | "clipboard" | "paste" | "copy" | "move" | "permissions" | "ownership" | "details" | "delete";
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
  dropTarget: string | null;
  dropHandlers: DropHandlers;
  onMenuButton: (entry: FileEntry, trigger: DOMRect) => void;
  onContextMenu: (entry: FileEntry, event: React.MouseEvent) => void;
  onDragStart: (entry: FileEntry, event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

const DRAG_TYPE = "application/x-filesdude-paths";
const MENU_WIDTH = 224;
const MULTI_ITEM_ACTIONS: EntryAction[] = ["cut", "clipboard", "copy", "move", "permissions", "ownership", "delete"];

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
  const [view, setView] = useState<ViewMode>("list");
  const [sort, setSort] = useState<SortState>(() => (typeof window !== "undefined" ? storedSort() : parseSort(null)));
  const [loading, setLoading] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<{ message: string; tone?: "error"; undo?: UndoAction } | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const uploadRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<number | undefined>(undefined);
  const undoRef = useRef<UndoAction | null>(null);
  const dragPathsRef = useRef<string[]>([]);
  const sortedEntries = useMemo(() => sortEntries(entries, sort), [entries, sort]);
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
      if (query) params.set("search", query);
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
  }, [activeSearch, auth.authenticated, currentPath, notify, refreshAuth, showHidden]);

  const loadFavorites = useCallback(async () => {
    if (!auth.authenticated) return;
    try {
      const result = await requestJson<{ favorites: FavoriteLocation[] }>("/api/favorites");
      setFavorites(result.favorites);
    } catch (error) {
      const typed = error as Error & { status?: number };
      if (typed.status === 401) await refreshAuth();
      else notify(typed.message, "error");
    }
  }, [auth.authenticated, notify, refreshAuth]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (auth.authenticated) void loadDirectory(currentPath, activeSearch);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [auth.authenticated, activeSearch, currentPath, showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const transferEntries = (mode: "copy" | "move", paths: string[], destination: string) =>
    runAction({ action: mode, paths, destination }, `${itemCount(paths.length)} ${mode === "copy" ? "copied" : "moved"} to ${folderLabel(destination)}`);

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
    window.location.href = `/api/fs/download?path=${encodePath(chosen[0].path)}`;
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
        window.location.assign(`/api/fs/download?path=${encodePath(entry.path)}`);
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
    const parts = currentPath ? currentPath.split("/") : [];
    return [{ label: "Root", path: "" }, ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join("/") }))];
  }, [currentPath]);

  const selectedEntries = entries.filter((entry) => selected.has(entry.path));
  const favoritePaths = new Set(favorites.map((favorite) => favorite.path));
  const allSelected = entries.length > 0 && selected.size === entries.length;
  const diskPercent = disk?.total ? Math.round((disk.used / disk.total) * 100) : 0;

  if (auth.loading) return <AppLoading />;
  if (!auth.authenticated) return <LoginScreen auth={auth} onSuccess={refreshAuth} theme={theme} onToggleTheme={toggleTheme} />;

  return (
    <div className="app-shell" onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer.types.includes(DRAG_TYPE)) event.dataTransfer.dropEffect = "none"; }} onDrop={(event) => { event.preventDefault(); if (!event.dataTransfer.types.includes(DRAG_TYPE)) queueUpload(event.dataTransfer.files); }}>
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><FolderOpen size={21} /></div>
          <div><strong>FilesDude</strong><span>Proxmox explorer</span></div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}><X size={18} /></button>
        </div>

        <nav className="primary-nav" aria-label="File locations">
          <button className={`nav-item ${currentPath === "" ? "active" : ""} ${dropTarget === "" ? "drop-target" : ""}`} data-drop-path="" {...dropHandlers} onClick={() => { navigate(""); setSidebarOpen(false); }}><Home size={18} /><span>All files</span><ChevronRight size={15} /></button>
          <button className="nav-item" onClick={() => { setShowHidden(true); navigate(""); setSidebarOpen(false); }}><Eye size={18} /><span>Hidden files</span></button>
          <button className="nav-item" onClick={() => { setDialog({ kind: "trash" }); setSidebarOpen(false); }}><Trash2 size={18} /><span>Trash</span></button>
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

        <button type="button" className="storage-card" title="Find the largest files" aria-label="Storage usage. Open the largest-files scanner" onClick={() => setDialog({ kind: "storage" })}>
          <div className="storage-heading"><span><HardDrive size={16} /> Storage</span><strong>{diskPercent}%</strong></div>
          <div className="storage-track"><span style={{ width: `${diskPercent}%` }} /></div>
          <p>{disk ? `${formatBytes(disk.used)} of ${formatBytes(disk.total)} used` : "Calculating…"}</p>
          <small>{disk ? `${formatBytes(disk.available)} available` : ""}</small>
          <span className="storage-action">Click to find and manage largest files <ChevronRight size={12} /></span>
        </button>

        <div className="sidebar-footer">
          <button className="user-chip" title="Open preferences" onClick={() => setDialog({ kind: "preferences" })}><span className="avatar">{auth.username?.slice(0, 1).toUpperCase()}</span><span><strong>{auth.username}</strong><small>Administrator</small></span></button>
          <button className="icon-button" aria-label="Preferences" title="Preferences" onClick={() => setDialog({ kind: "preferences" })}><Settings2 size={17} /></button>
          <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={() => void logout()}><LogOut size={17} /></button>
        </div>
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
              <p>{activeSearch ? `${entries.length} search results` : `${entries.length} ${entries.length === 1 ? "item" : "items"}`}{showHidden ? " · hidden files shown" : ""}</p>
            </div>
            <div className="primary-actions">
              <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => event.target.files && queueUpload(event.target.files)} />
              {currentPath && <button className={`button secondary favorite-location ${favoritePaths.has(currentPath) ? "active" : ""}`} title={favoritePaths.has(currentPath) ? "Remove this folder from favourites" : "Add this folder to favourites"} onClick={() => void toggleFavorite(currentPath)}><Star size={16} fill={favoritePaths.has(currentPath) ? "currentColor" : "none"} /> <span>{favoritePaths.has(currentPath) ? "Favourited" : "Favourite"}</span></button>}
              {clipboard && <div className="clipboard-chip"><button className="button secondary" title={`Paste into ${folderLabel(currentPath)} (${modifierLabel()}V)`} onClick={() => void pasteInto(currentPath)}><ClipboardPaste size={16} /> <span>Paste {itemCount(clipboard.paths.length)}</span></button><button className="icon-button" aria-label="Clear clipboard" title="Clear clipboard" onClick={() => setClipboard(null)}><X size={15} /></button></div>}
              <button className="button secondary" onClick={() => uploadRef.current?.click()}><Upload size={17} /> Upload</button>
              <button className="button primary" onClick={() => setDialog({ kind: "new" })}><Plus size={17} /> New <ChevronDown size={14} /></button>
            </div>
          </div>

          <div className="file-toolbar">
            <form className="search-field" onSubmit={(event) => { event.preventDefault(); setActiveSearch(search.trim()); }}>
              <Search size={17} />
              <input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search this folder…" aria-label="Search files" />
              {search && <button type="button" aria-label="Clear search" onClick={() => { setSearch(""); setActiveSearch(""); }}><X size={15} /></button>}
              <kbd>⌘K</kbd>
            </form>
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
                {selected.size === 1 && isEditable(selectedEntries[0]) && <button onClick={() => setDialog({ kind: "edit", entry: selectedEntries[0] })}><FilePenLine size={16} /> Edit</button>}
                {selected.size === 1 && <button onClick={downloadSelected}><Download size={16} /> Download</button>}
                {selected.size === 1 && selectedEntries[0].type === "directory" && <button onClick={() => void toggleFavorite(selectedEntries[0].path)}><Star size={16} fill={favoritePaths.has(selectedEntries[0].path) ? "currentColor" : "none"} /> {favoritePaths.has(selectedEntries[0].path) ? "Unfavourite" : "Favourite"}</button>}
                {selected.size === 1 && <button onClick={() => setDialog({ kind: "rename", entry: selectedEntries[0] })}><Pencil size={16} /> Rename</button>}
                <button onClick={() => setDialog({ kind: "transfer", mode: "copy" })}><Copy size={16} /> Copy</button>
                <button onClick={() => setDialog({ kind: "transfer", mode: "move" })}><FolderInput size={16} /> Move</button>
                <button onClick={() => setDialog({ kind: "permissions" })}><KeyRound size={16} /> Permissions</button>
                <button onClick={() => setDialog({ kind: "ownership" })}><UserRoundCog size={16} /> Ownership</button>
                {selected.size > 1 && <button onClick={() => setDialog({ kind: "bulk" })}><Sparkles size={16} /> Bulk rename</button>}
                {selected.size === 1 && <button onClick={() => setDialog({ kind: "details", entry: selectedEntries[0] })}><Info size={16} /> Properties</button>}
                <button className="danger-action" onClick={() => setDialog({ kind: "delete" })}><Trash2 size={16} /> Delete</button>
                <button className="icon-button" aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={16} /></button>
              </div>
            </div>
          )}

          <div className={`files-surface ${view === "grid" ? "grid-mode" : ""}`} onContextMenu={openBackgroundMenu}>
            {loading && !entries.length ? <FileSkeleton /> : entries.length === 0 ? (
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
          username={auth.username || ""}
          onCredentialsUpdated={async () => { setDialog(null); await refreshAuth(); notify("Account preferences updated"); }}
          onReveal={(entry) => { setDialog(null); navigate(entry.path.split("/").slice(0, -1).join("/")); }}
          onPreview={(entry) => setDialog({ kind: "preview", entry })}
        />
      )}
      {menu && createPortal(menu.kind === "entry"
        ? <FileActionMenu entry={menu.entry} targets={menuTargets(menu.entry)} position={{ top: menu.top, left: menu.left }} menuRef={menuRef} favoritePaths={favoritePaths} canPaste={Boolean(clipboard) && menu.entry.type === "directory"} onAction={(action, entry) => { setMenu(null); handleEntryAction(action, entry); }} />
        : <BackgroundMenu position={{ top: menu.top, left: menu.left }} menuRef={menuRef} folder={currentPath ? currentPath.split("/").at(-1) || "" : "All files"} clipboardCount={clipboard?.paths.length ?? 0} canSelectAll={sortedEntries.length > 0} onChoose={chooseBackground} />,
      document.body)}
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await requestJson("/api/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
      await onSuccess();
    } catch (caught) {
      setError((caught as Error).message);
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
          <form onSubmit={submit} className="login-form">
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
  return {
    draggable: true,
    onDragStart: (event: React.DragEvent<HTMLElement>) => interactions.onDragStart(entry, event),
    onDragEnd: interactions.onDragEnd,
    onContextMenu: (event: React.MouseEvent) => interactions.onContextMenu(entry, event),
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
            <div className="file-name-cell" role="cell"><span className={`file-icon ${entry.type}`}>{fileIcon(entry)}</span><button className="file-name" onClick={() => onOpen(entry)}>{entry.name}</button>{entry.symlinkBlocked && <span className="warning-badge" title="This link points outside the allowed root"><CircleAlert size={13} /></span>}</div>
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

function FileActionMenu({ entry, targets, position, menuRef, favoritePaths, canPaste, onAction }: {
  entry: FileEntry;
  targets: FileEntry[];
  position: MenuPosition;
  menuRef: React.RefObject<HTMLDivElement | null>;
  favoritePaths: Set<string>;
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
        {entry.type === "file" && item("edit", "Edit", <FilePenLine size={16} />, { disabled: !isEditable(entry) })}
        {item("download", "Download", <Download size={16} />)}
      </div>}
      <div className="file-menu-section">
        {!multiple && item("rename", "Rename", <Pencil size={16} />)}
        {!multiple && entry.type === "directory" && item("favorite", favoritePaths.has(entry.path) ? "Remove from favourites" : "Add to favourites", <Star size={16} fill={favoritePaths.has(entry.path) ? "currentColor" : "none"} />)}
        {item("cut", "Cut", <Scissors size={16} />)}
        {item("clipboard", "Copy", <ClipboardCopy size={16} />)}
        {!multiple && canPaste && item("paste", "Paste into folder", <ClipboardPaste size={16} />)}
        {item("copy", "Copy to…", <Copy size={16} />)}
        {item("move", "Move to…", <FolderInput size={16} />)}
      </div>
      <div className="file-menu-section">
        {item("permissions", "Change permissions", <KeyRound size={16} />)}
        {item("ownership", "Change ownership", <UserRoundCog size={16} />)}
        {!multiple && item("details", "Properties", <Info size={16} />)}
      </div>
      <div className="file-menu-section">
        {item("delete", multiple ? `Delete ${itemCount(targets.length)}` : "Delete", <Trash2 size={16} />, { danger: true })}
      </div>
    </div>
  );
}

function BackgroundMenu({ position, menuRef, folder, clipboardCount, canSelectAll, onChoose }: {
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
      <div className="file-menu-section">
        {item("new", "New folder or file", <FolderPlus size={16} />)}
        {item("upload", "Upload files", <Upload size={16} />)}
        {item("paste", clipboardCount ? `Paste ${itemCount(clipboardCount)}` : "Paste", <ClipboardPaste size={16} />, !clipboardCount)}
      </div>
      <div className="file-menu-section">
        {item("selectAll", "Select all", <ListChecks size={16} />, !canSelectAll)}
        {item("refresh", "Refresh", <RefreshCw size={16} />)}
      </div>
    </div>
  );
}

function FileGrid({ entries, selected, cursor, interactions, onToggle, onOpen }: { entries: FileEntry[]; selected: Set<string>; cursor: string | null; interactions: EntryInteractions; onToggle: (entry: FileEntry, options?: SelectOptions) => void; onOpen: (entry: FileEntry) => void }) {
  return <div className="file-grid">{entries.map((entry) => <article key={entry.path} data-path={entry.path} className={`file-card ${selected.has(entry.path) ? "selected" : ""} ${cursor === entry.path ? "cursor" : ""} ${entryStateClasses(entry, interactions)}`} {...entryItemProps(entry, interactions)} onMouseDown={(event) => { if (event.shiftKey) event.preventDefault(); }} onClick={(event) => { if ((event.target as HTMLElement).closest("button,input,label")) return; onToggle(entry, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey }); }} onDoubleClick={() => onOpen(entry)}><CheckBox checked={selected.has(entry.path)} onChange={(event) => onToggle(entry, { additive: true, range: event.shiftKey })} label={`Select ${entry.name}`} /><button className={`grid-icon ${entry.type}`} onClick={() => onOpen(entry)}>{fileIcon(entry, 34)}</button><button className="grid-name" onClick={() => onOpen(entry)}>{entry.name}</button><span>{entry.type === "directory" ? "Folder" : `${extension(entry.name)} · ${formatBytes(entry.size)}`}</span></article>)}</div>;
}

function CheckBox({ checked, onChange, label }: { checked: boolean; onChange: (event: { shiftKey: boolean }) => void; label: string }) {
  // React fires a checkbox's change from its click event, which carries the shift key.
  return <label className="checkbox"><input type="checkbox" checked={checked} onChange={(event) => onChange({ shiftKey: (event.nativeEvent as MouseEvent).shiftKey === true })} aria-label={label} /><span>{checked && <Check size={12} strokeWidth={3} />}</span></label>;
}

function EmptyState({ searching, onUpload, onNew }: { searching: boolean; onUpload: () => void; onNew: () => void }) {
  return <div className="empty-state"><div className="empty-icon">{searching ? <Search size={27} /> : <FolderOpen size={29} />}</div><h2>{searching ? "No matching files" : "This folder is empty"}</h2><p>{searching ? "Try another name or clear your search." : "Upload files or create a folder to get started."}</p>{!searching && <div><button className="button secondary" onClick={onUpload}><Upload size={16} /> Upload</button><button className="button primary" onClick={onNew}><Plus size={16} /> New</button></div>}</div>;
}

function FileSkeleton() {
  return <div className="file-skeleton">{Array.from({ length: 6 }).map((_, index) => <div key={index}><span /><span /><span /><span /></div>)}</div>;
}

function DialogHost({ dialog, selected, currentPath, username, onClose, onRun, notify, onRefresh, onCredentialsUpdated, onReveal, onPreview }: {
  dialog: NonNullable<DialogState>;
  selected: FileEntry[];
  currentPath: string;
  username: string;
  onClose: () => void;
  onRun: (body: Record<string, unknown>, success: string) => Promise<boolean>;
  notify: (message: string, tone?: "error") => void;
  onRefresh: () => Promise<void>;
  onCredentialsUpdated: () => Promise<void>;
  onReveal: (entry: FileEntry) => void;
  onPreview: (entry: FileEntry) => void;
}) {
  if (dialog.kind === "upload") return <UploadDialog files={dialog.files} currentPath={currentPath} onClose={onClose} notify={notify} onComplete={onRefresh} />;
  if (dialog.kind === "storage") return <StorageDialog onClose={onClose} onReveal={onReveal} onPreview={onPreview} notify={notify} />;
  if (dialog.kind === "trash") return <TrashDialog onClose={onClose} notify={notify} onRefresh={onRefresh} />;
  if (dialog.kind === "new") return <NewDialog path={currentPath} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "rename") return <RenameDialog entry={dialog.entry} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "delete") return <DeleteDialog entries={selected} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "permissions") return <PermissionsDialog entries={selected} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "ownership") return <OwnershipDialog entries={selected} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "transfer") return <TransferDialog mode={dialog.mode} entries={selected} startPath={currentPath} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "bulk") return <BulkRenameDialog entries={selected} onClose={onClose} notify={notify} onRefresh={onRefresh} />;
  if (dialog.kind === "preview") return <PreviewDialog entry={dialog.entry} onClose={onClose} />;
  if (dialog.kind === "edit") return <EditDialog entry={dialog.entry} onClose={onClose} onRun={onRun} />;
  if (dialog.kind === "preferences") return <PreferencesDialog username={username} onClose={onClose} onUpdated={onCredentialsUpdated} />;
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
          <div>{listing ? <><strong>{items.length.toLocaleString()} {items.length === 1 ? "item" : "items"} · {totalLabel}</strong><span>Items stay here until you restore them or delete them forever</span></> : <><strong>Protected trash</strong><span>Loading deleted items…</span></>}</div>
          <div className="storage-scan-actions"><button className="button secondary" disabled={loading || busy} onClick={() => void load()}><RefreshCw size={15} className={loading ? "spin" : ""} /> Refresh</button><button className="button danger" disabled={!items.length || busy} onClick={() => setConfirm({ kind: "empty" })}><Trash2 size={15} /> Empty trash</button></div>
        </div>
        {listing && !listing.enabled && <div className="storage-scan-note trash-note"><Info size={15} /> Protected trash is turned off on this server, so new deletions are permanent.</div>}
        {selected.size > 0 && <div className="storage-selection-bar"><div><span>{selected.size}</span><strong>{selected.size === 1 ? "item" : "items"} selected</strong></div><div><button className="button primary" disabled={busy} onClick={() => void restore(selectedItems)}><RotateCcw size={15} /> Restore</button><button className="button danger" disabled={busy} onClick={() => setConfirm({ kind: "delete", items: selectedItems })}><Trash2 size={15} /> Delete forever</button><button className="button secondary" onClick={() => setSelected(new Set())}>Clear</button></div></div>}
        {loading && !listing ? <div className="storage-scan-state"><LoaderCircle className="spin" size={25} /><strong>Loading the trash…</strong></div> : error && !listing ? <div className="storage-scan-state error"><CircleAlert size={25} /><strong>Unable to open the trash</strong><span>{error}</span><button className="button secondary" onClick={() => void load()}>Try again</button></div> : listing && <>
          <div className="largest-file-table" role="table" aria-label="Deleted items">
            <div className="trash-row largest-file-header" role="row"><div role="columnheader"><CheckBox checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))} label="Select all deleted items" /></div><div role="columnheader">Name</div><div role="columnheader">Original location</div><div role="columnheader">Size</div><div role="columnheader">Deleted</div><div role="columnheader" /></div>
            {items.map((item) => {
              const parent = item.originalPath?.split("/").slice(0, -1).join("/") ?? "";
              return <div className={`trash-row ${selected.has(item.id) ? "selected" : ""}`} role="row" key={item.id}><div role="cell"><CheckBox checked={selected.has(item.id)} onChange={() => toggleSelected(item.id)} label={`Select ${item.name}`} /></div><div className="largest-name" role="cell"><span className={`file-icon ${item.type}`}>{fileIcon(item, 17)}</span><span className="trash-name" title={item.name}>{item.name}</span></div><div className="largest-location" role="cell" title={item.originalPath ? `/${item.originalPath}` : "Deleted before FilesDude recorded locations; restores to Root"}>{item.originalPath ? <><span>/</span>{parent || "Root"}</> : <>Root <span>(original unknown)</span></>}</div><div className="largest-size" role="cell">{sizeLabel(item.size, item.sizeComplete)}</div><div className="muted" role="cell" title={new Date(item.deletedAt).toLocaleString()}>{formatDate(item.deletedAt)}</div><div className="largest-actions" role="cell"><button className="icon-button" title="Restore" aria-label={`Restore ${item.name}`} disabled={busy} onClick={() => void restore([item])}><RotateCcw size={16} /></button><button className="icon-button delete" title="Delete forever" aria-label={`Delete ${item.name} forever`} disabled={busy} onClick={() => setConfirm({ kind: "delete", items: [item] })}><Trash2 size={16} /></button></div></div>;
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

function UploadDialog({ files, currentPath, onClose, notify, onComplete }: { files: File[]; currentPath: string; onClose: () => void; notify: (message: string, tone?: "error") => void; onComplete: () => Promise<void> }) {
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
  }, [currentPath]);

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
    if (!options) return;
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

  return <Modal title={`Upload ${files.length} ${files.length === 1 ? "file" : "files"}`} subtitle={`Choose ownership before uploading to /${currentPath}`} icon={<Upload size={19} />} onClose={onClose}><form className="upload-form" onSubmit={submit}><div className="upload-file-summary"><div><Upload size={18} /><span><strong>{files.length} {files.length === 1 ? "file" : "files"}</strong><small>{formatBytes(files.reduce((total, file) => total + file.size, 0))} total{uploadedCount ? ` · ${uploadedCount} uploaded` : ""}</small></span></div><div className="upload-file-list">{files.slice(0, 4).map((file) => <span key={`${file.name}-${file.size}`}>{file.name}</span>)}{files.length > 4 && <span>and {files.length - 4} more…</span>}</div></div>{progressPanel}<div className="ownership-heading"><div><UserRoundCog size={17} /><span><strong>Owner and group</strong><small>Detected from this folder and its contents</small></span></div>{options?.truncated && <small>Based on the first 2,000 items</small>}</div>{!options && !error ? <div className="ownership-loading"><LoaderCircle className="spin" size={18} /> Detecting ownership…</div> : options && <div className="ownership-options"><label className={`ownership-option ${selectedOwnership === "service" ? "active" : ""}`}><input type="radio" name="upload-ownership" value="service" checked={selectedOwnership === "service"} onChange={(event) => setSelectedOwnership(event.target.value)} /><span className="ownership-radio" /><span><strong>Keep FilesDude service ownership</strong><small>{options.service.owner}:{options.service.group} · {options.service.uid}:{options.service.gid}</small></span>{preferredKey === "service" && <em>Default</em>}</label>{ownershipPairs.map((pair) => { const key = ownershipKey(pair); const destination = key === ownershipKey(options.destination); return <label key={key} className={`ownership-option ${selectedOwnership === key ? "active" : ""} ${!options.canChangeOwnership ? "disabled" : ""}`}><input type="radio" name="upload-ownership" value={key} checked={selectedOwnership === key} disabled={!options.canChangeOwnership} onChange={(event) => setSelectedOwnership(event.target.value)} /><span className="ownership-radio" /><span><strong>{pair.owner}:{pair.group}</strong><small>{pair.uid}:{pair.gid}{destination ? " · destination folder" : pair.source === "default" ? " · saved default" : ` · ${pair.count || 0} existing ${pair.count === 1 ? "item" : "items"}`}</small></span>{preferredKey === key && <em>Default</em>}</label>; })}</div>}{options && !options.canChangeOwnership && <div className="warning-box"><CircleAlert size={17} /> Ownership changes require FilesDude&apos;s systemd service to run as root. This upload will keep <code>{options.service.uid}:{options.service.gid}</code>.</div>}<div className="info-box"><Info size={17} /> Uploaded files use mode <code>640</code>. Owner/group selection does not change those read and write permissions.</div>{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}{busy ? <div className="modal-actions"><button type="button" className="button danger" onClick={() => controllerRef.current?.abort()}><X size={16} /> Cancel upload</button></div> : <ModalActions onClose={onClose} submitLabel={uploadedCount ? "Upload remaining files" : `Upload ${files.length === 1 ? "file" : "files"}`} busy={!options} />}</form></Modal>;
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

function TransferDialog({ mode, entries, startPath, onClose, onRun }: { mode: "copy" | "move"; entries: FileEntry[]; startPath: string; onClose: () => void; onRun: (body: Record<string, unknown>, success: string) => Promise<boolean> }) {
  const [destination, setDestination] = useState(startPath);
  const [busy, setBusy] = useState(false);
  const blockedDirectories = useMemo(() => entries.filter((entry) => entry.type === "directory").map((entry) => entry.path), [entries]);
  const blocked = blockedDirectories.some((dirPath) => destination === dirPath || destination.startsWith(`${dirPath}/`));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    setBusy(true);
    await onRun({ action: mode, paths: entries.map((entry) => entry.path), destination }, `${entries.length} ${entries.length === 1 ? "item" : "items"} ${mode === "copy" ? "copied" : "moved"}`);
    setBusy(false);
  };
  return (
    <Modal title={`${mode === "copy" ? "Copy" : "Move"} ${entries.length} ${entries.length === 1 ? "item" : "items"}`} subtitle="Type a destination or browse the folder structure below" icon={mode === "copy" ? <Copy size={19} /> : <FolderInput size={19} />} onClose={onClose}>
      <form onSubmit={submit}>
        <FormField label="Destination folder" hint="Leave empty to use the root folder">
          <div className="path-input"><span>/</span><input autoFocus value={destination} onChange={(event) => setDestination(event.target.value.replace(/^\/+/, ""))} placeholder="media/archive" /></div>
        </FormField>
        <FolderPicker value={destination} onChange={setDestination} />
        {blocked && <div className="warning-box"><CircleAlert size={17} /> You can&apos;t {mode === "copy" ? "copy" : "move"} a folder into itself or one of its own subfolders.</div>}
        <ModalActions onClose={onClose} submitLabel={mode === "copy" ? "Copy here" : "Move here"} busy={busy} disabled={blocked} />
      </form>
    </Modal>
  );
}

type FolderListing = { browsePath: string; folders: FileEntry[]; filterPrefix: string | null };

function FolderPicker({ value, onChange }: { value: string; onChange: (path: string) => void }) {
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
    const base = listing?.browsePath ?? "";
    const parts = base ? base.split("/") : [];
    return [{ label: "Root", path: "" }, ...parts.map((part, index) => ({ label: part, path: parts.slice(0, index + 1).join("/") }))];
  }, [listing]);

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

function PreferencesDialog({ username: initialUsername, onClose, onUpdated }: { username: string; onClose: () => void; onUpdated: () => Promise<void> }) {
  const [username, setUsername] = useState(initialUsername);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [uploadMode, setUploadMode] = useState<UploadOwnershipPreference["mode"]>("destination");
  const [fixedUid, setFixedUid] = useState("0");
  const [fixedGid, setFixedGid] = useState("0");
  const [users, setUsers] = useState<IdentityOption[]>([]);
  const [groups, setGroups] = useState<IdentityOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    requestJson<{ username: string; uploadOwnership: UploadOwnershipPreference; identities: { users: IdentityOption[]; groups: IdentityOption[] } }>("/api/auth/preferences", { signal: controller.signal })
      .then((result) => {
        setUsername(result.username);
        setUploadMode(result.uploadOwnership.mode);
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
        body: JSON.stringify({ currentPassword: currentPassword || undefined, username, newPassword: newPassword || undefined, uploadOwnership }),
      });
      await onUpdated();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <Modal title="Preferences" subtitle="Account, sign-in security, and upload defaults" icon={<Settings2 size={19} />} onClose={onClose}><form className="preferences-form" onSubmit={submit}><div className="preferences-intro"><div className="avatar large-avatar">{initialUsername.slice(0, 1).toUpperCase()}</div><div><strong>Administrator account</strong><span>Account changes invalidate other signed-in sessions.</span></div></div><div className="settings-section"><div className="settings-section-title"><span><Upload size={16} /></span><div><strong>Default upload ownership</strong><small>This choice is preselected for confirmation before every upload</small></div></div><FormField label="Default owner and group"><select value={uploadMode} onChange={(event) => setUploadMode(event.target.value as UploadOwnershipPreference["mode"])} disabled={!loaded}><option value="destination">Match the destination folder</option><option value="service">Keep FilesDude service ownership</option><option value="fixed">Use a fixed owner and group</option></select></FormField>{uploadMode === "fixed" && <div className="field-pair preference-identity-pair"><FormField label="Owner"><select value={fixedUid} onChange={(event) => setFixedUid(event.target.value)} required>{!users.some((user) => String(user.id) === fixedUid) && <option value={fixedUid}>UID {fixedUid}</option>}{users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.id})</option>)}</select></FormField><FormField label="Group"><select value={fixedGid} onChange={(event) => setFixedGid(event.target.value)} required>{!groups.some((group) => String(group.id) === fixedGid) && <option value={fixedGid}>GID {fixedGid}</option>}{groups.map((group) => <option key={group.id} value={group.id}>{group.name} ({group.id})</option>)}</select></FormField></div>}<div className="info-box"><Info size={17} /> FilesDude still shows the detected owner/group choices each time, so unusual folders can be handled safely.</div></div><div className="settings-section"><div className="settings-section-title"><span><UserRoundCog size={16} /></span><div><strong>Username</strong><small>Used on the FilesDude sign-in screen</small></div></div><FormField label="Username"><input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" minLength={3} maxLength={64} pattern="[A-Za-z0-9._-]+" required /></FormField></div><div className="settings-section"><div className="settings-section-title"><span><LockKeyhole size={16} /></span><div><strong>Password</strong><small>Only required when changing the username or password</small></div></div><FormField label="Current password" hint={credentialsChanged ? "Required to save account changes" : "Not needed for upload preferences"}><div className="password-field"><input type={showPasswords ? "text" : "password"} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" required={credentialsChanged} /><LockKeyhole size={15} /></div></FormField><div className="field-pair preferences-passwords"><FormField label="New password"><input type={showPasswords ? "text" : "password"} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" minLength={newPassword ? 12 : undefined} placeholder="At least 12 characters" /></FormField><FormField label="Confirm new password"><input type={showPasswords ? "text" : "password"} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} autoComplete="new-password" placeholder="Repeat new password" /></FormField></div><label className="show-passwords"><input type="checkbox" checked={showPasswords} onChange={(event) => setShowPasswords(event.target.checked)} />{showPasswords ? <EyeOff size={15} /> : <Eye size={15} />} Show passwords</label></div>{error && <div className="form-error"><CircleAlert size={16} />{error}</div>}<div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy || !loaded}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}Save preferences</button></div></form></Modal>;
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

function DetailsDialog({ entry, onClose }: { entry: FileEntry; onClose: () => void }) {
  const rows = [["Type", entry.type === "directory" ? "Folder" : entry.mime], ["Size", entry.type === "directory" ? "—" : `${formatBytes(entry.size)} (${entry.size.toLocaleString()} bytes)`], ["Location", `/${entry.path}`], ["Owner", `${entry.owner}:${entry.group} (${entry.uid}:${entry.gid})`], ["Permissions", entry.mode], ["Modified", new Date(entry.modified).toLocaleString()], ["Created", new Date(entry.created).toLocaleString()]];
  return <Modal title="Item details" subtitle={entry.name} icon={<Info size={19} />} onClose={onClose}><div className="details-hero"><span className={`file-icon ${entry.type}`}>{fileIcon(entry, 32)}</span><div><strong>{entry.name}</strong><span>{entry.type === "directory" ? "Folder" : extension(entry.name)}</span></div></div><dl className="details-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{label === "Permissions" ? <code className="mode-chip">{value}</code> : value}</dd></div>)}</dl><div className="modal-actions"><button className="button primary" onClick={onClose}>Done</button></div></Modal>;
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="form-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
