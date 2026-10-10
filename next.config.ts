import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

const { version } = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as { version: string };

// The installer builds from a GitHub tarball (no .git) and passes the commit it downloaded.
function buildCommit() {
  const provided = process.env.FILEDUDE_BUILD_COMMIT?.trim() ?? "";
  if (/^[0-9a-f]{7,40}$/i.test(provided)) return provided.slice(0, 7).toLowerCase();
  try {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // ssh2 loads an optional native add-on, so it is required at run time rather than bundled.
  serverExternalPackages: ["ssh2"],
  // /_next/image would decode any image FilesDude serves (a share link's included) with sharp inside
  // this process; thumbnails are made in a sandbox instead (see lib/image-resize.ts).
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_FILESDUDE_VERSION: version,
    NEXT_PUBLIC_FILESDUDE_COMMIT: buildCommit(),
    NEXT_PUBLIC_FILESDUDE_BUILT_AT: new Date().toISOString(),
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // Other sites (sibling subdomains included) can't embed FilesDude's files or responses.
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      // The pages (not API routes or share downloads, which set their own stricter sandbox policy,
      // and which a header here would replace): no plugins, no changing the base address, no framing,
      // and forms only send here.
      {
        source: "/:path((?!api/|s/[^/]+/download).*)",
        headers: [{ key: "Content-Security-Policy", value: "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" }],
      },
    ];
  },
};

export default nextConfig;
