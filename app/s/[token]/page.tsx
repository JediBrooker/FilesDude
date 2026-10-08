import type { Metadata } from "next";
import { Clock, Download, File, Folder, FolderOpen, Link2Off } from "lucide-react";
import { openSharedItem, resolveShareToken } from "@/lib/shares";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Shared with you · FilesDude",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function formatBytes(value: number) {
  if (value === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// Relative wording avoids showing a time in the server's own time zone.
function expiresIn(expiresAt: string) {
  const hours = Math.max(0, (Date.parse(expiresAt) - Date.now()) / 3_600_000);
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${Math.round(hours)} ${Math.round(hours) === 1 ? "hour" : "hours"}`;
  return `${Math.round(hours / 24)} days`;
}

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const share = await resolveShareToken(token);
  let size: number | null = null;
  let available = false;
  if (share) {
    const opened = await openSharedItem(share);
    if (opened) {
      available = true;
      size = opened.stat.isFile() ? opened.stat.size : null;
      await opened.handle.close().catch(() => undefined);
    }
  }

  return (
    <main className="login-page share-page">
      <section className="login-card share-card">
        <div className="login-brand">
          <div className="brand-mark large"><FolderOpen size={24} /></div>
          <div><strong>FilesDude</strong><span>Shared link</span></div>
        </div>
        {share && available ? (
          <>
            <div className="share-item">
              <span className={`file-icon ${share.type}`}>{share.type === "directory" ? <Folder size={22} /> : <File size={22} />}</span>
              <div>
                <strong title={share.name}>{share.name}</strong>
                <small>{share.type === "directory" ? "Folder · downloads as a ZIP file" : formatBytes(size ?? 0)}</small>
              </div>
            </div>
            <a className="button primary login-button" href={`/s/${encodeURIComponent(token)}/download`} rel="nofollow"><Download size={17} /> Download</a>
            <p className="share-meta"><Clock size={14} /> This link expires in {expiresIn(share.expiresAt)}{share.maxDownloads !== null ? ` · ${share.maxDownloads - share.downloads} ${share.maxDownloads - share.downloads === 1 ? "download" : "downloads"} left` : ""}.</p>
          </>
        ) : (
          <div className="share-missing">
            <Link2Off size={28} />
            <strong>This link isn&apos;t available</strong>
            <span>It may have expired, been used up or revoked, or the item may have been moved or deleted. Ask the person who shared it for a new link.</span>
          </div>
        )}
      </section>
    </main>
  );
}
