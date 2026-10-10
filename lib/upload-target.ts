import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config";
import { INTERNAL_NAMES, inside, safeResolve, type AnchoredDirectory } from "./files";
import { AppError } from "./http";

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
  if (INTERNAL_NAMES.has(name)) throw new AppError("That file name can't be used", 400, "INVALID_NAME");
  const state = await fsp.realpath(config.stateDir).catch(() => path.resolve(config.stateDir));
  const extension = path.extname(name);
  const stem = extension ? name.slice(0, -extension.length) : name;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = attempt === 0 ? name : fitName(stem, attempt <= 20 ? ` (${attempt})` : `-${crypto.randomBytes(6).toString("base64url")}`, extension);
    if (INTERNAL_NAMES.has(candidate) || path.join(folder.real, candidate) === state) continue;
    try {
      const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
      const handle = await fsp.open(inside(folder, candidate), flags, 0o640);
      try {
        return { name: candidate, handle, created: await handle.stat() };
      } catch (error) {
        await handle.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      console.error(error);
      throw new AppError("The file couldn't be saved", 500, "SAVE_FAILED");
    }
  }
  throw new AppError("The file couldn't be saved", 500, "SAVE_FAILED");
}
