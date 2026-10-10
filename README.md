# FilesDude

FilesDude File Explorer is a secure, self-hosted web file manager designed for a Proxmox host, VM, or LXC container. It exposes one explicitly configured filesystem root and keeps every browser operation inside that boundary.

## What is included

- Browse folders in list or grid view, sorted by name, size, owner, permissions, or modified time (folders stay first and the choice is remembered per browser), including an optional hidden-files view; the browser's own back/forward buttons and gestures step through folder history instead of leaving the app
- Use a SharePoint-style row menu, also available by right-clicking any item (or empty space for folder actions), for preview, text editing, downloads, organization, administration, properties, and deletion; with several items selected it acts on all of them
- Cut, copy, and paste items between folders, or drag them onto a folder, favourite, or breadcrumb to move them (hold Option/Alt to copy); copies into a folder that already has the name are saved as `name (copy)`
- Copies and moves run as background jobs with byte progress and cancel, so large copies don't hold up browsing or other work; a copy in progress shows as `name (copying)` and gets its real name once complete, a cancelled or failed copy is removed (as is one interrupted by a restart, the next time the service starts), and a move between filesystems removes only what it copied unchanged, with share links following the copies
- Undo the latest rename, move, copy, or delete from the confirmation toast or with `Command/Ctrl + Z`; deletes are undone by restoring from protected trash
- Pin durable favourite folder locations to the sidebar from a folder menu, selection toolbar, or the current-location button
- Create files and folders; edit text/code files up to 2 MB; rename, copy, move, soft-delete, and permanently delete, with a breadcrumb folder browser and autofill suggestions for picking a copy/move destination
- Upload whole folders, by dropping them or with the arrow on the Upload button, keeping their subfolders (empty ones too); each uploaded folder lands in a new folder ("Photos (1)" if "Photos" exists), and system clutter like `.DS_Store` is left out
- Multi-file drag-and-drop upload with live progress, transfer speed, time remaining, and cancel (cancelled or interrupted files are discarded and can be resumed), collision-safe names, a configurable size limit, and owner/group confirmation based on the destination folder and its existing contents
- Direct file downloads and ZIP downloads for folders; select several items (from one folder or from search results) to download them together as one ZIP
- Share links: let anyone with a private link download a file (or a folder as a ZIP) without signing in, for 1 hour to 30 days and optionally a limited number of downloads; links can be revoked at any time, follow renames and moves, and every download is audited
- Compress selected items into `.zip` or `.tar.gz` and extract `.zip`, `.tar`, `.tar.gz`, and `.tgz` archives into a new folder, as background jobs with progress and cancel; extraction refuses archives with absolute or `..` paths, never creates links or devices, and stops before filling the disk
- Inline previews for text, code, JSON, images, PDF, audio, and video; media uses byte-range streaming. Videos offer subtitles in the player's CC menu: subtitle files beside them (`Movie.srt`, `Movie.en.vtt`) and text subtitle tracks inside them (extracted once by ffmpeg in the media sandbox and kept). Step through a folder's files with the arrow keys, the on-screen arrows, or a swipe on touch screens; neighbouring photos load ahead
- Image thumbnails in grid view (JPEG, PNG, GIF, WebP, and AVIF up to 64 MB), generated on the server with EXIF rotation applied and all metadata stripped, and cached in the state directory
- Video thumbnails in grid view (MP4, MKV, MOV, WebM, AVI, of any size) when ffmpeg is installed, taken by ffmpeg in a throwaway, locked-down systemd sandbox
- Media details in Properties: an image's dimensions, format, colour, frames, and the camera and date taken from EXIF; a video's or audio file's length, resolution, frame rate, codecs, channels, bit rate, and title/artist/album tags (audio and video need ffmpeg, and are read by ffprobe in the same sandbox as video thumbnails)
- Folder sizes in the list: switch on **Sizes** in the toolbar to fill the Size column for every folder in view and sort folders by how much they hold (remembered per browser)
- Folder sizes in Properties: how many files and folders a folder holds, their total size, and the space they take on disk (showing what ZFS compression saves), counted when Properties opens; hard-linked files count once and links aren't followed
- SHA-256 and MD5 checksums in Properties, calculated automatically for files up to 64 MB, with copy buttons and a field to compare against an expected checksum
- POSIX `chmod` and numeric `chown` for one or many items
- Bulk rename with find/replace, regular expressions, prefix, suffix, sequential numbering, live conflict detection, and two-phase application
- Search inside files: switch the search box to **Contents** to find text in files under the current folder, with matching lines, line numbers, highlighting, and an optional match-case toggle. It reads text files up to 5 MB (skipping binary files, symlinks, and FilesDude's internal folders) and stops at 20,000 files, 256 MB, 15 seconds, or 200 matching files, saying when it did
- Recursive filename search with filters (**Filters** next to Names/Contents) for kind (folders, images, videos, audio, documents, archives), when modified, and minimum size, which work with or without a name; results show their folder, and a search never holds up other work while it walks the tree
- Disk usage, owner/group display, symlink escape warnings, and a cached whole-tree largest-files view from the clickable Storage card
- Filter largest files by a minimum size, load 100, 250, or 500 more at a time, export the currently loaded results to CSV, and move one or many selected files to protected trash (or permanently delete them after confirmation)
- Protected trash by default with a Trash view for restoring items to their original folders, deleting them forever, or emptying the trash, plus optional automatic removal of items after 7, 30, or 90 days or a year; persistent favourites; and a JSON Lines audit log inside the protected state directory
- Activity (owner): who did what and when, newest first, in plain sentences, filtered by kind (files, downloads, sign-ins, sharing, accounts, snapshots), account, or text
- Signed, expiring, HTTP-only, SameSite login sessions; scrypt password hashes; login throttling; same-origin mutation checks; and hardened response headers
- Account preferences for changing the username and password; credential changes invalidate other sessions
- Optional two-factor sign-in for every account with an authenticator app (6-digit codes), with one-time recovery codes
- Duplicate finder (owner): scan a folder for files with identical contents, see which copies waste the most space, and move extra copies to the trash or replace them with hard links, always keeping one of each
- ZFS snapshots: when the root is a ZFS dataset, browse earlier versions of files ("Previous versions" or **Snapshots**), download them, and restore them beside the current version; the owner can take snapshots or schedule them hourly or daily
- Other servers (owner): connect to any machine you can SSH into over SFTP, then browse it, preview, download, upload, organise, and copy files and folders to and from FilesDude
- User accounts: the owner (the installer's login) can add editors (view and change files) and viewers (view and download only), each confined to one folder, from **Users** in the sidebar
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

## Restore or empty the trash

Deleting an item moves it to FilesDude's protected trash (`.filedude/trash` inside
the managed root) unless you choose permanent deletion. Open **Trash** in the
sidebar to see each item's original location, size, and deletion time.

- **Restore** puts items back in their original folder, recreating missing parent
  folders. If something with the same name now exists there, the restored item is
  renamed (for example `notes (restored).md`) rather than overwriting it.
- **Delete forever** removes the selected items permanently.
- **Empty trash** permanently removes everything in the trash and frees its space.

By default items stay in the trash until someone removes them. The owner can instead
choose, under **Preferences → Trash**, to remove items automatically 7, 30, or 90 days
or a year after they were deleted. FilesDude checks hourly (and as soon as the setting
is saved), the Trash shows how long each item has left, and every automatic removal is
recorded in the audit log as `trash.purge`.

Items trashed by FilesDude versions that did not record original locations are
listed with an unknown location and restore to the root folder.

## Compress and extract archives

Select items and choose **Compress** (or right-click and choose **Compress…**) to save
them as a `.zip` or `.tar.gz` in the open folder. Right-click an archive and choose
**Extract here** to unpack it into a new folder named after it; nothing existing is
replaced. Both run in the background with a progress panel and a cancel button, so
large archives are not cut off by reverse-proxy timeouts. One archive job runs at a
time, and jobs stop if the service restarts.

Extraction treats any archive containing an absolute path, a `..` segment, or
FilesDude's internal folder name as hostile and extracts nothing from it. Symlinks,
hard links, and device entries are skipped and counted, and extraction stops (removing
its partial folder) rather than leave less than 512 MB free or unpack more than
100,000 entries. New files and folders take the owner of the folder they are created in.

## User accounts

The login created by the installer is the **owner**: it has full access and is the only
account that can manage users, create share links, change permissions or ownership,
choose upload ownership, run the largest-files scan, and empty the trash.

From **Users** in the sidebar, the owner can add other accounts, each confined to one
folder:

- **Editors** can browse, preview, download, search, upload, create, rename, move, copy,
  edit, delete (to trash), compress, and extract inside their folder.
- **Viewers** can browse, preview, download, search, and see checksums inside their
  folder, and nothing else.

Accounts start in their folder and can't open anything above it, including through
symlinks; they can't rename, move, or delete their home folder itself. The trash shows
each account only items deleted from inside its folder, favourites are per account, and
uploads and new files or folders made by editors take the destination folder's owner.
Archive jobs, content searches, and checksums are limited per account, so one account
can't hold up another, and an account's running jobs stop when it is changed or deleted.

File operations act through open folder handles rather than re-resolving paths, so a user
who can also change the folder from inside the container can't redirect them elsewhere by
swapping in a symlink. Copies keep each item's permissions (minus setuid/setgid) and, when
running as root, its owner; FIFOs, sockets, and devices aren't copied. Changing an account's role,
folder, or password signs it out everywhere; accounts can change their own password from
the account menu. Accounts are stored in `users.json` in the state directory.

## Two-factor sign-in

Any account can require a 6-digit code from an authenticator app (1Password, Google
Authenticator, Authy, and so on) as well as its password: open **Preferences** (or
**Your account**), choose **Set up** under Two-factor sign-in, confirm your password,
scan the QR code, and enter a code. You then get 10 recovery codes, each of which signs
you in once if you lose your phone; save them, as they aren't shown again.

- Each code works only once, and wrong codes count towards the sign-in limit.
- Turning it on or off, or replacing recovery codes, needs your password and signs out
  your other sessions. Turning it off or replacing codes also needs a code.
- After five wrong codes, an account can't use a code for 15 minutes.
- The owner can reset two-factor sign-in for another account from **Users**, for
  example after a lost phone; that account then signs in with its password and can set
  it up again.
- If the owner loses both their phone and recovery codes, remove the `twoFactor` entry
  from `credentials.json` in the state directory as root (for example
  `/var/lib/filesdude/credentials.json`) and restart the service.

Passkeys aren't offered because browsers only allow them over HTTPS, and FilesDude is
often reached over plain HTTP on a LAN.

## Share links

Right-click a file or folder and choose **Share link…** to create a link that anyone can
use to download it without signing in. Every link expires (1 hour to 30 days) and can
be limited to a number of downloads, including single use. Shared items show a link
icon, and **Shared links** in the sidebar lists everything currently shared, with
copy and revoke buttons.

- Shared files are always downloaded, never displayed in the browser; folders
  download as a ZIP of their current contents (without FilesDude's internal folders).
- Links follow items that are renamed or moved, and are revoked when the item is deleted.
- Each link is signed with `FILEDUDE_SESSION_SECRET`; rotating that secret invalidates
  every link along with every session. Only link ids are stored, in `shares.json` in
  the state directory.
- Every public download is recorded in the audit log.
- Links use the address you are browsing FilesDude on, so people can only open them
  if they can reach that address. Over plain HTTP, links and downloads can be read by
  anyone on the network path; use HTTPS for anything sensitive.
- Set `FILEDUDE_SHARING_ENABLED=false` to turn sharing off entirely.

## Video thumbnails

When the host has ffmpeg (`/usr/bin/ffmpeg`, or set `FILEDUDE_FFMPEG_PATH`) and the
service runs as root under systemd, videos get thumbnails in grid view from a frame a few
seconds in. ffmpeg decodes files other users control, so it never runs inside FilesDude:
each frame comes from a throwaway systemd unit running as a temporary unprivileged user,
with no network, sockets, or capabilities, a system-call filter, memory, task, CPU, and
time limits (15 seconds), and nothing of the filesystem but the system's programs and
libraries: every other top-level folder is hidden, and `/etc` and `/run` are empty apart
from what the dynamic linker needs. The video is passed in as the already-opened file,
never by path, and ffmpeg may only read that file, as MP4/MOV, Matroska/WebM, or AVI, so a
crafted file can't make it open playlists, other files, or URLs. One video is worked on at
a time, separately from images, and a video no frame could be taken from isn't tried
again for six hours unless it changes. Set `FILEDUDE_VIDEO_THUMBNAILS=false` to turn this
off.

The same sandbox runs ffprobe (`/usr/bin/ffprobe`, or set `FILEDUDE_FFPROBE_PATH`) for the
length, resolution, codecs, and tags shown under **Video** or **Audio** in Properties; set
`FILEDUDE_MEDIA_INFO=false` to turn that off. Image details are read by sharp from images
up to 64 MB.

## Activity

The owner's **Activity** view (in the sidebar) reads the audit log, `audit.jsonl` in the
state directory, newest first: sign-ins (and failed attempts, with the address), uploads,
downloads, changes, shares and their downloads, account changes, and snapshots. Filter by
kind, by account (including share links and FilesDude's own upkeep), or by any text such as
a file name or address, and load older entries as you scroll back. Uploads show as one entry with their totals (every file is still recorded on its own).
Looking at an item's
Properties is logged but not shown. Names, paths, and addresses that came from users are
shown set apart, with invisible or direction-changing characters spelled out, so a crafted
file name can't read as part of the sentence around it.

The log is set aside as a dated archive (`audit-<time>.jsonl`) at 8 MB. Archives are kept
for at least 30 days however much is written, so nobody can push recent history out by
flooding the log, and beyond that while history stays under 256 MB; only past 1 GB in total
are recent ones removed, to protect the disk. Every entry is kept small, rotations and
removals are recorded in the log, and downloads through a share link are recorded once per
link and address every ten minutes rather than for each range request.

## Other servers (SFTP)

The owner can add other servers under **Servers** in the sidebar: a name, host, port,
username, and how to sign in. The recommended way is a key FilesDude generates: only its
public half leaves this server, to be added to `~/.ssh/authorized_keys` on the other one
(the dialog shows the line and a command). A password or a pasted private key also work.
Credentials are encrypted at rest in the state directory, bound to their server, and never
sent to the browser; changing a password-based server's host or account needs the password
again.

The first connection shows the server's host key fingerprint to confirm (check it with
`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on that server); after that, a changed key
is refused. A server can be browsed within its starting folder, previewed, downloaded from,
uploaded to, and organised (new folder, rename, delete: the server has no trash). Items copy
both ways as background jobs with progress and cancel: select items there and choose **Copy
to** the folder open in FilesDude, or select items in FilesDude and choose **Copy to server**.
The other server is treated as untrusted: unsafe names, links, and special files are skipped;
entries, bytes, and free space are checked as a copy goes; a folder is copied into a private
placeholder and appears only once complete; and a server that stops responding is
disconnected.

## Duplicate files

The owner can open **Duplicates** in the sidebar, choose a folder (or everything) and a
minimum size, and scan for files with identical contents.

- Files are grouped by size, then narrowed by comparing a few blocks of each, and only
  files that still match are read in full and compared by SHA-256, so every set shown is
  an exact byte-for-byte match. Files are read one at a time, so a large tree takes a
  while; the scan runs in the background and can be cancelled.
- Hard links to the same file are the same data, not duplicates; they're marked
  "hard-linked" and count once.
- Sets are listed by the space their extra copies take. Pick copies by hand or with "All
  but the oldest" / "All but the newest", then move them to the trash. At least one copy
  of each set is always kept, and nothing is deleted outright (protected trash must be
  on), so a mistake can be restored from the trash.
- **Replace with hard links** instead turns each chosen copy into a hard link to a copy
  you keep (the oldest one not chosen), so every path keeps working, for example files a
  torrent client is seeding, while they share one copy of the data. Each replaced copy
  goes to the trash, so the space comes back once the trash is emptied, and until then
  it can be restored. A copy is only linked if it is still exactly the scanned file and
  has the same owner, group, and permissions as the kept copy (a hard link shares
  them), and isn't executable or writable by its group or others (so linking can't widen
  who may change it); others are left alone and listed.
- Removing a copy that a torrent client is still seeding breaks that torrent; replacing
  it with a hard link doesn't.

## Snapshots (ZFS)

When `FILEDUDE_ROOT` is on a ZFS dataset (such as a Proxmox container's
`subvol-<id>-disk-<n>`), **Snapshots** appears in the sidebar and **Previous versions** in
each item's menu. FilesDude finds the dataset itself; set `FILEDUDE_ZFS_PATH` if the `zfs`
command isn't in `/usr/sbin`, `/sbin`, or `/usr/local/sbin`.

The installer sets this up when the service runs as root over a ZFS folder: it binds
`/dev/zfs` into the service's otherwise private `/dev`, and delegates only the ZFS
permissions snapshots need on that dataset (`zfs allow -u root snapshot,destroy,mount
<dataset>`) rather than giving the service `CAP_SYS_ADMIN`. ZFS can't limit `destroy` to
snapshots, so the service could also destroy the dataset itself; it can already delete
every file in it. If snapshots don't appear, check `journalctl -u filesdude` for a
"zfs list failed" warning. To withdraw the access, run
`zfs unallow -u root snapshot,destroy,mount <dataset>`.

- **Who can see them:** only the owner, until the owner shares snapshots with editors or
  with everyone (**Who can see snapshots** in the Snapshots dialog). Shared accounts see
  only their own folder in each snapshot, but as it was then, including anything since
  moved out of it; delete a snapshot to remove what it holds.
- Accounts that can see snapshots browse them and download earlier versions (folders as
  ZIPs). Editors and the owner can also restore an item: it is copied back beside the
  current one as `name (restored <date>)` (or under its own name if that is free), so
  nothing is ever replaced.
- **The owner** can take a snapshot at any time, or turn on automatic snapshots every
  hour or every day, keeping the newest so many. Automatic snapshots are off by default;
  once on, they are taken from when the service starts, whether or not anyone signs in.
- FilesDude names its snapshots `filesdude-auto-...` and `filesdude-manual-...`, and only
  ever deletes those: automatic ones beyond the number to keep, or ones the owner
  deletes. Other snapshots, such as Proxmox's, are listed and browsable but never
  touched.
- Snapshots take no space at first, then hold on to data that later changes or is
  deleted; each one's "unique" size shows what deleting it would free.
- These are plain ZFS snapshots that Proxmox doesn't know about. Delete FilesDude's
  snapshots before moving or migrating the container's disk if Proxmox complains about
  them.

## Version

The running version (from `package.json`) and the commit it was built from appear
at the bottom of the sidebar once signed in; hover it for the build time. It is not
shown on the sign-in page.

An open page checks whether the server has been updated when you return to its tab and
every 10 minutes while it is visible. If the server runs a newer build, a banner offers to
reload, so a tab left open across `filesdude-update` doesn't keep running the old version.

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
- Behind a reverse proxy or tunnel (such as a Cloudflare Tunnel's `cloudflared`), set `FILEDUDE_TRUSTED_PROXIES` in `/etc/filesdude/filesdude.env` to its address, for example `FILEDUDE_TRUSTED_PROXIES=192.168.0.3`, and restart. Only connections that really come from that address (FilesDude checks the connection itself, not a header) have their client address (Cloudflare's `CF-Connecting-IP`, or `X-Forwarded-For`) and HTTPS believed, so sign-in limits apply per real visitor, Activity shows real addresses, and session cookies are marked secure. Anyone else is taken as their own address, whatever headers they send. `FILEDUDE_TRUST_PROXY=true` (believing every connection is a proxy) remains only for setups where FilesDude can't be reached except through one.
- Back up the underlying data independently. Protected trash helps with mistakes but is not a backup.
- Keep Proxmox, the container image, and reverse proxy patched. Rotate the session secret to invalidate all sessions.

## Useful keyboard shortcuts

- `Command/Ctrl + K`: focus search
- `Command/Ctrl + A`: select every item in the folder; `Escape` clears the selection
- Arrow keys, `Home`, and `End`: move between items (`Shift` extends the selection); `Enter` opens the current item
- `Shift`-click: select a range; `Command/Ctrl`-click: add or remove one item
- `Command/Ctrl + X`, `C`, `V`: cut or copy the selection, then paste it into the open folder
- `Command/Ctrl + Z`: undo the latest rename, move, copy, or delete
- `F2`: rename the selected item
- `Space`: preview the selected file; in a preview, `←` and `→` step to the previous or next file
- `Delete`: delete selected items

Shortcuts are ignored while you are typing in a field such as search.

## Good next features

The safest default set is already included. These are strong next additions when you need them:

- OIDC single sign-on, and passkeys for installations served over HTTPS
- An index for searching file contents on very large trees
- Antivirus scanning and upload quarantine for environments with untrusted uploaders
- SFTP/SMB/NFS connection profiles for managing remote roots without mounting them into the app container

## Development checks

```bash
npm test
npm run lint
npm run build
```
