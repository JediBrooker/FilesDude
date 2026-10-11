// Folder tabs in the file manager: the folders open, and which one is showing. Tabs only exist with
// two or more; one folder is just the folder. These are the rules for changing them, kept apart
// from the page so they can be tested.

export type FolderTabs = { paths: string[]; active: number };

export const MAX_TABS = 12;

/** Tabs as remembered (JSON), or null for none or anything that doesn't read right. */
export function parseTabs(raw: string | null): FolderTabs | null {
  try {
    const parsed = JSON.parse(raw ?? "null") as { paths?: unknown; active?: unknown } | null;
    if (!parsed || !Array.isArray(parsed.paths) || parsed.paths.length < 2 || !parsed.paths.every((item) => typeof item === "string" && item.length <= 4096)) return null;
    const paths = (parsed.paths as string[]).slice(0, MAX_TABS);
    const active = typeof parsed.active === "number" && Number.isInteger(parsed.active) && parsed.active >= 0 && parsed.active < paths.length ? parsed.active : 0;
    return { paths, active };
  } catch {
    return null;
  }
}

/** The tabs as shown: the one showing always holds the folder open. */
export function shownTabs(tabs: FolderTabs | null, current: string): FolderTabs | null {
  return tabs ? { paths: tabs.paths.map((tabPath, index) => (index === tabs.active ? current : tabPath)), active: tabs.active } : null;
}

/** A new tab for `path`, beside the one showing (null when there are already as many as allowed). */
export function openTab(tabs: FolderTabs | null, current: string, path: string): FolderTabs | null {
  const now = shownTabs(tabs, current) ?? { paths: [current], active: 0 };
  if (now.paths.length >= MAX_TABS) return null;
  return { paths: [...now.paths.slice(0, now.active + 1), path, ...now.paths.slice(now.active + 1)], active: now.active + 1 };
}

/** The tabs once one is closed (null once one folder is left), and the folder to show if that changes. */
export function closeTab(tabs: FolderTabs, index: number): { tabs: FolderTabs | null; show: string | null } {
  const paths = tabs.paths.filter((_, position) => position !== index);
  const active = index < tabs.active ? tabs.active - 1 : index === tabs.active ? Math.min(index, paths.length - 1) : tabs.active;
  return { tabs: paths.length < 2 ? null : { paths, active }, show: index === tabs.active ? paths[active] : null };
}
