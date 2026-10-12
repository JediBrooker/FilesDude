import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";
import { AppError } from "./http";
import { addressGroup } from "./address-group";

// Messages to the owner's phone or chat when something worth knowing happens: files arriving through
// upload links, signs of someone trying to get in, changes to sign-in security, sign-ins (if wanted),
// and the disk filling up. Sent to ntfy, Discord, Slack, or any webhook, from what the audit log
// records. The settings (including the address, which for Discord and Slack is itself a secret) are
// readable only by this service, and the browser is never sent the ntfy token.

export type NotificationKind = "ntfy" | "discord" | "slack" | "webhook";
export type NotificationTopic = "uploads" | "security" | "signIns" | "storage";
export const NOTIFICATION_TOPICS: NotificationTopic[] = ["uploads", "security", "signIns", "storage"];

type StoredSettings = { kind: NotificationKind | null; url: string; token: string; topics: Record<NotificationTopic, boolean> };
export type NotificationSettings = Omit<StoredSettings, "token"> & { hasToken: boolean };

const DEFAULT_TOPICS: Record<NotificationTopic, boolean> = { uploads: true, security: true, signIns: false, storage: true };
const defaults: StoredSettings = { kind: null, url: "", token: "", topics: DEFAULT_TOPICS };
// No more than so many messages an hour, so a flood of events can't flood the owner's phone. What
// strangers can set off (failed sign-ins, wrong link passwords, files through upload links) has its
// own smaller allowance, so it can never use up the room for changes made by signed-in accounts,
// sign-ins, and storage alerts.
const MAX_PER_HOUR = { public: 10, account: 30 };
type Budget = keyof typeof MAX_PER_HOUR;
const SEND_TIMEOUT_MS = 10_000;

const settingsFile = () => path.join(config.stateDir, "notifications.json");
let cache: { settings: StoredSettings; mtimeMs: number } | null = null;

async function readSettings(): Promise<StoredSettings> {
  try {
    const stat = await fs.stat(settingsFile());
    if (cache && cache.mtimeMs === stat.mtimeMs) return cache.settings;
    const value = JSON.parse(await fs.readFile(settingsFile(), "utf8")) as Partial<StoredSettings>;
    const settings: StoredSettings = {
      kind: value.kind === "ntfy" || value.kind === "discord" || value.kind === "slack" || value.kind === "webhook" ? value.kind : null,
      url: typeof value.url === "string" ? value.url : "",
      token: typeof value.token === "string" ? value.token : "",
      topics: Object.fromEntries(NOTIFICATION_TOPICS.map((topic) => [topic, typeof value.topics?.[topic] === "boolean" ? value.topics[topic] : DEFAULT_TOPICS[topic]])) as Record<NotificationTopic, boolean>,
    };
    cache = { settings, mtimeMs: stat.mtimeMs };
    return settings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaults;
    console.error("Notification settings could not be read", error);
    return defaults;
  }
}

const toPublic = ({ token, ...settings }: StoredSettings): NotificationSettings => ({ ...settings, hasToken: Boolean(token) });

export async function getNotificationSettings() {
  return toPublic(await readSettings());
}

// ntfy users often give just their topic's name (as its apps do), or the address without https://.
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

function checkUrl(value: unknown, kind: NotificationKind) {
  if (typeof value !== "string" || value.length > 2048) throw new AppError("Enter the address to send notifications to", 400, "INVALID_URL");
  let text = value.trim();
  if (kind === "ntfy" && NTFY_TOPIC.test(text)) text = `https://ntfy.sh/${text}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && /^[\w.-]+\.[a-z]{2,}(:\d+)?\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AppError("That isn't a valid address", 400, "INVALID_URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError("Notifications go to an http:// or https:// address", 400, "INVALID_URL");
  if (url.username || url.password) throw new AppError("Leave the user name and password out of the address; for ntfy, use an access token", 400, "INVALID_URL");
  return url.toString();
}

/** Saves the owner's notification settings; an omitted token keeps the saved one, "" removes it. */
export async function saveNotificationSettings(input: { kind?: unknown; url?: unknown; token?: unknown; topics?: unknown }) {
  const current = await readSettings();
  const kind = input.kind === null || input.kind === "off" ? null : input.kind;
  if (kind !== null && kind !== "ntfy" && kind !== "discord" && kind !== "slack" && kind !== "webhook") throw new AppError("Choose where to send notifications", 400, "INVALID_KIND");
  const url = kind === null ? "" : checkUrl(input.url, kind);
  if (input.token !== undefined && (typeof input.token !== "string" || input.token.length > 512)) throw new AppError("The access token is invalid", 400, "INVALID_TOKEN");
  // A saved token is only kept for the same server, so it's never sent somewhere new.
  const sameServer = Boolean(current.url) && kind === current.kind && new URL(url).origin === new URL(current.url).origin;
  const token = kind === "ntfy" ? (input.token === undefined ? (sameServer ? current.token : "") : String(input.token).trim()) : "";
  const requested = input.topics && typeof input.topics === "object" ? input.topics as Record<string, unknown> : {};
  const topics = Object.fromEntries(NOTIFICATION_TOPICS.map((topic) => [topic, typeof requested[topic] === "boolean" ? requested[topic] : current.topics[topic]])) as Record<NotificationTopic, boolean>;
  const settings: StoredSettings = { kind, url, token, topics };
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `notifications-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, settingsFile());
  cache = null;
  return toPublic(settings);
}

