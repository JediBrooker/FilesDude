# FilesDude

FilesDude is a secure, self-hosted web file manager designed for a Proxmox host, VM, or LXC container. It exposes one explicitly configured filesystem root and keeps every browser operation inside that boundary.

## What is included

- Browse folders in list or grid view, including an optional hidden-files view; the browser's own back/forward buttons and gestures step through folder history instead of leaving the app
- Use a SharePoint-style row menu for preview, text editing, downloads, organization, administration, properties, and deletion
- Pin durable favourite folder locations to the sidebar from a folder menu, selection toolbar, or the current-location button
- Create files and folders; edit text/code files up to 2 MB; rename, copy, move, soft-delete, and permanently delete, with a breadcrumb folder browser and autofill suggestions for picking a copy/move destination
- Multi-file drag-and-drop upload with collision-safe names, a configurable size limit, and owner/group confirmation based on the destination folder and its existing contents
- Direct file downloads and ZIP downloads for folders
- Inline previews for text, code, JSON, images, PDF, audio, and video; media uses byte-range streaming
- POSIX `chmod` and numeric `chown` for one or many items
- Bulk rename with find/replace, regular expressions, prefix, suffix, sequential numbering, live conflict detection, and two-phase application
- Recursive filename search, disk usage, owner/group display, symlink escape warnings, and a cached whole-tree largest-files view from the clickable Storage card
- Filter largest files by a minimum size, load 100, 250, or 500 more at a time, export the currently loaded results to CSV, and move one or many selected files to protected trash (or permanently delete them after confirmation)
- Protected trash by default, persistent favourites, and a JSON Lines audit log inside the protected state directory
- Signed, expiring, HTTP-only, SameSite login sessions; scrypt password hashes; login throttling; same-origin mutation checks; and hardened response headers
- Account preferences for changing the username and password; credential changes invalidate other sessions
- Multi-selection toolbar actions, responsive UI, dark mode, keyboard shortcuts, and no external analytics or storage services

## Install on Proxmox with systemd

This GitHub repository is currently private. SSH into the Proxmox server,
authenticate GitHub CLI once, and run the installer without exposing the token
in the downloaded file or Git remote:

```bash
sudo apt update && sudo apt install -y gh
gh auth login
gh api -H "Accept: application/vnd.github.raw+json" \
  "/repos/JediBrooker/FilesDude/contents/install.sh?ref=main" \
  | sudo GITHUB_TOKEN="$(gh auth token)" bash
```

The token only needs read access to this repository. It is used for that run and
is not stored by FilesDude. If you later make the repository public, the shorter
installer works without GitHub authentication:

```bash
curl -fsSLo /tmp/filesdude-install.sh \
  https://raw.githubusercontent.com/JediBrooker/FilesDude/main/install.sh
sudo bash /tmp/filesdude-install.sh
```

The installer asks for the folder FilesDude may manage, the initial username and
password, and whether the service needs full root-level ownership management. It
then installs a checksum-verified Node.js 22 runtime when necessary, builds an
immutable release, writes a hardened systemd service, and starts FilesDude.

The installer binds to `127.0.0.1:3000` by default. Put an HTTPS reverse proxy
on the same host in front of it, or reach it through an SSH tunnel or VPN. To
bind directly to a trusted LAN, explicitly pass `--bind 0.0.0.0`; plain HTTP
exposes passwords and session cookies to anyone able to observe that network.
Loopback installs trust the local proxy's forwarded HTTPS headers so browser
sessions receive the `Secure` cookie attribute.

Useful service commands:

```bash
systemctl status filesdude
journalctl -u filesdude -f
sudo filesdude-update
```

For updates while the repository remains private, pass a fresh token from your
GitHub CLI login:

```bash
sudo GITHUB_TOKEN="$(gh auth token)" filesdude-update
```

To recover a forgotten login, generate a new bootstrap login and invalidate all
sessions:

```bash
sudo filesdude-update --reset-credentials
```

Re-running the updater preserves the managed root, favourites, account settings,
audit log, and other state in `/var/lib/filesdude`.

## Change the username or password

Open the account area at the bottom-left of FilesDude and choose **Preferences**.
From there you can:

- Change the username, password, or both. The current password is only required
  for account changes; other sessions are invalidated when credentials change.
