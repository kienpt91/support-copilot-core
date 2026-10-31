import { PermanentJobError } from "../errors.js";
import type { ProcessingBudget } from "./budget.js";

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

/**
 * Everything in this file runs on attacker-controlled input (up to 1 MB per document) on the thread
 * that serves all tenants, so every scan is written to be linear in the input: hand-written scanners
 * instead of backtracking regular expressions, lookups that cannot restart at every position, and
 * "no closer exists after here, so none exists later either" short-circuits. Lines longer than
 * MAX_LINE_CHARS are wrapped before any per-line work. The remaining regular expressions are single
 * character classes or anchored patterns that cannot backtrack. `test/worst-case.test.ts` and
 * `scripts/worst-case.mjs` check this against hostile inputs.
 */
export const MAX_LINE_CHARS = 8192;
const SNIFF_CHARS = 32_768;

// --- character helpers ----------------------------------------------------------------------------

/** The characters JavaScript's `\s` matches. */
function isSpace(c: number): boolean {
  return (
    c === 32 ||
    (c >= 9 && c <= 13) ||
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

function isAlnum(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isWordChar(c: number): boolean {
  return isAlnum(c) || c === 95;
}

function isAsciiLetter(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// --- format detection -----------------------------------------------------------------------------

const HTML_HINT_TAGS = new Set(["html", "head", "body", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "section", "article", "br", "span", "a"]);

/** HTML if the sample has a doctype or <html>, or at least two well-known tags. Linear in the sample. */
function looksLikeHtml(sample: string): boolean {
  const lastGt = sample.lastIndexOf(">");
  let tags = 0;
  let i = sample.indexOf("<");
  while (i !== -1 && i < lastGt) {
    let j = i + 1;
    if (sample.charCodeAt(j) === 33) {
      if (sample.slice(j + 1, j + 8).toLowerCase() === "doctype") return true;
    } else {
      if (sample.charCodeAt(j) === 47) j++;
      const start = j;
      while (j < sample.length && j - start < 12 && isAlnum(sample.charCodeAt(j))) j++;
      const name = sample.slice(start, j).toLowerCase();
      if (name === "html") return true;
      if (HTML_HINT_TAGS.has(name) && !isAlnum(sample.charCodeAt(j))) {
        tags += 1;
        if (tags >= 2) return true;
      }
    }
    i = sample.indexOf("<", i + 1);
  }
  return false;
}

/** Markdown if any line starts like a heading, list item, fence or quote. Linear in the sample. */
function looksLikeMarkdown(sample: string): boolean {
  let pos = 0;
  while (pos <= sample.length) {
    const nl = sample.indexOf("\n", pos);
    const end = nl === -1 ? sample.length : nl;
    let i = pos;
    while (i < end && isSpace(sample.charCodeAt(i))) i++;
    const c = sample.charCodeAt(i);
    const next = sample.charCodeAt(i + 1);
    const nextIsBlank = (k: number) => k < end && (sample.charCodeAt(k) === 32 || sample.charCodeAt(k) === 9);
    const hasTextAfter = (k: number) => {
      for (let m = k; m < end; m++) if (!isSpace(sample.charCodeAt(m))) return true;
      return false;
    };
    if (i < end) {
      if (c === 35) {
        let h = i;
        while (h < end && sample.charCodeAt(h) === 35) h++;
        if (h - i <= 6 && nextIsBlank(h) && hasTextAfter(h)) return true;
      } else if ((c === 45 || c === 42 || c === 43) && nextIsBlank(i + 1) && hasTextAfter(i + 1)) {
        return true;
      } else if (c >= 48 && c <= 57) {
        let d = i;
        while (d < end && sample.charCodeAt(d) >= 48 && sample.charCodeAt(d) <= 57) d++;
        if (sample.charCodeAt(d) === 46 && nextIsBlank(d + 1) && hasTextAfter(d + 1)) return true;
      } else if (c === 96 && next === 96 && sample.charCodeAt(i + 2) === 96) {
        return true;
      } else if (c === 62 && nextIsBlank(i + 1)) {
        return true;
      }
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  return false;
}

/** Guesses the format from the first 32 KB. Linear in that window. */
export function detectFormat(content: string): DocFormat {
  const sample = content.length > SNIFF_CHARS ? content.slice(0, SNIFF_CHARS) : content;
  if (looksLikeHtml(sample)) return "html";
  if (looksLikeMarkdown(sample)) return "markdown";
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

// --- HTML -> text ---------------------------------------------------------------------------------

const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
  ["ndash", "\u2013"],
  ["mdash", "\u2014"],
  ["hellip", "\u2026"],
  ["lsquo", "\u2018"],
  ["rsquo", "\u2019"],
  ["ldquo", "\u201C"],
  ["rdquo", "\u201D"],
  ["bull", "\u2022"],
  ["middot", "\u00B7"],
  ["copy", "\u00A9"],
  ["reg", "\u00AE"],
  ["trade", "\u2122"],
  ["euro", "\u20AC"],
]);

/** Decodes a fixed set of named entities and numeric references in one pass (never recursively). */
export function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z]{2,8}));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES.get(name) ?? whole;
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
 * Finds the end of the next `</name ...>` at or after `from`, case-insensitively, or -1. `missing`
 * remembers names for which no closer exists after some position: if none exists after one opener,
 * none exists after any later opener either, so repeated unclosed openers cost one scan in total.
 */
function findClosingTag(text: string, name: string, from: number, missing: Set<string>): number {
  if (missing.has(name)) return -1;
  const n = text.length;
  let p = text.indexOf("</", from);
  while (p !== -1) {
    let q = p + 2;
    while (q < n && isSpace(text.charCodeAt(q))) q++;
    if (q + name.length <= n && text.slice(q, q + name.length).toLowerCase() === name && !isWordChar(text.charCodeAt(q + name.length))) {
      const gt = text.indexOf(">", q + name.length);
      if (gt === -1) break; // no ">" anywhere later, so no later closer can be complete either
      return gt + 1;
    }
    p = text.indexOf("</", p + 2);
  }
  missing.add(name);
  return -1;
}

function tidyLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

/**
 * Converts HTML to markdown-flavoured plain text with a state-machine tokenizer: only text nodes
 * survive. Script/style/template and similar elements are dropped with their contents, comments,
 * doctype, CDATA and processing instructions are dropped, attributes (including event handlers and
 * URLs) are never read into the output, and the result contains no markup that the tokenizer
 * recognised. Entities are decoded once, after tag removal, so `&lt;script&gt;` ends up as literal
 * text, never as a tag. Linear in the input.
 */
export async function htmlToText(html: string, budget?: ProcessingBudget): Promise<string> {
  const out: string[] = [];
  const text: string[] = [];
  const missing = new Set<string>();
  let i = 0;
  const n = html.length;
  const flush = () => {
    if (text.length) {
      out.push(decodeEntities(text.join("")));
      text.length = 0;
    }
  };
  while (i < n) {
    if (budget?.due()) await budget.yield();
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
    let quote = 0;
    while (j < n) {
      const ch = html.charCodeAt(j);
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === 34 || ch === 39) quote = ch;
      else if (ch === 62) break;
      j++;
    }
    i = j < n ? j + 1 : n;
    let k = lt + 1;
    const closing = html.charCodeAt(k) === 47;
    if (closing) k++;
    while (k < j && isSpace(html.charCodeAt(k))) k++;
    const nameStart = k;
    if (k < j && isAsciiLetter(html.charCodeAt(k))) {
      k++;
      while (k < j && (isAlnum(html.charCodeAt(k)) || html.charCodeAt(k) === 45)) k++;
    }
    const name = html.slice(nameStart, k).toLowerCase();
    const selfClosing = html.charCodeAt(j - 1) === 47;
    if (!name) continue; // garbage such as "</ >": dropped, never emitted
    if (!closing && DROP_CONTENT.has(name) && !selfClosing) {
      const end = findClosingTag(html, name, i, missing);
      i = end === -1 ? n : end;
      continue;
    }
    flush();
    if (/^h[1-6]$/.test(name)) out.push(closing ? "\n\n" : `\n\n${"#".repeat(Number(name[1]))} `);
    else if (name === "li") out.push(closing ? "" : "\n- ");
    else if (name === "br") out.push("\n");
    else if (BLOCK.has(name)) out.push("\n\n");
    else if (name === "td" || name === "th") out.push(closing ? " " : "");
  }
  flush();
  return tidyLines(out.join(""));
}

// --- markdown -> sections -------------------------------------------------------------------------

const HTML_NAMES = new Set([
  "a", "abbr", "b", "blockquote", "body", "br", "button", "center", "code", "dd", "details", "div", "dl", "dt", "em", "embed", "font",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hr", "html", "i", "iframe", "img", "input", "label", "li",
  "link", "main", "meta", "nav", "object", "ol", "p", "pre", "script", "section", "select", "small", "span", "strong", "style", "sub",
  "summary", "sup", "svg", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "title", "tr", "u", "ul", "video",
]);
const RAW_ELEMENTS = new Set(["script", "style", "template", "iframe", "object"]);

/** One linear pass: removes comments, known HTML tags, and raw-content elements together with their contents. */
function stripInlineHtmlOnce(line: string): string {
  const n = line.length;
  let out = "";
  let i = 0;
  let commentsClosed = true; // false once a "<!--" is found with no "-->" after it
  const missing = new Set<string>();
  while (i < n) {
    const lt = line.indexOf("<", i);
    if (lt === -1) {
      out += line.slice(i);
      break;
    }
    out += line.slice(i, lt);
    if (line.startsWith("<!--", lt)) {
      const close = commentsClosed ? line.indexOf("-->", lt + 4) : -1;
      if (close !== -1) {
        i = close + 3;
        continue;
      }
      commentsClosed = false;
      out += "<";
      i = lt + 1;
      continue;
    }
    let j = lt + 1;
    const closing = line.charCodeAt(j) === 47;
    if (closing) j++;
    const nameStart = j;
    if (isAsciiLetter(line.charCodeAt(j))) while (j < n && isAlnum(line.charCodeAt(j))) j++;
    const name = line.slice(nameStart, j).toLowerCase();
    let tagEnd = -1;
    if (HTML_NAMES.has(name)) {
      const c = line.charCodeAt(j);
      if (c === 62) tagEnd = j + 1;
      else if (c === 47 && line.charCodeAt(j + 1) === 62) tagEnd = j + 2;
      else if (isSpace(c)) {
        let k = j;
        while (k < n && line.charCodeAt(k) !== 60 && line.charCodeAt(k) !== 62) k++;
        if (k < n && line.charCodeAt(k) === 62) tagEnd = k + 1;
      }
    }
    if (tagEnd === -1) {
      out += "<";
      i = lt + 1;
      continue;
    }
    if (!closing && RAW_ELEMENTS.has(name)) {
      const end = findClosingTag(line, name, tagEnd, missing);
      i = end === -1 ? tagEnd : end;
    } else {
      i = tagEnd;
    }
  }
  return out;
}

/** Removes HTML from a markdown line. Repeats until stable so split-tag evasions such as `<scr<script>ipt>` collapse. */
function stripInlineHtml(line: string): string {
  if (line.indexOf("<") === -1) return line;
  let current = line;
  for (let pass = 0; pass < 10; pass++) {
    const next = stripInlineHtmlOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}

/** Removes `delim` pairs around at least one character: `**a**` becomes `a`. */
function stripPairs(line: string, delim: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = line.indexOf(delim, i);
    if (open === -1) break;
    const close = line.indexOf(delim, open + delim.length + 1);
    if (close === -1) break; // no closer after this opener, so none after a later opener either
    out += line.slice(i, open) + line.slice(open + delim.length, close);
    i = close + delim.length;
  }
  return out + line.slice(i);
}

/** `*italic*` to `italic`, with the usual flanking rules: not inside words, no space inside the delimiters. */
function stripItalics(line: string): string {
  const n = line.length;
  let out = "";
  let from = 0;
  let i = 0;
  while (i < n) {
    if (line.charCodeAt(i) === 42) {
      const prev = i > 0 ? line.charCodeAt(i - 1) : 32;
      const openOk = !isWordChar(prev) && prev !== 42 && i + 1 < n && !isSpace(line.charCodeAt(i + 1));
      if (openOk) {
        let close = -1;
        for (let j = i + 2; j < n; j++) {
          if (line.charCodeAt(j) !== 42 || isSpace(line.charCodeAt(j - 1))) continue;
          const after = j + 1 < n ? line.charCodeAt(j + 1) : 32;
          if (!isWordChar(after) && after !== 42) {
            close = j;
            break;
          }
        }
        if (close === -1) break; // no valid closer after this opener, so none after a later opener either
        out += line.slice(from, i) + line.slice(i + 1, close);
        i = close + 1;
        from = i;
        continue;
      }
    }
    i++;
  }
  return out + line.slice(from);
}

/** `` `code` `` to `code`. */
function stripCodeSpans(line: string): string {
  let out = "";
  let i = 0;
  for (;;) {
    const open = line.indexOf("`", i);
    if (open === -1) break;
    const close = line.indexOf("`", open + 1);
    if (close === -1) break;
    if (close === open + 1) {
      out += line.slice(i, close);
      i = close;
      continue;
    }
    out += line.slice(i, open) + line.slice(open + 1, close);
    i = close + 1;
  }
  return out + line.slice(i);
}

/** `![alt](url)`, `[text](url)` and `[text][ref]` to the alt text or link text. Two lookup tables make each step O(1). */
function stripLinks(line: string): string {
  if (line.indexOf("[") === -1) return line;
  const n = line.length;
  const nextBracket = new Int32Array(n + 2).fill(-1);
  const nextParen = new Int32Array(n + 2).fill(-1);
  for (let k = n - 1; k >= 0; k--) {
    const c = line.charCodeAt(k);
    nextBracket[k] = c === 93 ? k : nextBracket[k + 1]!;
    nextParen[k] = c === 41 ? k : nextParen[k + 1]!;
  }
  let out = "";
  let from = 0;
  let i = 0;
  while (i < n) {
    const c = line.charCodeAt(i);
    const image = c === 33 && line.charCodeAt(i + 1) === 91;
    const open = image ? i + 1 : c === 91 ? i : -1;
    if (open === -1) {
      i++;
      continue;
    }
    const close = nextBracket[open + 1]!;
    if (close === -1) break; // no "]" after this point, so no later link can close either
    const after = line.charCodeAt(close + 1);
    let end = -1;
    if (after === 40) {
      const rp = nextParen[close + 2]!;
      if (rp !== -1) end = rp + 1;
    } else if (after === 91) {
      const rb = nextBracket[close + 2]!;
      if (rb !== -1) end = rb + 1;
    }
    if (end !== -1 && (image || close > open + 1)) {
      out += line.slice(from, i) + line.slice(open + 1, close);
      i = end;
      from = end;
      continue;
    }
    i++;
  }
  return out + line.slice(from);
}

function inlineMarkdown(line: string): string {
  let s = stripLinks(line);
  if (s.includes("**")) s = stripPairs(s, "**");
  if (s.includes("__")) s = stripPairs(s, "__");
  if (s.includes("*")) s = stripItalics(s);
  if (s.includes("`")) s = stripCodeSpans(s);
  if (s.includes("~~")) s = stripPairs(s, "~~");
  return s;
}

interface Heading {
  level: number;
  text: string;
}

/** ATX heading: up to 3 leading spaces, 1-6 "#", whitespace, text, optional closing "#"s. */
function parseHeading(line: string): Heading | null {
  const n = line.length;
  let i = 0;
  while (i < n && i < 3 && isSpace(line.charCodeAt(i))) i++;
  let level = 0;
  while (i < n && line.charCodeAt(i) === 35) {
    level++;
    i++;
  }
  if (level < 1 || level > 6 || i >= n || !isSpace(line.charCodeAt(i))) return null;
  while (i < n && isSpace(line.charCodeAt(i))) i++;
  let end = n;
  while (end > i && isSpace(line.charCodeAt(end - 1))) end--;
  while (end > i && line.charCodeAt(end - 1) === 35) end--;
  while (end > i && isSpace(line.charCodeAt(end - 1))) end--;
  return { level, text: line.slice(i, end) };
}

/** A line of three or more `-`, `*` or `_` (all the same character) and whitespace. */
function isThematicBreak(line: string): boolean {
  let marker = 0;
  let count = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (isSpace(c)) continue;
    if (marker === 0) {
      if (c !== 45 && c !== 42 && c !== 95) return false;
      marker = c;
    } else if (c !== marker) return false;
    count++;
  }
  return count >= 3;
}

