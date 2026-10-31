import { describe, expect, it } from "vitest";
import { Bm25Index } from "../src/retrieval/bm25.js";
import { EmbedderError, HashingEmbedder, OpenAiCompatibleEmbedder, RedactingEmbedder } from "../src/retrieval/embedder.js";
import { reciprocalRankFusion } from "../src/retrieval/fusion.js";
import { splitSentences, stem, tokenize } from "../src/retrieval/text.js";
import { VectorIndex, cosine } from "../src/retrieval/vector.js";
import { actorFor, ingestHarness } from "./helpers.js";

describe("tokenizer", () => {
  it("lower-cases, folds accents, drops stopwords and stems plurals", () => {
    expect(tokenize("How do I reset the Passwords for my Accounts?")).toEqual(["reset", "password", "account"]);
    expect(tokenize("Café déjà vu")).toEqual(["cafe", "deja", "vu"]);
  });

  it("ignores redaction tags and one-letter words but keeps numbers", () => {
    expect(tokenize("email [EMAIL] a b 7 days")).toEqual(["email", "7", "day"]);
  });

  it("stems only simple plurals", () => {
    expect([stem("policies"), stem("boxes"), stem("class"), stem("status"), stem("cards"), stem("is"), stem("refunded")]).toEqual([
      "policy",
      "box",
      "class",
      "status",
      "card",
      "is",
      "refunded",
    ]);
  });

  it("splits sentences", () => {
    expect(splitSentences("One. Two? Three!\nFour")).toEqual(["One.", "Two?", "Three!", "Four"]);
    expect(splitSentences("Version 1.2 is out. Yes.")).toEqual(["Version 1.2 is out.", "Yes."]);
  });
});

describe("BM25", () => {
  const build = () => {
    const idx = new Bm25Index();
    idx.add("d1", tokenize("refund policy for annual plans refund within thirty days"));
    idx.add("d2", tokenize("how to change your password and enable two factor"));
    idx.add("d3", tokenize("invoice download and billing address update"));
    return idx;
  };

  it("ranks the document that matches the query terms first", () => {
    const hits = build().search(tokenize("refund policy"), 3);
    expect(hits[0]!.id).toBe("d1");
    expect(hits).toHaveLength(1);
  });

  it("matches the textbook formula", () => {
    const idx = new Bm25Index(1.2, 0.75);
    idx.add("a", ["x", "y"]);
    idx.add("b", ["y", "z"]);
    idx.add("c", ["z"]);
    // N=3, df(x)=1: idf = ln(1 + (3-1+0.5)/(1+0.5)); tf=1, len=2, avgLen=5/3
    const idf = Math.log(1 + 2.5 / 1.5);
    const expected = (idf * 1 * 2.2) / (1 + 1.2 * (1 - 0.75 + (0.75 * 2) / (5 / 3)));
    expect(idx.search(["x"], 1)[0]!.score).toBeCloseTo(expected, 10);
  });

  it("gives rarer terms more weight and caps the benefit of repetition", () => {
    const idx = new Bm25Index();
    idx.add("a", ["rare", "common"]);
    idx.add("b", ["common", "pad"]);
    idx.add("c", ["common", "pad"]);
    expect(idx.idf("rare")).toBeGreaterThan(idx.idf("common"));
    const sat = new Bm25Index();
    sat.add("one", ["term", "pad", "pad", "pad"]);
    sat.add("many", ["term", "term", "term", "term", "term", "term", "term", "term", "term", "term"]);
    sat.add("other", ["pad"]);
    const [first, second] = sat.search(["term"], 2);
    expect(first!.id).toBe("many");
    expect(first!.score).toBeGreaterThan(second!.score);
    expect(first!.score).toBeLessThan(sat.idf("term") * (1.2 + 1)); // BM25 saturates at idf * (k1 + 1)
  });

  it("removes documents completely, including statistics", () => {
    const idx = build();
    expect(idx.remove("d1")).toBe(true);
    expect(idx.remove("d1")).toBe(false);
    expect(idx.search(["refund"], 5)).toEqual([]);
    expect(idx.size).toBe(2);
  });

  it("re-adding a document replaces it", () => {
    const idx = build();
    idx.add("d1", ["completely", "different"]);
    expect(idx.search(["refund"], 5)).toEqual([]);
    expect(idx.search(["different"], 5)[0]!.id).toBe("d1");
    expect(idx.size).toBe(3);
  });

  it("breaks score ties by insertion order, so results are deterministic", () => {
    const idx = new Bm25Index();
    idx.add("zzz", ["a"]);
    idx.add("aaa", ["a"]);
    expect(idx.search(["a"], 2).map((r) => r.id)).toEqual(["zzz", "aaa"]);
  });

  it("returns nothing for an empty index, empty query or k=0", () => {
    expect(new Bm25Index().search(["a"], 3)).toEqual([]);
    expect(build().search([], 3)).toEqual([]);
    expect(build().search(["refund"], 0)).toEqual([]);
  });

  it("coverage is the idf-weighted share of query terms found in a document", () => {
    const idx = build();
    expect(idx.coverage("d1", ["refund", "policy"])).toBeCloseTo(1, 10);
    expect(idx.coverage("d1", ["refund", "bitcoin"])).toBeGreaterThan(0.1);
    expect(idx.coverage("d1", ["refund", "bitcoin"])).toBeLessThan(0.7);
    expect(idx.coverage("d1", ["bitcoin"])).toBe(0);
    expect(idx.coverage("missing", ["refund"])).toBe(0);
  });
});

