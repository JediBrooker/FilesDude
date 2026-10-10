import { constants } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { inside, safeResolve, type AnchoredDirectory } from "./files";
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
