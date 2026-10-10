"use client";

import { ArrowDownToLine, ChevronRight, CircleAlert, Copy, Download, Folder, FolderPlus, HardDriveDownload, KeyRound, LoaderCircle, Pencil, RefreshCw, Server, Settings2, ShieldAlert, ShieldCheck, Trash2, Upload, X } from "lucide-react";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { FileEntry, JobState } from "@/lib/types";
import { PIECES_ABOVE_BYTES, uploadInPieces } from "./upload-pieces";
import { CheckBox, copyText, downloadFrom, fileIcon, folderLabel, formatBytes, formatDate, FormField, itemCount, Modal, PreviewDialog, requestJson, uploadFile, type PreviewUrls } from "./file-manager";

// The owner's other servers (SFTP): setting them up, browsing them, and copying to and from them.

export type ServerConnection = { id: string; name: string; host: string; port: number; username: string; auth: "key" | "password"; root: string; hostKey?: string; publicKey?: string; hasSecret: boolean };
type RemoteEntry = { name: string; path: string; type: "file" | "directory" | "symlink" | "other"; size: number; modified: string; mode: string; uid: number; gid: number; mime: string };
type Listing = { root: string; path: string; entries: RemoteEntry[]; truncated: boolean };
type Notify = (message: string, tone?: "error") => void;
type RequestError = Error & { status?: number; code?: string; fingerprint?: string };

const q = encodeURIComponent;

