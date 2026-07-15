# FilesDude

FilesDude is a secure, self-hosted web file manager designed for a Proxmox host, VM, or LXC container. It exposes one explicitly configured filesystem root and keeps every browser operation inside that boundary.

## What is included

- Browse folders in list or grid view, including an optional hidden-files view
- Use a SharePoint-style row menu for preview, text editing, downloads, organization, administration, properties, and deletion
- Pin durable favourite folder locations to the sidebar from a folder menu, selection toolbar, or the current-location button
- Create files and folders; edit text/code files up to 2 MB; rename, copy, move, soft-delete, and permanently delete
- Multi-file drag-and-drop upload with collision-safe names and a configurable size limit
- Direct file downloads and ZIP downloads for folders
- Inline previews for text, code, JSON, images, PDF, audio, and video; media uses byte-range streaming
- POSIX `chmod` and numeric `chown` for one or many items
- Bulk rename with find/replace, regular expressions, prefix, suffix, sequential numbering, live conflict detection, and two-phase application
- Recursive filename search, disk usage, owner/group display, and symlink escape warnings
- Protected trash by default, persistent favourites, and a JSON Lines audit log inside the protected state directory
- Signed, expiring, HTTP-only, SameSite login sessions; scrypt password hashes; login throttling; same-origin mutation checks; and hardened response headers
- Account preferences for changing the username and password; credential changes invalidate other sessions
- Multi-selection toolbar actions, responsive UI, dark mode, keyboard shortcuts, and no external analytics or storage services

## Install on Proxmox with systemd

SSH into the Proxmox server, download the installer, and run it:

```bash
curl -fsSLo /tmp/filesdude-install.sh \
  https://raw.githubusercontent.com/JediBrooker/FilesDude/main/install.sh
sudo bash /tmp/filesdude-install.sh
```

The installer asks for the folder FilesDude may manage, the initial username and
password, and whether the service needs full root-level ownership management. It
then installs a checksum-verified Node.js 22 runtime when necessary, builds an
immutable release, writes a hardened systemd service, and starts FilesDude.

Open `http://<proxmox-ip>:3000`. Keep this address on a trusted LAN/VPN, or put
an HTTPS reverse proxy in front of it before allowing remote access.

Useful service commands:

```bash
systemctl status filesdude
journalctl -u filesdude -f
sudo filesdude-update
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
Enter the current password, then change the username, password, or both. The new
credentials are stored in the protected state directory and all other sessions
are invalidated. The current browser receives a fresh session automatically.

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
