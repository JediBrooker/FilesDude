# FilesDude

FilesDude File Explorer is a secure, self-hosted web file manager designed for a Proxmox host, VM, or LXC container. It exposes one explicitly configured filesystem root and keeps every browser operation inside that boundary.

## What is included

- Browse folders in list or grid view, sorted by name, size, owner, permissions, or modified time (folders stay first and the choice is remembered per browser), including an optional hidden-files view; the browser's own back/forward buttons and gestures step through folder history instead of leaving the app
- Use a SharePoint-style row menu, also available by right-clicking any item (or empty space for folder actions), for preview, text editing, downloads, organization, administration, properties, and deletion; with several items selected it acts on all of them
- Cut, copy, and paste items between folders, or drag them onto a folder, favourite, or breadcrumb to move them (hold Option/Alt to copy); copies into a folder that already has the name are saved as `name (copy)`
- Split view (on screens 1200 px wide or more): **Split** in the toolbar, or **Open in split view** on a folder's menu, shows a second folder beside the current one, with its own breadcrumb; select items on either side and copy or move them across with one click, or drag them from one side onto the other (or onto a folder or breadcrumb there; hold Option/Alt to copy). The second folder is remembered per browser
- Copies and moves run as background jobs with byte progress and cancel, so large copies don't hold up browsing or other work; a copy in progress shows as `name (copying)` and gets its real name once complete, a cancelled or failed copy is removed (as is one interrupted by a restart, the next time the service starts), and a move between filesystems removes only what it copied unchanged, with share links following the copies
- Undo the latest rename, move, copy, or delete from the confirmation toast or with `Command/Ctrl + Z`; deletes are undone by restoring from protected trash
- Pin durable favourite folder locations to the sidebar from a folder menu, selection toolbar, or the current-location button
- Create files and folders; edit text/code files up to 2 MB; rename, copy, move, soft-delete, and permanently delete, with a breadcrumb folder browser and autofill suggestions for picking a copy/move destination
- Upload whole folders, by dropping them or with the arrow on the Upload button, keeping their subfolders (empty ones too); each uploaded folder lands in a new folder ("Photos (1)" if "Photos" exists), and system clutter like `.DS_Store` is left out
- Multi-file drag-and-drop upload with live progress, transfer speed, time remaining, and cancel (cancelled or interrupted files are discarded and can be resumed), collision-safe names, a configurable size limit, and owner/group confirmation based on the destination folder and its existing contents
- Large files (over 16 MB) upload in 16 MB pieces, so they get through proxies with a request size limit such as Cloudflare's 100 MB, and a dropped connection only re-sends the piece in flight: the upload waits and carries on by itself, up to five times in a row. The file is written under a visible `name (uploading)` placeholder and takes its real name once complete; an abandoned upload's placeholder is removed after 30 minutes, or when the service restarts. This applies to upload links too. The owner can turn it off under **Preferences → Large uploads** when nothing in front of FilesDude limits request sizes; each file then goes in one request, which must finish within an hour. The size limit is still `FILEDUDE_MAX_UPLOAD_MB` per file, so raise it to upload files larger than 512 MB
- Direct file downloads and ZIP downloads for folders; select several items (from one folder or from search results) to download them together as one ZIP
- Share links: let anyone with a private link download a file (or a folder as a ZIP) without signing in, for 1 hour to 30 days and optionally a limited number of downloads; links can be revoked at any time, follow renames and moves, and every download is audited
- Upload links: let anyone with a private link send files into a folder, without an account and without seeing what's in it, within a total size and number of files you choose
- Compress selected items into `.zip` or `.tar.gz` and extract `.zip`, `.tar`, `.tar.gz`, and `.tgz` archives into a new folder, as background jobs with progress and cancel; extraction refuses archives with absolute or `..` paths, never creates links or devices, and stops before filling the disk
- Inline previews for text, code, JSON, images, PDF, audio, and video; media uses byte-range streaming. Videos offer subtitles in the player's CC menu: subtitle files beside them (`Movie.srt`, `Movie.en.vtt`) and text subtitle tracks inside them (extracted once by ffmpeg in the media sandbox and kept). Step through a folder's files with the arrow keys, the on-screen arrows, or a swipe on touch screens; neighbouring photos load ahead. A picture's preview can play a slideshow of the folder's pictures (3 to 20 seconds each, looping, with the next one loaded ahead; P plays or pauses) and go full screen
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
- Notifications (owner): a message to ntfy, Discord, Slack, or any webhook when files arrive through upload links, someone keeps failing to sign in or guessing a link's password, sign-in security changes, the disk is nearly full, or a scheduled snapshot fails (and, if wanted, on every sign-in)
- Activity (owner): who did what and when, newest first, in plain sentences, filtered by kind (files, downloads, sign-ins, sharing, accounts, snapshots), account, or text
- Signed, expiring, HTTP-only, SameSite login sessions; scrypt password hashes; login throttling; same-origin mutation checks; and hardened response headers
- Account preferences for changing the username and password; credential changes invalidate other sessions
- Optional two-factor sign-in for every account with an authenticator app (6-digit codes), with one-time recovery codes
- Passkeys: sign in with a fingerprint, face, device PIN, or security key instead of a password, when FilesDude is opened over HTTPS
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
sessions and passkeys:

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
- Choose how files over 16 MB are sent (**Large uploads**): in 16 MB pieces, which is
  needed behind Cloudflare and recovers from dropped connections, or in one request.

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

