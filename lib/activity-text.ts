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

export function activityCategory(event: string): ActivityCategory {
  if (event === "fs.download" || event === "snapshots.download" || event === "share.download") return "downloads";
  if (event.startsWith("login.") || event === "logout") return "sign-ins";
  if (event.startsWith("share.")) return "sharing";
  if (event.startsWith("users.") || event.startsWith("settings.")) return "accounts";
  if (event.startsWith("snapshots.")) return "snapshots";
  return "files";
}

export type ActivityText = { text: string; detail?: string; tone?: "danger" | "warning" };
type Entry = { event: string; [key: string]: unknown };

/** Who did it: the account, "share link" for downloads through a link, or "system" for upkeep. */
export function activityUser(entry: Entry) {
  if (entry.event === "share.download") return "share link";
  if (entry.event.startsWith("login.")) return typeof entry.username === "string" ? entry.username : "";
  return typeof entry.username === "string" ? entry.username : "system";
}

const str = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const slash = (value: unknown) => `/${str(value)}`;
const count = (value: number, noun: string) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;

// "/a/b.txt" for one path, "3 items" for several; the detail line lists them.
function items(paths: string[], fallback?: unknown) {
  if (paths.length === 1) return slash(paths[0]);
  if (!paths.length && typeof fallback === "string") return slash(fallback);
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
function outcome(entry: Entry): Pick<ActivityText, "tone"> & { suffix: string } {
  if (entry.status === "failed") return { tone: "danger", suffix: ` (failed${str(entry.error) ? `: ${str(entry.error)}` : ""})` };
  if (entry.status === "cancelled") return { tone: "warning", suffix: " (cancelled)" };
  return { suffix: "" };
}

/** What happened, in words: "moved 3 items to /Media", with any long detail on a second line. */
export function describeActivity(entry: Entry): ActivityText {
  const paths = list(entry.paths);
  switch (entry.event) {
    case "login.succeeded": return { text: entry.twoFactor ? "signed in with two-factor" : "signed in", detail: str(entry.client) || undefined };
    case "login.failed": return { text: `failed to sign in${str(entry.username) ? ` as “${str(entry.username)}”` : ""}`, detail: str(entry.client) || undefined, tone: "danger" };
    case "login.two_factor.challenged": return { text: "entered their password and was asked for a code", detail: str(entry.client) || undefined };
    case "login.two_factor.failed": return { text: "entered a wrong two-factor code", detail: str(entry.client) || undefined, tone: "danger" };
    case "logout": return { text: "signed out" };
    case "fs.upload": {
      const files = Array.isArray(entry.files) ? entry.files.length : 0;
      const size = typeof entry.bytes === "number" ? ` (${formatSize(entry.bytes)})` : "";
      return { text: `uploaded ${count(files, "file")}${size} to ${slash(entry.directory)}` };
    }
    case "fs.download": return typeof entry.items === "number"
      ? { text: `downloaded ${count(entry.items, "item")} as a ZIP`, detail: pathDetail(paths) }
      : { text: `downloaded ${slash(entry.path)}` };
    case "fs.create": return { text: `created ${slash([str(entry.path), str(entry.name)].filter(Boolean).join("/"))}` };
    case "fs.rename": return { text: `renamed ${slash(entry.path)}${str(entry.name) ? ` to “${str(entry.name)}”` : ""}` };
    case "fs.write": return { text: `edited ${slash(entry.path)}` };
    case "fs.delete": return { text: `${entry.permanent ? "permanently deleted" : "moved to the trash"} ${items(paths)}`, detail: pathDetail(paths), tone: entry.permanent ? "warning" : undefined };
    case "fs.copy":
    case "fs.move": {
      const result = outcome(entry);
      return { text: `${entry.event === "fs.move" ? "moved" : "copied"} ${items(paths)} to ${slash(entry.destination)}${result.suffix}`, detail: pathDetail(paths), tone: result.tone };
    }
    case "fs.chmod": return { text: `changed permissions of ${items(paths)}${str(entry.mode) ? ` to ${str(entry.mode)}` : ""}`, detail: pathDetail(paths) };
    case "fs.chown": return { text: `changed the owner of ${items(paths)}${typeof entry.uid === "number" ? ` to ${entry.uid}:${entry.gid}` : ""}`, detail: pathDetail(paths) };
    case "fs.bulkRename": return { text: `renamed ${items(paths)} at once`, detail: pathDetail(paths) };
    case "fs.compress": {
      const result = outcome(entry);
      return { text: `compressed ${items(paths)}${str(entry.result) ? ` into ${slash(entry.result)}` : ""}${result.suffix}`, detail: pathDetail(paths), tone: result.tone };
    }
    case "fs.extract": {
      const result = outcome(entry);
      return { text: `extracted ${slash(entry.path)}${str(entry.result) ? ` into ${slash(entry.result)}` : ""}${result.suffix}`, tone: result.tone };
    }
    case "trash.restore": return { text: `restored ${count(list(entry.ids).length || 1, "item")} from the trash` };
    case "trash.delete": return { text: `deleted ${count(list(entry.ids).length || 1, "item")} from the trash forever`, tone: "warning" };
    case "trash.empty": return { text: `emptied the trash${typeof entry.removed === "number" ? ` (${count(entry.removed, "item")})` : ""}`, tone: "warning" };
    case "trash.purge": return { text: `removed ${count(typeof entry.removed === "number" ? entry.removed : 0, "old item")} from the trash${typeof entry.retentionDays === "number" ? ` (kept ${entry.retentionDays} days)` : ""}` };
    case "duplicates.scan": return { text: `looked for duplicates in ${slash(entry.path)}` };
    case "duplicates.trash": return { text: `moved ${items(paths)} duplicates to the trash`, detail: pathDetail(paths) };
    case "duplicates.link": return { text: `replaced ${count(Array.isArray(entry.linked) ? entry.linked.length : 0, "duplicate")} with hard links` };
    case "share.create": return { text: `shared ${slash(entry.path)}${str(entry.expiresAt) ? `, until ${new Date(str(entry.expiresAt)).toLocaleString()}` : ""}` };
    case "share.revoke": return { text: entry.reason === "item deleted" ? `revoked ${count(list(entry.ids).length, "share link")} for deleted items` : "revoked a share link" };
    case "share.download": return { text: `downloaded ${slash(entry.path)}`, detail: str(entry.address) || undefined };
    case "users.create": return { text: `added ${str(entry.role) === "viewer" ? "viewer" : "editor"} “${str(entry.account)}” with ${slash(entry.root)}` };
    case "users.update": return { text: `changed “${str(entry.account)}” (${str(entry.role)}, ${slash(entry.root)})${entry.passwordReset ? " and reset their password" : ""}` };
    case "users.delete": return { text: `removed the account “${str(entry.account)}”`, tone: "warning" };
    case "users.two_factor_reset": return { text: `turned off two-factor for “${str(entry.account)}”`, tone: "warning" };
    case "settings.password.changed": return { text: "changed their password" };
    case "settings.credentials.failed": return { text: "entered a wrong current password in preferences", tone: "danger" };
    case "settings.preferences.updated": return { text: str(entry.previousUsername) && entry.previousUsername !== entry.username ? `renamed their account from “${str(entry.previousUsername)}”` : "updated their preferences" };
    case "settings.two_factor.enabled": return { text: "turned on two-factor sign-in" };
    case "settings.two_factor.disabled": return { text: "turned off two-factor sign-in", tone: "warning" };
    case "settings.two_factor.recovery_codes": return { text: "made new recovery codes" };
    case "settings.two_factor.failed": return { text: "entered a wrong two-factor code in preferences", tone: "danger" };
    case "snapshots.create": return { text: `took snapshot ${str(entry.name)}${entry.scheduled ? " (scheduled)" : ""}` };
    case "snapshots.delete": return { text: `deleted snapshot ${str(entry.name)}`, tone: "warning" };
    case "snapshots.prune": return { text: `removed ${count(list(entry.names).length, "old scheduled snapshot")}` };
    case "snapshots.restore": {
      const result = outcome(entry);
      return { text: `restored ${slash(entry.path)} from ${str(entry.snapshot)}${str(entry.restoredTo) ? ` as ${slash(entry.restoredTo)}` : ""}${result.suffix}`, tone: result.tone };
    }
    case "snapshots.download": return { text: `downloaded ${slash(entry.path)} from ${str(entry.snapshot)}` };
    case "snapshots.schedule": return { text: "changed the snapshot schedule" };
    case "snapshots.access": return { text: "changed who can see snapshots" };
    default: return { text: entry.event };
  }
}