- Select the default upload ownership: match the destination folder, keep the
  FilesDude service account, or use a fixed system owner and group.

Before every upload, FilesDude shows the saved default alongside owner/group
pairs detected from the destination folder and its existing contents. Applying
ownership other than the service identity requires the systemd service to run
as root; the installer offers this mode when full ownership administration is
needed.

## Find and cull large files

Click the **Storage** card in the sidebar to scan the entire configured root.
Set a minimum size in GB, choose whether each page loads 100, 250, or 500 files,
and use **Show more** until the required results are visible. **Export CSV**
exports every currently loaded row, including its path, exact byte count,
owner, group, and modified time.

Use the row checkboxes (or the header checkbox for all loaded rows) to select
files for bulk deletion. Deletion uses FilesDude's protected trash unless you
explicitly enable permanent deletion in the confirmation panel.

## Manual development setup

FilesDude deliberately refuses to sign users in until a password hash and a strong session secret are configured.

1. Install Node.js 22 or newer and dependencies:

   ```bash
   npm ci
   ```

2. Generate a password hash. This keeps the plain password out of `.env`:

   ```bash
   FILEDUDE_PASSWORD='use-a-long-unique-password' npm run password
   ```

3. Copy the example configuration. The password command prints a ready-to-paste,
   single-quoted `FILEDUDE_PASSWORD_HASH=...` line; the quotes prevent Docker
   Compose from interpreting the hash's dollar signs.

   ```bash
   cp .env.example .env
   openssl rand -base64 48
   ```

   Put the random output in `FILEDUDE_SESSION_SECRET`. Set `FILEDUDE_ROOT` to the only directory the app should expose.

4. Start locally:

   ```bash
   npm run dev
   ```

   Open `http://localhost:3000`.

## Alternative Docker Compose deployment

Set the host directory in `.env`:

```dotenv
FILEDUDE_HOST_ROOT=/mnt/pve/storage
```

Then start the service:

```bash
docker compose up -d --build
```

The default Compose file only binds FilesDude to `127.0.0.1:3000`. Put Caddy, Nginx Proxy Manager, Traefik, Tailscale Serve, or another trusted reverse proxy in front of it and use HTTPS. A Caddy example is in `deploy/Caddyfile.example`.

The container runs as UID/GID `1001:1001` by default. Give that account access to the mounted files. If FilesDude must change arbitrary ownership or administer files that this UID cannot access, set `user: "0:0"` for the service. That is powerful: use a narrowly scoped mount, never mount `/`, and restrict network access to your VPN or trusted LAN.

## Recommended deployment rules

- Expose only the smallest useful root, such as `/mnt/pve/media`; never expose the Proxmox host root.
- Prefer a dedicated unprivileged LXC or VM and bind-mount the managed storage into it.
- Use HTTPS even on a LAN. For remote access, prefer WireGuard or Tailscale over directly exposing the login page to the internet.
- Keep `FILEDUDE_TRUST_PROXY=true` only when the app is behind a trusted proxy that replaces forwarded headers. The systemd installer defaults it to `false` for direct LAN access.
- Back up the underlying data independently. Protected trash helps with mistakes but is not a backup.
- Keep Proxmox, the container image, and reverse proxy patched. Rotate the session secret to invalidate all sessions.

## Useful keyboard shortcuts

- `Command/Ctrl + K`: focus search
- `F2`: rename the selected item
- `Space`: preview the selected file
- `Delete`: delete selected items

## Good next features

The safest default set is already included. These are strong next additions when you need them:

- OIDC or WebAuthn/passkeys for multi-user sign-in and two-factor authentication
- Role-based roots and read-only accounts instead of one server administrator
- Restore and retention management UI for protected trash
- Archive creation/extraction with path-traversal scanning
- Content search, thumbnails, checksums, duplicate detection, and media metadata
- Antivirus scanning and upload quarantine for environments with untrusted uploaders
- ZFS snapshot shortcuts and a version-history browser for Proxmox storage
- Background jobs with progress for very large copies, moves, uploads, and archives
- SFTP/SMB/NFS connection profiles for managing remote roots without mounting them into the app container

## Development checks

```bash
npm test
npm run lint
npm run build
```
