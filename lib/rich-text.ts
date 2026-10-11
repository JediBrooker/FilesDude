// Text files shown formatted in the preview window: Markdown parsed into blocks and inlines (which
// the page renders as React elements, never as HTML), CSV and TSV into rows, and which files get
// which. Runs in the browser on up to 2 MB of text, so nothing here may take more than linear-ish
// time on any input: no regular expression can backtrack over a long run, and searches that fail
// are remembered rather than repeated.

export type RichKind = "markdown" | "csv" | "tsv" | "json";

/** The formatted preview a file gets, if any. */
export function richKind(name: string, mime: string): RichKind | null {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (mime === "text/markdown" || ["md", "markdown", "mdown", "mkd"].includes(extension)) return "markdown";
  if (mime === "text/csv" || extension === "csv") return "csv";
  if (mime === "text/tab-separated-values" || extension === "tsv" || extension === "tab") return "tsv";
  if (mime === "application/json" || mime.endsWith("+json") || extension === "json" || extension === "geojson") return "json";
  return null;
}

const withoutBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

// ---------------------------------------------------------------------------------------------
// CSV and TSV

/** A TSV file's tab; for CSV, whichever of comma, semicolon (as Excel writes in much of Europe), or tab the first line uses most. */
export function guessDelimiter(text: string, kind: "csv" | "tsv") {
  if (kind === "tsv") return "\t";
  const counts = new Map([[",", 0], [";", 0], ["\t", 0]]);
  let quoted = false;
  for (let index = 0; index < Math.min(text.length, 65_536); index += 1) {
    const character = text[index];
    if (character === "\"") quoted = !quoted;
    else if (!quoted && (character === "\n" || character === "\r")) break;
    else if (!quoted && counts.has(character)) counts.set(character, counts.get(character)! + 1);
  }
  let best = ",";
  for (const [delimiter, count] of counts) if (count > counts.get(best)!) best = delimiter;
  return best;
}

export type Delimited = { rows: string[][]; columns: number; truncated: boolean; columnsTruncated: boolean };

/**
 * Rows of a CSV or TSV file (quoted fields, doubled quotes, and line breaks inside quotes as in RFC
 * 4180). Blank lines are skipped. When the text is only the start of the file (`complete: false`),
 * its last row may be cut short, so it's left out.
 */
export function parseDelimited(source: string, delimiter: string, options: { complete?: boolean; maxRows?: number; maxColumns?: number } = {}): Delimited {
  const { complete = true, maxRows = 100_000, maxColumns = 200 } = options;
  const text = withoutBom(source);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  let columns = 0;
  let truncated = !complete;
  let columnsTruncated = false;
  const endCell = () => {
    if (row.length < maxColumns) row.push(cell);
    else columnsTruncated = true;
    cell = "";
    started = false;
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
      columns = Math.max(columns, row.length);
    }
    row = [];
  };
  let index = 0;
  let ended = true;
  for (; index < text.length; index += 1) {
    const character = text[index];
    ended = false;
    if (quoted) {
      if (character !== "\"") cell += character;
      else if (text[index + 1] === "\"") {
        cell += "\"";
        index += 1;
      } else quoted = false;
      continue;
    }
    if (character === "\"" && !started) {
      quoted = true;
      started = true;
    } else if (character === delimiter) endCell();
    else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      endRow();
      ended = true;
      if (rows.length >= maxRows) {
        if (index + 1 < text.length) truncated = true;
        break;
      }
    } else {
      cell += character;
      started = true;
    }
  }
  // The last row, unless it may have been cut off (but not when it's the only one).
  if (!ended && (complete || rows.length === 0)) endRow();
  return { rows, columns, truncated, columnsTruncated };
}

// A number as tables write them: 1234, -1,234.5, 1e6, $12, 45%.
const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

