import { audit } from "./audit";
import type { Session } from "./auth";
import { ensureFolders, isAvailableUploadOwnership, MAX_UPLOAD_FOLDER_DEPTH, openDirectory, type AnchoredDirectory } from "./files";
import { AppError } from "./http";
import { getPreferences } from "./preferences";

// The folder inside the destination a file goes into, when uploading a folder: "Photos/2024".
function folderNames(raw: string | null) {
  if (raw === null) return [];
  const names = raw.split("/");
  if (raw.length > 4096 || names.length > MAX_UPLOAD_FOLDER_DEPTH || names.some((name) => !name)) throw new AppError("The upload folder is invalid", 400, "INVALID_FOLDER");
  return names;
}

export type UploadDestination = {
  /** The folder the upload was started in, and the folder inside it the file goes into (or null). */
  folder: AnchoredDirectory;
  target: AnchoredDirectory | null;
  into: AnchoredDirectory;
  directory: string;
  subfolders: string[];
  ownership: { uid: number; gid: number } | null;
  batch: string | undefined;
  close: () => Promise<void>;
};

/**
 * Opens where an upload goes, from its query: `path`, and when uploading a folder `folder` (made as
 * needed, the first level always new with `unique=1`), plus the owner's choice of `uid` and `gid`.
 * Called with the filesystem lock held; the caller closes the result.
 */
export async function openUploadDestination(url: URL, session: Session): Promise<UploadDestination> {
  const baseDirectory = url.searchParams.get("path") || "";
  const subfolders = folderNames(url.searchParams.get("folder"));
  // The upload this request is part of (each file is its own request), so Activity can show the
  // whole upload as one entry. Every file is still recorded on its own.
  const batchValue = url.searchParams.get("batch");
  const batch = batchValue && /^[A-Za-z0-9-]{8,64}$/.test(batchValue) ? batchValue : undefined;
  const folder = await openDirectory(baseDirectory).catch((error: unknown) => {
    if (error instanceof AppError && error.code === "NOT_A_DIRECTORY") throw new AppError("Upload destination is not a folder", 400);
    throw error;
  });
  let target: AnchoredDirectory | null = null;
  const close = async () => {
    await target?.handle.close().catch(() => undefined);
    await folder.handle.close().catch(() => undefined);
  };
  try {
    const uidValue = url.searchParams.get("uid");
    const gidValue = url.searchParams.get("gid");
    if ((uidValue === null) !== (gidValue === null)) throw new AppError("Choose both an owner and group", 400, "INVALID_UPLOAD_OWNERSHIP");
    let ownership: { uid: number; gid: number } | null = null;
    if (session.role !== "owner") {
      // Only the owner chooses ownership; other accounts' uploads take the destination folder's
      // owner, so files a root service writes stay usable by that folder's users.
      if (uidValue !== null || gidValue !== null) throw new AppError("Only the owner account can choose upload ownership", 403, "FORBIDDEN");
      if (typeof process.getuid === "function" && process.getuid() === 0) ownership = { uid: folder.stat.uid, gid: folder.stat.gid };
    } else if (uidValue !== null && gidValue !== null) {
      const uid = Number(uidValue);
      const gid = Number(gidValue);
      const preference = (await getPreferences()).uploadOwnership;
      const savedDefault = preference.mode === "fixed" ? { uid: preference.uid, gid: preference.gid } : undefined;
      if (!(await isAvailableUploadOwnership(baseDirectory, uid, gid, savedDefault))) {
        throw new AppError("That owner and group are not available for this folder", 400, "INVALID_UPLOAD_OWNERSHIP");
      }
      ownership = { uid, gid };
    }

    // Uploading a folder: its top folder is made first (always new, so nothing is merged into an
    // existing folder by accident), and each file then goes into its place inside it, with any
    // folders on the way created as needed.
    let directory = baseDirectory;
    if (subfolders.length) {
      // Other accounts' new folders take the owner of the folder each is made in, as their other new
      // items do; the owner's choice (if any) applies throughout.
      const inherit = session.role !== "owner";
      const ensured = await ensureFolders(folder, baseDirectory, subfolders, { owner: inherit ? null : ownership, inheritOwner: inherit && ownership !== null, uniqueFirst: url.searchParams.get("unique") === "1" });
      target = ensured.folder;
      directory = ensured.relative;
      if (inherit && ownership) ownership = { uid: target.stat.uid, gid: target.stat.gid };
      // Every folder made is recorded now, under its actual name, even if the upload then fails.
      for (const made of ensured.made) {
        await audit("fs.create", { username: session.username, path: made.split("/").slice(0, -1).join("/"), name: made.split("/").at(-1), upload: true, batch });
      }
    }
    return { folder, target, into: target ?? folder, directory, subfolders, ownership, batch, close };
  } catch (error) {
    await close();
    throw error;
  }
}
