import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

// The log rotates at this size, keeping the current file and two older ones (audit.jsonl.1, .2).
export const MAX_AUDIT_BYTES = 8 * 1024 * 1024;
export const AUDIT_FILES = ["audit.jsonl", "audit.jsonl.1", "audit.jsonl.2"];

// Writes happen one at a time, so rotation never races an append.
let queue: Promise<void> = Promise.resolve();

async function write(event: string, details: Record<string, unknown>) {
  const directory = config.stateDir;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`;
  const current = path.join(directory, AUDIT_FILES[0]);
  const size = (await fs.stat(current).catch(() => null))?.size ?? 0;
  if (size > 0 && size + Buffer.byteLength(line) > MAX_AUDIT_BYTES) {
    for (let index = AUDIT_FILES.length - 1; index > 0; index -= 1) {
      await fs.rename(path.join(directory, AUDIT_FILES[index - 1]), path.join(directory, AUDIT_FILES[index])).catch(() => undefined);
    }
  }
  await fs.appendFile(current, line, { mode: 0o600 });
}

export async function audit(event: string, details: Record<string, unknown> = {}) {
  const run = queue.then(() => write(event, details));
  queue = run.catch(() => undefined);
  try {
    await run;
  } catch (error) {
    console.error("Unable to write audit event", error);
  }
}