export function cellNumber(value: string) {
  let text = value.trim();
  if (text.length > 64) return null;
  text = text.replace(/^\$/, "").replace(/%$/, "");
  if (!/\d/.test(text) || !NUMBER.test(text)) return null;
  const number = Number(text.replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Rows sorted by one cell (stable): as numbers when every filled cell is one, otherwise as text
 * with numbers inside it in order ("file 9" before "file 10"). Empty cells go last either way.
 */
export function sortRows<T>(items: T[], cell: (item: T) => string, direction: "asc" | "desc"): T[] {
  const keyed = items.map((item, index) => {
    const value = cell(item) ?? "";
    return { item, index, value, number: cellNumber(value), empty: value.trim() === "" };
  });
  const numeric = keyed.every((key) => key.empty || key.number !== null);
  const sign = direction === "asc" ? 1 : -1;
  keyed.sort((a, b) => {
    if (a.empty || b.empty) return a.empty === b.empty ? a.index - b.index : a.empty ? 1 : -1;
    const order = numeric ? a.number! - b.number! : collator.compare(a.value, b.value);
    return order * sign || a.index - b.index;
  });
  return keyed.map((key) => key.item);
}

/** A spreadsheet's name for a column: A, B, ... Z, AA, AB, ... */
export function columnName(index: number) {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  return name;
}

// ---------------------------------------------------------------------------------------------
// Markdown (CommonMark's common parts and GitHub's tables, task lists, strikethrough, and bare links)

export type MdInline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "em" | "strong" | "del"; children: MdInline[] }
  | { type: "link"; href: string; children: MdInline[] }
  | { type: "image"; src: string; alt: string; index: number }
  | { type: "break" };

export type MdAlign = "left" | "center" | "right" | null;
export type MdListItem = { checked: boolean | null; children: MdBlock[] };
export type MdBlock =
  | { type: "heading"; level: number; children: MdInline[] }
  | { type: "paragraph"; children: MdInline[] }
  | { type: "code"; language: string; text: string }
  | { type: "quote"; children: MdBlock[] }
  | { type: "list"; ordered: boolean; start: number; items: MdListItem[] }
  | { type: "table"; align: MdAlign[]; head: MdInline[][]; rows: MdInline[][][] }
  | { type: "rule" };

type Context = { definitions: Map<string, string>; images: number };

// Lists and quotes nest this deep at most; deeper text is shown as plain paragraphs.
const MAX_BLOCK_DEPTH = 12;
const MAX_INLINE_DEPTH = 8;
// Longer runs of backticks are just text (which keeps the kinds of closer searched for few).
const MAX_BACKTICKS = 16;
const MAX_TABLE_COLUMNS = 64;

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const RULE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const BULLET = /^( {0,3})([-*+])( *)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])( *)/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
const DEFINITION = /^ {0,3}\[([^\]]{1,200})\]:[ \t]*<?([^\s<>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED = /^ {4}/;
const COMMENT = /^ {0,3}<!--/;

const normalizeLabel = (label: string) => label.trim().toLowerCase().split(/\s+/).join(" ");

/** Leading tabs as spaces (to the next multiple of four), so indents can be counted. */
function expandIndent(line: string) {
  if (!line.startsWith("\t") && !line.startsWith(" \t") && !line.startsWith("  \t") && !line.startsWith("   \t")) return line;
  let column = 0;
  let index = 0;
  for (; index < line.length && (line[index] === " " || line[index] === "\t"); index += 1) column = line[index] === "\t" ? column + 4 - (column % 4) : column + 1;
  return " ".repeat(column) + line.slice(index);
}

const leadingSpaces = (line: string) => line.length - line.trimStart().length;
const isBlank = (line: string) => line.trim() === "";

type Marker = { ordered: boolean; start: number; symbol: string; contentIndent: number; rest: string };

function listMarker(line: string): Marker | null {
  const bullet = BULLET.exec(line);
  const ordered = bullet ? null : ORDERED.exec(line);
  const match = bullet ?? ordered;
  if (!match) return null;
  const spaces = match[match.length - 1].length;
  const markerEnd = match[0].length - spaces;
  const rest = line.slice(match[0].length);
  // A marker needs a space after it, unless the item is empty.
  if (!spaces && rest) return null;
  const contentIndent = !rest || spaces > 4 ? markerEnd + 1 : markerEnd + spaces;
  return { ordered: Boolean(ordered), start: ordered ? Number(ordered[2]) : 1, symbol: bullet ? bullet[2] : ordered![3], contentIndent, rest: spaces > 4 ? line.slice(markerEnd + 1) : rest };
}

/** A line that ends a paragraph by starting something else. */
function startsBlock(line: string) {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || COMMENT.test(line)) return true;
  const marker = listMarker(line);
  return Boolean(marker && marker.rest.trim() && (!marker.ordered || marker.start === 1));
}

function headingText(raw: string) {
  let text = raw.trim();
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end === 0) return "";
  if (end < text.length && (text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trimEnd();
  return text;
}

/** A table row's cells, split at pipes that aren't escaped. */
function tableCells(line: string) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && text[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (text[index] === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += text[index];
  }
  cells.push(cell.trim());
  return cells;
}

function parseBlocks(lines: string[], context: Context, depth: number): MdBlock[] {
  const blocks: MdBlock[] = [];
  let index = 0;
  const inline = (text: string) => parseInline(text, context);
  while (index < lines.length) {
    const line = lines[index];
    if (isBlank(line)) {
      index += 1;
      continue;
    }
    // Too deeply nested: the rest is plain paragraphs.
    if (depth >= MAX_BLOCK_DEPTH) {
      const paragraph: string[] = [];
      while (index < lines.length && !isBlank(lines[index])) paragraph.push(lines[index++].trim());
      blocks.push({ type: "paragraph", children: [{ type: "text", text: paragraph.join("\n") }] });
      continue;
    }
    // HTML comments are hidden; other HTML shows as the text it is.
    if (COMMENT.test(line)) {
      while (index < lines.length && !lines[index].includes("-->")) index += 1;
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const indent = leadingSpaces(line);
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const closing = CLOSING_FENCE.exec(lines[index]);
        if (closing && closing[1][0] === fence[1][0] && closing[1].length >= fence[1].length) {
          index += 1;
          break;
        }
        const next = lines[index++];
        body.push(next.slice(Math.min(indent, leadingSpaces(next))));
      }
      blocks.push({ type: "code", language: fence[2] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, children: inline(headingText(line.slice(heading[0].length))) });
      index += 1;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: "rule" });
      index += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      // Lines without ">" carry on the quote's paragraph (lazily), up to a blank line.
      while (index < lines.length && !isBlank(lines[index]) && (QUOTE.test(lines[index]) || (inner.length > 0 && !startsBlock(lines[index])))) inner.push(lines[index++].replace(QUOTE, ""));
      blocks.push({ type: "quote", children: parseBlocks(inner, context, depth + 1) });
      continue;
    }
    if (line.includes("|") && index + 1 < lines.length && TABLE_DELIMITER.test(lines[index + 1])) {
      const head = tableCells(line);
      const delimiters = tableCells(lines[index + 1]);
      if (head.length === delimiters.length && head.length <= MAX_TABLE_COLUMNS) {
        const align = delimiters.map((cell): MdAlign => (cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null));
        index += 2;
        const rows: MdInline[][][] = [];
        while (index < lines.length && !isBlank(lines[index]) && !startsBlock(lines[index])) {
          // Only the cells a row has (missing ones are shown empty), so short rows stay small.
          rows.push(tableCells(lines[index++]).slice(0, head.length).map(inline));
        }
        blocks.push({ type: "table", align, head: head.map(inline), rows });
        continue;
      }
    }
    if (INDENTED.test(line)) {
      const body: string[] = [];
      while (index < lines.length && (INDENTED.test(lines[index]) || isBlank(lines[index]))) body.push(lines[index++].slice(4));
      while (body.length && isBlank(body[body.length - 1])) body.pop();
      blocks.push({ type: "code", language: "", text: body.join("\n") });
      continue;
    }
    const marker = listMarker(line);
    if (marker) {
      const items: MdListItem[] = [];
      while (index < lines.length) {
        const item = listMarker(lines[index]);
        if (!item || item.ordered !== marker.ordered || item.symbol !== marker.symbol || RULE.test(lines[index])) break;
        const itemLines = [item.rest];
        index += 1;
        let afterBlank = false;
        while (index < lines.length) {
          const next = lines[index];
          if (isBlank(next)) {
            itemLines.push("");
            afterBlank = true;
          } else if (leadingSpaces(next) >= item.contentIndent) {
            itemLines.push(next.slice(item.contentIndent));
            afterBlank = false;
          } else if (afterBlank || listMarker(next) || startsBlock(next)) break;
          // An unindented line straight after carries on the item's paragraph.
          else itemLines.push(next);
          index += 1;
        }
        while (itemLines.length && isBlank(itemLines[itemLines.length - 1])) itemLines.pop();
        let checked: boolean | null = null;
        const task = /^\[([ xX])\](?:[ \t]|$)/.exec(itemLines[0] ?? "");
        if (task) {
          checked = task[1] !== " ";
          itemLines[0] = itemLines[0].slice(task[0].length);
        }
        items.push({ checked, children: parseBlocks(itemLines, context, depth + 1) });
      }
      blocks.push({ type: "list", ordered: marker.ordered, start: marker.start, items });
      continue;
    }
    // Link definitions ([label]: url) are used by links, not shown.
    if (DEFINITION.test(line)) {
      index += 1;
      continue;
    }
    const paragraph = [line.trimStart()];
    index += 1;
    let level = 0;
    while (index < lines.length && !isBlank(lines[index])) {
      const next = lines[index];
      if (SETEXT_1.test(next) || SETEXT_2.test(next)) {
        level = SETEXT_1.test(next) ? 1 : 2;
        index += 1;
        break;
      }
      if (startsBlock(next)) break;
      paragraph.push(next.replace(/^[ \t]+/, ""));
      index += 1;
    }
    const text = paragraph.join("\n").trimEnd();
    blocks.push(level ? { type: "heading", level, children: inline(text) } : { type: "paragraph", children: inline(text) });
  }
  return blocks;
}

