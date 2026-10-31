import { PermanentJobError } from "../errors.js";
import { findPii } from "../privacy/pii.js";
import type { ProcessingBudget } from "./budget.js";
import type { Section } from "./parse.js";

export interface ChunkDraft {
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /** Upper bound on characters per chunk. Only a PII span longer than this can push a chunk past it. */
  maxChars?: number;
  /** Refuse documents that would produce more chunks than this. */
  maxChunks?: number;
}

/** How far past a candidate cut to look for PII that the cut would split. */
const SPAN_LOOKAHEAD = 256;

function isSpaceCode(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0;
}

function tooMany(maxChunks: number): PermanentJobError {
  return new PermanentJobError(`document produces more than ${maxChunks} chunks`);
}

/**
 * Picks where to end the piece that starts at `start`. Prefers the last sentence end, then the last
 * whitespace, within `max` characters; never cuts through a detected email, phone number, card, IBAN or
 * id (otherwise the halves would no longer match the detectors and would reach the index unredacted);
 * and falls back to a hard cut for text with no usable boundary (one enormous token).
 */
function cutPoint(text: string, start: number, max: number): number {
  const len = text.length;
  const hardEnd = Math.min(len, start + max);
  if (hardEnd === len) return len;

  // Detection runs on a bounded window, so the cost per piece does not depend on the document size.
  const windowEnd = Math.min(len, hardEnd + SPAN_LOOKAHEAD);
  const spans = findPii(text.slice(start, windowEnd)).filter((s) => s.end - s.start <= max);
  const inside = new Uint8Array(windowEnd - start + 1);
  for (const s of spans) inside.fill(1, s.start + 1, s.end);

  let whitespaceCut = -1;
  for (let pos = hardEnd; pos > start + 1; pos--) {
    if (inside[pos - start]) continue;
    const before = text.charCodeAt(pos - 1);
    const at = text.charCodeAt(pos);
    if (!isSpaceCode(at) && !isSpaceCode(before)) continue;
    if (isSpaceCode(at) && (before === 46 || before === 33 || before === 63) && pos - start >= max / 3) return pos;
    if (whitespaceCut === -1) whitespaceCut = pos;
  }
  if (whitespaceCut !== -1) return whitespaceCut;

  if (inside[hardEnd - start]) {
    const straddling = spans.find((s) => s.start + start < hardEnd && hardEnd < s.end + start)!;
    return straddling.start + start > start ? straddling.start + start : straddling.end + start;
  }
  return hardEnd;
}

/** Splits one over-long paragraph into pieces of at most `max` characters. */
async function splitLong(text: string, max: number, maxChunks: number, budget?: ProcessingBudget): Promise<string[]> {
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    if (budget?.due()) await budget.yield();
    const end = Math.max(cutPoint(text, start, max), start + 1);
    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (pieces.length > maxChunks) throw tooMany(maxChunks);
    start = end;
    while (start < text.length && isSpaceCode(text.charCodeAt(start))) start++;
  }
  return pieces;
}

/**
 * Splits sections into chunks. Section boundaries are never crossed (a chunk belongs to exactly one
 * heading); inside a section, paragraphs are packed up to `maxChars` and over-long paragraphs are cut
 * at sentence ends, then whitespace, never through PII. Linear in the input, and cooperative: it yields
 * through the optional budget.
 */
export async function chunkSections(sections: readonly Section[], opts: ChunkOptions = {}, budget?: ProcessingBudget): Promise<ChunkDraft[]> {
  const max = opts.maxChars ?? 600;
  const maxChunks = opts.maxChunks ?? 1000;
  const out: ChunkDraft[] = [];
  for (const section of sections) {
    const units: string[] = [];
    for (const para of section.text.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= max) units.push(p);
      else for (const piece of await splitLong(p, max, maxChunks, budget)) units.push(piece);
    }
    let cur = "";
    for (const unit of units) {
      if (budget?.due()) await budget.yield();
      if (cur && cur.length + 1 + unit.length > max) {
        out.push({ heading: section.heading, text: cur });
        cur = unit;
      } else cur = cur ? `${cur}\n${unit}` : unit;
      if (out.length > maxChunks) throw tooMany(maxChunks);
    }
    if (cur) out.push({ heading: section.heading, text: cur });
    if (out.length > maxChunks) throw tooMany(maxChunks);
  }
  return out;
}
