import { PermanentJobError } from "../errors.js";

export type DocFormat = "markdown" | "text" | "html";

export interface Section {
  /** Heading path such as "Billing > Refunds". Empty for text before the first heading. */
  heading: string;
  text: string;
}

export interface ParsedDocument {
  format: DocFormat;
  title: string | null;
  sections: Section[];
}

const HTML_TAG_HINT = /<\s*(?:!doctype|html|head|body|div|p|h[1-6]|ul|ol|li|table|section|article|br|span|a)\b/i;
const MD_HINT = /^(?:#{1,6}\s+\S|\s*[-*+]\s+\S|\s*\d+\.\s+\S|```|>\s)/m;

export function detectFormat(content: string): DocFormat {
  if (HTML_TAG_HINT.test(content) && /<\/\w+\s*>|<\w+[^>]*\/>|<br\s*\/?>/i.test(content)) return "html";
  if (MD_HINT.test(content)) return "markdown";
  return "text";
}

/** Normalises newlines, drops NUL and other control characters (keeps tab and newline), strips a BOM. */
export function normalizeContent(content: string): string {
  return content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

// ---------------------------------------------------------------------------------------------
// HTML -> text

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ldquo: "\u201C",
  rdquo: "\u201D",
  bull: "\u2022",
  middot: "\u00B7",
  copy: "\u00A9",
  reg: "\u00AE",
  trade: "\u2122",
  euro: "\u20AC",
};

/** Decodes a fixed set of named entities and numeric references in one pass (never recursively). */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name] ?? whole;
    const cp = dec ? Number.parseInt(dec, 10) : Number.parseInt(hex!, 16);
    if (cp === 0x0a || cp === 0x09) return " ";
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0) || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return " ";
    return String.fromCodePoint(cp);
  });
}

const DROP_CONTENT = new Set(["script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math", "head", "title", "textarea", "select", "button"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "header", "footer", "main", "nav", "aside", "ul", "ol", "table", "tr", "blockquote", "pre",
  "figure", "figcaption", "form", "fieldset", "dl", "dt", "dd", "hr", "details", "summary", "address",
]);

/**
 * Converts HTML to markdown-flavoured plain text with a small state-machine tokenizer: only text
 * nodes survive. Script/style/template and similar elements are dropped with their contents,
 * comments, doctype, CDATA and processing instructions are dropped, attributes (including event
 * handlers and URLs) are never read into the output, and the result contains no markup that the
 * tokenizer recognised. Entities are decoded once, after tag removal, so `&lt;script&gt;` ends up
 * as literal text, never as a tag.
 */