/** Markdown as blocks, ready to render. */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = withoutBom(source).split(/\r\n|\r|\n/).map(expandIndent);
  // Link definitions can come after the links that use them, so they're gathered first (outside fenced code).
  const definitions = new Map<string, string>();
  let fence: string | null = null;
  for (const line of lines) {
    const match: RegExpExecArray | null = (fence ? CLOSING_FENCE : FENCE).exec(line);
    if (match && (!fence || (match[1][0] === fence[0] && match[1].length >= fence.length))) fence = fence ? null : match[1];
    else if (!fence) {
      const definition = DEFINITION.exec(line);
      if (definition && !definitions.has(normalizeLabel(definition[1]))) definitions.set(normalizeLabel(definition[1]), unescapeMarkdown(definition[2]));
    }
  }
  return parseBlocks(lines, { definitions, images: 0 }, 0);
}

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/;
const ENTITY = /&(#\d{1,7}|#[xX][\da-fA-F]{1,6}|[a-zA-Z][a-zA-Z\d]{1,31});/y;
const AUTOLINK = /<((?:https?|mailto):[^\s<>]*|[^\s<>@]+@[^\s<>@]+)>/iy;
const BARE_LINK = /(?:https?:\/\/|www\.)[^\s<]+/iy;
const NAMED_ENTITIES: Record<string, number> = {
  amp: 38, lt: 60, gt: 62, quot: 34, apos: 39, nbsp: 160, copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211,
  laquo: 171, raquo: 187, middot: 183, bull: 8226, rarr: 8594, larr: 8592, uarr: 8593, darr: 8595, times: 215, deg: 176, euro: 8364, pound: 163,
};

function unescapeMarkdown(text: string) {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\\" && PUNCTUATION.test(text[index + 1] ?? "")) index += 1;
    result += text[index];
  }
  return result;
}

