// Plain-language descriptions of audit events for the Activity view. Shared by the server (for
// filtering by category) and the page (for display), so it has no server-only imports.

export type ActivityCategory = "files" | "downloads" | "sign-ins" | "sharing" | "accounts" | "snapshots";

export const ACTIVITY_CATEGORIES: Array<{ id: ActivityCategory | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "files", label: "Files" },
  { id: "downloads", label: "Downloads" },
  { id: "sign-ins", label: "Sign-ins" },
  { id: "sharing", label: "Sharing" },
  { id: "accounts", label: "Accounts" },
  { id: "snapshots", label: "Snapshots" },
];

// Who did it, for entries not made by an account: names no account can have (usernames are
// letters, numbers, dots, dashes, and underscores).
export const SHARE_LINK_ACTOR = "@share-link";
export const SYSTEM_ACTOR = "@system";

export function activityCategory(event: string): ActivityCategory {
  if (event === "fs.download" || event === "snapshots.download" || event === "share.download") return "downloads";
  if (event.startsWith("login.") || event === "logout") return "sign-ins";
  if (event.startsWith("share.")) return "sharing";
  if (event.startsWith("users.") || event.startsWith("settings.")) return "accounts";
  if (event.startsWith("snapshots.")) return "snapshots";
  return "files";
}

/**
 * A sentence as parts: plain words, and values that came from users (names, paths, addresses),
 * which the page shows set apart so they can't pass for the sentence around them.
 */
export type ActivityPart = string | { value: string };
export type ActivityText = { parts: ActivityPart[]; text: string; detail?: string; tone?: "danger" | "warning" };
type Entry = { event: string; [key: string]: unknown };

/** Who did it: the account, a share link, or FilesDude itself (upkeep). */
export function activityUser(entry: Entry) {
  if (entry.event === "share.download" || entry.event === "share.upload") return SHARE_LINK_ACTOR;
  if (entry.event === "share.unlock_failed") return "";
  if (entry.event.startsWith("login.")) return typeof entry.username === "string" ? entry.username : "";
  return typeof entry.username === "string" ? entry.username : SYSTEM_ACTOR;
}

// Characters that are invisible or change the direction of the text around them.
const HIDDEN_CHARACTERS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u2069\\ufeff\\ufff9-\\ufffb]", "g");

