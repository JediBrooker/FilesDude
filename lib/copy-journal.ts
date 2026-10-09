import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// Copies in progress, so placeholders left by a restart part-way through a copy can be removed when
// the service starts again. Each entry names the placeholder's folder (by real path), its name, and
// the identity of the item this service created there.
export interface CopyJournalEntry {
  id: string;
  directory: string;
  name: string;
  identity: string;
  startedAt: string;
}

let mutationQueue: Promise<void> = Promise.resolve();

function journalFile() {
  return path.join(config.stateDir, "copy-journal.json");
}

export async function readCopyJournal(): Promise<CopyJournalEntry[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(journalFile(), "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is CopyJournalEntry => typeof entry?.id === "string" && typeof entry.directory === "string" && typeof entry.name === "string" && typeof entry.identity === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("The copy journal could not be read", error);
    return [];
  }
}

async function writeCopyJournal(entries: CopyJournalEntry[]) {
  await fs.mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const temporary = path.join(config.stateDir, `copy-journal-${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(entries));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, journalFile());
}

function mutate(change: (entries: CopyJournalEntry[]) => CopyJournalEntry[]) {
  const run = async () => writeCopyJournal(change(await readCopyJournal()));
  const result = mutationQueue.then(run, run);
  mutationQueue = result.then(() => undefined, () => undefined);
  return result;
}

export function recordCopy(entry: CopyJournalEntry) {
  return mutate((entries) => [...entries, entry]);
}

export function forgetCopies(ids: string[]) {
  const forgotten = new Set(ids);
  return mutate((entries) => entries.filter((entry) => !forgotten.has(entry.id)));
}