function entity(name: string) {
  if (name[0] !== "#") return Object.hasOwn(NAMED_ENTITIES, name) ? String.fromCodePoint(NAMED_ENTITIES[name]) : null;
  const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return String.fromCodePoint(!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code);
}

/** Where each [ is closed, matched in one pass (escaped brackets don't count). */
function matchBrackets(source: string) {
  const closes = new Map<number, number>();
  const open: number[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\") index += 1;
    else if (character === "[") open.push(index);
    else if (character === "]" && open.length) closes.set(open.pop()!, index);
  }
  return closes;
}

/** A run of exactly `length` backticks from `from` on, or -1. */
function findBackticks(source: string, from: number, length: number) {
  for (let at = source.indexOf("`", from); at >= 0; at = source.indexOf("`", at)) {
    let run = 1;
    while (source[at + run] === "`") run += 1;
    if (run === length) return at;
    at += run;
  }
  return -1;
}

/** Where emphasis opened with `length` of `character` closes: a run at least as long, after something that isn't a space. */
function findCloser(source: string, from: number, character: string, length: number) {
  for (let at = source.indexOf(character, from); at >= 0; at = source.indexOf(character, at)) {
    let run = 1;
    while (source[at + run] === character) run += 1;
    const before = source[at - 1] ?? " ";
    const after = source[at + run] ?? " ";
    if (run >= length && (character === "~" ? run === length : true) && !WHITESPACE.test(before) && (character !== "_" || !WORD.test(after))) return at + run - length;
    at += run;
  }
  return -1;
}

