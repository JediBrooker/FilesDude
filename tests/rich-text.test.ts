import assert from "node:assert/strict";
import test from "node:test";
import { columnName, guessDelimiter, parseDelimited, parseMarkdown, relativePicturePath, richKind, safeLink, sortRows, type MdBlock, type MdInline } from "../lib/rich-text";

test("files get the formatted preview of their kind", () => {
  assert.equal(richKind("README.md", "text/markdown"), "markdown");
  assert.equal(richKind("notes.markdown", "application/octet-stream"), "markdown");
  assert.equal(richKind("data.CSV", "text/csv"), "csv");
  assert.equal(richKind("data.tsv", "text/tab-separated-values"), "tsv");
  assert.equal(richKind("package.json", "application/json"), "json");
  assert.equal(richKind("map.geojson", "application/geo+json"), "json");
  assert.equal(richKind("notes.txt", "text/plain"), null);
  assert.equal(richKind(".md", "application/octet-stream"), null);
});

test("CSV and TSV rows, with quotes, line breaks in quotes, and blank lines", () => {
  const text = "\ufeffname,notes,amount\r\nAda,\"says \"\"hi\"\", twice\",3\r\n\r\nBob,\"two\nlines\",\r\nCy";
  assert.deepEqual(parseDelimited(text, ","), { rows: [["name", "notes", "amount"], ["Ada", "says \"hi\", twice", "3"], ["Bob", "two\nlines", ""], ["Cy"]], columns: 3, truncated: false, columnsTruncated: false });
  // Only the start of a file: its last line may be cut short, so it goes.
  assert.deepEqual(parseDelimited("a,b\nc,d\ne,", ",", { complete: false }).rows, [["a", "b"], ["c", "d"]]);
  assert.equal(parseDelimited("a,b\nc,d\n", ",", { complete: false }).rows.length, 2);
  // Limits on rows and columns.
  const many = parseDelimited("1\n2\n3\n4\n", ",", { maxRows: 2 });
  assert.deepEqual([many.rows.length, many.truncated], [2, true]);
  const wide = parseDelimited("a,b,c,d\n", ",", { maxColumns: 2 });
  assert.deepEqual([wide.rows[0], wide.columns, wide.columnsTruncated], [["a", "b"], 2, true]);
  assert.deepEqual(parseDelimited("a\tb\n", "\t").rows, [["a", "b"]]);
});

test("the delimiter is guessed from the first line", () => {
  assert.equal(guessDelimiter("a,b,c\n1;2", "csv"), ",");
  assert.equal(guessDelimiter("name;price;\"x,y\"\n", "csv"), ";");
  assert.equal(guessDelimiter("a\tb\tc", "csv"), "\t");
  assert.equal(guessDelimiter("one column", "csv"), ",");
  assert.equal(guessDelimiter("a,b", "tsv"), "\t");
});

test("rows sort as numbers when they are, otherwise as text, with empty cells last", () => {
  const rows = [["10"], [""], ["9"], ["1,200"], ["-3.5"], ["$4"]];
  assert.deepEqual(sortRows(rows, (row) => row[0], "asc").map((row) => row[0]), ["-3.5", "$4", "9", "10", "1,200", ""]);
  assert.deepEqual(sortRows(rows, (row) => row[0], "desc").map((row) => row[0]), ["1,200", "10", "9", "$4", "-3.5", ""]);
  const names = [["file 10"], ["File 9"], ["apple"], [""]];
  assert.deepEqual(sortRows(names, (row) => row[0], "asc").map((row) => row[0]), ["apple", "File 9", "file 10", ""]);
  // Stable: equal cells keep their order.
  const pairs = [["b", "1"], ["a", "2"], ["b", "3"]];
  assert.deepEqual(sortRows(pairs, (row) => row[0], "asc").map((row) => row[1]), ["2", "1", "3"]);
  assert.deepEqual([0, 25, 26, 27, 701, 702].map(columnName), ["A", "Z", "AA", "AB", "ZZ", "AAA"]);
});

// Inline nodes as compact text, for readable expectations.
function show(nodes: MdInline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text": return node.text;
      case "code": return `<code:${node.text}>`;
      case "break": return "<br>";
      case "image": return `<img:${node.src}|${node.alt}>`;
      case "link": return `<a:${node.href}|${show(node.children)}>`;
      default: return `<${node.type}:${show(node.children)}>`;
    }
  }).join("");
}
const inline = (markdown: string) => {
  const [block] = parseMarkdown(markdown);
  assert.equal(block.type, "paragraph", markdown);
  return show((block as Extract<MdBlock, { type: "paragraph" }>).children);
};

