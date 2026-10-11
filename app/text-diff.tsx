"use client";

import { CircleAlert, Diff, LoaderCircle } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";
import { allRows, diffLines, foldRows, lines, MAX_EDITS, type DiffCell, type DiffOp, type DiffRow } from "@/lib/text-diff";
import { Modal } from "./file-manager";

// Two text files side by side, with what changed between them marked: two files chosen in the
// list, or an earlier version of a file (from a snapshot) and the current one.

export type DiffSource = { label: string; url: string };

// Each side is read only this far (a huge log would otherwise be read whole).
const MAX_BYTES = 1024 * 1024;
// A folded stretch opens this many lines at a time.
const UNFOLD_STEP = 200;

type Loaded = { text: string; raw: string; truncated: boolean };

/** The start of a file as text, at most MAX_BYTES of it, or an error for one that isn't text. */
async function readText(url: string, signal: AbortSignal): Promise<Loaded> {
  const response = await fetch(url, { signal, credentials: "same-origin", headers: { Range: `bytes=0-${MAX_BYTES}` } });
  // An empty file has no bytes to ask for.
  if (response.status === 416) return { text: "", raw: "", truncated: false };
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
  let bytes = new Uint8Array(Math.min(size, MAX_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.max(0, bytes.length - offset));
    bytes.set(part, offset);
    offset += part.length;
  }
  if (bytes.subarray(0, 8000).includes(0)) throw new Error("This isn't a text file");
  const truncated = size > MAX_BYTES;
  // Cut short, the last line (and any character split at the cut) is left out.
  if (truncated) bytes = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
  const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  return { text: raw.replace(/^\ufeff/, ""), raw, truncated };
}

const MARKS: Record<string, [string, string]> = { same: [" ", "Unchanged"], changed: ["~", "Changed"], removed: ["−", "Removed"], added: ["+", "Added"] };

function Cell({ cell, side }: { cell?: DiffCell; side: "left" | "right" }) {
  if (!cell) return <><span className="diff-number" /><span className="diff-text empty" /></>;
  const [start, end] = cell.changed ?? [0, 0];
  const text = cell.changed && end > start
    ? <>{cell.text.slice(0, start)}<mark className={side === "left" ? "diff-removed-part" : "diff-added-part"}>{cell.text.slice(start, end)}</mark>{cell.text.slice(end)}</>
    : cell.text;
  return <><span className="diff-number">{cell.line}</span><span className="diff-text">{text || " "}</span></>;
}

function Row({ row }: { row: Exclude<DiffRow, { kind: "fold" }> }) {
  const [mark, label] = MARKS[row.kind];
  const where = [row.left && `line ${row.left.line} on the left`, row.right && `line ${row.right.line} on the right`].filter(Boolean).join(", ");
  return (
    <div className={`diff-row ${row.kind}`} role="listitem">
      <span className="visually-hidden">{label}, {where}: </span>
      <span className="diff-mark" aria-hidden>{mark}</span>
      <Cell cell={row.left} side="left" /><Cell cell={row.right} side="right" />
    </div>
  );
}

export function TextDiffDialog({ left, right, onClose }: { left: DiffSource; right: DiffSource; onClose: () => void }) {
  const [loaded, setLoaded] = useState<[Loaded, Loaded] | null>(null);
  const [error, setError] = useState("");
  // How much of each folded stretch is open, by where it starts.
  const [opened, setOpened] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([readText(left.url, controller.signal), readText(right.url, controller.signal)])
      .then((both) => setLoaded(both))
      .catch((caught: Error) => { if (!controller.signal.aborted) setError(caught.message); });
    return () => controller.abort();
  }, [left.url, right.url]);

  const ops = useMemo<DiffOp[] | null | undefined>(() => (loaded ? diffLines(lines(loaded[0].text), lines(loaded[1].text)) : undefined), [loaded]);
  const rows = useMemo(() => (ops ? allRows(ops) : []), [ops]);
  const shown = useMemo(() => foldRows(rows), [rows]);
  const counts = useMemo(() => ({ removed: ops?.filter((op) => op.type === "removed").length ?? 0, added: ops?.filter((op) => op.type === "added").length ?? 0 }), [ops]);
  const same = ops && !counts.removed && !counts.added;
  const invisible = same && loaded && loaded[0].raw !== loaded[1].raw;
  return (
    <Modal title="Compare files" subtitle="What changed between them, line by line" icon={<Diff size={19} />} onClose={onClose} wide>
      <div className="storage-browser text-diff">
        <div className="text-diff-heads"><strong title={left.label}><bdi>{left.label}</bdi></strong><strong title={right.label}><bdi>{right.label}</bdi></strong></div>
        <div aria-live="polite">
          {error && <div className="form-error"><CircleAlert size={16} />{error}</div>}
          {!loaded && !error && <div className="snapshot-empty"><LoaderCircle className="spin" size={22} /><span>Reading both files…</span></div>}
        </div>
        {loaded && (loaded[0].truncated || loaded[1].truncated) && <div className="storage-scan-note"><CircleAlert size={15} /> Only the first megabyte of {loaded[0].truncated && loaded[1].truncated ? "each file" : loaded[0].truncated ? "the left file" : "the right file"} is compared.</div>}
        {ops === null && <div className="snapshot-empty"><Diff size={22} /><strong>Too different to compare line by line</strong><span>More than {MAX_EDITS.toLocaleString()} lines would have to be removed or added.</span></div>}
        {ops && <>
          <div className="text-diff-summary muted">{same ? (invisible ? "The text is the same; they differ only in line endings, a final newline, or a byte-order mark" : "The files are the same") : <><span className="diff-count-removed">−{counts.removed.toLocaleString()}</span> <span className="diff-count-added">+{counts.added.toLocaleString()}</span> {counts.removed + counts.added === 1 ? "line" : "lines"}</>}</div>
          {shown.length > 0 && <div className="text-diff-rows" role="list" aria-label="Lines">
            {shown.map((row, index) => {
              if (row.kind !== "fold") return <Row key={index} row={row} />;
              const open = Math.min(opened.get(row.from) ?? 0, row.count);
              const left = row.count - open;
              return (
                <Fragment key={`fold-${row.from}`}>
                  {rows.slice(row.from, row.from + open).map((same, offset) => same.kind === "fold" ? null : <Row key={`open-${row.from}-${offset}`} row={same} />)}
                  {left > 0 && <div role="listitem"><button className="diff-fold" onClick={() => setOpened(new Map(opened).set(row.from, open + Math.min(left, UNFOLD_STEP)))}>{open ? "Show more:" : "Show"} {Math.min(left, UNFOLD_STEP).toLocaleString()} {left > UNFOLD_STEP ? `of ${left.toLocaleString()} ` : ""}unchanged {left === 1 ? "line" : "lines"}</button></div>}
                </Fragment>
              );
            })}
          </div>}
        </>}
        <div className="storage-scan-foot"><span className="muted">Lines marked − are only on the left, + only on the right, and ~ changed.</span><button className="button primary" onClick={onClose}>Done</button></div>
      </div>
    </Modal>
  );
}
