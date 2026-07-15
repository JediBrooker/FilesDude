import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./http";
import type { UploadOwnershipPreference } from "./types";

export interface StoredPreferences {
  uploadOwnership: UploadOwnershipPreference;
  updatedAt?: string;
}

const preferencesFile = path.join(config.stateDir, "preferences.json");
const defaults: StoredPreferences = { uploadOwnership: { mode: "destination" } };

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
    const value = JSON.parse(await fs.readFile(preferencesFile, "utf8")) as Partial<StoredPreferences>;
    return {
      uploadOwnership: value.uploadOwnership ? parseUploadOwnershipPreference(value.uploadOwnership) : defaults.uploadOwnership,
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
  await fs.rename(temporary, preferencesFile);
}
