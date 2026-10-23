import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { MOUNT_DIR } from "../lib/media-sandbox";
import { HELPER, helperEnvironment } from "./helpers/sandbox";

// The media sandbox in the Docker image (sandbox-helper.py --container): what each run would get. The
// runs themselves are checked in the image, by docker/smoke-test.sh.

type ContainerRun = { program: string; args: string[]; limits: Record<string, number>; denied: string[] };

const containerRun = (request: object) => JSON.parse(execFileSync("python3", ["-I", HELPER, "--print-container", JSON.stringify(request)], { env: helperEnvironment() }).toString()) as ContainerRun;

test("runs only the three tools, from the sandbox's own root, with the arguments as given", () => {
  assert.equal(containerRun({ tool: "ffmpeg", args: [] }).program, "/usr/bin/ffmpeg");
  assert.equal(containerRun({ tool: "ffprobe", args: [] }).program, "/usr/bin/ffprobe");
  // Where image-resize.ts expects Node.js and sharp, as in the systemd sandbox.
  assert.equal(containerRun({ tool: "node", args: [] }).program, `${MOUNT_DIR}/node`);
  assert.deepEqual(containerRun({ tool: "ffprobe", args: ["-v", "error", "fd:"] }).args, ["-v", "error", "fd:"]);
  for (const request of [{ tool: "sh", args: [] }, { tool: "/usr/bin/ffmpeg", args: [] }, { tool: "ffmpeg", args: "-version" }, { tool: "ffmpeg", args: [1] }]) {
    assert.throws(() => execFileSync("python3", ["-I", HELPER, "--print-container", JSON.stringify(request)], { stdio: "ignore", env: helperEnvironment() }), JSON.stringify(request));
  }
});

test("limits each run's memory, tasks, files, and CPU time, and lets only a playable copy write a file", () => {
  const { limits } = containerRun({ tool: "ffmpeg", args: [], seconds: 20 });
  assert.equal(limits.RLIMIT_DATA, 512 * 1024 * 1024);
  assert.equal(limits.RLIMIT_NPROC, 64);
  assert.equal(limits.RLIMIT_NOFILE, 256);
  assert.equal(limits.RLIMIT_CORE, 0);
  assert.ok(limits.RLIMIT_CPU >= 40 && limits.RLIMIT_CPU <= 60);
  assert.equal(limits.RLIMIT_FSIZE, 0);
  assert.equal(containerRun({ tool: "ffmpeg", args: [], fileOutput: 5000 }).limits.RLIMIT_FSIZE, 5000);
  // Time limits are capped like the systemd sandbox's.
  assert.ok(containerRun({ tool: "ffmpeg", args: [], seconds: 1e9 }).limits.RLIMIT_CPU <= 2 * 600 + 10);
});

test("refuses sockets, new processes, io_uring, namespaces, mounts, tracing, shared memory, and System V IPC", () => {
  const { denied } = containerRun({ tool: "ffmpeg", args: [] });
  for (const call of ["socket", "socketpair", "connect", "sendmsg", "fork", "vfork", "io_uring_setup", "unshare", "setns", "mount", "chroot", "ptrace", "process_vm_readv", "bpf", "userfaultfd", "keyctl", "memfd_create", "shmget", "mq_open", "inotify_init1", "getsockname"]) {
    assert.ok(denied.includes(call), call);
  }
  assert.ok(!denied.includes("fallocate") && !denied.includes("ftruncate"));
  // Node.js only gets to ask what its standard input and output are; a playable copy can't reserve or resize.
  assert.ok(!containerRun({ tool: "node", args: [], inspectSockets: true }).denied.includes("getsockname"));
  const copy = containerRun({ tool: "ffmpeg", args: [], fileOutput: 5000 }).denied;
  assert.ok(copy.includes("fallocate") && copy.includes("ftruncate"));
});