// --- Sending ---

export type Notification = { topic: NotificationTopic; title: string; message: string; urgent?: boolean; budget?: Budget };

const sentTimes: Record<Budget, number[]> = { public: [], account: [] };
const droppedSinceLimit: Record<Budget, number> = { public: 0, account: 0 };
const scrubAddresses = (text: string) => text.replace(/https?:\/\/\S+/g, "the address");
// Text from strangers may hold web addresses; they're broken up (with an invisible space) so chat and
// notification apps don't make them links: "://", "www.", and bare domains like example.com.
const unlink = (text: string) => text
  .replace(/:\/\//g, ":\u200b//")
  .replace(/\bwww\./gi, (match) => `${match.slice(0, 3)}\u200b.`)
  .replace(/\b([a-z0-9-]+)\.([a-z]{2,})\b/gi, "$1.\u200b$2");

// Names and other text from users are shown as text, not formatting or mentions, in chat apps.
const escapeSlack = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeDiscord = (text: string) => text.replace(/([\\*_~`|>#\[\]()@-])/g, "\\$1");

function request(settings: StoredSettings, note: Notification): { body: string; headers: Record<string, string> } {
  switch (settings.kind) {
    case "ntfy":
      return {
        body: unlink(note.message),
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          // ntfy takes the title from a header, which must be plain ASCII.
          Title: note.title.replace(/[^\x20-\x7e]/g, "?").slice(0, 200),
          Tags: note.urgent ? "warning" : "file_folder",
          Priority: note.urgent ? "high" : "default",
          ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
        },
      };
    case "discord":
      // flags 4: no link previews.
      return { body: JSON.stringify({ content: `**${escapeDiscord(unlink(note.title))}**\n${escapeDiscord(unlink(note.message))}`.slice(0, 2000), allowed_mentions: { parse: [] }, flags: 4 }), headers: { "Content-Type": "application/json" } };
    case "slack":
      return { body: JSON.stringify({ text: `*${escapeSlack(unlink(note.title))}*\n${escapeSlack(unlink(note.message))}`, unfurl_links: false, unfurl_media: false }), headers: { "Content-Type": "application/json" } };
    default:
      return { body: JSON.stringify({ source: "filesdude", topic: note.topic, title: note.title, message: note.message, urgent: Boolean(note.urgent), at: new Date().toISOString() }), headers: { "Content-Type": "application/json" } };
  }
}

async function deliver(settings: StoredSettings, note: Notification) {
  const { body, headers } = request(settings, note);
  const response = await fetch(settings.url, { method: "POST", body, headers, redirect: "error", signal: AbortSignal.timeout(SEND_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`The notification service answered ${response.status}`);
  await response.body?.cancel().catch(() => undefined);
}

/** Sends a notification if notifications are on for its topic, within the hourly limit. Never throws. */
export async function notify(note: Notification) {
  try {
    const settings = await readSettings();
    if (!settings.kind || !settings.url || !settings.topics[note.topic]) return;
    const budget = note.budget ?? "account";
    const times = sentTimes[budget];
    const now = Date.now();
    while (times.length && now - times[0] > 3_600_000) times.shift();
    if (times.length >= MAX_PER_HOUR[budget]) {
      droppedSinceLimit[budget] += 1;
      return;
    }
    times.push(now);
    if (droppedSinceLimit[budget]) {
      const dropped = droppedSinceLimit[budget];
      droppedSinceLimit[budget] = 0;
      note = { ...note, message: `${note.message}\n\n(${dropped} earlier ${dropped === 1 ? "notification like this wasn't" : "notifications like this weren't"} sent: too many in an hour. See Activity.)` };
    }
    await deliver(settings, note);
  } catch (error) {
    console.error("A notification could not be sent:", scrubAddresses((error as Error).message));
  }
}

/** Sends a test message with the given settings (or the saved ones), reporting any failure. */
export async function sendTestNotification() {
  const settings = await readSettings();
  if (!settings.kind || !settings.url) throw new AppError("Turn notifications on first", 400, "NOT_CONFIGURED");
  try {
    await deliver(settings, { topic: "security", title: "FilesDude test", message: "Notifications from FilesDude are working." });
  } catch (error) {
    const message = (error as Error).name === "TimeoutError" ? "The notification service didn't answer in time" : scrubAddresses((error as Error).message);
    throw new AppError(`The test notification wasn't delivered: ${message}`, 502, "NOTIFICATION_FAILED");
  }
}

// --- From the audit log ---

const str = (value: unknown) => (typeof value === "string" ? value : "");
const formatBytes = (bytes: number) => {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};

// Files arriving through one link close together are told as one message: within two minutes, or
// fifteen if the link was told about in the last half hour, so one link can't send many messages.
const UPLOAD_GATHER_MS = 2 * 60_000;
const BUSY_LINK_GATHER_MS = 15 * 60_000;
const arriving = new Map<string, { path: string; files: string[]; bytes: number; from: Set<string>; timer: NodeJS.Timeout }>();
const lastUploadNote = new Map<string, number>();

function gatherUpload(details: Record<string, unknown>) {
  const id = str(details.id);
  let batch = arriving.get(id);
  if (!batch) {
    const recently = Date.now() - (lastUploadNote.get(id) ?? 0) < 30 * 60_000;
    batch = { path: str(details.path), files: [], bytes: 0, from: new Set(), timer: setTimeout(() => sendUploads(id), recently ? BUSY_LINK_GATHER_MS : UPLOAD_GATHER_MS) };
    batch.timer.unref?.();
    arriving.set(id, batch);
  }
  if (batch.files.length < 1_000) batch.files.push(str(details.name));
  batch.bytes += typeof details.bytes === "number" ? details.bytes : 0;
  if (str(details.from) && batch.from.size < 10) batch.from.add(str(details.from));
}

function sendUploads(id: string) {
  const batch = arriving.get(id);
  arriving.delete(id);
  if (!batch) return;
  if (lastUploadNote.size > 1_000) lastUploadNote.clear();
  lastUploadNote.set(id, Date.now());
  const count = batch.files.length;
  const who = batch.from.size ? ` from ${[...batch.from].join(", ")}` : "";
  const names = batch.files.slice(0, 5).join(", ") + (count > 5 ? `, and ${count - 5} more` : "");
  void notify({ topic: "uploads", budget: "public", title: `${count} ${count === 1 ? "file" : "files"} received`, message: `${names} (${formatBytes(batch.bytes)}) arrived in /${batch.path} through an upload link${who}.` });
}

// Failed sign-ins are told once an address (an IPv6 /64 counts as one) has failed five times in 15
// minutes: the first straight away, and any more in the next 15 minutes as one summary.
const FAILURE_WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; resetAt: number; told: boolean }>();
const failureSummary: { until: number; addresses: Set<string>; timer: NodeJS.Timeout | null } = { until: 0, addresses: new Set(), timer: null };

function sendFailureSummary() {
  failureSummary.timer = null;
  const addresses = [...failureSummary.addresses];
  failureSummary.addresses.clear();
  if (!addresses.length) return;
  failureSummary.until = Date.now() + FAILURE_WINDOW_MS;
  failureSummary.timer = setTimeout(sendFailureSummary, FAILURE_WINDOW_MS);
  failureSummary.timer.unref?.();
  void notify({ topic: "security", budget: "public", urgent: true, title: "More failed sign-ins", message: `${addresses.length} more ${addresses.length === 1 ? "address has" : "addresses have"} failed to sign in 5 times in 15 minutes: ${addresses.slice(0, 5).join(", ")}${addresses.length > 5 ? `, and ${addresses.length - 5} more` : ""}. See Activity.` });
}

function countFailure(address: string, what: string) {
  const now = Date.now();
  const group = address ? addressGroup(address) : "an unknown address";
  if (failures.size > 5_000) for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
  let entry = failures.get(group);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + FAILURE_WINDOW_MS, told: false };
    failures.set(group, entry);
  }
  entry.count += 1;
  if (entry.count < 5 || entry.told) return;
  entry.told = true;
  if (now < failureSummary.until) {
    if (failureSummary.addresses.size < 1_000) failureSummary.addresses.add(group);
    return;
  }
  failureSummary.until = now + FAILURE_WINDOW_MS;
  if (!failureSummary.timer) {
    failureSummary.timer = setTimeout(sendFailureSummary, FAILURE_WINDOW_MS);
    failureSummary.timer.unref?.();
  }
  void notify({ topic: "security", budget: "public", urgent: true, title: "Repeated failed sign-ins", message: `${group} has ${what} 5 times in 15 minutes. Sign-ins from it are now paused for a while.` });
}

