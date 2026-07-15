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

export interface LargestFilesResult {
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
