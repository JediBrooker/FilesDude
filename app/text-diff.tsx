"use client";

import { CircleAlert, Diff, LoaderCircle } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { diffLines, lines, sideBySide, unfold, type DiffCell, type DiffOp, type DiffRow } from "@/lib/text-diff";
import { Modal } from "./file-manager";

// Two text files side by side, with what changed between them marked: two files chosen in the
// list, or an earlier version of a file (from a snapshot) and the current one.

export type DiffSource = { label: string; url: string };

// Each side is read only this far (a huge log would otherwise be read whole).
const MAX_BYTES = 1024 * 1024;

type Loaded = { text: string; truncated: boolean };

/** The start of a file as text, at most MAX_BYTES of it, or an error for one that isn't text. */
async function readText(url: string, signal: AbortSignal): Promise<Loaded> {
  const response = await fetch(url, { signal, credentials: "same-origin", headers: { Range: `bytes=0-${MAX_BYTES}` } });
  if (!response.ok || !response.body) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error || "The file couldn't be read");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size <= MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.max(0, bytes.length - offset));
    bytes.set(part, offset);
    offset += part.length;
  }
  if (bytes.subarray(0, 8000).includes(0)) throw new Error("This isn't a text file");
  return { text: new TextDecoder().decode(bytes), truncated: size > MAX_BYTES };
}

function Cell({ cell, side }: { cell?: DiffCell; side: "left" | "right" }) {
  if (!cell) return <><span className="diff-number" /><span className="diff-text empty" /></>;
  const [start, end] = cell.changed ?? [0, 0];
  const text = cell.changed && end > start
    ? <>{cell.text.slice(0, start)}<mark className={side === "left" ? "diff-removed-part" : "diff-added-part"}>{cell.text.slice(start, end)}</mark>{cell.text.slice(end)}</>
    : cell.text;
  return <><span className="diff-number">{cell.line}</span><span className="diff-text">{text || " "}</span></>;
}

export function TextDiffDialog({ left, right, onClose }: { left: DiffSource; right: DiffSource; onClose: () => void }) {
  const [loaded, setLoaded] = useState<[Loaded, Loaded] | null>(null);
  const [error, setError] = useState("");
  // Folded stretches opened, by where they start.
  const [opened, setOpened] = useState<Set<number>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([readText(left.url, controller.signal), readText(right.url, controller.signal)])
      .then((both) => setLoaded(both))
      .catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message); });
    return () => controller.abort();
  }, [left.url, right.url]);

  const ops = useMemo<DiffOp[] | null | undefined>(() => (loaded ? diffLines(lines(loaded[0].text), lines(loaded[1].text)) : undefined), [loaded]);
  const rows = useMemo<DiffRow[]>(() => (ops ? sideBySide(ops) : []), [ops]);
  const removed = ops?.filter((op) => op.type === "removed").length ?? 0;
  const added = ops?.filter((op) => op.type === "added").length ?? 0;
  return (
    <Modal title="Compare files" subtitle="What changed between them, line by line" icon={<Diff size={19} />} onClose={onClose} wide>
      <div className="storage-browser text-diff">
        <div className="text-diff-heads"><strong title={left.label}><bdi>{left.label}</bdi></strong><strong title={right.label}><bdi>{right.label}</bdi></strong></div>
        {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
        {!loaded && !error && <div className="snapshot-empty"><LoaderCircle className="spin" size={22} /><span>Reading both files…</span></div>}
        {loaded && (loaded[0].truncated || loaded[1].truncated) && <div className="storage-scan-note"><CircleAlert size={15} /> Only the first megabyte of {loaded[0].truncated && loaded[1].truncated ? "each file" : loaded[0].truncated ? "the left file" : "the right file"} is compared.</div>}
        {ops === null && <div className="snapshot-empty"><Diff size={22} /><strong>Too different to compare line by line</strong><span>These files differ in thousands of places.</span></div>}
        {ops && <>
          <div className="text-diff-summary muted">{removed || added ? <><span className="diff-count-removed">−{removed.toLocaleString()}</span> <span className="diff-count-added">+{added.toLocaleString()}</span> {removed + added === 1 ? "line" : "lines"}</> : "The files are the same"}</div>
          <div className="text-diff-rows" role="table" aria-label="Differences">
            {rows.map((row, index) => {
              if (row.kind === "fold") {
                if (!opened.has(row.from)) return <button key={`fold-${row.from}`} className="diff-fold" onClick={() => setOpened(new Set([...opened, row.from]))}>Show {row.count.toLocaleString()} unchanged {row.count === 1 ? "line" : "lines"}</button>;
                return <Fragment key={`fold-${row.from}`}>{unfold(ops, row.from, row.count).map((same, offset) => same.kind === "fold" ? null : <div key={`unfolded-${row.from}-${offset}`} className="diff-row same" role="row"><Cell cell={same.left} side="left" /><Cell cell={same.right} side="right" /></div>)}</Fragment>;
              }
              return <div key={index} className={`diff-row ${row.kind}`} role="row"><Cell cell={row.left} side="left" /><Cell cell={row.right} side="right" /></div>;
            })}
          </div>
        </>}
        <div className="storage-scan-foot"><span className="muted">Compares the text of the files as they are now.</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}