test("Markdown blocks", () => {
  const blocks = parseMarkdown([
    "# Title #", "", "Intro", "text", "", "Sub", "---", "", "```js", "let a = 1;", "", "```", "", "> quoted", "lazy", "",
    "- one", "- [x] done", "  - nested", "", "3. three", "4. four", "", "| A | B |", "|:--|--:|", "| 1 | 2 \\| 3 |", "", "***", "", "    code", "", "<!-- hidden -->", "[ref]: https://example.com",
  ].join("\n"));
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "heading", "code", "quote", "list", "list", "table", "rule", "code"]);
  assert.deepEqual(blocks[0], { type: "heading", level: 1, children: [{ type: "text", text: "Title" }] });
  assert.equal(show((blocks[1] as Extract<MdBlock, { type: "paragraph" }>).children), "Intro\ntext");
  assert.equal((blocks[2] as Extract<MdBlock, { type: "heading" }>).level, 2);
  assert.deepEqual(blocks[3], { type: "code", language: "js", text: "let a = 1;\n" });
  const quote = blocks[4] as Extract<MdBlock, { type: "quote" }>;
  assert.equal(show((quote.children[0] as Extract<MdBlock, { type: "paragraph" }>).children), "quoted\nlazy");
  const list = blocks[5] as Extract<MdBlock, { type: "list" }>;
  assert.deepEqual(list.items.map((item) => item.checked), [null, true]);
  assert.deepEqual(list.items[1].children.map((block) => block.type), ["paragraph", "list"]);
  const ordered = blocks[6] as Extract<MdBlock, { type: "list" }>;
  assert.deepEqual([ordered.ordered, ordered.start, ordered.items.length], [true, 3, 2]);
  const table = blocks[7] as Extract<MdBlock, { type: "table" }>;
  assert.deepEqual(table.align, ["left", "right"]);
  assert.deepEqual(table.rows.map((row) => row.map(show)), [["1", "2 | 3"]]);
  assert.deepEqual(blocks[9], { type: "code", language: "", text: "code" });
});

test("Markdown inlines", () => {
  assert.equal(inline("*em* **strong** ***both*** ~~gone~~ `a * b`"), "<em:em> <strong:strong> <strong:<em:both>> <del:gone> <code:a * b>");
  assert.equal(inline("**bold *italic***"), "<strong:bold <em:italic>>");
  assert.equal(inline("snake_case_name and 2 * 3 * 4"), "snake_case_name and 2 * 3 * 4");
  assert.equal(inline("\\*not em\\* &amp; &copy; &#65; &#x1F600; &bogus; &constructor;"), "*not em* & © A \u{1F600} &bogus; &constructor;");
  assert.equal(inline("[site](https://example.com/a_(b) \"Title\") and ![pic](img/a.png)"), "<a:https://example.com/a_(b)|site> and <img:img/a.png|pic>");
  assert.equal(inline("[![badge](https://img.example/b.svg)](https://example.com)"), "<a:https://example.com|<img:https://img.example/b.svg|badge>>");
  assert.equal(inline("See [the docs][docs] or [docs].\n\n[docs]: <https://example.com/docs>"), "See <a:https://example.com/docs|the docs> or <a:https://example.com/docs|docs>.");
  assert.equal(inline("<https://example.com> <me@example.com> visit www.example.com/x. (https://example.com/a)"), "<a:https://example.com|https://example.com> <a:mailto:me@example.com|me@example.com> visit <a:https://www.example.com/x|www.example.com/x>. (<a:https://example.com/a|https://example.com/a>)");
  assert.equal(inline("line one  \nline two\\\nthree"), "line one<br>line two<br>three");
  assert.equal(inline("unclosed `code and *em and [link"), "unclosed `code and *em and [link");
});

test("links are followed only to web and mail addresses, and pictures only from beside the file", () => {
  assert.equal(safeLink("https://example.com/a b"), "https://example.com/a%20b");
  assert.equal(safeLink("mailto:me@example.com"), "mailto:me@example.com");
  for (const bad of ["javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "file:///etc/passwd", "//evil.example", "other.md", "vbscript:x", "java\tscript:x", "https://filesdude.home@evil.example/", "https://user:pass@example.com"]) assert.equal(safeLink(bad), null, bad);
  assert.equal(relativePicturePath("img/a.png", "docs"), "docs/img/a.png");
  assert.equal(relativePicturePath("./a%20b.JPG?raw=1", "docs"), "docs/a b.JPG");
  assert.equal(relativePicturePath("../shared/logo.svg", "docs/guide"), "docs/shared/logo.svg");
  for (const bad of ["../../x.png", "https://example.com/x.png", "/etc/x.png", "//host/x.png", "data:image/png;base64,AA", "notes.txt", "a%2", "a\\b.png", "a%0A.png"]) assert.equal(relativePicturePath(bad, "docs"), null, bad);
});

test("Markdown that would be slow to parse naively is still quick", () => {
  const cases = [
    "_a ".repeat(200_000),
    "*a ".repeat(200_000),
    "[".repeat(300_000),
    "`".repeat(10) + " x ".repeat(100_000),
    Array.from({ length: 2000 }, (_, index) => "`".repeat(index % 40 + 1)).join(" a "),
    "<a".repeat(300_000),
    "https://example.com/" + ")".repeat(300_000),
    "https://example.com/" + ".".repeat(300_000),
    "&".repeat(300_000),
    "#".repeat(300_000) + "a",
    "a" + " ".repeat(300_000) + "b",
    "> ".repeat(50_000) + "deep",
    Array.from({ length: 5000 }, (_, index) => `${" ".repeat(index % 60)}- item`).join("\n"),
    "[a](" + "(".repeat(300_000),
    "| a |\n|---|\n" + "| x |\n".repeat(50_000),
    // Found in review: each was seconds to minutes at 2 MB.
    "a\n".repeat(1_000_000),
    "a \n".repeat(650_000),
    "[".repeat(300_000) + "][]".repeat(300_000),
    "[a][".repeat(250_000) + "]".repeat(250_000),
    "[a](<".repeat(400_000),
    "[a](x (".repeat(280_000),
    "[](".repeat(650_000),
    `|${" c |".repeat(64)}\n|${"---|".repeat(64)}\n` + "a\n".repeat(1_000_000),
  ];
  for (const text of cases) {
    const started = performance.now();
    parseMarkdown(text);
    const took = performance.now() - started;
    assert.ok(took < 3000, `${JSON.stringify(text.slice(0, 30))}... took ${Math.round(took)} ms`);
  }
});
