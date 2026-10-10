import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";
import { generateKeyPair } from "../../lib/connections";

// An SFTP server that answers however a test says, to check FilesDude copes with hostile servers:
// listings that never end, files bigger than they claim, and requests it never answers.

const { Server, utils } = ssh2;
const { STATUS_CODE } = utils.sftp;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;

export const dirAttrs = () => ({ mode: S_IFDIR | 0o755, uid: 0, gid: 0, size: 4096, atime: 0, mtime: 0 });
export const fileAttrs = (size: number) => ({ mode: S_IFREG | 0o644, uid: 0, gid: 0, size, atime: 0, mtime: 0 });

type Attrs = ReturnType<typeof dirAttrs>;
export type Scenario = {
  realpath?: (requested: string) => string | "hang";
  stat: (requested: string) => Attrs | null;
  /** Entries for the nth READDIR of the nth OPENDIR of a path; null ends the listing; "hang" never answers. */
  readdir: (requested: string, call: number, opened: number) => Array<{ filename: string; attrs: Attrs }> | null | "hang";
  read: (requested: string, offset: number, length: number) => Buffer | null | "hang";
};

export async function startHostileServer(scenario: Scenario) {
  const hostKey = { private: generateKeyPair("test host").privateKey };
  const opened = new Map<string, number>();
  const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
    client.on("authentication", (context) => (context.method === "password" ? context.accept() : context.reject(["password"])));
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<number, { path: string; calls: number; opened: number }>();
          let next = 0;
          const handleFor = (value: { path: string; calls: number; opened: number }) => {
            const id = next++;
            handles.set(id, value);
            const buffer = Buffer.alloc(4);
            buffer.writeUInt32BE(id);
            return buffer;
          };
          const lookup = (buffer: Buffer) => handles.get(buffer.readUInt32BE(0))!;
          sftp.on("REALPATH", (reqid, requested) => {
            const resolved = scenario.realpath ? scenario.realpath(requested) : "/";
            if (resolved !== "hang") sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: {} as never }]);
          });
          const stat = (reqid: number, requested: string) => {
            const attrs = scenario.stat(requested);
            if (attrs) sftp.attrs(reqid, attrs);
            else sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE);
          };
          sftp.on("STAT", stat);
          sftp.on("LSTAT", stat);
          sftp.on("OPENDIR", (reqid, requested) => {
            const count = (opened.get(requested) ?? 0) + 1;
            opened.set(requested, count);
            sftp.handle(reqid, handleFor({ path: requested, calls: 0, opened: count }));
          });
          sftp.on("READDIR", (reqid, buffer) => {
            const entry = lookup(buffer);
            const result = scenario.readdir(entry.path, entry.calls++, entry.opened);
            if (result === "hang") return;
            if (!result) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.name(reqid, result.map((item) => ({ ...item, longname: item.filename })));
          });
          sftp.on("OPEN", (reqid, requested) => sftp.handle(reqid, handleFor({ path: requested, calls: 0, opened: 0 })));
          sftp.on("READ", (reqid, buffer, offset, length) => {
            const result = scenario.read(lookup(buffer).path, offset, length);
            if (result === "hang") return;
            if (!result) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.data(reqid, result);
          });
          sftp.on("FSTAT", (reqid, buffer) => stat(reqid, lookup(buffer).path));
          sftp.on("CLOSE", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
          for (const event of ["WRITE", "SETSTAT", "FSETSTAT", "MKDIR", "RMDIR", "REMOVE", "RENAME"] as const) sftp.on(event as "MKDIR", (reqid: number) => sftp.status(reqid, STATUS_CODE.OK));
        });
      });
    });
    client.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
