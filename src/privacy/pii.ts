/**
 * Pattern-based PII detection.
 *
 * Detection runs on a normalised copy of the text (Unicode NFKC, invisible characters
 * dropped, non-ASCII digits and dashes folded) with an index map back to the original, so
 * full-width digits, zero-width joiners or odd dashes do not hide a match, and the redacted
 * span still covers exactly the characters the user typed.
 */

export type PiiKind = "EMAIL" | "PHONE" | "CARD" | "IBAN" | "NATIONAL_ID";

export interface PiiMatch {
  kind: PiiKind;
  /** Offsets into the original text, end exclusive. */
  start: number;
  end: number;
  value: string;
}

// Zero-width and formatting characters, and standalone combining marks, are dropped for detection so
// that "4\u200B1\u03011" style padding cannot split a number.
const INVISIBLE = /[\u00AD\u034F\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\p{M}]/u;
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u;
const IS_DIGIT = /\p{Nd}/u;

function foldDigit(ch: string): string {
  if (/[0-9]/.test(ch)) return ch;
  if (!IS_DIGIT.test(ch)) return ch;
  let base = ch.codePointAt(0)!;
  const cp = base;
  while (IS_DIGIT.test(String.fromCodePoint(base - 1))) base--;
  return String((cp - base) % 10);
}

interface Normalized {
  text: string;
  /** For each UTF-16 unit of `text`, the original start offset and end offset. */
  start: number[];
  end: number[];
}

function normalize(original: string): Normalized {
  const start: number[] = [];
  const end: number[] = [];
  let text = "";
  let offset = 0;
  for (const ch of original) {
    const len = ch.length;
    if (!INVISIBLE.test(ch)) {
      let folded = ch.normalize("NFKC");
      folded = [...folded].map((c) => (DASHES.test(c) ? "-" : foldDigit(c))).join("");
      for (let i = 0; i < folded.length; i++) {
        start.push(offset);
        end.push(offset + len);
      }
      text += folded;
    }
    offset += len;
  }
  return { text, start, end };
}

