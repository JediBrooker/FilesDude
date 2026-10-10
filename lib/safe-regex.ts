import { Worker } from "node:worker_threads";
import { AppError } from "./http";

// A regular expression an account typed (bulk rename) can take exponential time on a crafted name
// ("^(a+)+$" on 40 characters runs for hours), which on Node's one thread would stop the whole
// server. So it's applied in a separate thread, with a time and memory limit, and given up on if it
// takes too long.

const TIME_LIMIT_MS = 1_000;

const WORKER = `(() => {
  const { parentPort, workerData } = require("node:worker_threads");
  const { names, find, flags, replace } = workerData;
  let pattern;
  try {
    pattern = new RegExp(find, flags);
  } catch {
    parentPort.postMessage({ invalid: true });
    return;
  }
  parentPort.postMessage({ names: names.map((name) => name.replace(pattern, replace)) });
})();`;

/** Each name with every match of the pattern replaced, or an error if the pattern is invalid or too slow. */
export function replaceWithPattern(names: string[], find: string, flags: string, replace: string) {
  return new Promise<string[]>((resolve, reject) => {
    const worker = new Worker(WORKER, { eval: true, workerData: { names, find, flags, replace }, resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 } });
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      run();
    };
    const timer = setTimeout(() => finish(() => reject(new AppError("That pattern takes too long to apply; try a simpler one", 400, "REGEX_TOO_SLOW"))), TIME_LIMIT_MS);
    worker.once("message", (message: { invalid?: boolean; names?: string[] }) => finish(() => {
      if (message.invalid || !message.names) reject(new AppError("The bulk rename regular expression is invalid", 400, "INVALID_REGEX"));
      else resolve(message.names);
    }));
    worker.once("error", () => finish(() => reject(new AppError("That pattern couldn't be applied; try a simpler one", 400, "REGEX_FAILED"))));
    worker.once("exit", () => finish(() => reject(new AppError("That pattern couldn't be applied; try a simpler one", 400, "REGEX_FAILED"))));
  });
}