type ParsedLink = { label: string; href: string; end: number };
/** How much more of the text looking for links' addresses may read, so failed attempts can't add up to more than a few passes over it. */
type Budget = { left: number };

/** Where `character` is within `limit` characters from `from` on, or -1 (reading no further). */
function indexWithin(source: string, character: string, from: number, limit: number, budget: Budget) {
  const window = source.slice(from, from + limit + 1);
  budget.left -= window.length;
  const found = window.indexOf(character);
  return found < 0 ? -1 : from + found;
}

/** A link or image starting at the [ at `open`: inline (url "title"), full [label][ref], collapsed [ref][], or shortcut [ref]. */
function parseLink(source: string, open: number, brackets: Map<number, number>, context: Context, budget: Budget): ParsedLink | null {
  const close = brackets.get(open);
  if (close === undefined) return null;
  const label = source.slice(open + 1, close);
  if (source[close + 1] === "(") {
    if (budget.left <= 0) return null;
    let index = close + 2;
    while (source[index] === " " || source[index] === "\n") index += 1;
    let href = "";
    if (source[index] === "<") {
      const end = indexWithin(source, ">", index, 4096, budget);
      if (end < 0 || source.slice(index, end).includes("\n")) return null;
      href = source.slice(index + 1, end);
      index = end + 1;
    } else {
      const start = index;
      let depth = 0;
      for (; index < source.length && index - start <= 4096; index += 1) {
        budget.left -= 1;
        const character = source[index];
        if (character === "\\") index += 1;
        else if (WHITESPACE.test(character)) break;
        else if (character === "(") depth += 1;
        else if (character === ")") {
          if (!depth) break;
          depth -= 1;
        }
      }
      if (index - start > 4096) return null;
      href = source.slice(start, index);
    }
    while (source[index] === " " || source[index] === "\n") index += 1;
    const quote = source[index];
    if (quote === "\"" || quote === "'" || quote === "(") {
      const end = indexWithin(source, quote === "(" ? ")" : quote, index + 1, 1024, budget);
      if (end < 0) return null;
      index = end + 1;
      while (source[index] === " " || source[index] === "\n") index += 1;
    }
    if (source[index] !== ")") return null;
    return { label, href: unescapeMarkdown(href), end: index + 1 };
  }
  if (source[close + 1] === "[") {
    const refClose = brackets.get(close + 1);
    if (refClose !== undefined) {
      const reference = source.slice(close + 2, refClose) || label;
      // Labels are at most 999 characters (as in CommonMark), so a long one isn't worth looking up.
      if (reference.length > 999) return null;
      const href = context.definitions.get(normalizeLabel(reference));
      return href === undefined ? null : { label, href, end: refClose + 1 };
    }
  }
  const href = label.length <= 200 ? context.definitions.get(normalizeLabel(label)) : undefined;
  return href === undefined ? null : { label, href, end: close + 1 };
}