/** Turns what the audit log records into notifications. Called for every entry written. */
export function notifyFromAudit(event: string, details: Record<string, unknown>) {
  const who = str(details.username);
  switch (event) {
    case "share.upload":
      gatherUpload(details);
      return;
    case "share.unlock_locked":
      void notify({ topic: "security", budget: "public", urgent: true, title: "A link was closed", message: `So many wrong passwords were tried for the link to /${str(details.path)} that it's closed for 15 minutes (last from ${str(details.address) || "an unknown address"}).` });
      return;
    case "login.failed":
      countFailure(str(details.client), "failed to sign in");
      return;
    case "login.two_factor.failed":
      countFailure(str(details.client), "entered a wrong two-factor code");
      return;
    case "login.succeeded":
      void notify({ topic: "signIns", title: `${who} signed in`, message: `${who} signed in${details.method === "passkey" ? " with a passkey" : details.twoFactor ? " with two-factor" : ""} from ${str(details.client) || "an unknown address"}.` });
      return;
    case "settings.password.changed":
      void notify({ topic: "security", title: "A password was changed", message: `${who} changed their password.` });
      return;
    case "settings.preferences.updated":
      if (details.passwordChanged || (str(details.previousUsername) && details.previousUsername !== details.username)) void notify({ topic: "security", title: "The owner's sign-in was changed", message: `The owner account's ${details.passwordChanged ? "password" : "username"} was changed.` });
      return;
    case "settings.two_factor.disabled":
      void notify({ topic: "security", urgent: true, title: "Two-factor sign-in turned off", message: `${who} turned off two-factor sign-in.` });
      return;
    case "settings.stay_signed_in":
      if (details.on && !details.thisDeviceOnly) void notify({ topic: "security", title: "Staying signed in was turned on", message: `${who} turned on staying signed in (from ${str(details.client) || "an unknown address"}): their devices now stay signed in until they sign out.` });
      if (!details.on) void notify({ topic: "security", title: "Staying signed in was turned off", message: `${who} turned off staying signed in (from ${str(details.client) || "an unknown address"}), signing out their other devices.` });
      return;
    case "logout.others":
      void notify({ topic: "security", title: "Other devices were signed out", message: `${who} signed out their other devices (from ${str(details.client) || "an unknown address"}).` });
      return;
    case "settings.passkey.added":
      void notify({ topic: "security", title: "A passkey was added", message: `${who} added the passkey "${str(details.passkey)}".` });
      return;
    case "users.create":
      void notify({ topic: "security", title: "An account was added", message: `${str(details.account)} (${str(details.role)}) was added by ${who}.` });
      return;
    case "users.delete":
      void notify({ topic: "security", title: "An account was removed", message: `${str(details.account)} was removed by ${who}.` });
      return;
    default:
  }
}