## Passkeys

When FilesDude is opened over HTTPS (for example through a Cloudflare Tunnel), any account
can add passkeys and then choose **Sign in with a passkey** on the sign-in page, with no
username or password. Open **Preferences** (or **Your account**), choose **Add** under
Passkeys, confirm your password (and a two-factor code, if that is on), and follow your
browser's prompt. Passwords keep working alongside them.

- A passkey needs the device's fingerprint, face, PIN, or the security key's PIN, so it
  counts as two factors on its own: signing in with one doesn't ask for a two-factor code.
- Each passkey works only at the address it was added on (such as
  `filesdude.example.com`); browsers don't offer passkeys over plain HTTP, except on
  `localhost`, so the button doesn't appear on a LAN address like `http://192.168.0.2:3000`.
- Only public keys are stored, in `passkeys.json` in the state directory; failed passkey
  sign-ins count towards the same sign-in limit as passwords, and appear in Activity.
- Rename or remove passkeys from the same place; removing one needs only your session.
- Changing your own password keeps your passkeys; if you change it because it may have
  been exposed, also check the list and remove any you don't recognise (renames and
  removals appear in Activity).
- When the owner resets another account's password or two-factor sign-in, or removes the
  account, its passkeys are removed too. `filesdude-update --reset-credentials` removes
  every passkey, or delete `passkeys.json` as root and restart.

## Share links

Right-click a file or folder and choose **Share link…** to create a link that anyone can
use to download it without signing in. Every link expires (1 hour to 30 days) and can
be limited to a number of downloads, including single use. Shared items show a link
icon, and **Shared links** in the sidebar lists everything currently shared, with
copy and revoke buttons.

