"use client";

import { ArrowLeft, ArrowRight, CircleAlert, File, Folder, GitCompareArrows, Info, Link2, LoaderCircle, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompareDifference, CompareSide, CompareStatus, FolderComparison } from "@/lib/folder-compare";
import type { JobState } from "@/lib/types";
import { CheckBox, formatBytes, formatDate, Modal, requestJson } from "./file-manager";

// Compares the two folders of the split view, and copies what differs from one to the other.

type Direction = "left" | "right";
type Filter = "all" | CompareStatus;

const PAGE = 300;
const MAX_SYNC = 1_000;

const folderName = (value: string) => `/${value}`;
const parentOf = (value: string) => value.split("/").slice(0, -1).join("/");
const lastSegment = (value: string) => value.split("/").at(-1) ?? value;

/** Which way an item is copied by default: towards the side that lacks it, or from the newer copy. */
function defaultDirection(difference: CompareDifference): Direction | null {
  if (difference.status === "onlyLeft") return "right";
  if (difference.status === "onlyRight") return "left";
  if (difference.status === "changed" && difference.newer) return difference.newer === "left" ? "right" : "left";
  return null;
}

function statusLabel(difference: CompareDifference) {
  switch (difference.status) {
    case "onlyLeft": return "Only on the left";
    case "onlyRight": return "Only on the right";
    case "typeMismatch": return "Different kinds";
    default:
      if (difference.contentsDiffer) return difference.newer ? `Contents differ · newer on the ${difference.newer}` : "Contents differ";
      if (difference.left?.type === "symlink") return "Links point elsewhere";
      if (difference.newer) return `Newer on the ${difference.newer}`;
      return "Different size";
  }
}

function SideCell({ side }: { side?: CompareSide }) {
  if (!side) return <span className="compare-side muted">—</span>;
  const icon = side.type === "directory" ? <Folder size={13} /> : side.type === "symlink" ? <Link2 size={13} /> : <File size={13} />;
  return <span className="compare-side" title={new Date(side.modified).toLocaleString()}>{icon}<span>{side.type === "directory" ? "Folder" : side.type === "symlink" ? "Link" : formatBytes(side.size)}</span><small>{formatDate(side.modified)}</small></span>;
}

