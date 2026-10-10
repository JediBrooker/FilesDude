import { constants, type Stats } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { INTERNAL_NAMES, inside, safeResolve, type AnchoredDirectory } from "./files";
import { AppError } from "./http";

/** Gives an uploaded file its owner and group, through its open handle. */
export async function applyOwnership(handle: FileHandle, ownership: { uid: number; gid: number } | null) {
  if (!ownership) return;
  try {
    await handle.chown(ownership.uid, ownership.gid);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") throw new AppError("FilesDude cannot apply that ownership. Run the service as root or choose service ownership.", 403, "CHOWN_DENIED");
    throw error;
  }
}

export function uploadName(raw: string) {
  const name = path.basename(raw).trim();
  if (!name || name === "." || name === ".." || name.includes("\0") || name.includes("/") || name.includes("\\") || Buffer.byteLength(name, "utf8") > 255) {
    throw new AppError("An uploaded file has an invalid name", 400, "INVALID_NAME");
  }
  return name;
}

/**
 * Creates a new file for an upload inside the destination folder's open handle, so the folder can't
 * be swapped for a symlink between the check and the write. Never replaces anything: a name that's
 * taken becomes "name (1).ext".
 */
export async function reserveTarget(folder: AnchoredDirectory, directory: string, name: string) {
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let index = 0; index < 10_000; index += 1) {
    const candidateName = index === 0 ? name : `${stem} (${index})${extension}`;
    const relative = [directory, candidateName].filter(Boolean).join("/");
    await safeResolve(relative, { mustExist: false });
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      const handle = await fsp.open(inside(folder, candidateName), flags, 0o640);
      try {
        return { name: candidateName, relative, handle, created: await handle.stat() };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new AppError("Unable to choose an available upload name", 409);
}

const MAX_NAME_BYTES = 255;

// "stem" + suffix + extension, with the stem shortened (by whole characters) to fit a file name.
function fitName(stem: string, suffix: string, extension: string) {
  const ending = Buffer.byteLength(suffix + extension) > MAX_NAME_BYTES - 16 ? suffix : suffix + extension;
  const characters = Array.from(stem);
  while (characters.length && Buffer.byteLength(characters.join("") + ending) > MAX_NAME_BYTES) characters.pop();
  return (characters.join("") + ending).replace(/^[ -]+/, "") || `upload${ending}`;
}

/**
 * Creates a new file for an upload through a link, inside the link's already-checked folder handle.
 * Unlike reserveTarget it looks at nothing but the one new name: it never resolves paths (whose
 * errors could say what's in the folder), tries a few numbered names and then random ones (so names
 * never run out), and fails the same way whatever is in the way.
 */
export async function reservePublicTarget(folder: AnchoredDirectory, name: string) {
  let reserved: { name: string; handle: FileHandle; created: Stats } | null = null;
  await withPublicNames(folder, name, async (candidate) => {
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      const handle = await fsp.open(inside(folder, candidate), flags, 0o640);
      try {
        reserved = { name: candidate, handle, created: await handle.stat() };
        return true;
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  });
  if (!reserved) throw new AppError("The file couldn't be saved", 500, "SAVE_FAILED");
  return reserved as { name: string; handle: FileHandle; created: Stats };
}

/**
 * Offers `take` free-looking names for a stranger's file in `folder` (the name, a few numbered ones,
 * then random ones) until it takes one, never one of FilesDude's own. Any failure other than the name
 * being taken is reported the same way, whatever was in the way.
 */
export async function withPublicNames(folder: AnchoredDirectory, name: string, take: (candidate: string) => Promise<boolean>) {
  if (INTERNAL_NAMES.has(name)) throw new AppError("That file name can't be used", 400, "INVALID_NAME");
  const state = await fsp.realpath(config.stateDir).catch(() => path.resolve(config.stateDir));
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = attempt === 0 ? name : fitName(stem, attempt <= 20 ? ` (${attempt})` : `-${crypto.randomBytes(6).toString("base64url")}`, extension);
    if (INTERNAL_NAMES.has(candidate) || path.join(folder.real, candidate) === state) continue;
    try {
      if (await take(candidate)) return candidate;
    } catch (error) {
      console.error(error);
      throw new AppError("The file couldn't be saved", 500, "SAVE_FAILED");
    }
  }
  throw new AppError("The file couldn't be saved", 500, "SAVE_FAILED");
}

// Names come from strangers and are shown in the owner's file list: invisible and direction-changing
// characters are replaced so a name reads as what it is, lookalike spacing is collapsed, and a leading
// dot (a hidden file other software may act on, such as .htaccess) becomes an underscore.
export function publicName(raw: string) {
  const cleaned = raw.normalize("NFC").replace(/[\p{Cc}\p{Cf}]/gu, "_").replace(/\s+/g, " ").trim();
  const name = uploadName(cleaned);
  return name.startsWith(".") ? `_${name.slice(1)}` : name;
}

export { addressGroup } from "./address-group";