/** `|---|:--:|` style table separator rows. */
function isTableSeparator(line: string): boolean {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  if (s.length === 0) return false;
  for (const cell of s.split("|")) {
    const c = cell.trim();
    let i = 0;
    if (c.charCodeAt(i) === 58) i++;
    let dashes = 0;
    while (c.charCodeAt(i) === 45) {
      dashes++;
      i++;
    }
    if (dashes < 2) return false;
    if (c.charCodeAt(i) === 58) i++;
    if (i !== c.length) return false;
  }
  return true;
}

function stripBlockquote(line: string): string {
  let i = 0;
  while (i < line.length && isSpace(line.charCodeAt(i))) i++;
  if (line.charCodeAt(i) !== 62) return line;
  while (line.charCodeAt(i) === 62) i++;
  if (i < line.length && isSpace(line.charCodeAt(i))) i++;
  return line.slice(i);
}

function fenceMarker(line: string): string | null {
  let i = 0;
  while (i < line.length && isSpace(line.charCodeAt(i))) i++;
  if (line.startsWith("```", i)) return "```";
  if (line.startsWith("~~~", i)) return "~~~";
  return null;
}

/** Splits an over-long line into pieces of at most MAX_LINE_CHARS, preferring to break at a space. */
function* wrapLine(raw: string): Generator<string> {
  if (raw.length <= MAX_LINE_CHARS) {
    yield raw;
    return;
  }
  let start = 0;
  while (start < raw.length) {
    let end = Math.min(raw.length, start + MAX_LINE_CHARS);
    if (end < raw.length) {
      const space = raw.lastIndexOf(" ", end);
      if (space > start + MAX_LINE_CHARS / 2) end = space;
    }
    yield raw.slice(start, end);
    start = end;
  }
}