export function luhn(digits: string): boolean {
  if (!/^\d{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check on a compact (no separators) IBAN-shaped string. */
export function ibanChecksumValid(compact: string): boolean {
  const s = compact.toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

interface Candidate {
  kind: PiiKind;
  priority: number;
  start: number;
  end: number;
}

const EMAIL_LABEL = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?`;
const EMAIL_RE = new RegExp(
  String.raw`[\p{L}\p{N}][\p{L}\p{N}._%+'-]{0,63}(?:\s?@\s?|\s?[\[(]\s?at\s?[\])]\s?)` +
    EMAIL_LABEL +
    String.raw`(?:(?:\.|\s?[\[(]\s?dot\s?[\])]\s?)` +
    EMAIL_LABEL +
    String.raw`)+`,
  "giu",
);

// Card digits may be separated by up to two of space, dot, dash, slash or underscore; the Luhn check keeps false positives down.
const CARD_RE = /(?<![\p{N}])(?:\d[ .\-/_]{0,2}){12,18}\d(?![\p{N}])/gu;
const IBAN_RE = /(?<![\p{L}\p{N}])[A-Za-z]{2}\d{2}(?:[ \-]?[A-Za-z0-9]){11,30}(?![\p{L}\p{N}])/gu;
const SSN_RE = /(?<![\d-])(?!000|666|9\d\d)\d{3}([ .-])(?!00)\d{2}\1(?!0000)\d{4}(?![\d-])/g;
const ID_KEYWORD_RE =
  /\b(?:ssn|social security(?: number| no\.?)?|national id(?:entity)?(?: number| no\.?)?|id (?:number|no\.?)|cccd|cmnd|passport(?: number| no\.?)?|nino|tax id|tin)\b[\s:#=-]{0,6}([A-Z]{0,2}\d(?:[ .-]?\d){4,14}[A-Z]?)(?![A-Za-z0-9])/gi;
const NINO_RE = /(?<![A-Za-z0-9])[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D](?![A-Za-z0-9])/gi;
const VN_CCCD_RE = /(?<!\d)0(?:[0-8]\d|9[0-6])[0-3]\d{8}(?!\d)/g;
const PHONE_RE = /(?<![\p{N}\p{L}_])\+?\(?\d[\d ()\-.]{5,22}\d(?![\p{N}\p{L}_])/gu;

function digitsOf(s: string): string {
  return s.replace(/\D/g, "");
}

function plausiblePhone(raw: string): boolean {
  const digits = digitsOf(raw);
  if (digits.length < 7 || digits.length > 15) return false;
  // Dates, including an ISO date followed by a time ("2026-10-31 02:12"), which would otherwise look like 10+ digits.
  if (/^\d{4}-\d{1,2}-\d{1,2}(?:\D|$)/.test(raw) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(raw)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return false; // IPv4
  if (/^\d+\.\d+(\.\d+)*$/.test(raw) && digits.length < 10) return false; // versions, decimals
  if (raw.startsWith("+")) return digits.length >= 8;
  if (digits.length >= 10) return true;
  // Short numbers only count when they look like grouped phone numbers, e.g. 555-1234 or (555) 123-4567.
  return /\d{3}[ -]\d{4}$/.test(raw) || raw.includes("(");
}

function collect(norm: Normalized): Candidate[] {
  const text = norm.text;
  const out: Candidate[] = [];
  const add = (kind: PiiKind, priority: number, start: number, end: number) => out.push({ kind, priority, start, end });

  for (const m of text.matchAll(CARD_RE)) {
    const digits = digitsOf(m[0]);
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) add("CARD", 1, m.index, m.index + m[0].length);
  }

  for (const m of text.matchAll(IBAN_RE)) {
    const positions: number[] = [];
    let compact = "";
    for (let i = 0; i < m[0].length; i++) {
      const ch = m[0][i]!;
      if (/[A-Za-z0-9]/.test(ch)) {
        compact += ch;
        positions.push(m.index + i);
      }
    }
    // The greedy match can run into the next word, so take the longest valid prefix.
    for (let len = Math.min(34, compact.length); len >= 15; len--) {
      if (ibanChecksumValid(compact.slice(0, len))) {
        add("IBAN", 2, positions[0]!, positions[len - 1]! + 1);
        break;
      }
    }
  }

  for (const m of text.matchAll(EMAIL_RE)) add("EMAIL", 3, m.index, m.index + m[0].length);

  for (const m of text.matchAll(SSN_RE)) add("NATIONAL_ID", 4, m.index, m.index + m[0].length);
  for (const m of text.matchAll(NINO_RE)) add("NATIONAL_ID", 4, m.index, m.index + m[0].length);
  for (const m of text.matchAll(VN_CCCD_RE)) add("NATIONAL_ID", 4, m.index, m.index + m[0].length);
  for (const m of text.matchAll(ID_KEYWORD_RE)) {
    const value = m[1]!;
    if (digitsOf(value).length >= 5) {
      const start = m.index + m[0].length - value.length;
      add("NATIONAL_ID", 4, start, start + value.length);
    }
  }

  for (const m of text.matchAll(PHONE_RE)) {
    if (plausiblePhone(m[0])) add("PHONE", 5, m.index, m.index + m[0].length);
  }
  return out;
}

/** Finds PII spans in `text`. Spans never overlap; higher-confidence kinds win overlaps. */
export function findPii(text: string): PiiMatch[] {
  if (text.length === 0) return [];
  const norm = normalize(text);
  const candidates = collect(norm).sort((a, b) => a.priority - b.priority || a.start - b.start);
  if (candidates.length === 0) return [];
  // Candidates are taken in priority order; a mask over the normalised text makes the overlap test
  // proportional to the candidate's own length (the earlier pairwise scan was quadratic in the candidate count).
  const occupied = new Uint8Array(norm.text.length);
  const accepted: Candidate[] = [];
  for (const c of candidates) {
    let free = true;
    for (let k = c.start; k < c.end; k++) {
      if (occupied[k]) {
        free = false;
        break;
      }
    }
    if (free) {
      occupied.fill(1, c.start, c.end);
      accepted.push(c);
    }
  }
  accepted.sort((a, b) => a.start - b.start);
  return accepted.map((c) => {
    const start = norm.start[c.start]!;
    const end = norm.end[c.end - 1]!;
    return { kind: c.kind, start, end, value: text.slice(start, end) };
  });
}

/** Replaces PII with static tags such as `[EMAIL]`. Irreversible; used for stored text and embeddings. */
export function redactStatic(text: string): string {
  const matches = findPii(text);
  if (matches.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + `[${m.kind}]`;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}