// fetch with the fingerprint kept from an unconfirmed or changed host key.
async function testServer(id: string) {
  const response = await fetch("/api/connections", { method: "POST", headers: { "x-filedude-request": "1", "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ action: "test", id }) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `Request failed (${response.status})`), { status: response.status, code: data.code, fingerprint: data.fingerprint }) as RequestError;
  return data as { ok: boolean; root: string };
}

/** Adds or edits a server, then checks it works, asking the owner to confirm its fingerprint. */
export function ServerSettingsDialog({ connection, onClose, onSaved, onDeleted, notify }: { connection?: ServerConnection; onClose: () => void; onSaved: (connection: ServerConnection, open: boolean) => void; onDeleted: (id: string) => void; notify: Notify }) {
  const [form, setForm] = useState({ name: connection?.name ?? "", host: connection?.host ?? "", port: String(connection?.port ?? 22), username: connection?.username ?? "", root: connection?.root ?? "", password: "", privateKey: "", passphrase: "" });
  const [method, setMethod] = useState<"generated" | "password" | "pasted">(connection ? (connection.auth === "password" ? "password" : connection.publicKey ? "generated" : "pasted") : "generated");
  const [saved, setSaved] = useState<ServerConnection | null>(connection ?? null);
  const [step, setStep] = useState<"form" | "key" | "connecting" | "fingerprint">("form");
  const [fingerprint, setFingerprint] = useState<{ value: string; changed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });

  const connect = async (target: ServerConnection) => {
    setStep("connecting");
    setError("");
    try {
      await testServer(target.id);
      notify(`Connected to ${target.name}`);
      onSaved(target, true);
    } catch (caught) {
      const failure = caught as RequestError;
      if (failure.fingerprint) {
        setFingerprint({ value: failure.fingerprint, changed: failure.code === "HOST_KEY_CHANGED" });
        setStep("fingerprint");
      } else {
        setError(failure.message);
        setStep(target.publicKey && method === "generated" ? "key" : "form");
      }
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const body = {
        action: saved ? "update" : "create",
        id: saved?.id,
        name: form.name,
        host: form.host,
        port: form.port,
        username: form.username,
        root: form.root,
        auth: method === "password" ? "password" : "key",
        ...(method === "password" && form.password ? { password: form.password } : {}),
        ...(method === "pasted" && form.privateKey ? { privateKey: form.privateKey, passphrase: form.passphrase } : {}),
        // Switching an existing server to a generated key makes a new one.
        ...(method === "generated" && saved && !saved.publicKey ? { generateKey: true } : {}),
      };
      const { connection: result } = await requestJson<{ connection: ServerConnection }>("/api/connections", { method: "POST", body: JSON.stringify(body) });
      setSaved(result);
      onSaved(result, false);
      if (method === "generated" && result.publicKey && (!connection || !connection.publicKey || result.publicKey !== connection.publicKey)) setStep("key");
      else await connect(result);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const trust = async () => {
    if (!saved || !fingerprint) return;
    setBusy(true);
    try {
      const { connection: result } = await requestJson<{ connection: ServerConnection }>("/api/connections", { method: "POST", body: JSON.stringify({ action: "trust", id: saved.id, fingerprint: fingerprint.value }) });
      setSaved(result);
      await connect(result);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!saved) return;
    setBusy(true);
    try {
      await requestJson("/api/connections", { method: "POST", body: JSON.stringify({ action: "delete", id: saved.id }) });
      notify(`Removed ${saved.name}`);
      onDeleted(saved.id);
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  };

  const command = saved?.publicKey ? `mkdir -p ~/.ssh && echo '${saved.publicKey}' >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys` : "";
  return (
    <Modal title={connection ? `${connection.name} settings` : "Add a server"} subtitle="Connect to another computer over SFTP (the file transfer part of SSH)" icon={<Server size={19} />} onClose={onClose}>
      {step === "key" && saved?.publicKey ? (
        <div className="server-step">
          <div className="info-box"><KeyRound size={17} /> FilesDude made a key to sign in to {saved.host} with. Add its public half to <code>~/.ssh/authorized_keys</code> for <strong>{saved.username}</strong> on that server; the private half never leaves this server.</div>
          <label className="form-field"><span>Public key</span><textarea className="server-key" readOnly value={saved.publicKey} onFocus={(event) => event.currentTarget.select()} /></label>
          <label className="form-field"><span>Or run this on {saved.host} as {saved.username}</span><textarea className="server-key" readOnly value={command} onFocus={(event) => event.currentTarget.select()} /></label>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <div className="modal-actions"><button type="button" className="button secondary" onClick={() => void copyText(command).then((ok) => notify(ok ? "Command copied" : "Couldn't copy; select it instead", ok ? undefined : "error"))}><Copy size={15} /> Copy command</button><button type="button" className="button primary" onClick={() => void connect(saved)}>I&apos;ve added it · Connect</button></div>
        </div>
      ) : step === "connecting" ? (
        <div className="storage-scan-state"><LoaderCircle className="spin" size={25} /><strong>Connecting to {saved?.host}…</strong></div>
      ) : step === "fingerprint" && fingerprint && saved ? (
        <div className="server-step">
          <div className={fingerprint.changed ? "warning-box danger" : "info-box"}>{fingerprint.changed ? <ShieldAlert size={17} /> : <ShieldCheck size={17} />} {fingerprint.changed
            ? <span><strong>{saved.host}&apos;s identity has changed.</strong> If it was reinstalled or its SSH keys replaced, confirm the new fingerprint. Otherwise don&apos;t: someone could be intercepting the connection.</span>
            : <span>This is the first connection to <strong>{saved.host}</strong>. Check the fingerprint below is that server&apos;s (on it, run <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>), then confirm it. FilesDude refuses to connect if it ever changes.</span>}</div>
          <code className="server-fingerprint">{fingerprint.value}</code>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className={`button ${fingerprint.changed ? "danger" : "primary"}`} disabled={busy} onClick={() => void trust()}>{busy && <LoaderCircle className="spin" size={16} />}{fingerprint.changed ? "Trust the new key" : "It matches · Connect"}</button></div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="field-pair"><FormField label="Name"><input value={form.name} onChange={set("name")} placeholder="Backup NAS" required maxLength={64} /></FormField><FormField label="Username"><input value={form.username} onChange={set("username")} placeholder="backup" required autoCapitalize="off" spellCheck={false} /></FormField></div>
          <div className="field-pair"><FormField label="Host"><input value={form.host} onChange={set("host")} placeholder="192.168.0.20 or nas.local" required autoCapitalize="off" spellCheck={false} /></FormField><FormField label="Port"><input value={form.port} onChange={set("port")} inputMode="numeric" /></FormField></div>
          <div className="server-methods" role="radiogroup" aria-label="Sign in with">
            {([["generated", "A key FilesDude makes", "Recommended: only the public key leaves this server"], ["password", "Password", "The account's password"], ["pasted", "My private key", "Paste a private key (OpenSSH or PEM)"]] as const).map(([value, label, hint]) => (
              <button key={value} type="button" role="radio" aria-checked={method === value} className={method === value ? "active" : ""} onClick={() => setMethod(value)}><strong>{label}</strong><span>{hint}</span></button>
            ))}
          </div>
          {method === "password" && <FormField label="Password" hint={connection?.auth === "password" ? "Leave empty to keep the saved password" : undefined}><input type="password" value={form.password} onChange={set("password")} autoComplete="off" required={connection?.auth !== "password"} /></FormField>}
          {method === "pasted" && <>
            <FormField label="Private key" hint={connection && !connection.publicKey && connection.auth === "key" ? "Leave empty to keep the saved key" : undefined}><textarea className="server-key" value={form.privateKey} onChange={set("privateKey")} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} /></FormField>
            <FormField label="Passphrase (if the key has one)"><input type="password" value={form.passphrase} onChange={set("passphrase")} autoComplete="off" /></FormField>
          </>}
          <FormField label="Starting folder" hint="A full path such as /srv/backups, or empty for the account's home folder. Browsing stays inside it."><input value={form.root} onChange={set("root")} placeholder="/home/backup" spellCheck={false} /></FormField>
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          {confirmDelete ? (
            <div className="modal-actions"><span className="server-delete-note">Remove {connection?.name}? Nothing on the server is changed.</span><button type="button" className="button secondary" onClick={() => setConfirmDelete(false)}>Keep</button><button type="button" className="button danger" disabled={busy} onClick={() => void remove()}>Remove</button></div>
          ) : (
            <div className="modal-actions">{connection && <button type="button" className="button secondary server-remove" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Remove</button>}<button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}{connection ? "Save and connect" : "Add and connect"}</button></div>
          )}
        </form>
      )}
    </Modal>
  );
}

const remoteFileEntry = (entry: RemoteEntry): FileEntry => ({ name: entry.name, path: entry.path, type: entry.type === "directory" ? "directory" : entry.type === "symlink" ? "symlink" : "file", size: entry.size, modified: entry.modified, created: entry.modified, mode: entry.mode, uid: entry.uid, gid: entry.gid, owner: String(entry.uid), group: String(entry.gid), mime: entry.mime, hidden: entry.name.startsWith(".") });

const trail = (folder: string) => folder.split("/").filter(Boolean);

/** Browses one of the owner's servers: open, preview, download, upload, organise, and copy into FilesDude. */
export function RemoteBrowserDialog({ connection, localFolder, inPieces, onClose, onEdit, onJob, notify }: { connection: ServerConnection; localFolder: string; inPieces: boolean; onClose: () => void; onEdit: () => void; onJob: (job: JobState) => Promise<boolean>; notify: Notify }) {
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<{ message: string; fingerprint?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [naming, setNaming] = useState<{ kind: "mkdir" | "rename"; entry?: RemoteEntry; value: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState("");
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    try {
      const result = await requestJson<Listing>(`/api/remote?id=${q(connection.id)}&path=${q(target)}`);
      setListing(result);
      setFolder(result.path);
      setSelected(new Set());
      setError(null);
    } catch (caught) {
      setError({ message: (caught as Error).message });
    } finally {
      setLoading(false);
    }
  }, [connection.id]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(""), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const entries = [...(listing?.entries ?? [])].sort((a, b) => (a.type === "directory") !== (b.type === "directory") ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const chosen = entries.filter((entry) => selected.has(entry.path));
  const files = entries.filter((entry) => entry.type === "file").map(remoteFileEntry);
  const urls: PreviewUrls = (entry) => ({ stream: `/api/remote/file?id=${q(connection.id)}&path=${q(entry.path)}`, download: `/api/remote/file?id=${q(connection.id)}&path=${q(entry.path)}&download=1` });

  const act = async (label: string, run: () => Promise<void>) => {
    setBusy(label);
    try {
      await run();
    } catch (caught) {
      notify((caught as Error).message, "error");
    } finally {
      setBusy("");
    }
  };

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    if (!naming) return;
    void act(naming.kind === "mkdir" ? "Creating…" : "Renaming…", async () => {
      await requestJson("/api/remote", { method: "POST", body: JSON.stringify(naming.kind === "mkdir" ? { action: "mkdir", id: connection.id, path: folder, name: naming.value } : { action: "rename", id: connection.id, path: naming.entry!.path, name: naming.value }) });
      setNaming(null);
      await load(folder);
    });
  };

  const upload = (list: FileList | null) => {
    const picked = Array.from(list ?? []);
    if (uploadRef.current) uploadRef.current.value = "";
    if (!picked.length) return;
    void act("Uploading…", async () => {
      const controller = new AbortController();
      for (const [index, file] of picked.entries()) {
        const label = `Uploading ${index + 1} of ${picked.length}: ${file.name}`;
        setBusy(label);
        // Large files go in pieces (unless the owner turned that off), so they get through proxies.
        if (inPieces && file.size > PIECES_ABOVE_BYTES) await uploadInPieces({ base: "/api/remote/file/pieces", query: `id=${q(connection.id)}&path=${q(folder)}` }, file, (sent) => setBusy(`${label} · ${formatBytes(sent)} of ${formatBytes(file.size)}`), controller.signal);
        else await uploadFile(`/api/remote/file?id=${q(connection.id)}&path=${q(folder)}`, file, () => undefined, controller.signal);
      }
      notify(`${itemCount(picked.length).replace("item", "file")} uploaded to ${connection.name}`);
      await load(folder);
    });
  };

  const remove = () => void act("Deleting…", async () => {
    const { removed } = await requestJson<{ removed: number }>("/api/remote", { method: "POST", body: JSON.stringify({ action: "delete", id: connection.id, paths: chosen.map((entry) => entry.path) }) });
    setConfirmDelete(false);
    notify(`Deleted ${itemCount(removed)} from ${connection.name}`);
    await load(folder);
  });

  const copyHere = () => void act("Starting the copy…", async () => {
    const { job } = await requestJson<{ job: JobState }>("/api/remote", { method: "POST", body: JSON.stringify({ action: "copyFrom", id: connection.id, paths: chosen.map((entry) => entry.path), destination: localFolder }) });
    await onJob(job);
    setSelected(new Set());
    notify(`Copying ${itemCount(chosen.length)} to ${folderLabel(localFolder)}`);
  });

  const allSelected = entries.length > 0 && chosen.length === entries.length;
  return (
    <Modal title={connection.name} subtitle={`${connection.username}@${connection.host}${connection.port === 22 ? "" : `:${connection.port}`}${listing ? ` · ${listing.root}` : ""}`} icon={<Server size={19} />} onClose={onClose} wide>
      <div className="storage-browser remote-browser">
        <div className="remote-toolbar">
          <nav className="remote-trail" aria-label="Folder on the server">
            <button type="button" onClick={() => void load("")}><Server size={14} /> {connection.name}</button>
            {trail(folder).map((part, index, parts) => <span key={index}><ChevronRight size={13} /><button type="button" onClick={() => void load(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}
          </nav>
          <div className="remote-actions">
            <button type="button" className="icon-button" title="Refresh" aria-label="Refresh" onClick={() => void load(folder)}><RefreshCw size={15} className={loading ? "spin" : ""} /></button>
            <button type="button" className="icon-button" title="Server settings" aria-label="Server settings" onClick={onEdit}><Settings2 size={15} /></button>
            <button type="button" className="button secondary" disabled={!!busy || !!error} onClick={() => setNaming({ kind: "mkdir", value: "" })}><FolderPlus size={15} /> New folder</button>
            <button type="button" className="button secondary" disabled={!!busy || !!error} onClick={() => uploadRef.current?.click()}><Upload size={15} /> Upload</button>
            <input ref={uploadRef} className="visually-hidden" type="file" multiple onChange={(event) => upload(event.target.files)} />
          </div>
        </div>
        {chosen.length > 0 && (
          <div className="storage-selection-bar"><div><span>{chosen.length}</span><strong>{chosen.length === 1 ? "item" : "items"} selected</strong></div><div>
            <button className="button primary" disabled={!!busy} onClick={copyHere} title={`Copy into ${folderLabel(localFolder)} on FilesDude`}><HardDriveDownload size={15} /> Copy to {folderLabel(localFolder)}</button>
            {chosen.length === 1 && chosen[0].type === "file" && <button className="button secondary" onClick={() => downloadFrom(urls(remoteFileEntry(chosen[0])).download)}><Download size={15} /> Download</button>}
            {chosen.length === 1 && <button className="button secondary" disabled={!!busy} onClick={() => setNaming({ kind: "rename", entry: chosen[0], value: chosen[0].name })}><Pencil size={15} /> Rename</button>}
            <button className="button danger" disabled={!!busy} onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Delete</button>
          </div></div>
        )}
        {naming && <form className="remote-naming" onSubmit={submitName}><span>{naming.kind === "mkdir" ? "New folder" : `Rename ${naming.entry?.name}`}</span><input autoFocus value={naming.value} onChange={(event) => setNaming({ ...naming, value: event.target.value })} placeholder="Name" /><button className="button primary" disabled={!naming.value.trim() || !!busy}>{naming.kind === "mkdir" ? "Create" : "Rename"}</button><button type="button" className="icon-button" aria-label="Cancel" onClick={() => setNaming(null)}><X size={15} /></button></form>}
        {confirmDelete && <div className="storage-delete-confirm" role="alert"><div><Trash2 size={19} /><span><strong>Delete {itemCount(chosen.length)} from {connection.name}?</strong><small>Folders are deleted with everything in them. The server has no trash, so this can&apos;t be undone.</small></span></div><div><button className="button secondary" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="button danger" disabled={!!busy} onClick={remove}>Delete forever</button></div></div>}
        {busy && <p className="checksum-note"><LoaderCircle className="spin" size={14} /> {busy}</p>}
        {error ? <div className="storage-scan-state error"><CircleAlert size={25} /><strong>Couldn&apos;t open {connection.name}</strong><span>{error.message}</span><div className="remote-error-actions"><button className="button secondary" onClick={() => void load(folder)}>Try again</button><button className="button secondary" onClick={onEdit}>Settings</button></div></div>
          : !listing ? <div className="storage-scan-state"><LoaderCircle className="spin" size={25} /><strong>Connecting to {connection.host}…</strong></div>
          : (
            <div className="remote-table" role="table" aria-label={`Contents of ${folder || connection.name}`}>
              <div className="remote-row remote-header" role="row"><div role="columnheader"><CheckBox checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.path)))} label="Select everything" /></div><div role="columnheader">Name</div><div role="columnheader">Size</div><div role="columnheader">Modified</div><div role="columnheader">Mode</div></div>
              {entries.map((entry) => (
                <div key={entry.path} className={`remote-row ${selected.has(entry.path) ? "selected" : ""}`} role="row">
                  <div role="cell"><CheckBox checked={selected.has(entry.path)} onChange={() => setSelected((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })} label={`Select ${entry.name}`} /></div>
                  <div className="remote-name" role="cell"><span className={`file-icon ${entry.type === "directory" ? "directory" : ""}`}>{entry.type === "directory" ? <Folder size={17} /> : fileIcon(remoteFileEntry(entry), 17)}</span><button type="button" className="file-name" disabled={entry.type === "symlink" || entry.type === "other"} onClick={() => (entry.type === "directory" ? void load(entry.path) : setPreview(remoteFileEntry(entry)))}>{entry.name}</button>{entry.type === "symlink" && <small>link</small>}</div>
                  <div className="muted" role="cell">{entry.type === "file" ? formatBytes(entry.size) : "—"}</div>
                  <div className="muted" role="cell">{formatDate(entry.modified)}</div>
                  <div role="cell"><code className="mode-chip">{entry.mode}</code></div>
                </div>
              ))}
              {!entries.length && <div className="storage-no-results"><Folder size={23} /><strong>This folder is empty</strong><span>Upload files or create a folder here.</span></div>}
            </div>
          )}
        <div className="storage-scan-foot"><span className="muted">{listing?.truncated ? "Showing the first 10,000 items. " : ""}Copies into FilesDude go to {folderLabel(localFolder)}; open another folder there first to copy somewhere else.</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
      {preview && <PreviewDialog key={preview.path} entry={preview} siblings={files} urls={urls} onStep={setPreview} onClose={() => setPreview(null)} />}
    </Modal>
  );
}

/** Copies items selected in FilesDude into a folder chosen on one of the owner's servers. */
export function CopyToServerDialog({ entries, connections, onClose, onJob, notify }: { entries: FileEntry[]; connections: ServerConnection[]; onClose: () => void; onJob: (job: JobState) => Promise<boolean>; notify: Notify }) {
  const [id, setId] = useState(connections[0]?.id ?? "");
  const [folder, setFolder] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const connection = connections.find((item) => item.id === id);

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    requestJson<Listing>(`/api/remote?id=${q(id)}&path=${q(folder)}`, { signal: controller.signal })
      .then((result) => { setListing(result); setError(""); })
      .catch((caught: Error) => { if (caught.name !== "AbortError") { setListing(null); setError(caught.message); } });
    return () => controller.abort();
  }, [id, folder]);

  const start = async () => {
    setBusy(true);
    try {
      const { job } = await requestJson<{ job: JobState }>("/api/remote", { method: "POST", body: JSON.stringify({ action: "copyTo", id, paths: entries.map((entry) => entry.path), destination: folder }) });
      await onJob(job);
      notify(`Copying ${itemCount(entries.length)} to ${connection?.name}`);
      onClose();
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  };

  const folders = (listing?.entries ?? []).filter((entry) => entry.type === "directory").sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <Modal title={`Copy ${itemCount(entries.length)} to a server`} subtitle="Choose a server and the folder to copy into" icon={<ArrowDownToLine size={19} style={{ transform: "rotate(180deg)" }} />} onClose={onClose}>
      <div className="copy-to-server">
        <FormField label="Server"><select value={id} onChange={(event) => { setId(event.target.value); setFolder(""); setListing(null); }}>{connections.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.host})</option>)}</select></FormField>
        <nav className="remote-trail" aria-label="Folder on the server"><button type="button" onClick={() => setFolder("")}><Server size={14} /> {connection?.name}</button>{trail(folder).map((part, index, parts) => <span key={index}><ChevronRight size={13} /><button type="button" onClick={() => setFolder(parts.slice(0, index + 1).join("/"))}>{part}</button></span>)}</nav>
        <div className="copy-folder-list">
          {!listing && !error && <p className="checksum-note"><LoaderCircle className="spin" size={14} /> Connecting…</p>}
          {listing && folders.map((entry) => <button key={entry.path} type="button" onClick={() => setFolder(entry.path)}><Folder size={15} /> {entry.name}</button>)}
          {listing && !folders.length && <p className="checksum-note">No folders inside this one.</p>}
        </div>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button primary" disabled={busy || !listing} onClick={() => void start()}>{busy && <LoaderCircle className="spin" size={16} />}Copy into {folder ? `/${folder.split("/").at(-1)}` : "the starting folder"}</button></div>
      </div>
    </Modal>
  );
}
