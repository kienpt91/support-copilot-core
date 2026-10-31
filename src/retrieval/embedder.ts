import { isRecord } from "../util.js";
import { redactStatic } from "../privacy/pii.js";

export interface Embedder {
  /** Identifies the model; indexes built with one id must be queried with the same id. */
  readonly id: string;
  readonly dimensions: number;
  /** Returns one unit-length vector per input text, in order. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export class EmbedderError extends Error {
  constructor(
    message: string,
    /** True for failures worth retrying (timeouts, 429, 5xx). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbedderError";
  }
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

function fnv1a(text: string, seed: number): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const WORD = /[\p{L}\p{N}]+/gu;

/**
 * Deterministic offline embedder: the hashing trick over word unigrams, word bigrams and character
 * trigrams (signed buckets, sub-linear term frequency, L2 normalised).
 *
 * This is a lexical embedder, not a semantic one. Character trigrams make it tolerant of typos
 * and word-form changes ("refunded" ~ "refund"), but it knows nothing about synonyms.
 */
export class HashingEmbedder implements Embedder {
  readonly id: string;

  constructor(readonly dimensions = 512) {
    this.id = `hashing-ngram-${dimensions}`;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  embedOne(text: string): Float32Array {
    const folded = text.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");
    const words = folded.match(WORD) ?? [];
    const counts = new Map<string, number>();
    const bump = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      bump(`w:${w}`);
      if (i + 1 < words.length) bump(`b:${w} ${words[i + 1]}`);
      const padded = `^${w}$`;
      for (let j = 0; j + 3 <= padded.length; j++) bump(`c:${padded.slice(j, j + 3)}`);
    }
    const vec = new Float32Array(this.dimensions);
    for (const [feature, count] of counts) {
      const weight = (1 + Math.log(count)) * (feature.startsWith("w:") ? 1 : feature.startsWith("b:") ? 0.7 : 0.4);
      const bucket = fnv1a(feature, 0) % this.dimensions;
      const sign = fnv1a(feature, 0x9e3779b9) & 1 ? 1 : -1;
      vec[bucket] = vec[bucket]! + sign * weight;
    }
    return l2normalize(vec);
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpEmbedderOptions {
  /** e.g. https://api.example.com/v1 (the path /embeddings is appended). */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Output size of the model. Responses of any other size are rejected. */
  dimensions: number;
  batchSize?: number;
  timeoutMs?: number;
  fetch?: FetchLike;
}

/**
 * Embedder for any server that implements the OpenAI-style `POST /embeddings` API.
 * `fetch` is injected so tests run against a fake. Error messages never include response bodies,
 * which could echo input text.
 */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;
  private readonly fetchFn: FetchLike;
  private readonly url: string;

  constructor(private readonly opts: HttpEmbedderOptions) {
    this.dimensions = opts.dimensions;
    this.id = `http:${opts.model}:${opts.dimensions}`;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.url = `${opts.baseUrl.replace(/\/+$/, "")}/embeddings`;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    const size = this.opts.batchSize ?? 32;
    for (let i = 0; i < texts.length; i += size) {
      out.push(...(await this.embedBatch(texts.slice(i, i + size))));
    }
    return out;
  }

  private async embedBatch(batch: readonly string[]): Promise<Float32Array[]> {
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.opts.model, input: batch, encoding_format: "float" }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch {
      throw new EmbedderError("embedding request failed (network or timeout)", true);
    }
    if (!res.ok) {
      throw new EmbedderError(`embedding endpoint returned HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new EmbedderError("embedding endpoint returned invalid JSON", false);
    }
    const rows = isRecord(payload) ? payload.data : undefined;
    if (!Array.isArray(rows) || rows.length !== batch.length) {
      throw new EmbedderError("embedding endpoint returned an unexpected number of vectors", false);
    }
    const indexOf = (row: unknown) => (isRecord(row) && typeof row.index === "number" ? row.index : 0);
    const ordered: unknown[] = [...rows].sort((a, b) => indexOf(a) - indexOf(b));
    return ordered.map((row) => {
      const e = isRecord(row) ? row.embedding : undefined;
      if (!Array.isArray(e) || e.length !== this.dimensions || !e.every((x) => typeof x === "number" && Number.isFinite(x))) {
        throw new EmbedderError("embedding endpoint returned a malformed or wrongly sized vector", false);
      }
      return l2normalize(Float32Array.from(e as number[]));
    });
  }
}

/**
 * Wraps any embedder so that text is always redacted first. Every embedder the core uses goes through
 * this wrapper, which makes "no raw PII reaches an embedding model" a property of the wiring
 * rather than something each caller has to remember.
 */
export class RedactingEmbedder implements Embedder {
  readonly id: string;
  readonly dimensions: number;

  constructor(private readonly inner: Embedder) {
    this.id = inner.id;
    this.dimensions = inner.dimensions;
  }

  embed(texts: readonly string[]): Promise<Float32Array[]> {
    return this.inner.embed(texts.map((t) => redactStatic(t)));
  }
}
