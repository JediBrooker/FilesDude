import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";

/** On a Linux host with systemd and Python, as root (like the deployed helper): the real sandbox. */
export const realSandbox = process.platform === "linux" && process.getuid?.() === 0 && existsSync("/usr/bin/systemd-run") && existsSync("/usr/bin/python3");

export const HELPER = path.join(process.cwd(), "scripts", "sandbox-helper.py");

/** An environment of just these values. */
export const environment = (values: Record<string, string>) => values as NodeJS.ProcessEnv;

/** The environment a helper runs with in tests: this Node.js and these packages, bound to no service. */
export function helperEnvironment(extra: Record<string, string> = {}) {
  return environment({
    PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
    FILEDUDE_SANDBOX_BIND: "",
    FILEDUDE_SANDBOX_NODE: realpathSync(process.execPath),
    FILEDUDE_SANDBOX_MODULES: realpathSync("node_modules"),
    ...extra,
  });
}

/** Starts a sandbox helper on its own socket; resolves with the socket and a way to stop it. */
export async function startSandboxHelper(extra: Record<string, string> = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "filesdude-helper-"));
  const socket = path.join(folder, "sandbox.sock");
  const child: ChildProcess = spawn("/usr/bin/python3", ["-I", HELPER, "--socket", socket], { stdio: ["ignore", "ignore", "inherit"], env: helperEnvironment(extra) });
  for (let tries = 0; tries < 100 && !existsSync(socket); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  if (!existsSync(socket)) throw new Error("The sandbox helper didn't start");
  return {
    socket,
    async stop() {
      child.kill("SIGKILL");
      await fs.rm(folder, { recursive: true, force: true });
    },
  };
}

/** Runs this file's tests with a sandbox helper that FilesDude reaches (where there can be one). */
export function sandboxHelperForThisFile() {
  if (!realSandbox) return;
  let helper: Awaited<ReturnType<typeof startSandboxHelper>> | undefined;
  before(async () => {
    helper = await startSandboxHelper();
    process.env.FILEDUDE_SANDBOX_SOCKET = helper.socket;
  });
  after(async () => {
    delete process.env.FILEDUDE_SANDBOX_SOCKET;
    await helper?.stop();
  });
}
