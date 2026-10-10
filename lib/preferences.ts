import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./http";
import type { UploadOwnershipPreference } from "./types";

export interface StoredPreferences {
  uploadOwnership: UploadOwnershipPreference;
  /** Days trashed items are kept before being deleted forever; null keeps them until removed by hand. */
  trashRetentionDays: number | null;
  snapshotSchedule: SnapshotSchedule;
  /** Which accounts besides the owner may browse, download from, and restore from snapshots. */
  snapshotAccess: SnapshotAccess;
  /** Whether large files upload in pieces (for proxies with a request size limit, such as Cloudflare). */
  uploadInPieces: boolean;
  updatedAt?: string;
}

export type SnapshotAccess = "owner" | "editors" | "everyone";

export function parseSnapshotAccess(value: unknown): SnapshotAccess {
  if (value === "owner" || value === "editors" || value === "everyone") return value;
  throw new AppError("Choose who can see snapshots: only the owner, editors too, or everyone", 400, "INVALID_SNAPSHOT_ACCESS");
}

/** Automatic ZFS snapshots: how often, and how many of FilesDude's automatic ones to keep. */
export interface SnapshotSchedule {
  frequency: "off" | "hourly" | "daily";
  keep: number;
}

export const MAX_SNAPSHOTS_KEPT = 1000;

export function parseSnapshotSchedule(value: unknown): SnapshotSchedule {
  const candidate = value && typeof value === "object" ? value as { frequency?: unknown; keep?: unknown } : {};
  if ((candidate.frequency === "off" || candidate.frequency === "hourly" || candidate.frequency === "daily") && Number.isInteger(candidate.keep) && Number(candidate.keep) >= 1 && Number(candidate.keep) <= MAX_SNAPSHOTS_KEPT) {
    return { frequency: candidate.frequency, keep: Number(candidate.keep) };
  }
  throw new AppError(`Choose off, hourly, or daily, keeping 1 to ${MAX_SNAPSHOTS_KEPT} snapshots`, 400, "INVALID_SNAPSHOT_SCHEDULE");
}

export const MAX_TRASH_RETENTION_DAYS = 3650;

function preferencesFile() {
  return path.join(config.stateDir, "preferences.json");
}
const defaults: StoredPreferences = { uploadOwnership: { mode: "destination" }, trashRetentionDays: null, snapshotSchedule: { frequency: "off", keep: 24 }, snapshotAccess: "owner", uploadInPieces: true };

export function parseTrashRetention(value: unknown): number | null {
  if (value === null) return null;
  if (Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_TRASH_RETENTION_DAYS) return Number(value);
  throw new AppError(`Keep trashed items for 1 to ${MAX_TRASH_RETENTION_DAYS.toLocaleString()} days, or until removed`, 400, "INVALID_TRASH_RETENTION");
}

export function parseUploadOwnershipPreference(value: unknown): UploadOwnershipPreference {
  if (!value || typeof value !== "object") throw new AppError("Choose a valid default upload owner and group", 400, "INVALID_UPLOAD_OWNERSHIP");
  const candidate = value as { mode?: unknown; uid?: unknown; gid?: unknown };
  if (candidate.mode === "destination" || candidate.mode === "service") return { mode: candidate.mode };
  if (candidate.mode === "fixed" && Number.isInteger(candidate.uid) && Number(candidate.uid) >= 0 && Number.isInteger(candidate.gid) && Number(candidate.gid) >= 0) {
    return { mode: "fixed", uid: Number(candidate.uid), gid: Number(candidate.gid) };
  }
  throw new AppError("Choose a valid default upload owner and group", 400, "INVALID_UPLOAD_OWNERSHIP");
}

export async function getPreferences(): Promise<StoredPreferences> {
  try {
    const value = JSON.parse(await fs.readFile(preferencesFile(), "utf8")) as Partial<StoredPreferences>;
    return {
      uploadOwnership: value.uploadOwnership ? parseUploadOwnershipPreference(value.uploadOwnership) : defaults.uploadOwnership,
      trashRetentionDays: value.trashRetentionDays === undefined ? defaults.trashRetentionDays : parseTrashRetention(value.trashRetentionDays),
      snapshotSchedule: value.snapshotSchedule === undefined ? defaults.snapshotSchedule : parseSnapshotSchedule(value.snapshotSchedule),
      snapshotAccess: value.snapshotAccess === undefined ? defaults.snapshotAccess : parseSnapshotAccess(value.snapshotAccess),
      uploadInPieces: typeof value.uploadInPieces === "boolean" ? value.uploadInPieces : defaults.uploadInPieces,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    if (error instanceof SyntaxError) throw new AppError("Stored preferences are corrupted", 503, "PREFERENCES_CORRUPT");
    throw error;
  }
}

export async function savePreferences(preferences: StoredPreferences) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `preferences-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, preferencesFile());
}