export function htmlToText(html: string): string {
  let out = "";
  let i = 0;
  const n = html.length;
  const text: string[] = [];
  const flush = () => {
    if (text.length) {
      out += decodeEntities(text.join(""));
      text.length = 0;
    }
  };
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      text.push(html.slice(i));
      break;
    }
    text.push(html.slice(i, lt));
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", lt)) {
      const close = html.indexOf("]]>", lt + 9);
      i = close === -1 ? n : close + 3;
      continue;
    }
    if (next === "!" || next === "?") {
      const close = html.indexOf(">", lt + 2);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (!/[A-Za-z/]/.test(next)) {
      // A "<" that does not start a tag. Keep it only where it reads as a comparison ("a < b", "x <= 3");
      // otherwise drop it so removing neighbouring markup can never glue it into something tag-shaped.
      if (next === "" || /[\s\d=]/.test(next)) text.push("<");
      i = lt + 1;
      continue;
    }
    // Scan to the end of the tag, honouring quoted attribute values.
    let j = lt + 1;
    let quote = "";
    while (j < n) {
      const ch = html[j]!;
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ">") break;
      j++;
    }
    const raw = html.slice(lt + 1, j);
    i = j < n ? j + 1 : n;
    const closing = raw.startsWith("/");
    const selfClosing = raw.endsWith("/");
    const name = (/^\/?\s*([A-Za-z][A-Za-z0-9-]*)/.exec(raw)?.[1] ?? "").toLowerCase();
    if (!name) continue; // "<scr<script>" style garbage: dropped, never emitted
    if (!closing && DROP_CONTENT.has(name) && !selfClosing) {
      const end = new RegExp(`</\\s*${name}\\b[^>]*>`, "i").exec(html.slice(i));
      i = end ? i + end.index + end[0].length : n;
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(name)) out += closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `;
    else if (name === "li") out += closing ? "" : "\n- ";
    else if (name === "br") out += "\n";
    else if (BLOCK.has(name)) out += "\n\n";
    else if (name === "td" || name === "th") out += closing ? " " : "";
  }
  flush();
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

// ---------------------------------------------------------------------------------------------
// Markdown / text -> sections

const HTML_NAMES =
  "a|abbr|b|blockquote|body|br|button|center|code|dd|details|div|dl|dt|em|embed|font|footer|form|h[1-6]|head|header|hr|html|i|iframe|img|input|label|li|link|main|meta|nav|object|ol|p|pre|script|section|select|small|span|strong|style|sub|summary|sup|svg|table|tbody|td|template|textarea|tfoot|th|thead|title|tr|u|ul|video";

/** Removes HTML that appears inside markdown. Repeats until stable so split-tag evasions such as `<scr<script>ipt>` collapse. */
function stripInlineHtml(line: string): string {
  const blocks = new RegExp(`<(script|style|template|iframe|object)\\b[^>]*>[\\s\\S]*?</\\1\\s*>`, "gi");
  const comments = /<!--[\s\S]*?-->/g;
  const tags = new RegExp(`</?(?:${HTML_NAMES})(?:\\s[^<>]*)?/?>`, "gi");
  let prev = "";
  let cur = line;
  for (let pass = 0; pass < 10 && cur !== prev; pass++) {
    prev = cur;
    cur = cur.replace(comments, "").replace(blocks, "").replace(tags, "");
  }
  return cur;
}

function inlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1");
}

function parseMarkdown(source: string, stripHtml: boolean): { title: string | null; sections: Section[] } {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let title: string | null = null;
  let current: string[] = [];
  let heading = "";
  let fence: string | null = null;

  const flush = () => {
    const text = current.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text) sections.push({ heading, text });
    current = [];
  };

  for (const rawLine of source.split("\n")) {
    const fenceMatch = /^\s*(```|~~~)/.exec(rawLine);
    if (fenceMatch) {
      if (fence === null) fence = fenceMatch[1]!;
      else if (fenceMatch[1] === fence) fence = null;
      continue; // drop the fence markers, keep the code as text
    }
    if (fence !== null) {
      current.push(rawLine);
      continue;
    }
    let line = stripHtml ? stripInlineHtml(rawLine) : rawLine;
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      const text = inlineMarkdown(h[2]!).trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: text });
      heading = stack.map((s) => s.title).filter(Boolean).join(" > ");
      if (title === null && level === 1 && text) title = text;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue; // rules, table separators
    line = line.replace(/^\s*>+\s?/, "");
    if (line.includes("|") && /^\s*\|.*\|\s*$/.test(line)) {
      line = line.trim().slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(" | ");
    }
    current.push(inlineMarkdown(line).replace(/\s+$/g, ""));
  }
  flush();
  return { title, sections };
}

/**
 * Parses document content into heading-labelled sections.
 * Throws PermanentJobError when there is no text to index (retrying cannot help).
 */
export function parseDocument(content: string, format: DocFormat | "auto" = "auto"): ParsedDocument {
  const normalized = normalizeContent(content);
  const resolved: DocFormat = format === "auto" ? detectFormat(normalized) : format;
  let parsed: { title: string | null; sections: Section[] };
  if (resolved === "html") {
    parsed = parseMarkdown(htmlToText(normalized), false);
  } else if (resolved === "markdown") {
    parsed = parseMarkdown(normalized, true);
  } else {
    const text = normalized.trim();
    parsed = { title: null, sections: text ? [{ heading: "", text }] : [] };
  }
  const sections = parsed.sections.filter((s) => /[\p{L}\p{N}]/u.test(s.text));
  if (sections.length === 0) throw new PermanentJobError("document has no extractable text");
  return { format: resolved, title: parsed.title, sections };
}
