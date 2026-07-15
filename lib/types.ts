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
