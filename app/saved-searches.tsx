"use client";

import { Bookmark, BookmarkPlus, CircleAlert, LoaderCircle, Search, Trash2 } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { visibleText } from "@/lib/activity-text";
import type { SavedSearch } from "@/lib/saved-searches";
import { formatBytes, requestJson } from "./file-manager";

// Searches saved to run again, in a small menu beside the search box: the current search (its
// text, names or contents, filters, and folder) can be saved under a name, and a saved one opens
// its folder and runs it.

export type CurrentSearch = Omit<SavedSearch, "id" | "name" | "createdAt">;

const KINDS: Record<string, string> = { folders: "folders", images: "pictures", videos: "videos", audio: "audio", documents: "documents", archives: "archives" };

/** What a search looks for, in a few words. */
export function describeSearch(search: CurrentSearch) {
  const parts = [search.query ? `“${visibleText(search.query)}”${search.mode === "contents" ? " inside files" : ""}${search.matchCase ? " (match case)" : ""}` : ""];
  if (search.kind !== "any") parts.push(KINDS[search.kind] ?? search.kind);
  if (search.modifiedDays) parts.push(`changed in ${search.modifiedDays === 1 ? "a day" : `${search.modifiedDays} days`}`);
  if (search.minBytes) parts.push(`over ${formatBytes(search.minBytes)}`);
  return `${parts.filter(Boolean).join(", ")} in ${search.folder ? `/${visibleText(search.folder)}` : "all files"}`;
}

export function SavedSearchesMenu({ current, onApply }: { current: CurrentSearch | null; onApply: (search: SavedSearch) => void }) {
  const [open, setOpen] = useState(false);
  const [searches, setSearches] = useState<SavedSearch[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    requestJson<{ searches: SavedSearch[] }>("/api/saved-searches", { signal: controller.signal })
      .then((result) => setSearches(result.searches))
      .catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message); });
    // Clicking elsewhere, or Escape, closes it.
    const away = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      controller.abort();
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const post = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ searches: SavedSearch[] }>("/api/saved-searches", { method: "POST", body: JSON.stringify(body) });
      setSearches(result.searches);
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (current && name.trim() && (await post({ action: "save", search: { ...current, name } }))) setName("");
  };

  return (
    <div className="saved-searches" ref={ref}>
      <button type="button" className={`toolbar-button ${open ? "active" : ""}`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)} title="Saved searches"><Bookmark size={16} /><span>Saved</span></button>
      {open && (
        <div className="saved-searches-menu" role="dialog" aria-label="Saved searches">
          {current
            ? <form className="saved-searches-save" onSubmit={save}>
              <small>{describeSearch(current)}</small>
              <div><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name this search" aria-label="Name for this search" maxLength={80} /><button className="button primary" disabled={busy || !name.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <BookmarkPlus size={14} />} Save</button></div>
            </form>
            : <p className="saved-searches-hint">Search, or set filters, to save that search here.</p>}
          {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
          {searches === null && !error && <div className="saved-searches-hint"><LoaderCircle className="spin" size={14} /> Loading…</div>}
          {searches?.length === 0 && <p className="saved-searches-hint">No saved searches yet.</p>}
          {searches && searches.length > 0 && (
            <ul className="saved-searches-list">
              {searches.map((search) => (
                <li key={search.id}>
                  <button type="button" className="saved-search-run" onClick={() => { onApply(search); setOpen(false); }} title={`Run: ${describeSearch(search)}`}><Search size={14} /><span><strong><bdi>{visibleText(search.name)}</bdi></strong><small>{describeSearch(search)}</small></span></button>
                  <button type="button" className="icon-button" disabled={busy} aria-label={`Delete the saved search ${visibleText(search.name)}`} title="Delete" onClick={() => void post({ action: "delete", id: search.id })}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
