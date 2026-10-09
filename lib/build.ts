export type BuildIdentity = { version: string; commit: string };

/** Whether the server runs a different build from the page's; an unknown commit never counts. */
export function isNewerBuild(server: BuildIdentity | undefined | null, page: BuildIdentity) {
  if (!server || typeof server.version !== "string" || typeof server.commit !== "string") return false;
  if (server.version !== page.version) return true;
  return Boolean(server.commit && page.commit && server.commit !== page.commit);
}