async function parseMarkdown(source: string, stripHtml: boolean, budget?: ProcessingBudget): Promise<{ title: string | null; sections: Section[] }> {
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

  const handleLine = (rawLine: string) => {
    const marker = fenceMarker(rawLine);
    if (marker) {
      if (fence === null) fence = marker;
      else if (marker === fence) fence = null;
      return; // drop the fence markers, keep the code as text
    }
    if (fence !== null) {
      current.push(rawLine);
      return;
    }
    let line = stripHtml ? stripInlineHtml(rawLine) : rawLine;
    const h = parseHeading(line);
    if (h) {
      flush();
      const text = inlineMarkdown(h.text).trim();
      while (stack.length && stack[stack.length - 1]!.level >= h.level) stack.pop();
      stack.push({ level: h.level, title: text });
      heading = stack.map((s) => s.title).filter(Boolean).join(" > ");
      if (title === null && h.level === 1 && text) title = text;
      return;
    }
    if (isThematicBreak(line) || isTableSeparator(line)) return;
    line = stripBlockquote(line);
    const trimmed = line.trim();
    if (trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|")) {
      line = trimmed.slice(1, -1).split("|").map((c) => c.trim()).filter(Boolean).join(" | ");
    }
    current.push(inlineMarkdown(line).trimEnd());
  };

  for (const rawLine of source.split("\n")) {
    if (budget?.due()) await budget.yield();
    for (const piece of wrapLine(rawLine)) handleLine(piece);
  }
  flush();
  return { title, sections };
}

/**
 * Parses document content into heading-labelled sections.
 * Throws PermanentJobError when there is no text to index (retrying cannot help), or when the
 * document uses up its processing budget.
 */
export async function parseDocument(content: string, format: DocFormat | "auto" = "auto", budget?: ProcessingBudget): Promise<ParsedDocument> {
  const normalized = normalizeContent(content);
  const resolved: DocFormat = format === "auto" ? detectFormat(normalized) : format;
  let parsed: { title: string | null; sections: Section[] };
  if (resolved === "html") {
    parsed = await parseMarkdown(await htmlToText(normalized, budget), false, budget);
  } else if (resolved === "markdown") {
    parsed = await parseMarkdown(normalized, true, budget);
  } else {
    const text = normalized.trim();
    parsed = { title: null, sections: text ? [{ heading: "", text }] : [] };
  }
  const sections = parsed.sections.filter((s) => /[\p{L}\p{N}]/u.test(s.text));
  if (sections.length === 0) throw new PermanentJobError("document has no extractable text");
  return { format: resolved, title: parsed.title, sections };
}
