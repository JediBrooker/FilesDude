export type EntryType = "file" | "directory" | "symlink";

export interface FileEntry {
  name: string;
  path: string;
  type: EntryType;
  size: number;
  modified: string;
  created: string;
  mode: string;
  uid: number;
  gid: number;
  owner: string;
  group: string;
  mime: string;
  hidden: boolean;
  symlinkTarget?: string;
  symlinkBlocked?: boolean;
}

export interface DiskInfo {
  total: number;
  available: number;
  used: number;
}

export interface OwnershipPair {
  uid: number;
  gid: number;
  owner: string;
  group: string;
  count?: number;
  source?: "destination" | "contents" | "service" | "default";
}

export type UploadOwnershipPreference =
  | { mode: "destination" }
  | { mode: "service" }
  | { mode: "fixed"; uid: number; gid: number };

export interface UploadOwnershipOptions {
  destination: OwnershipPair;
  detected: OwnershipPair[];
  service: OwnershipPair;
  preference: UploadOwnershipPreference;
  defaultPair?: OwnershipPair;
  canChangeOwnership: boolean;
  truncated: boolean;
}

export interface IdentityOption {
  id: number;
  name: string;
}

export interface LargestFilesProgress {
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  elapsedMs: number;
}

export interface LargestFilesReady {
  status: "ready";
  entries: FileEntry[];
  totalMatching: number;
  matchingBytes: number;
  offset: number;
  limit: number;
  nextOffset: number;
  hasMore: boolean;
  scannedFiles: number;
  scannedDirectories: number;
  skippedEntries: number;
  durationMs: number;
  generatedAt: string;
  cached: boolean;
}

export interface LargestFilesScanning {
  status: "scanning";
  progress: LargestFilesProgress;
}

export type LargestFilesResult = LargestFilesReady | LargestFilesScanning;

export interface TrashItem {
  id: string;
  name: string;
  /** Where the item lived before deletion; null for items trashed before FilesDude recorded it. */
  originalPath: string | null;
  deletedAt: string;
  type: EntryType;
  mime: string;
  size: number;
  /** False when a large folder was only partially measured. */
  sizeComplete: boolean;
}

export interface TrashListing {
  enabled: boolean;
  items: TrashItem[];
  totalBytes: number;
}

export interface TransferResult {
  source: string;
  path: string;
  /** True when a copy was given a new name because the original name was taken. */
  renamed: boolean;
}

export interface DeleteResult {
  /** Items moved to protected trash, with the ids needed to restore them. */
  trashed: Array<{ path: string; id: string }>;
}

export type ArchiveFormat = "zip" | "tar.gz";

export interface JobProgress {
  done: number;
  /** Absent when the total cannot be known in advance. */
  total?: number;
  unit: "bytes" | "entries";
}

export interface ArchiveResult {
  /** The archive created, or the folder extracted into. */
  path: string;
  entries: number;
  bytes: number;
  /** Archive entries left out for safety, such as links and devices. */
  skipped: number;
}

export interface JobState {
  id: string;
  kind: "compress" | "extract";
  label: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt?: string;
  progress: JobProgress;
  result?: ArchiveResult;
  error?: string;
}

export interface TrashRestoreResult {
  id: string;
  path: string;
  renamed: boolean;
}

export interface BulkRenameRule {
  find?: string;
  replace?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  prefix?: string;
  suffix?: string;
  start?: number;
  pad?: number;
  numbering?: boolean;
}

export interface RenamePreview {
  source: string;
  from: string;
  to: string;
  changed: boolean;
  error?: string;
}