// --- Storage ---

const LOW_SPACE = 0.1;
const RECOVERED_SPACE = 0.12;
let lowSpaceTold = false;

/** Tells the owner once when free space falls below 10%, and again only after it has recovered. */
export async function checkFreeSpace() {
  const stat = await fs.statfs(config.root).catch(() => null);
  if (!stat || !Number(stat.blocks)) return;
  const free = Number(stat.bavail) / Number(stat.blocks);
  if (free >= RECOVERED_SPACE) lowSpaceTold = false;
  if (free >= LOW_SPACE || lowSpaceTold) return;
  lowSpaceTold = true;
  await notify({ topic: "storage", urgent: true, title: "The disk is nearly full", message: `Only ${(free * 100).toFixed(1)}% (${formatBytes(Number(stat.bavail) * Number(stat.bsize))}) of the disk FilesDude manages is free.` });
}

let spaceTimer: NodeJS.Timeout | null = null;

/** Checks free space every hour (from when the service starts). */
export function startFreeSpaceChecks() {
  if (spaceTimer) return;
  void checkFreeSpace();
  spaceTimer = setInterval(() => void checkFreeSpace(), 3_600_000);
  spaceTimer.unref();
}

/** For tests: sends gathered uploads now and forgets counts. */
export function flushNotificationsForTests() {
  for (const [id, batch] of arriving) {
    clearTimeout(batch.timer);
    sendUploads(id);
  }
  failures.clear();
  if (failureSummary.timer) clearTimeout(failureSummary.timer);
  Object.assign(failureSummary, { until: 0, timer: null });
  failureSummary.addresses.clear();
  lastUploadNote.clear();
  sentTimes.public.length = 0;
  sentTimes.account.length = 0;
  droppedSinceLimit.public = 0;
  droppedSinceLimit.account = 0;
  lowSpaceTold = false;
  cache = null;
}