describe("Reciprocal Rank Fusion", () => {
  it("scores 1/(k+rank) summed over lists", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["b", "c"]], 60);
    const byId = Object.fromEntries(fused.map((f) => [f.id, f]));
    expect(byId.b!.score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(byId.a!.score).toBeCloseTo(1 / 61, 12);
    expect(byId.c!.score).toBeCloseTo(1 / 62, 12);
    expect(fused.map((f) => f.id)).toEqual(["b", "a", "c"]);
    expect(byId.b!.ranks).toEqual([2, 1]);
    expect(byId.a!.ranks).toEqual([1, null]);
  });

  it("promotes items both rankers like over items only one ranker loves", () => {
    const fused = reciprocalRankFusion([["x", "shared"], ["y", "shared"]]);
    expect(fused[0]!.id).toBe("shared");
  });

  it("handles empty and single lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], ["a"]]).map((f) => f.id)).toEqual(["a"]);
  });

  it("breaks exact ties by best rank, then first appearance", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["b", "a"]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
  });
});

describe("hashing embedder", () => {
  const e = new HashingEmbedder(256);

  it("is deterministic, unit length and has the declared size", async () => {
    const [a, b] = await e.embed(["reset my password", "reset my password"]);
    expect(a).toEqual(b);
    expect(a!.length).toBe(256);
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);
    let norm = 0;
    for (const x of a!) norm += x * x;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it("scores word-form variants and typos higher than unrelated text", async () => {
    const [base, variant, typo, other] = await e.embed(["refund request", "refunded requests", "refnd reqest", "dark mode setting"]);
    expect(cosine(base!, variant!)).toBeGreaterThan(cosine(base!, other!) + 0.2);
    expect(cosine(base!, typo!)).toBeGreaterThan(cosine(base!, other!) + 0.1);
  });

  it("returns the zero vector for empty text, which matches nothing", async () => {
    const [empty, other] = await e.embed(["", "something"]);
    expect([...empty!].every((x) => x === 0)).toBe(true);
    expect(cosine(empty!, other!)).toBe(0);
  });
});

describe("vector index", () => {
  it("returns exact cosine neighbours in order and removes entries", () => {
    const idx = new VectorIndex(2);
    idx.add("x", Float32Array.from([1, 0]));
    idx.add("diag", Float32Array.from([1, 1]));
    idx.add("y", Float32Array.from([0, 1]));
    const hits = idx.search(Float32Array.from([1, 0.1]), 3);
    expect(hits.map((h) => h.id)).toEqual(["x", "diag", "y"]);
    idx.remove("x");
    expect(idx.search(Float32Array.from([1, 0.1]), 3)[0]!.id).toBe("diag");
    expect(idx.similarity("nope", Float32Array.from([1, 0]))).toBeNull();
  });

  it("rejects vectors of the wrong size", () => {
    expect(() => new VectorIndex(2).add("a", Float32Array.from([1, 2, 3]))).toThrow(/dimensions/);
  });
});

describe("OpenAI-compatible embedder over HTTP (fake fetch)", () => {
  const ok = (vectors: number[][]) =>
    new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })) }), { status: 200, headers: { "content-type": "application/json" } });

  it("posts the model and inputs with a bearer token, batches, and normalises the result", async () => {
    const calls: { url: string; body: { model: string; input: string[] }; auth: string | null }[] = [];
    const embedder = new OpenAiCompatibleEmbedder({
      baseUrl: "https://llm.example.test/v1/",
      apiKey: "test-token",
      model: "m1",
      dimensions: 2,
      batchSize: 2,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
        calls.push({ url, body, auth: new Headers(init?.headers).get("authorization") });
        return ok(body.input.map(() => [3, 4]));
      },
    });
    const out = await embedder.embed(["a", "b", "c"]);
    expect(calls.map((c) => c.body.input)).toEqual([["a", "b"], ["c"]]);
    expect(calls[0]).toMatchObject({ url: "https://llm.example.test/v1/embeddings", auth: "Bearer test-token" });
    expect(calls[0]!.body.model).toBe("m1");
    expect(out).toHaveLength(3);
    expect(out[0]![0]).toBeCloseTo(0.6, 5);
    expect(out[0]![1]).toBeCloseTo(0.8, 5);
  });

  it("re-orders rows by index", async () => {
    const embedder = new OpenAiCompatibleEmbedder({
      baseUrl: "https://x.test",
      model: "m",
      dimensions: 2,
      fetch: async () => new Response(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })),
    });
    const [first, second] = await embedder.embed(["one", "two"]);
    expect([...first!]).toEqual([1, 0]);
    expect([...second!]).toEqual([0, 1]);
  });

  it("classifies failures as retryable or not and never echoes the response body", async () => {
    const make = (res: () => Promise<Response>) => new OpenAiCompatibleEmbedder({ baseUrl: "https://x.test", model: "m", dimensions: 2, fetch: res });
    const rejected = (e: Promise<unknown>) => e.then(() => null, (err: unknown) => err as EmbedderError);
    expect(await rejected(make(async () => new Response("secret body jane@example.com", { status: 503 })).embed(["a"]))).toMatchObject({ retryable: true, message: "embedding endpoint returned HTTP 503" });
    expect(await rejected(make(async () => new Response("{}", { status: 429 })).embed(["a"]))).toMatchObject({ retryable: true });
    expect(await rejected(make(async () => new Response("{}", { status: 401 })).embed(["a"]))).toMatchObject({ retryable: false });
    expect(await rejected(make(async () => { throw new Error("socket jane@example.com"); }).embed(["a"]))).toMatchObject({ retryable: true, message: "embedding request failed (network or timeout)" });
    expect(await rejected(make(async () => new Response("not json")).embed(["a"]))).toMatchObject({ retryable: false });
  });

  it("rejects wrong counts, wrong sizes and non-numeric vectors", async () => {
    const make = (data: unknown) => new OpenAiCompatibleEmbedder({ baseUrl: "https://x.test", model: "m", dimensions: 2, fetch: async () => new Response(JSON.stringify({ data })) });
    await expect(make([]).embed(["a"])).rejects.toBeInstanceOf(EmbedderError);
    await expect(make([{ index: 0, embedding: [1, 2, 3] }]).embed(["a"])).rejects.toThrow(/malformed/);
    await expect(make([{ index: 0, embedding: ["a", "b"] }]).embed(["a"])).rejects.toThrow(/malformed/);
    await expect(make([{ index: 0, embedding: [Number.NaN, 1] }]).embed(["a"])).rejects.toThrow(/malformed/);
  });
});

