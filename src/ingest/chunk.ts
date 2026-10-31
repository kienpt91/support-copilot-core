import { PermanentJobError } from "../errors.js";
import { splitSentences } from "../retrieval/text.js";
import type { Section } from "./parse.js";

export interface ChunkDraft {
  heading: string;
  text: string;
}

export interface ChunkOptions {
  /** Soft upper bound on characters per chunk (a single over-long word is never split). */
  maxChars?: number;
  /** Refuse documents that would produce more chunks than this. */
  maxChunks?: number;
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    if (cur && cur.length + 1 + word.length > max) {
      out.push(cur);
      cur = word;
    } else cur = cur ? `${cur} ${word}` : word;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Splits sections into chunks. Section boundaries are never crossed (a chunk belongs to exactly
 * one heading); inside a section, paragraphs are packed up to `maxChars`, over-long paragraphs are
 * split at sentence boundaries, and over-long sentences at word boundaries.
 */
export function chunkSections(sections: readonly Section[], opts: ChunkOptions = {}): ChunkDraft[] {
  const max = opts.maxChars ?? 600;
  const maxChunks = opts.maxChunks ?? 1000;
  const out: ChunkDraft[] = [];
  for (const section of sections) {
    const units: string[] = [];
    for (const para of section.text.split(/\n{2,}/)) {
      const p = para.trim();
      if (!p) continue;
      if (p.length <= max) units.push(p);
      else for (const s of splitSentences(p)) units.push(...(s.length <= max ? [s] : hardSplit(s, max)));
    }
    let cur = "";
    for (const unit of units) {
      if (cur && cur.length + 1 + unit.length > max) {
        out.push({ heading: section.heading, text: cur });
        cur = unit;
      } else cur = cur ? `${cur}\n${unit}` : unit;
      if (out.length > maxChunks) throw new PermanentJobError(`document produces more than ${maxChunks} chunks`);
    }
    if (cur) out.push({ heading: section.heading, text: cur });
    if (out.length > maxChunks) throw new PermanentJobError(`document produces more than ${maxChunks} chunks`);
  }
  return out;
}
