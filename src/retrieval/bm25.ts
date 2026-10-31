export interface ScoredId {
  id: string;
  score: number;
}

interface DocEntry {
  order: number;
  length: number;
  tf: Map<string, number>;
}

/**
 * Okapi BM25 over an in-memory inverted index.
 * idf = ln(1 + (N - df + 0.5) / (df + 0.5)); score = sum idf * tf*(k1+1) / (tf + k1*(1 - b + b*len/avgLen)).
 * Ties break by insertion order so results are deterministic.
 */
export class Bm25Index {
  private readonly docs = new Map<string, DocEntry>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;
  private counter = 0;

  constructor(
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  add(id: string, tokens: readonly string[]): void {
    this.remove(id);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(id, { order: this.counter++, length: tokens.length, tf });
    this.totalLength += tokens.length;
    for (const term of tf.keys()) {
      let set = this.postings.get(term);
      if (!set) this.postings.set(term, (set = new Set()));
      set.add(id);
    }
  }

  remove(id: string): boolean {
    const doc = this.docs.get(id);
    if (!doc) return false;
    for (const term of doc.tf.keys()) {
      const set = this.postings.get(term);
      set?.delete(id);
      if (set && set.size === 0) this.postings.delete(term);
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
    return true;
  }

  idf(term: string): number {
    const n = this.docs.size;
    const df = this.postings.get(term)?.size ?? 0;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }

  search(queryTokens: readonly string[], k: number): ScoredId[] {
    const n = this.docs.size;
    if (n === 0 || k <= 0) return [];
    const avgLen = this.totalLength / n || 1;
    const scores = new Map<string, number>();
    for (const term of new Set(queryTokens)) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = this.idf(term);
      for (const id of posting) {
        const doc = this.docs.get(id)!;
        const tf = doc.tf.get(term)!;
        const norm = tf + this.k1 * (1 - this.b + (this.b * doc.length) / avgLen);
        scores.set(id, (scores.get(id) ?? 0) + (idf * tf * (this.k1 + 1)) / norm);
      }
    }
    return [...scores.entries()]
      .map(([id, score]) => ({ id, score, order: this.docs.get(id)!.order }))
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, k)
      .map(({ id, score }) => ({ id, score }));
  }

  /**
   * Fraction of the query's idf mass that appears in document `id`. Terms missing from the whole
   * corpus count with the highest idf, so a question about something the corpus never mentions
   * scores low even if it shares a few common words with a chunk.
   */
  coverage(id: string, queryTokens: readonly string[]): number {
    const doc = this.docs.get(id);
    const terms = new Set(queryTokens);
    if (!doc || terms.size === 0) return 0;
    let total = 0;
    let matched = 0;
    for (const term of terms) {
      const w = this.idf(term);
      total += w;
      if (doc.tf.has(term)) matched += w;
    }
    return total === 0 ? 0 : matched / total;
  }
}