/** Inline Markdown: code, emphasis, strikethrough, links, pictures, line breaks, escapes, and entities. */
function parseInline(source: string, context: Context, depth = 0, inLink = false): MdInline[] {
  if (depth >= MAX_INLINE_DEPTH) return [{ type: "text", text: source }];
  const nodes: MdInline[] = [];
  let text = "";
  const flush = () => {
    if (text) nodes.push({ type: "text", text });
    text = "";
  };
  const brackets = matchBrackets(source);
  const budget: Budget = { left: 2 * source.length + 65_536 };
  // Searches that found no closer, by what they looked for and from where: one from later on can't find one either.
  const noCloser = new Map<string, number>();
  const search = (key: string, from: number, find: () => number) => {
    const failedFrom = noCloser.get(key);
    if (failedFrom !== undefined && failedFrom <= from) return -1;
    const found = find();
    if (found < 0) noCloser.set(key, from);
    return found;
  };
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "\\") {
      const next = source[index + 1];
      if (next === "\n") {
        flush();
        nodes.push({ type: "break" });
        index += 2;
      } else if (next !== undefined && PUNCTUATION.test(next)) {
        text += next;
        index += 2;
      } else {
        text += character;
        index += 1;
      }
      continue;
    }
    if (character === "\n") {
      // Two spaces at the end of a line break it; otherwise it's a space. The spaces are counted in
      // the source, and each line's text is ended here, so nothing rereads the paragraph so far.
      let spaces = 0;
      while (source[index - 1 - spaces] === " ") spaces += 1;
      if (spaces) text = text.slice(0, Math.max(0, text.length - spaces));
      if (spaces >= 2) {
        flush();
        nodes.push({ type: "break" });
      } else {
        text += "\n";
        flush();
      }
      index += 1;
      continue;
    }
    if (character === "`") {
      let run = 1;
      while (source[index + run] === "`") run += 1;
      const close = run > MAX_BACKTICKS ? -1 : search(`\`${run}`, index + run, () => findBackticks(source, index + run, run));
      if (close < 0) {
        text += source.slice(index, index + run);
        index += run;
        continue;
      }
      let code = source.slice(index + run, close).split("\n").join(" ");
      if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
      flush();
      nodes.push({ type: "code", text: code });
      index = close + run;
      continue;
    }
    if (character === "*" || character === "_" || character === "~") {
      let run = 1;
      while (source[index + run] === character) run += 1;
      const before = source[index - 1] ?? " ";
      const after = source[index + run] ?? " ";
      const opens = (character === "~" ? run === 2 : run <= 3) && !WHITESPACE.test(after) && (character !== "_" || !WORD.test(before));
      const close = opens ? search(`${character}${run}`, index + run, () => findCloser(source, index + run, character, run)) : -1;
      if (close > index + run) {
        flush();
        const children = parseInline(source.slice(index + run, close), context, depth + 1, inLink);
        nodes.push(character === "~" ? { type: "del", children } : run === 1 ? { type: "em", children } : run === 2 ? { type: "strong", children } : { type: "strong", children: [{ type: "em", children }] });
        index = close + run;
        continue;
      }
      text += source.slice(index, index + run);
      index += run;
      continue;
    }
    if (character === "!" && source[index + 1] === "[") {
      const link = parseLink(source, index + 1, brackets, context, budget);
      if (link) {
        flush();
        nodes.push({ type: "image", src: link.href, alt: unescapeMarkdown(link.label).replace(/[*_`]/g, ""), index: context.images++ });
        index = link.end;
        continue;
      }
    }
    if (character === "[" && !inLink) {
      const link = parseLink(source, index, brackets, context, budget);
      if (link) {
        flush();
        nodes.push({ type: "link", href: link.href, children: parseInline(link.label, context, depth + 1, true) });
        index = link.end;
        continue;
      }
    }
    if (character === "<") {
      AUTOLINK.lastIndex = index;
      const match = AUTOLINK.exec(source);
      if (match && !inLink) {
        flush();
        const target = match[1];
        const href = /^(?:https?|mailto):/i.test(target) ? target : target.includes(".") ? `mailto:${target}` : "";
        if (href) nodes.push({ type: "link", href, children: [{ type: "text", text: target }] });
        else text += match[0];
        index += match[0].length;
        continue;
      }
    }
    if ((character === "h" || character === "H" || character === "w" || character === "W") && !inLink && !WORD.test(source[index - 1] ?? " ")) {
      BARE_LINK.lastIndex = index;
      const match = BARE_LINK.exec(source);
      if (match) {
        const found = match[0];
        // Trailing punctuation is the sentence's, and a closing bracket only belongs if it closes one in the link.
        let opening = 0;
        let closing = 0;
        for (const part of found) {
          if (part === "(") opening += 1;
          else if (part === ")") closing += 1;
        }
        let end = found.length;
        for (; end > 0; end -= 1) {
          const last = found[end - 1];
          if (last === ")" && closing > opening) closing -= 1;
          else if (!".,:;!?'\"*_~".includes(last)) break;
        }
        const url = found.slice(0, end);
        if (/^(?:www\.|https?:\/\/)$/i.test(url)) {
          text += character;
          index += 1;
          continue;
        }
        flush();
        nodes.push({ type: "link", href: /^www\./i.test(url) ? `https://${url}` : url, children: [{ type: "text", text: url }] });
        index += url.length;
        continue;
      }
    }
    if (character === "&") {
      ENTITY.lastIndex = index;
      const match = ENTITY.exec(source);
      const decoded = match ? entity(match[1]) : null;
      if (match && decoded !== null) {
        text += decoded;
        index += match[0].length;
        continue;
      }
    }
    text += character;
    index += 1;
  }
  flush();
  return nodes;
}

/**
 * A link's address if it's one to follow: web and mail addresses only (no javascript:, data:, or
 * file:), and none with a name or password before the host (https://filesdude.home@evil.example).
 */
export function safeLink(href: string): string | null {
  const value = href.trim();
  if (!/^(?:https?:\/\/|mailto:)/i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.href : null;
  } catch {
    return null;
  }
}

const PICTURE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * A picture's path from a Markdown file in `folder`, if it's a relative path to a picture inside the
 * root (`../` can't go above it). Pictures from other sites aren't loaded, so they get none.
 */
export function relativePicturePath(src: string, folder: string): string | null {
  const raw = src.trim();
  if (!raw || /^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) return null;
  let value = raw.split(/[?#]/)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!PICTURE.test(value) || /[\p{Cc}\\]/u.test(value)) return null;
  const parts = folder ? folder.split("/").filter(Boolean) : [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (!parts.length) return null;
    else parts.pop();
  }
  return parts.join("/");
}