/** Text from a user with invisible and direction-changing characters shown as their code. */
export function visibleText(value: string) {
  return value.replace(HIDDEN_CHARACTERS, (character) => `⟨U+${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}⟩`);
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const slash = (value: unknown) => `/${str(value)}`;
const count = (value: number, noun: string) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
const v = (value: string): ActivityPart => ({ value });

// Builds parts from a template: interpolated parts and part lists are kept, plain strings are words.
function t(strings: TemplateStringsArray, ...values: Array<ActivityPart | ActivityPart[]>): ActivityPart[] {
  const parts: ActivityPart[] = [];
  strings.forEach((text, index) => {
    if (text) parts.push(text);
    if (index < values.length) parts.push(...(Array.isArray(values[index]) ? values[index] as ActivityPart[] : [values[index] as ActivityPart]));
  });
  return parts;
}

// "/a/b.txt" for one path, "3 items" for several; the detail line lists them.
function items(paths: string[], fallback?: unknown): ActivityPart {
  if (paths.length === 1) return v(slash(paths[0]));
  if (!paths.length && typeof fallback === "string") return v(slash(fallback));
  return count(paths.filter((item) => !item.startsWith("…")).length || paths.length, "item");
}

function pathDetail(paths: string[]) {
  return paths.length > 1 ? paths.map((item) => (item.startsWith("…") ? item : `/${item}`)).join(", ") : undefined;
}

function formatSize(bytes: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

// A job's outcome, when it didn't simply finish.
function outcome(entry: Entry): { tone?: ActivityText["tone"]; parts: ActivityPart[] } {
  if (entry.status === "failed") return { tone: "danger", parts: str(entry.error) ? t` (failed: ${v(str(entry.error))})` : [" (failed)"] };
  if (entry.status === "cancelled") return { tone: "warning", parts: [" (cancelled)"] };
  return { parts: [] };
}

function describe(entry: Entry): Omit<ActivityText, "text"> {
  const paths = list(entry.paths);
  const client = str(entry.client) || undefined;
  switch (entry.event) {
    case "login.succeeded": return { parts: entry.method === "passkey" ? (str(entry.passkey) ? t`signed in with the passkey ${v(str(entry.passkey))}` : ["signed in with a passkey"]) : [entry.twoFactor ? "signed in with two-factor" : "signed in"], detail: client };
    case "login.failed": return { parts: str(entry.username) ? t`failed to sign in as ${v(str(entry.username))}` : [entry.method === "passkey" ? "failed to sign in with a passkey" : "failed to sign in"], detail: client, tone: "danger" };
    case "login.two_factor.challenged": return { parts: ["entered their password and was asked for a code"], detail: client };
    case "login.two_factor.failed": return { parts: ["entered a wrong two-factor code"], detail: client, tone: "danger" };
    case "logout": return { parts: ["signed out"] };
    case "fs.upload": {
      const files = typeof entry.fileCount === "number" ? entry.fileCount : Array.isArray(entry.files) ? entry.files.length : 0;
      const size = typeof entry.bytes === "number" ? ` (${formatSize(entry.bytes)})` : "";
      const folders = typeof entry.foldersMade === "number" && entry.foldersMade ? `, making ${count(entry.foldersMade, "folder")}` : "";
      return { parts: t`uploaded ${count(files, "file")}${size} to ${v(slash(entry.directory))}${folders}`, detail: typeof entry.fileCount === "number" ? undefined : pathDetail(list(entry.files)) };
    }
    case "fs.download": return typeof entry.items === "number"
      ? { parts: [`downloaded ${count(entry.items, "item")} as a ZIP`], detail: pathDetail(paths) }
      : { parts: t`downloaded ${v(slash(entry.path))}` };
    case "fs.create": return { parts: t`created ${v(slash([str(entry.path), str(entry.name)].filter(Boolean).join("/")))}` };
    case "fs.rename": return { parts: str(entry.name) ? t`renamed ${v(slash(entry.path))} to ${v(str(entry.name))}` : t`renamed ${v(slash(entry.path))}` };
    case "fs.write": return { parts: t`edited ${v(slash(entry.path))}` };
    case "fs.delete": return { parts: t`${entry.permanent ? "permanently deleted" : "moved to the trash"} ${items(paths)}`, detail: pathDetail(paths), tone: entry.permanent ? "warning" : undefined };
    case "fs.copy":
    case "fs.move": {
      const result = outcome(entry);
      return { parts: t`${entry.event === "fs.move" ? "moved" : "copied"} ${items(paths)} to ${v(slash(entry.destination))}${result.parts}`, detail: pathDetail(paths), tone: result.tone };
    }
    case "fs.chmod": return { parts: str(entry.mode) ? t`changed permissions of ${items(paths)} to ${v(str(entry.mode))}` : t`changed permissions of ${items(paths)}`, detail: pathDetail(paths) };
    case "fs.chown": return { parts: typeof entry.uid === "number" ? t`changed the owner of ${items(paths)} to ${`${entry.uid}:${entry.gid}`}` : t`changed the owner of ${items(paths)}`, detail: pathDetail(paths) };
    case "fs.bulkRename": return { parts: t`renamed ${items(paths)} at once`, detail: pathDetail(paths) };
    case "fs.compress": {
      const result = outcome(entry);
      return { parts: t`compressed ${items(paths)}${str(entry.result) ? t` into ${v(slash(entry.result))}` : []}${result.parts}`, detail: pathDetail(paths), tone: result.tone };
    }
    case "fs.extract": {
      const result = outcome(entry);
      return { parts: t`extracted ${v(slash(entry.path))}${str(entry.result) ? t` into ${v(slash(entry.result))}` : []}${result.parts}`, tone: result.tone };
    }
    case "trash.restore": return { parts: [`restored ${count(list(entry.ids).length || 1, "item")} from the trash`] };
    case "trash.delete": return { parts: [`deleted ${count(list(entry.ids).length || 1, "item")} from the trash forever`], tone: "warning" };
    case "trash.empty": return { parts: [`emptied the trash${typeof entry.removed === "number" ? ` (${count(entry.removed, "item")})` : ""}`], tone: "warning" };
    case "trash.purge": return { parts: [`removed ${count(typeof entry.removed === "number" ? entry.removed : 0, "old item")} from the trash${typeof entry.retentionDays === "number" ? ` (kept ${entry.retentionDays} days)` : ""}`] };
    case "duplicates.scan": return { parts: t`looked for duplicates in ${v(slash(entry.path))}` };
    case "duplicates.trash": return { parts: t`moved ${items(paths)} duplicates to the trash`, detail: pathDetail(paths) };
    case "duplicates.link": return { parts: [`replaced ${count(Array.isArray(entry.linked) ? entry.linked.length : 0, "duplicate")} with hard links`] };
    case "share.create": return entry.kind === "upload" ? { parts: t`made ${entry.protected ? "a password-protected" : "an"} upload link to ${v(slash(entry.path))}${str(entry.expiresAt) ? `, until ${new Date(str(entry.expiresAt)).toLocaleString()}` : ""}` } : { parts: t`shared ${v(slash(entry.path))}${entry.protected ? " with a password" : ""}${str(entry.expiresAt) ? `, until ${new Date(str(entry.expiresAt)).toLocaleString()}` : ""}` };
    case "share.revoke": return { parts: [entry.reason === "item deleted" ? `revoked ${count(list(entry.ids).length, "share link")} for deleted items` : "revoked a share link"] };
    case "share.download": return { parts: t`downloaded ${v(slash(entry.path))}`, detail: str(entry.address) || undefined };
    case "share.unlock_failed": return { parts: t`entered a wrong password for the link to ${v(slash(entry.path))}`, detail: str(entry.address) || undefined, tone: "danger" };
    case "fs.upload_discarded": return { parts: t`${entry.reason === "cancelled" ? "cancelled" : "stopped"} uploading ${v(str(entry.name))} to ${v(slash(entry.directory))}${entry.reason === "abandoned" ? " (nothing was sent for 30 minutes)" : entry.reason === "account changed" ? " (their account was changed)" : ""}` };
    case "share.upload": return { parts: str(entry.from) ? t`received ${v(str(entry.name))} in ${v(slash(entry.path))} from ${v(str(entry.from))}` : t`received ${v(str(entry.name))} in ${v(slash(entry.path))}`, detail: str(entry.address) || undefined };
    case "users.create": return { parts: t`added ${str(entry.role) === "viewer" ? "viewer" : "editor"} ${v(str(entry.account))} with ${v(slash(entry.root))}` };
    case "users.update": return { parts: t`changed ${v(str(entry.account))} (${str(entry.role)}, ${v(slash(entry.root))})${entry.passwordReset ? " and reset their password" : ""}${entry.passkeysRemoved ? ", removing their passkeys" : ""}` };
    case "users.delete": return { parts: t`removed the account ${v(str(entry.account))}`, tone: "warning" };
    case "users.two_factor_reset": return { parts: t`turned off two-factor for ${v(str(entry.account))}${entry.passkeysRemoved ? " and removed their passkeys" : ""}`, tone: "warning" };
    case "settings.password.changed": return { parts: ["changed their password"] };
    case "settings.credentials.failed": return { parts: ["entered a wrong current password in preferences"], tone: "danger" };
    case "settings.preferences.updated": return { parts: str(entry.previousUsername) && entry.previousUsername !== entry.username ? t`renamed their account from ${v(str(entry.previousUsername))}` : ["updated their preferences"] };
    case "settings.two_factor.enabled": return { parts: ["turned on two-factor sign-in"] };
    case "settings.two_factor.disabled": return { parts: ["turned off two-factor sign-in"], tone: "warning" };
    case "settings.two_factor.recovery_codes": return { parts: ["made new recovery codes"] };
    case "settings.two_factor.failed": return { parts: ["entered a wrong two-factor code in preferences"], tone: "danger" };
    case "settings.passkey.added": return { parts: str(entry.passkey) ? t`added the passkey ${v(str(entry.passkey))}` : ["added a passkey"] };
    case "settings.passkey.renamed": return { parts: t`renamed the passkey ${v(str(entry.from))} to ${v(str(entry.passkey))}` };
    case "settings.passkey.removed": return { parts: str(entry.passkey) ? t`removed the passkey ${v(str(entry.passkey))}` : ["removed a passkey"] };
    case "settings.passkey.failed": return { parts: [entry.reason === "INVALID_CURRENT_PASSWORD" ? "entered a wrong current password while adding a passkey" : "entered a wrong two-factor code while adding a passkey"], tone: "danger" };
    case "snapshots.create": return { parts: t`took snapshot ${v(str(entry.name))}${entry.scheduled ? " (scheduled)" : ""}` };
    case "snapshots.delete": return { parts: t`deleted snapshot ${v(str(entry.name))}`, tone: "warning" };
    case "snapshots.prune": return { parts: [`removed ${count(list(entry.names).length, "old scheduled snapshot")}`] };
    case "snapshots.restore": {
      const result = outcome(entry);
      return { parts: t`restored ${v(slash(entry.path))} from ${v(str(entry.snapshot))}${str(entry.restoredTo) ? t` as ${v(slash(entry.restoredTo))}` : []}${result.parts}`, tone: result.tone };
    }
    case "snapshots.download": return { parts: t`downloaded ${v(slash(entry.path))} from ${v(str(entry.snapshot))}` };
    case "snapshots.schedule": return { parts: ["changed the snapshot schedule"] };
    case "snapshots.access": return { parts: ["changed who can see snapshots"] };
    case "audit.rotated": return { parts: [`started a new audit log file${Array.isArray(entry.removed) ? `, removing ${count(entry.removed.length, "old file")}` : ""}`] };
    case "audit.dropped": return { parts: [`couldn't record ${count(typeof entry.count === "number" ? entry.count : 0, "event")} during a flood of activity`], tone: "warning" };
    default: return { parts: [v(entry.event)] };
  }
}

// The deepest folder all of these share: what an upload went into.
function sharedFolder(folders: string[]) {
  const [first = [], ...others] = folders.map((folder) => folder.split("/").filter(Boolean));
  let length = first.length;
  for (const parts of others) {
    let index = 0;
    while (index < length && parts[index] === first[index]) index += 1;
    length = index;
  }
  return first.slice(0, length).join("/");
}

/**
 * Folds each upload (its files' entries, and the folders it made, all sharing a batch id) into one
 * entry with the totals, for the Activity view; entries arrive newest first, and a batch split across
 * pages simply shows once per page.
 */
export function groupUploads<T extends Entry>(entries: T[]): T[] {
  const grouped: T[] = [];
  const batches = new Map<string, { entry: T; files: number; bytes: number; folders: number; directories: string[] }>();
  for (const entry of entries) {
    const batch = typeof entry.batch === "string" ? entry.batch : "";
    const isUpload = entry.event === "fs.upload" || (entry.event === "fs.create" && entry.upload === true);
    if (!batch || !isUpload) {
      grouped.push(entry);
      continue;
    }
    const key = `${String(entry.username ?? "")}|${batch}`;
    let group = batches.get(key);
    if (!group) {
      group = { entry: { ...entry, event: "fs.upload" }, files: 0, bytes: 0, folders: 0, directories: [] };
      batches.set(key, group);
      grouped.push(group.entry);
    }
    if (entry.event === "fs.upload") {
      group.files += Array.isArray(entry.files) ? entry.files.length : 0;
      group.bytes += typeof entry.bytes === "number" ? entry.bytes : 0;
      group.directories.push(str(entry.directory));
    } else {
      group.folders += 1;
      group.directories.push(str(entry.path));
    }
    Object.assign(group.entry, { directory: sharedFolder(group.directories), fileCount: group.files, bytes: group.bytes, foldersMade: group.folders, grouped: true });
  }
  return grouped;
}

/** What happened, in words ("moved 3 items to /Media"), with any long detail on a second line. */
export function describeActivity(entry: Entry): ActivityText {
  const described = describe(entry);
  return { ...described, text: described.parts.map((part) => (typeof part === "string" ? part : part.value)).join("") };
}