- Shared files are always downloaded, never displayed in the browser; folders
  download as a ZIP of their current contents (without FilesDude's internal folders).
- Links follow items that are renamed or moved, and are revoked when the item is deleted.
- **Edit** on a link changes it in place, keeping its address: when it expires (from now),
  its download limit (or an upload link's size and file limits), and its password (add,
  change, or remove). Limits can't go below what's already been used (or promised to
  uploads under way), and a new or removed password ends unlocks already given, so everyone
  needs the new one; uploads under way through the link stop when a password is added or
  changed.
- Each link is signed with `FILEDUDE_SESSION_SECRET`; rotating that secret invalidates
  every link along with every session. Only link ids are stored, in `shares.json` in
  the state directory.
- Every public download is recorded in the audit log.
- Links use the address you are browsing FilesDude on, so people can only open them
  if they can reach that address. Over plain HTTP, links and downloads can be read by
  anyone on the network path; use HTTPS for anything sensitive.
- Set `FILEDUDE_SHARING_ENABLED=false` to turn sharing off entirely.
- **Passwords:** any download or upload link can also need a password (8 characters or
  more), entered in the Share dialog. People opening the link see only a password box,
  not what's shared, until they enter it; it then works in that browser for 12 hours.
  Only a scrypt hash is stored, in `protected-shares.json` (so an older version, if rolled
  back to, doesn't serve those links). Wrong guesses are limited to 10 per visitor and 50
  per link every 15 minutes (right passwords don't count); each is recorded in Activity, as
  is a link being closed for 15 minutes after too many. Send the password separately
  from the link. Protected links show a lock in **Shared links**.

### Upload links

To collect files from someone without an account, right-click a folder, choose
**Share link…**, and pick **Upload**. Choose how long the link lasts, the total size it
takes (100 MB to 100 GB), and how many files (up to 10,000). The person opening the link
sees only the folder's name and a place to drop files, with an optional box for their
name, and each file shows its progress as it uploads.

- People with an upload link can't see, open, download, change, or delete anything in
  the folder, and the link can't be used as a download link.
- Files never replace anything: a name that's taken gets a number, as in `report (1).pdf`
  (or a random ending once many are taken). Invisible and direction-changing characters
  in names are replaced with `_`, and a leading dot becomes `_`, so nothing arrives
  hidden (such as `.htaccess`).
- Each file can be at most `FILEDUDE_MAX_UPLOAD_MB`, and counts at least 4 KB against the
  link; empty files aren't taken. Uploads stop when the link's size or file limit is
  reached, and always leave 2 GB free on the folder's disk.
- A server takes at most 8 uploads through links at once, 3 per link and 3 per address
  (IPv6 addresses count by /64). An upload that stops sending data for a minute, or runs
  slower than 64 KB/s overall, is dropped.
- Files over 16 MB are sent in pieces (unless the owner turned that off), so Cloudflare's
  request size limit doesn't apply. Each piece upload holds the link's room for its whole
  file until it finishes or is given up, ends if nothing arrives for 5 minutes or it runs
  past its deadline, and stops when the link is revoked.
- When FilesDude runs as root, received files belong to the folder's owner.
- Every file received is recorded in Activity, with the sender's address and the name
  they gave. **Shared links** shows how much each upload link has received.
- Like download links, upload links follow the folder when it's renamed or moved, and
  stop working if it's deleted or replaced.

## Image thumbnails and details

Images (JPEG, PNG, GIF, WebP, and AVIF, up to 64 MB and 100 megapixels) get thumbnails in
grid view, made by sharp, and their details (dimensions, format, colour, frames, and the
camera and date taken from EXIF) under **Image** in Properties, read by sharp too. Decoders parse files other people control, anyone with an upload
link included, so FilesDude never decodes images itself: a separate Node.js process does,
handed the already-opened file (never its path) and returning only the thumbnail, or the
details as a small JSON object that FilesDude checks field by field. When the
service runs as root, that process runs in the same throwaway sandbox as ffmpeg (below),
with Node.js and FilesDude's `node_modules` shown to it read-only, so it needs Linux,
systemd, and those readable by other users (the installer sees to that); without the
sandbox, a server running as root shows no image thumbnails or details rather than read
images as root. Running as another account (a development machine, or `--service-user filesdude`),
the process runs as that account with all of its access, so it only keeps a crash or
runaway decode from taking FilesDude down. Either way only the decoders for those formats
are enabled, the process is stopped after 15 seconds, and two images are decoded at a
time (details included). Next.js's built-in image optimizer, which would decode images inside FilesDude, is
turned off.

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
a time, separately from images, the frame is resized like an image (above), and a video no frame could be taken from isn't tried
again for six hours unless it changes. Set `FILEDUDE_VIDEO_THUMBNAILS=false` to turn this
off.

The same sandbox runs ffprobe (`/usr/bin/ffprobe`, or set `FILEDUDE_FFPROBE_PATH`) for the
length, resolution, codecs, and tags shown under **Video** or **Audio** in Properties; set
`FILEDUDE_MEDIA_INFO=false` to turn that off. Image details are read like image
thumbnails (above).

## Videos that play everywhere

Browsers don't all play every video: Safari (including on iPhones) can't play MKV at all,
and Chrome plays Dolby Digital (AC-3, E-AC-3), DTS, and TrueHD sound as silence. When a
video won't play, or its sound won't, its preview offers **Make it playable**: FilesDude
repackages it as MP4 without re-encoding the picture (so nothing is lost, and an hour of
video takes about a minute), turning the sound into stereo AAC where needed, and switches to
the copy once it's ready, carrying on from the same moment. H.264 and HEVC video can be
repackaged; other picture formats can't, and HEVC still needs a browser that shows it
(Safari, Edge, or Chrome on most recent computers).

- ffmpeg runs in the same locked-down sandbox as video thumbnails, reading the already-opened
  video and writing straight into a file FilesDude opened for it, never by path; it's
  stopped if its output grows past one and a half times the video (the kernel enforces that
  too, and it can't reserve disk space without writing), and runs at low disk and CPU
  priority. One video is prepared at a time (each account one), with a few waiting. Runs
  stop when FilesDude's service stops or restarts.
- Copies are kept in `playback/` in the state directory, up to 50 GB in total (set
  `FILEDUDE_PLAYBACK_CACHE_GB` to change it), the least recently watched going first; room
  is made before a copy starts, for the most it may grow to. A copy is only made while the
  disk keeps 10 GB (or 5%, if that's more) free, since the state directory is often on the
  system disk. A changed video gets a new copy. Set `FILEDUDE_PLAYBACK=false` to turn this
  off.

## Continue watching

FilesDude remembers how far each account got in each video and audiobook, so it carries on
where it was left off, on any device (with **Start over** to go back to the beginning). Audio
is remembered when it's longer than ten minutes (audiobooks, not songs). Videos
watched to within two minutes of the end (or 95%) are marked watched with a tick in the
list; part-watched ones show how far through they are. **Continue watching** in the sidebar
lists the videos you're part-way through, newest first, with how long is left.

- Positions are saved every 10 seconds while a video plays, and when it's paused or closed.
  Less than 30 seconds in isn't remembered.
- Each account's last 300 videos are kept in `watching.json` in the state directory, and
  only for videos the account can reach; an account's history goes when it's removed.

## Now playing, picture in picture, and up next

- **Up next:** when an episode ends, the next video in its folder (in name order, so episode 2
  comes before episode 10, whatever the list is sorted by) starts after a ten-second
  countdown, with **Play now** and **Cancel**. Audiobook parts and album tracks go straight
  on to the next.
- **Picture in picture:** a video's preview can hand it to a small player in the corner, so it
  keeps playing, from the same moment, while you browse. Where the browser supports it, it
  goes straight into the browser's own floating window (over other tabs and apps too); the
  corner player then shrinks to its controls. Picture in picture carries on into the next
  episode.
- **Keep playing:** closing an audio preview while it plays moves it to the same player, as an
  audio bar with the album's or audiobook's cover (a `cover.jpg`, `folder.jpg`, or the only
  picture beside it).
- The player has previous and next for the folder, play and pause, a way back to the full
  view at the same moment, and Stop. Starting anything else pauses it, and it saves where you
  got to like the full preview does.

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

## Notifications

The owner can have FilesDude send a message when something needs attention: open
**Preferences → Notifications**, choose where to send them, paste the address, pick what to
hear about, and use **Save and send a test**.

- **Where:** [ntfy](https://ntfy.sh) (just the topic name for ntfy.sh, or the full address
  of a topic on your own server, with an optional access token for protected topics), a Discord or Slack incoming webhook, or any other
  service that accepts a JSON POST (`source`, `topic`, `title`, `message`, `urgent`, `at`).
- **What:**
  - *Files received through upload links*, gathered into one message per link every couple
    of minutes, with the names, total size, and who sent them.
  - *Security*: an address failing to sign in (or entering wrong two-factor codes) 5 times
    in 15 minutes; a link closed after too many wrong passwords; passwords changed,
    two-factor sign-in turned off, passkeys added, and accounts added or removed.
  - *Every sign-in* (off unless chosen): who, how, and from where.
  - *Storage*: the managed disk falling below 10% free (checked hourly, told once until it
    recovers), and scheduled snapshots failing.
- What strangers can set off (failed sign-ins, wrong link passwords, files through upload
  links) has its own allowance of 10 messages an hour, so it can never use up the 30 an hour
  for changes made by accounts, sign-ins, and storage; anything beyond is held back and the
  next message says how many. Failed sign-ins from more addresses within 15 minutes of an
  alert come as one summary, an IPv6 /64 counts as one address, and a busy upload link is
  told about every 15 minutes rather than every two.
- File names and other text from users are shown as text, never as formatting, mentions,
  links, or link previews, in Discord and Slack.
- A saved ntfy token is only sent to the server it was saved for: changing to another server
  needs it entered again.
- The settings, including the address (which for Discord and Slack is itself a secret), are in
  `notifications.json` in the state directory, readable only by the service; the ntfy token
  is never sent to the browser.

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
uploaded to (files over 16 MB in pieces, like uploads to FilesDude, unless that's turned
off under **Preferences → Large uploads**), and organised (new folder, rename, delete: the server has no trash). Items copy
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
- `Space`: preview the selected file; in a preview, `←` and `→` step to the previous or next file, and `P` plays or pauses a slideshow of the folder's pictures
- `Delete`: delete selected items

Shortcuts are ignored while you are typing in a field such as search.

## Good next features

The safest default set is already included. These are strong next additions when you need them:

- OIDC single sign-on
- An index for searching file contents on very large trees
- Antivirus scanning and upload quarantine for environments with untrusted uploaders
- SMB/NFS connection profiles, alongside SFTP servers, for managing remote roots without mounting them into the app container

## Development checks

```bash
npm test
npm run lint
npm run build
```
