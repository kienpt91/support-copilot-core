import { ScopedCollection } from "../tenancy/scoped.js";
import { Bm25Index } from "./bm25.js";
import type { Embedder } from "./embedder.js";
import { reciprocalRankFusion } from "./fusion.js";
import { tokenize } from "./text.js";
import { VectorIndex } from "./vector.js";

export interface Chunk {
  id: string;
  tenantId: string;
  documentId: string;
  ordinal: number;
  heading: string;
  /** Original chunk text (shown to the tenant's own staff, passed through redaction before any model). */
  text: string;
  /** Redacted text that was actually indexed and embedded. */
  indexText: string;
}

export type SearchMode = "bm25" | "vector" | "hybrid";

export interface Hit {
  chunk: Chunk;
  /** Score in the ranking that produced the hit: BM25, cosine or RRF depending on the mode. */
  score: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  /** Cosine similarity between the query and this chunk (null in bm25 mode). */
  cosine: number | null;
  /** idf-weighted share of the query's terms present in this chunk. */
  coverage: number;
}

interface TenantIndex {
  bm25: Bm25Index;
  vectors: VectorIndex;
}

export interface RetrieverOptions {
  rrfK?: number;
  /** How many candidates each ranker contributes before fusion, as a multiple of k. */
  candidateMultiplier?: number;
}

/**
 * Per-tenant hybrid retrieval. Each tenant gets its own BM25 and vector index, so term statistics
 * (idf, average length) never mix between tenants and a query can only ever see the caller's chunks.
 */
export class HybridRetriever {
  private readonly indexes = new Map<string, TenantIndex>();
  readonly chunks = new ScopedCollection<Chunk>("Chunk");

  constructor(
    readonly embedder: Embedder,
    private readonly opts: RetrieverOptions = {},
  ) {}

  private index(tenantId: string): TenantIndex {
    let idx = this.indexes.get(tenantId);
    if (!idx) {
      idx = { bm25: new Bm25Index(), vectors: new VectorIndex(this.embedder.dimensions) };
      this.indexes.set(tenantId, idx);
    }
    return idx;
  }

  /** Atomically replaces everything indexed for a document. Synchronous, so readers never see a half-built document. */
  commit(tenantId: string, documentId: string, chunks: readonly Chunk[], vectors: readonly Float32Array[]): void {
    if (chunks.length !== vectors.length) throw new Error("chunks and vectors differ in length");
    for (const c of chunks) {
      if (c.tenantId !== tenantId || c.documentId !== documentId) throw new Error("chunk does not belong to this tenant and document");
    }
    for (const v of vectors) {
      if (v.length !== this.embedder.dimensions) throw new Error("vector dimension mismatch");
    }
    this.removeDocument(tenantId, documentId);
    const idx = this.index(tenantId);
    chunks.forEach((chunk, i) => {
      this.chunks.put(tenantId, chunk);
      idx.bm25.add(chunk.id, tokenize(`${chunk.heading} ${chunk.indexText}`));
      idx.vectors.add(chunk.id, vectors[i]!);
    });
  }

  removeDocument(tenantId: string, documentId: string): number {
    const idx = this.index(tenantId);
    const existing = this.chunks.list(tenantId, (c) => c.documentId === documentId);
    for (const c of existing) {
      idx.bm25.remove(c.id);
      idx.vectors.remove(c.id);
      this.chunks.delete(tenantId, c.id);
    }
    return existing.length;
  }

  chunkCount(tenantId: string): number {
    return this.chunks.count(tenantId);
  }

  async search(tenantId: string, query: string, opts: { mode?: SearchMode; k?: number } = {}): Promise<Hit[]> {
    const mode = opts.mode ?? "hybrid";
    const k = opts.k ?? 5;
    const idx = this.index(tenantId);
    const queryTokens = tokenize(query);
    const candidates = Math.max(k * (this.opts.candidateMultiplier ?? 5), 20);

    const needVector = mode !== "bm25";
    const queryVector = needVector ? (await this.embedder.embed([query]))[0]! : null;

    const bm25 = mode === "vector" ? [] : idx.bm25.search(queryTokens, candidates);
    const vec = queryVector && mode !== "bm25" ? idx.vectors.search(queryVector, candidates) : [];
    const bm25Rank = new Map(bm25.map((r, i) => [r.id, i + 1]));
    const vecRank = new Map(vec.map((r, i) => [r.id, i + 1]));

    let ranked: { id: string; score: number }[];
    if (mode === "bm25") ranked = bm25;
    else if (mode === "vector") ranked = vec;
    else {
      ranked = reciprocalRankFusion([bm25.map((r) => r.id), vec.map((r) => r.id)], this.opts.rrfK ?? 60);
    }

    const hits: Hit[] = [];
    for (const r of ranked.slice(0, k)) {
      const chunk = this.chunks.get(tenantId, r.id);
      if (!chunk) continue;
      hits.push({
        chunk,
        score: r.score,
        bm25Rank: bm25Rank.get(r.id) ?? null,
        vectorRank: vecRank.get(r.id) ?? null,
        cosine: queryVector ? idx.vectors.similarity(r.id, queryVector) : null,
        coverage: idx.bm25.coverage(r.id, queryTokens),
      });
    }
    return hits;
  }
}