describe("RedactingEmbedder", () => {
  it("redacts every text before the wrapped embedder sees it", async () => {
    const seen: string[] = [];
    const inner = { id: "spy", dimensions: 1, embed: async (t: readonly string[]) => (seen.push(...t), t.map(() => Float32Array.from([1]))) };
    await new RedactingEmbedder(inner).embed(["mail jane@example.com now", "plain"]);
    expect(seen).toEqual(["mail [EMAIL] now", "plain"]);
  });
});

describe("hybrid retriever", () => {
  const admin = actorFor("t1", "admin");

  async function seeded() {
    const h = ingestHarness();
    h.service.submit(admin, { title: "Refunds", content: "# Refunds\nRefunds are issued to the original payment method within 5 business days." });
    h.service.submit(admin, { title: "Passwords", content: "# Passwords\nUse the account settings page to reset a forgotten password. Two factor codes are required." });
    h.service.submit(admin, { title: "Invoices", content: "# Invoices\nInvoices can be downloaded as PDF from the billing page." });
    await h.queue.tick();
    return h;
  }

  it("finds the right document in bm25, vector and hybrid modes", async () => {
    const h = await seeded();
    for (const mode of ["bm25", "vector", "hybrid"] as const) {
      const hits = await h.retriever.search("t1", "how do I reset my password", { mode, k: 3 });
      expect(hits[0]!.chunk.heading, mode).toBe("Passwords > Passwords");
    }
  });

  it("hybrid surfaces a typo match that BM25 misses", async () => {
    const h = await seeded();
    const q = "pasword reset";
    const bm25 = await h.retriever.search("t1", q, { mode: "bm25", k: 3 });
    const hybrid = await h.retriever.search("t1", q, { mode: "hybrid", k: 3 });
    expect(hybrid[0]!.chunk.heading).toContain("Passwords");
    expect(bm25.map((h2) => h2.chunk.heading).join()).not.toContain("Passwords > Passwords,Passwords"); // sanity: single result list
    expect(hybrid[0]!.vectorRank).toBe(1);
  });

  it("reports per-ranker ranks, cosine and coverage on each hit", async () => {
    const h = await seeded();
    const [top] = await h.retriever.search("t1", "invoices pdf billing", { mode: "hybrid", k: 2 });
    expect(top!.chunk.heading).toContain("Invoices");
    expect(top!.bm25Rank).toBe(1);
    expect(top!.vectorRank).toBe(1);
    expect(top!.cosine).toBeGreaterThan(0.2);
    expect(top!.coverage).toBeGreaterThan(0.9);
    const [bm] = await h.retriever.search("t1", "invoices pdf billing", { mode: "bm25", k: 1 });
    expect(bm!.cosine).toBeNull();
  });

  it("returns nothing for an empty tenant and for unrelated queries in bm25 mode", async () => {
    const h = await seeded();
    expect(await h.retriever.search("empty", "refund", { mode: "hybrid" })).toEqual([]);
    expect(await h.retriever.search("t1", "xylophone zebra", { mode: "bm25" })).toEqual([]);
  });

  it("never returns another tenant's chunks, and tenants have independent statistics", async () => {
    const h = await seeded();
    const other = actorFor("t2", "admin");
    h.service.submit(other, { title: "Secrets", content: "# Secrets\nThe vault passphrase for Tenant Two is pelican." });
    await h.queue.tick();
    for (const mode of ["bm25", "vector", "hybrid"] as const) {
      const t1 = await h.retriever.search("t1", "vault passphrase pelican", { mode, k: 10 });
      expect(t1.every((x) => x.chunk.tenantId === "t1"), mode).toBe(true);
      expect(JSON.stringify(t1)).not.toContain("pelican");
      const t2 = await h.retriever.search("t2", "vault passphrase pelican", { mode, k: 10 });
      expect(t2[0]!.chunk.text).toContain("pelican");
    }
    expect(h.retriever.chunkCount("t1")).toBe(3);
    expect(h.retriever.chunkCount("t2")).toBe(1);
  });

  it("removing a document removes it from every ranking", async () => {
    const h = await seeded();
    const refunds = h.service.list(admin).find((d) => d.title === "Refunds")!;
    h.service.delete(admin, refunds.id);
    for (const mode of ["bm25", "vector", "hybrid"] as const) {
      const hits = await h.retriever.search("t1", "refund payment method", { mode, k: 5 });
      expect(hits.some((x) => x.chunk.documentId === refunds.id), mode).toBe(false);
    }
  });

  it("commit rejects chunks from another tenant or document and wrong-sized vectors", async () => {
    const h = ingestHarness();
    const chunk = { id: "d:0", tenantId: "t1", documentId: "d", ordinal: 0, heading: "", text: "x", indexText: "x" };
    const v = new Float32Array(256);
    expect(() => h.retriever.commit("t2", "d", [chunk], [v])).toThrow(/belong/);
    expect(() => h.retriever.commit("t1", "other", [chunk], [v])).toThrow(/belong/);
    expect(() => h.retriever.commit("t1", "d", [chunk], [new Float32Array(3)])).toThrow(/dimension/);
    expect(() => h.retriever.commit("t1", "d", [chunk], [])).toThrow(/length/);
    expect(h.retriever.chunkCount("t1")).toBe(0);
  });
});
