"use client";

import { ArrowDown, ArrowUp, ChevronRight, CircleAlert, ImageIcon } from "lucide-react";
import { createElement, useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { visibleText } from "@/lib/activity-text";
import { columnName, guessDelimiter, parseDelimited, parseMarkdown, relativePicturePath, safeLink, sortRows, type MdBlock, type MdInline, type RichKind } from "@/lib/rich-text";

// Markdown, tables (CSV and TSV), and JSON, shown formatted in the preview window. Everything is
// rendered as React elements from the parsed text, never as the file's own HTML; links open only
// web and mail addresses (in a new tab), and only pictures beside the file are loaded, never ones
// from other sites (which would tell them the file was opened).

const MAX_PICTURES = 50;
const TABLE_PAGE = 500;
const JSON_PAGE = 200;
// Long documents and tables in Markdown are shown a part at a time.
const MARKDOWN_PAGE = 1000;

const count = (value: number, noun: string) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;

function PartialNote({ children }: { children: ReactNode }) {
  return <p className="rich-note"><CircleAlert size={14} /> {children}</p>;
}

export function RichPreview({ kind, text, partial, folder, pictureUrl }: {
  kind: RichKind;
  text: string;
  /** Only the start of the file was read. */
  partial: boolean;
  /** The file's folder, for pictures given by relative paths. */
  folder: string;
  /** Where a picture in the root can be loaded from (none: pictures aren't loaded). */
  pictureUrl?: (path: string) => string;
}) {
  if (kind === "markdown") return <MarkdownPreview text={text} partial={partial} folder={folder} pictureUrl={pictureUrl} />;
  if (kind === "json") return <JsonPreview text={text} partial={partial} />;
  return <TablePreview text={text} kind={kind} partial={partial} />;
}

// --- Markdown -------------------------------------------------------------------------------

type Pictures = (src: string, index: number) => string | null;

function MarkdownPreview({ text, partial, folder, pictureUrl }: { text: string; partial: boolean; folder: string; pictureUrl?: (path: string) => string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const [shown, setShown] = useState(MARKDOWN_PAGE);
  const pictures: Pictures = (src, index) => {
    if (!pictureUrl || index >= MAX_PICTURES) return null;
    const path = relativePicturePath(src, folder);
    return path === null ? null : pictureUrl(path);
  };
  return (
    <div className="rich-preview">
      <article className="markdown-preview">
        {partial && <PartialNote>Only the first 2 MB of this file is shown.</PartialNote>}
        <Blocks blocks={blocks.slice(0, shown)} pictures={pictures} />
        {blocks.length > shown && <MoreButton left={blocks.length - shown} noun="part" onClick={() => setShown(shown + MARKDOWN_PAGE)} />}
      </article>
    </div>
  );
}

function Blocks({ blocks, pictures }: { blocks: MdBlock[]; pictures: Pictures }) {
  return <>{blocks.map((block, index) => <Block key={index} block={block} pictures={pictures} />)}</>;
}

function Block({ block, pictures }: { block: MdBlock; pictures: Pictures }): ReactNode {
  switch (block.type) {
    case "heading": return createElement(`h${block.level}`, null, <Inlines nodes={block.children} pictures={pictures} />);
    case "paragraph": return <p><Inlines nodes={block.children} pictures={pictures} /></p>;
    case "code": return <pre><code>{block.text}</code></pre>;
    case "quote": return <blockquote><Blocks blocks={block.children} pictures={pictures} /></blockquote>;
    case "rule": return <hr />;
    case "list": {
      const items = block.items.map((item, index) => {
        // An item's first paragraph sits beside its bullet (or checkbox), without a paragraph's spacing.
        const [first, ...rest] = item.children;
        return (
          <li key={index} className={item.checked === null ? undefined : "task"}>
            {item.checked !== null && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? "Done" : "Not done"} />}
            {first?.type === "paragraph" ? <><Inlines nodes={first.children} pictures={pictures} /><Blocks blocks={rest} pictures={pictures} /></> : <Blocks blocks={item.children} pictures={pictures} />}
          </li>
        );
      });
      return block.ordered ? <ol start={block.start === 1 ? undefined : block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table": return <MarkdownTable block={block} pictures={pictures} />;
  }
}

function MarkdownTable({ block, pictures }: { block: Extract<MdBlock, { type: "table" }>; pictures: Pictures }) {
  const [shown, setShown] = useState(MARKDOWN_PAGE);
  const align = (column: number) => ({ textAlign: block.align[column] ?? undefined });
  return (
    <div className="markdown-table">
      <table>
        <thead><tr>{block.head.map((cell, column) => <th key={column} style={align(column)}><Inlines nodes={cell} pictures={pictures} /></th>)}</tr></thead>
        <tbody>{block.rows.slice(0, shown).map((row, index) => <tr key={index}>{block.head.map((_, column) => <td key={column} style={align(column)}>{row[column] && <Inlines nodes={row[column]} pictures={pictures} />}</td>)}</tr>)}</tbody>
      </table>
      {block.rows.length > shown && <MoreButton left={block.rows.length - shown} noun="row" onClick={() => setShown(shown + MARKDOWN_PAGE)} />}
    </div>
  );
}

function MoreButton({ left, noun, onClick }: { left: number; noun: string; onClick: () => void }) {
  return <button type="button" className="button secondary rich-more" onClick={onClick}>Show {count(Math.min(MARKDOWN_PAGE, left), `more ${noun}`)}</button>;
}

function Inlines({ nodes, pictures }: { nodes: MdInline[]; pictures: Pictures }) {
  return <>{nodes.map((node, index) => <Inline key={index} node={node} pictures={pictures} />)}</>;
}

function Inline({ node, pictures }: { node: MdInline; pictures: Pictures }): ReactNode {
  switch (node.type) {
    case "text": return node.text;
    case "code": return <code>{node.text}</code>;
    case "em": return <em><Inlines nodes={node.children} pictures={pictures} /></em>;
    case "strong": return <strong><Inlines nodes={node.children} pictures={pictures} /></strong>;
    case "del": return <del><Inlines nodes={node.children} pictures={pictures} /></del>;
    case "break": return <br />;
    case "link": {
      const href = safeLink(node.href);
      const children = <Inlines nodes={node.children} pictures={pictures} />;
      // Other links (to other files, or javascript:) show as text, with where they'd go on hover.
      return href
        ? <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={visibleText(href)}>{children}</a>
        : <span className="markdown-link" title={visibleText(node.href)}>{children}</span>;
    }
    case "image": {
      const src = pictures(node.src, node.index);
      // eslint-disable-next-line @next/next/no-img-element -- a picture beside the file, served by FilesDude
      if (src) return <img src={src} alt={node.alt} loading="lazy" />;
      return <span className="markdown-picture" title={visibleText(node.src)}><ImageIcon size={13} />{node.alt || "Picture"}</span>;
    }
  }
}

// --- CSV and TSV ----------------------------------------------------------------------------

type Sort = { column: number; direction: "asc" | "desc" };

function TablePreview({ text, kind, partial }: { text: string; kind: "csv" | "tsv"; partial: boolean }) {
  const parsed = useMemo(() => parseDelimited(text, guessDelimiter(text, kind), { complete: !partial }), [text, kind, partial]);
  const [headings, setHeadings] = useState(true);
  const [sort, setSort] = useState<Sort | null>(null);
  const [filter, setFilter] = useState("");
  const wanted = useDeferredValue(filter.trim().toLocaleLowerCase());
  const [shown, setShown] = useState(TABLE_PAGE);
  const head = headings && parsed.rows.length > 1 ? parsed.rows[0] : null;
  const body = useMemo(() => (head ? parsed.rows.slice(1) : parsed.rows).map((cells, index) => ({ cells, number: index + 1 })), [parsed, head]);
  const rows = useMemo(() => {
    const matching = wanted ? body.filter((row) => row.cells.some((cell) => cell.toLocaleLowerCase().includes(wanted))) : body;
    return sort ? sortRows(matching, (row) => row.cells[sort.column] ?? "", sort.direction) : matching;
  }, [body, wanted, sort]);
  // Each heading sorts up, then down, then back to the file's order.
  const sortBy = (column: number) => setSort((current) => (current?.column !== column ? { column, direction: "asc" } : current.direction === "asc" ? { column, direction: "desc" } : null));
  if (!parsed.rows.length) return <div className="preview-message"><p>This file is empty.</p></div>;
  const columns = Array.from({ length: parsed.columns }, (_, column) => column);
  return (
    <div className="rich-preview table-preview">
      <div className="rich-toolbar">
        <span>{rows.length === body.length ? count(body.length, "row") : `${rows.length.toLocaleString()} of ${count(body.length, "row")}`} · {count(parsed.columns, "column")}</span>
        <label className="rich-check"><input type="checkbox" checked={headings} onChange={(event) => { setHeadings(event.target.checked); setSort(null); }} /> First row is headings</label>
        <input type="search" className="rich-filter" placeholder="Filter rows" aria-label="Filter rows" value={filter} onChange={(event) => { setFilter(event.target.value); setShown(TABLE_PAGE); }} />
      </div>
      {(partial || parsed.truncated) && <PartialNote>Only the first {partial ? "2 MB" : "100,000 rows"} of this file {partial ? "is" : "are"} shown.</PartialNote>}
      {parsed.columnsTruncated && <PartialNote>Only the first {parsed.columns} columns are shown.</PartialNote>}
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="row-number" scope="col">#</th>
              {columns.map((column) => (
                <th key={column} scope="col" aria-sort={sort?.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}>
                  <button type="button" title="Sort by this column" onClick={() => sortBy(column)}>
                    <span>{head?.[column] || columnName(column)}</span>
                    {sort?.column === column && (sort.direction === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, shown).map((row) => <tr key={row.number}><td className="row-number">{row.number}</td>{columns.map((column) => <td key={column}>{row.cells[column] ?? ""}</td>)}</tr>)}
          </tbody>
        </table>
        {!rows.length && <p className="rich-empty">No rows match.</p>}
      </div>
      {rows.length > shown && <button type="button" className="button secondary rich-more" onClick={() => setShown(shown + TABLE_PAGE)}>Show {Math.min(TABLE_PAGE, rows.length - shown).toLocaleString()} more rows</button>}
    </div>
  );
}

// --- JSON -----------------------------------------------------------------------------------

function JsonPreview({ text, partial }: { text: string; partial: boolean }) {
  const parsed = useMemo((): { value: unknown } | { error: string } => {
    if (partial) return { error: "Only the first 2 MB of this file was read, which isn't a whole JSON document, so it's shown as text." };
    try {
      return { value: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown };
    } catch (error) {
      // Including JSON nested too deeply to read.
      return { error: `This isn't valid JSON (${(error as Error).message}), so it's shown as text.` };
    }
  }, [text, partial]);
  if ("error" in parsed) return <div className="rich-preview rich-fallback"><PartialNote>{parsed.error}</PartialNote><pre className="text-preview">{text}</pre></div>;
  return <div className="rich-preview json-preview"><JsonNode label={null} value={parsed.value} depth={0} /></div>;
}

function JsonValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <span className="json-string">{visibleText(JSON.stringify(value))}</span>;
  if (typeof value === "number") return <span className="json-number">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="json-boolean">{String(value)}</span>;
  return <span className="json-null">null</span>;
}

function JsonNode({ label, value, depth, index = false }: { label: string | null; value: unknown; depth: number; index?: boolean }) {
  // The first two levels start open; the rest open when asked, so a huge document costs nothing until then.
  const [open, setOpen] = useState(depth < 2);
  const [limit, setLimit] = useState(JSON_PAGE);
  const key = label === null ? null : <span><span className={index ? "json-index" : "json-key"}>{visibleText(label)}</span>: </span>;
  // Each level is indented; values without a toggle line up with the keys beside one.
  const indent = (level: number, toggle: boolean) => ({ paddingLeft: 12 + level * 16 + (toggle ? 0 : 17) });
  if (value === null || typeof value !== "object") return <div className="json-row" style={indent(depth, false)}>{key}<JsonValue value={value} /></div>;
  const array = Array.isArray(value);
  const size = array ? value.length : Object.keys(value).length;
  const entries = open ? (array ? value.slice(0, limit).map((item, position) => [String(position), item] as const) : Object.entries(value).slice(0, limit)) : [];
  return (
    <div className="json-node">
      <button type="button" className="json-row json-toggle" style={indent(depth, true)} aria-expanded={open} disabled={!size} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className={open ? "open" : undefined} />{key}<span className="json-summary">{array ? `[ ${count(size, "item")} ]` : `{ ${count(size, "key")} }`}</span>
      </button>
      {entries.map(([childKey, child]) => <JsonNode key={childKey} label={childKey} index={array} value={child} depth={depth + 1} />)}
      {open && size > limit && <button type="button" className="text-button json-more" style={indent(depth + 1, false)} onClick={() => setLimit(limit + JSON_PAGE)}>Show {Math.min(JSON_PAGE, size - limit).toLocaleString()} more</button>}
    </div>
  );
}
