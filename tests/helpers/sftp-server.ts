import { constants } from "node:fs";
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import path from "node:path";
import ssh2, { type Attributes, type FileEntry } from "ssh2";
import { generateKeyPair } from "../../lib/connections";

const { Server, utils } = ssh2;
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

/**
 * A small SFTP server for tests, serving `root` as "/" (paths can't leave it). It accepts the given
 * password, or any of the given public keys.
 */
export async function startSftpServer(root: string, auth: { username: string; password?: string; publicKeys?: string[] }, port = 0) {
  const pair = generateKeyPair("test host");
  const hostKey = { private: pair.privateKey, public: pair.publicKey };
  const allowed = (auth.publicKeys ?? []).map((key) => utils.parseKey(key)).filter((key): key is ReturnType<typeof utils.parseKey> & { getPublicSSH(): Buffer; verify(data: Buffer, signature: Buffer, hash?: string): boolean } => !(key instanceof Error) && !Array.isArray(key));
  const local = (requested: string) => {
    const resolved = path.posix.normalize(path.posix.join("/", requested));
    return path.join(root, resolved);
  };
  const attributes = (stat: import("node:fs").Stats): Attributes => ({ mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) });

  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (context) => {
      if (context.username !== auth.username) return context.reject();
      if (context.method === "password" && auth.password && context.password === auth.password) return context.accept();
      if (context.method === "publickey") {
        const match = allowed.find((key) => key.getPublicSSH().equals(context.key.data));
        if (match && (!context.signature || match.verify(context.blob!, context.signature, context.hashAlgo))) return context.accept();
      }
      context.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { kind: "file"; handle: fs.FileHandle } | { kind: "dir"; location: string; listed: boolean }>();
          let next = 0;
          const handleFor = (value: object) => {
            const id = next++;
            handles.set(id, value as never);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(id);
            return buffer;
          };
          const lookup = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0));
          const fail = (reqid: number, error: NodeJS.ErrnoException) => sftp.status(reqid, error.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : error.code === "EACCES" || error.code === "EPERM" ? STATUS_CODE.PERMISSION_DENIED : STATUS_CODE.FAILURE, error.message);
          sftp.on("REALPATH", (reqid, requested) => {
            const resolved = path.posix.normalize(path.posix.join("/", requested === "." ? "/" : requested));
            sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as Attributes }]);
          });
          sftp.on("STAT", (reqid, requested) => { fs.stat(local(requested)).then((stat) => sftp.attrs(reqid, attributes(stat)), (error) => fail(reqid, error)); });
          sftp.on("LSTAT", (reqid, requested) => { fs.lstat(local(requested)).then((stat) => sftp.attrs(reqid, attributes(stat)), (error) => fail(reqid, error)); });
          sftp.on("OPENDIR", (reqid, requested) => {
            fs.stat(local(requested)).then((stat) => (stat.isDirectory() ? sftp.handle(reqid, handleFor({ kind: "dir", location: local(requested), listed: false })) : sftp.status(reqid, STATUS_CODE.FAILURE)), (error) => fail(reqid, error));
          });
          sftp.on("READDIR", async (reqid, buffer) => {
            const entry = lookup(buffer);
            if (!entry || entry.kind !== "dir") return sftp.status(reqid, STATUS_CODE.FAILURE);
            if (entry.listed) return sftp.status(reqid, STATUS_CODE.EOF);
            entry.listed = true;
            const names: FileEntry[] = [];
            for (const name of await fs.readdir(entry.location)) {
              const stat = await fs.lstat(path.join(entry.location, name));
              names.push({ filename: name, longname: name, attrs: attributes(stat) });
            }
            sftp.name(reqid, names);
          });
          sftp.on("OPEN", (reqid, requested, flags) => {
            let mode = constants.O_RDONLY;
            if (flags & OPEN_MODE.WRITE) mode = flags & OPEN_MODE.READ ? constants.O_RDWR : constants.O_WRONLY;
            if (flags & OPEN_MODE.CREAT) mode |= constants.O_CREAT;
            if (flags & OPEN_MODE.EXCL) mode |= constants.O_EXCL;
            if (flags & OPEN_MODE.TRUNC) mode |= constants.O_TRUNC;
            if (flags & OPEN_MODE.APPEND) mode |= constants.O_APPEND;
            fs.open(local(requested), mode, 0o644).then((handle) => sftp.handle(reqid, handleFor({ kind: "file", handle })), (error) => fail(reqid, error));
          });
          sftp.on("READ", async (reqid, buffer, offset, length) => {
            const entry = lookup(buffer);
            if (!entry || entry.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            const data = Buffer.alloc(length);
            const { bytesRead } = await entry.handle.read(data, 0, length, offset);
            if (!bytesRead) sftp.status(reqid, STATUS_CODE.EOF);
            else sftp.data(reqid, data.subarray(0, bytesRead));
          });
          sftp.on("WRITE", async (reqid, buffer, offset, data) => {
            const entry = lookup(buffer);
            if (!entry || entry.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            await entry.handle.write(data, 0, data.length, offset);
            sftp.status(reqid, STATUS_CODE.OK);
          });
          sftp.on("FSTAT", async (reqid, buffer) => {
            const entry = lookup(buffer);
            if (!entry || entry.kind !== "file") return sftp.status(reqid, STATUS_CODE.FAILURE);
            sftp.attrs(reqid, attributes(await entry.handle.stat()));
          });
          sftp.on("CLOSE", async (reqid, buffer) => {
            const entry = lookup(buffer);
            handles.delete(buffer.readUInt32BE(0));
            if (entry?.kind === "file") await entry.handle.close();
            sftp.status(reqid, STATUS_CODE.OK);
          });
          // Only a size change (truncation) is acted on; the rest is accepted and ignored.
          sftp.on("SETSTAT", (reqid, requested, attrs) => {
            if (typeof attrs.size !== "number") return sftp.status(reqid, STATUS_CODE.OK);
            fs.truncate(local(requested), attrs.size).then(() => sftp.status(reqid, STATUS_CODE.OK), (error) => fail(reqid, error));
          });
          sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          sftp.on("MKDIR", (reqid, requested) => { fs.mkdir(local(requested)).then(() => sftp.status(reqid, STATUS_CODE.OK), (error) => fail(reqid, error)); });
          sftp.on("RMDIR", (reqid, requested) => { fs.rmdir(local(requested)).then(() => sftp.status(reqid, STATUS_CODE.OK), (error) => fail(reqid, error)); });
          sftp.on("REMOVE", (reqid, requested) => { fs.unlink(local(requested)).then(() => sftp.status(reqid, STATUS_CODE.OK), (error) => fail(reqid, error)); });
          sftp.on("RENAME", (reqid, from, to) => {
            fs.lstat(local(to)).then(() => sftp.status(reqid, STATUS_CODE.FAILURE, "exists"), () => fs.rename(local(from), local(to)).then(() => sftp.status(reqid, STATUS_CODE.OK), (error) => fail(reqid, error)));
          });
        });
      });
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, hostKey: hostKey.public, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
