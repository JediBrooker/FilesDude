import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

export async function audit(event: string, details: Record<string, unknown> = {}) {
  try {
    const directory = config.stateDir;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...details });
    await fs.appendFile(path.join(directory, "audit.jsonl"), `${line}\n`, { mode: 0o600 });
  } catch (error) {
    console.error("Unable to write audit event", error);
  }
}
