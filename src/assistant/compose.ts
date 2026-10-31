import { type EvidenceItem, type Generator, INSUFFICIENT_EVIDENCE } from "./generator.js";

export interface EvidenceChunk extends EvidenceItem {
  chunkId: string;
  documentId: string;
}

export interface Citation {
  n: number;
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
}

export type Composed =
  | { kind: "answer"; text: string; citations: Citation[] }
  | { kind: "ungrounded"; reason: "insufficient_evidence" | "no_valid_citations" };

const SNIPPET_CHARS = 240;

/**
 * Turns generator output into a grounded answer. The generator is not trusted: markers that point
 * at a source that was not provided are removed, the remaining citations are renumbered in order of
 * first use, and an answer with no valid citation at all is rejected instead of shown.
 */
export async function composeAnswer(generator: Generator, question: string, evidence: readonly EvidenceChunk[]): Promise<Composed> {
  const raw = await generator.generate({
    question,
    evidence: evidence.map(({ n, title, text }) => ({ n, title, text })),
  });
  if (raw.includes(INSUFFICIENT_EVIDENCE)) return { kind: "ungrounded", reason: "insufficient_evidence" };

  const valid = new Set(evidence.map((e) => e.n));
  const renumber = new Map<number, number>();
  const text = raw
    .replace(/\s*\[(\d{1,3})\]/g, (whole, digits: string) => {
      const n = Number(digits);
      if (!valid.has(n)) return "";
      if (!renumber.has(n)) renumber.set(n, renumber.size + 1);
      return ` [${renumber.get(n)}]`;
    })
    .trim();
  if (renumber.size === 0 || text.replace(/\[\d+\]/g, "").trim().length === 0) return { kind: "ungrounded", reason: "no_valid_citations" };

  const citations: Citation[] = [...renumber.entries()].map(([original, n]) => {
    const e = evidence.find((x) => x.n === original)!;
    const snippet = e.text.length > SNIPPET_CHARS ? `${e.text.slice(0, SNIPPET_CHARS).trimEnd()}...` : e.text;
    return { n, documentId: e.documentId, chunkId: e.chunkId, title: e.title, snippet };
  });
  return { kind: "answer", text, citations };
}