// The file list is refreshed by the file manager when the job it's handed (`onJob`) finishes.
export function FolderCompareDialog({ left, right, canWrite, trashEnabled, onClose, onJob, notify }: {
  left: string;
  right: string;
  canWrite: boolean;
  trashEnabled: boolean;
  onClose: () => void;
  onJob: (job: JobState) => Promise<boolean>;
  notify: (message: string, tone?: "error") => void;
}) {
  const [contents, setContents] = useState(false);
  const [result, setResult] = useState<FolderComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(PAGE);
  // The items chosen to copy, and which side each goes to.
  const [chosen, setChosen] = useState<Map<string, Direction>>(new Map());
  const [syncing, setSyncing] = useState<JobState | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const compare = useCallback(async (byContents: boolean) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ left, right });
      if (byContents) params.set("contents", "1");
      const next = await requestJson<FolderComparison>(`/api/fs/compare?${params}`, { signal: controller.signal });
      setResult(next);
      setChosen(new Map());
      setShown(PAGE);
    } catch (caught) {
      if (!controller.signal.aborted) setError((caught as Error).message);
    } finally {
      if (requestRef.current === controller) setLoading(false);
    }
  }, [left, right]);

  useEffect(() => {
    const timer = window.setTimeout(() => void compare(false), 0);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [compare]);

  // While a sync runs its progress is checked each second; once it's over the folders are compared again.
  useEffect(() => {
    if (!syncing || syncing.status !== "running") return;
    const timer = window.setTimeout(async () => {
      try {
        const { job } = await requestJson<{ job: JobState }>(`/api/fs/jobs?id=${encodeURIComponent(syncing.id)}`);
        setSyncing(job);
        if (job.status !== "running") await compare(contents);
      } catch {
        setSyncing(null);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [syncing, compare, contents]);

  const differences = useMemo(() => result?.differences ?? [], [result]);
  const visible = useMemo(() => (filter === "all" ? differences : differences.filter((item) => item.status === filter)), [differences, filter]);
  const byPath = useMemo(() => new Map(differences.map((item) => [item.path, item])), [differences]);

  const choose = (difference: CompareDifference, direction: Direction | null) => {
    setChosen((current) => {
      const next = new Map(current);
      if (direction) next.set(difference.path, direction);
      else next.delete(difference.path);
      return next;
    });
  };
  const toggle = (difference: CompareDifference) => choose(difference, chosen.has(difference.path) ? null : defaultDirection(difference) ?? "right");
  const flip = (difference: CompareDifference) => choose(difference, (chosen.get(difference.path) ?? defaultDirection(difference) ?? "left") === "right" ? "left" : "right");

  // Quick choices: everything copied towards one side, or each item from its newer copy.
  const chooseAll = (mode: "newer" | Direction) => {
    const next = new Map<string, Direction>();
    for (const item of differences) {
      if (mode === "newer") {
        const direction = defaultDirection(item);
        if (direction) next.set(item.path, direction);
      } else if (item.status !== (mode === "right" ? "onlyRight" : "onlyLeft")) next.set(item.path, mode);
    }
    setChosen(next);
  };
  const allVisibleChosen = visible.length > 0 && visible.every((item) => chosen.has(item.path));
  const toggleVisible = () => {
    setChosen((current) => {
      const next = new Map(current);
      for (const item of visible) {
        if (allVisibleChosen) next.delete(item.path);
        else if (!next.has(item.path)) next.set(item.path, defaultDirection(item) ?? "right");
      }
      return next;
    });
  };

  const plan = [...chosen].map(([itemPath, to]) => ({ item: byPath.get(itemPath)!, to })).filter(({ item }) => item);
  const toRight = plan.filter(({ to }) => to === "right").length;
  const toLeft = plan.length - toRight;
  // Copying onto something that's there replaces it (it goes to the trash).
  const replacing = plan.filter(({ item, to }) => (to === "right" ? item.right : item.left)).length;
  // A file only on one side can't be copied from the side that lacks it.
  const impossible = plan.filter(({ item, to }) => !(to === "right" ? item.left : item.right)).length;

  const sync = async () => {
    if (!result || !plan.length || impossible || plan.length > MAX_SYNC) return;
    try {
      const items = plan.map(({ item, to }) => ({ path: item.path, to, left: item.left ?? null, right: item.right ?? null }));
      const { job } = await requestJson<{ job: JobState }>("/api/fs/compare", { method: "POST", body: JSON.stringify({ action: "sync", left, right, items, bases: { left: result!.leftId, right: result!.rightId } }) });
      setSyncing(job);
      await onJob(job);
    } catch (caught) {
      notify((caught as Error).message, "error");
    }
  };

  const counts = result?.counts;
  const filters: Array<[Filter, string, number]> = counts ? [
    ["all", "All differences", counts.onlyLeft + counts.onlyRight + counts.changed + counts.typeMismatch],
    ["onlyLeft", "Only left", counts.onlyLeft],
    ["onlyRight", "Only right", counts.onlyRight],
    ["changed", "Changed", counts.changed],
    ["typeMismatch", "Different kinds", counts.typeMismatch],
  ] : [];
  const running = syncing?.status === "running";
  const percent = running && syncing.progress.total ? Math.min(100, (syncing.progress.done / syncing.progress.total) * 100) : undefined;
  return (
    <Modal title="Compare folders" subtitle="See what differs between the two sides, and copy it across" icon={<GitCompareArrows size={19} />} onClose={onClose} wide>
      <div className="storage-browser compare-dialog">
        <div className="compare-folders">
          <div><small>Left</small><strong title={folderName(left)}>{folderName(left)}</strong></div>
          <GitCompareArrows size={16} aria-hidden />
          <div><small>Right</small><strong title={folderName(right)}>{folderName(right)}</strong></div>
          <label className="compare-contents" title="Compare files of the same size byte by byte, instead of by their modified times. Slower: every such file is read on both sides."><input type="checkbox" checked={contents} disabled={loading || running} onChange={(event) => { setContents(event.target.checked); void compare(event.target.checked); }} /> Check contents</label>
          <button className="button secondary" disabled={loading || running} onClick={() => void compare(contents)}>{loading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} Compare again</button>
        </div>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        {loading && !result && <div className="snapshot-empty"><LoaderCircle className="spin" size={22} /><strong>Comparing…</strong><span>Both folders are read, along with every folder they share.</span></div>}
        {result && counts && <>
          <div className={`storage-scan-note ${result.complete ? "compare-note" : ""}`}><Info size={15} /> {filters[0][2] ? `${filters[0][2].toLocaleString()} ${filters[0][2] === 1 ? "difference" : "differences"}` : "The folders match"} · {counts.identical.toLocaleString()} identical {counts.identical === 1 ? "item" : "items"}{counts.skipped ? ` · ${counts.skipped.toLocaleString()} skipped (special or unreadable)` : ""}{result.contents ? " · contents checked" : " · by size and modified time"}{!result.complete ? ` · stopped early: ${result.reason === "time" ? "it took too long" : result.reason === "limit" ? "too many items" : "some folders couldn't be read"}` : ""}{result.truncated ? ` · showing the first ${differences.length.toLocaleString()}` : ""}</div>
          {filters[0][2] > 0 && <>
            <div className="compare-filters" role="group" aria-label="Show">
              {filters.filter(([key, , count]) => key === "all" || count > 0).map(([key, label, count]) => <button key={key} className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => { setFilter(key); setShown(PAGE); }}>{label} <span>{count.toLocaleString()}</span></button>)}
            </div>
            {canWrite && <div className="duplicate-actions"><span className="muted">Choose:</span><button className="button secondary" onClick={() => chooseAll("newer")} title="Copy what each side lacks to it, and each changed file from its newer copy">Newer to older, both ways</button><button className="button secondary" onClick={() => chooseAll("right")} title="Make the right side match the left (what's only on the right stays)">Left to right</button><button className="button secondary" onClick={() => chooseAll("left")} title="Make the left side match the right (what's only on the left stays)">Right to left</button>{chosen.size > 0 && <button className="button secondary" onClick={() => setChosen(new Map())}>Clear</button>}</div>}
            <div className="compare-rows" role="table" aria-label="Differences">
              <div className="compare-row compare-head" role="row">
                {canWrite ? <CheckBox checked={allVisibleChosen} onChange={toggleVisible} label="Choose every item shown" /> : <span />}
                <span>Item</span><span>Left</span><span /><span>Right</span>
              </div>
              {visible.slice(0, shown).map((item) => {
                const direction = chosen.get(item.path);
                const parent = parentOf(item.path);
                return (
                  <div key={item.path} className={`compare-row ${direction ? "selected" : ""}`} role="row">
                    {canWrite ? <CheckBox checked={Boolean(direction)} onChange={() => toggle(item)} label={`Copy ${item.path}`} /> : <span />}
                    <span className="compare-name" title={item.path}><bdi>{parent && <span className="muted">{parent}/</span>}{lastSegment(item.path)}</bdi><small>{statusLabel(item)}</small></span>
                    <SideCell side={item.left} />
                    {canWrite
                      ? <button className={`compare-direction ${direction ? "active" : ""}`} onClick={() => flip(item)} aria-label={direction ? `Copying ${direction === "right" ? "left to right" : "right to left"}; switch direction` : "Copy this item"} title={direction ? "Click to copy the other way" : "Choose a direction to copy"}>{(direction ?? defaultDirection(item) ?? "right") === "right" ? <ArrowRight size={15} /> : <ArrowLeft size={15} />}</button>
                      : <span />}
                    <SideCell side={item.right} />
                  </div>
                );
              })}
            </div>
            {visible.length > shown && <div className="storage-show-more"><span>Showing {shown.toLocaleString()} of {visible.length.toLocaleString()}</span><button className="button secondary" onClick={() => setShown((count) => count + PAGE)}>Show more</button></div>}
          </>}
        </>}
        {running && <div className="duplicate-progress" role="status"><div><LoaderCircle className="spin" size={15} /> Copying {syncing.progress.done.toLocaleString()} of {(syncing.progress.total ?? 0).toLocaleString()} items…</div><div className={`job-panel-track ${percent === undefined ? "indeterminate" : ""}`}><span style={percent === undefined ? undefined : { width: `${percent}%` }} /></div></div>}
        <div className="storage-scan-foot">
          <span className="muted">
            {plan.length
              ? `${toRight ? `${toRight.toLocaleString()} to the right` : ""}${toRight && toLeft ? " · " : ""}${toLeft ? `${toLeft.toLocaleString()} to the left` : ""}${replacing ? ` · ${replacing.toLocaleString()} ${replacing === 1 ? "item" : "items"} on the other side replaced (moved to the trash)` : ""}${impossible ? ` · ${impossible.toLocaleString()} can't go that way (nothing to copy from)` : ""}${plan.length > MAX_SYNC ? ` · copy up to ${MAX_SYNC.toLocaleString()} at a time` : ""}`
              : canWrite ? "Tick items to copy them across; the arrow sets which way." : "Your account can view the differences but not copy them."}
          </span>
          <div className="compare-actions">
            <button className="button secondary" onClick={onClose}>Done</button>
            {canWrite && <button className="button primary" disabled={!plan.length || Boolean(impossible) || plan.length > MAX_SYNC || running || loading || (replacing > 0 && !trashEnabled)} title={replacing > 0 && !trashEnabled ? "Protected trash is turned off, so nothing can be replaced" : undefined} onClick={() => void sync()}>{running ? <LoaderCircle className="spin" size={15} /> : <GitCompareArrows size={15} />} Copy {plan.length ? plan.length.toLocaleString() : ""} {plan.length === 1 ? "item" : "items"}</button>}
          </div>
        </div>
      </div>
    </Modal>
  );
}
