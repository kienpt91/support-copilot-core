import type { ScoredId } from "./bm25.js";

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** Exact (brute-force) cosine search. Fine for thousands of chunks per tenant, not for millions. */
export class VectorIndex {
  private readonly vectors = new Map<string, { order: number; vector: Float32Array }>();
  private counter = 0;

  constructor(readonly dimensions: number) {}

  get size(): number {
    return this.vectors.size;
  }

  add(id: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`vector has ${vector.length} dimensions, index expects ${this.dimensions}`);
    }
    this.vectors.set(id, { order: this.counter++, vector });
  }

  remove(id: string): boolean {
    return this.vectors.delete(id);
  }

  similarity(id: string, query: Float32Array): number | null {
    const entry = this.vectors.get(id);
    return entry ? cosine(entry.vector, query) : null;
  }

  search(query: Float32Array, k: number): ScoredId[] {
    if (k <= 0) return [];
    return [...this.vectors.entries()]
      .map(([id, { order, vector }]) => ({ id, order, score: cosine(vector, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, k)
      .map(({ id, score }) => ({ id, score }));
  }
}
