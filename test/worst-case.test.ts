import { describe, expect, it, vi } from "vitest";
import { chunkSections } from "../src/ingest/chunk.js";
import { ProcessingBudget } from "../src/ingest/budget.js";
import { detectFormat, parseDocument } from "../src/ingest/parse.js";
import { findPii } from "../src/privacy/pii.js";
import { type DocFormat } from "../src/ingest/parse.js";
import { actorFor, ingestHarness } from "./helpers.js";

/*
 * Regression tests for hostile document content. Each input below made the earlier regular-expression
 * based parser spend tens of seconds to minutes on the single thread that serves every tenant (measured
 * in a container: for example 51 s for 262,144 "[" characters, 71 s for "# " + 262,144 "#"). With the linear
 * scanners each finishes in tens of milliseconds. The limits here are deliberately generous (about 25 to 100
 * times the measured time on the machine they were written on) so slow CI machines pass; a return of
 * quadratic behaviour would miss them by orders of magnitude, not by a few percent.
 */

const MB = 990_000;

interface Hostile {
  name: string;
  format: DocFormat | "auto";
  content: string;
}

const HOSTILE: Hostile[] = [
  { name: "unclosed comment openers", format: "markdown", content: "<!--".repeat(MB / 4) },
  { name: "unclosed <script> openers", format: "markdown", content: "<script>".repeat(MB / 8) },
  { name: "bracket openers", format: "markdown", content: "[".repeat(MB) },
  { name: "unfinished links", format: "markdown", content: "[a](".repeat(MB / 4) },
  { name: "unclosed emphasis", format: "markdown", content: " *a".repeat(MB / 3) },
  { name: "heading with a hash run", format: "markdown", content: `# ${"#".repeat(MB)}x` },
  { name: "long whitespace run before text", format: "markdown", content: `a${" ".repeat(MB)}x` },
  { name: "html: long whitespace run", format: "html", content: `<p>a${" ".repeat(MB)}x</p>` },
  { name: "html: unclosed <script> openers", format: "html", content: "<script>".repeat(MB / 8) },
  { name: "html: closed <script> pairs", format: "html", content: "<script></script>".repeat(MB / 17) },
  { name: "html: very many tags", format: "html", content: "<b>a</b>".repeat(MB / 8) },
  { name: "auto: tag openers", format: "auto", content: "<a ".repeat(MB / 3) },
  { name: "auto: newlines then text", format: "auto", content: `${"\n".repeat(MB)}x` },
  { name: "single token of phone-like text", format: "text", content: "415-555-2671,".repeat(MB / 13) },
  { name: "single 990 KB word", format: "text", content: "x".repeat(MB) },
];

async function parseAndChunk(h: Hostile): Promise<number> {
  const started = performance.now();
  const budget = new ProcessingBudget(60_000);
  try {
    const parsed = await parseDocument(h.content, h.format, budget);
    await chunkSections(parsed.sections, {}, budget);
  } catch (err) {
    // Rejection is fine (no text, too many chunks); what matters is how long it took.
    expect((err as Error).name).toBe("PermanentJobError");
  }
  return performance.now() - started;
}

describe("hostile document content is processed in linear time", () => {
  it.each(HOSTILE.map((h) => [h.name, h] as const))("%s (about 1 MB) parses and chunks in well under a few seconds", async (_name, hostile) => {
    expect(await parseAndChunk(hostile)).toBeLessThan(3000);
  }, 30_000);

  it("detects the format of hostile 1 MB inputs quickly", () => {
    for (const content of ["<a ".repeat(MB / 3), `${"\n".repeat(MB)}x`, "<".repeat(MB), "- ".repeat(MB / 2), `${" ".repeat(MB)}#`]) {
      const started = performance.now();
      detectFormat(content);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });

  it("resolves PII overlaps in linear time: tens of thousands of phone numbers in one span", () => {
    const started = performance.now();
    const found = findPii("415-555-2671,".repeat(60_000));
    expect(found).toHaveLength(60_000);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it("chunks a million-character token into bounded pieces instead of one giant chunk", async () => {
    const parsed = await parseDocument("a".repeat(500_000), "text");
    const chunks = await chunkSections(parsed.sections, { maxChunks: 5000 });
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(600);
  }, 30_000);
});

describe("one tenant's hostile document does not stall the others", () => {
  const admin = actorFor("t1", "admin");

  /** Longest gap between ticks of a 1 ms timer while `work` runs: how long everything else was blocked. */
  async function longestStall(work: () => Promise<void>): Promise<number> {
    let last = performance.now();
    let worst = 0;
    const beat = setInterval(() => {
      const now = performance.now();
      worst = Math.max(worst, now - last);
      last = now;
    }, 1);
    await work();
    await new Promise<void>((resolve) => setImmediate(resolve)); // let the timer record the final gap
    clearInterval(beat);
    return worst;
  }

  it.each([
    ["unclosed comment openers", { format: "markdown" as const, content: "<!--".repeat(60_000) }],
    ["bracket openers", { format: "markdown" as const, content: "[".repeat(240_000) }],
    ["heading with a hash run", { format: "markdown" as const, content: `# ${"#".repeat(240_000)}x` }],
    ["html whitespace run", { format: "html" as const, content: `<p>a${" ".repeat(240_000)}x</p>` }],
    ["phone-like single token", { format: "text" as const, content: "415-555-2671,".repeat(18_000) }],
  ])("%s: the event loop keeps running during ingestion", async (_name, doc) => {
    const h = ingestHarness();
    h.service.submit(admin, { title: "hostile", ...doc });
    const stall = await longestStall(async () => {
      await h.queue.tick();
    });
    expect(stall).toBeLessThan(750);
  }, 30_000);

  it("processing yields to timers while a large document is parsed", async () => {
    const h = ingestHarness();
    // 200,000 short lines: far more than one 10 ms slice of work on any machine, and under the chunk limit.
    h.service.submit(admin, { title: "big", format: "markdown", content: "a\n".repeat(200_000) });
    let ticks = 0;
    const interval = setInterval(() => ticks++, 0);
    const yields = vi.spyOn(globalThis, "setImmediate");
    await h.queue.tick();
    const yielded = yields.mock.calls.length;
    yields.mockRestore();
    clearInterval(interval);
    expect(h.service.list(admin)[0]!.status).toBe("ready");
    expect(yielded).toBeGreaterThan(0);
    expect(ticks).toBeGreaterThan(0);
  }, 30_000);

  it("a document that exhausts its processing budget is rejected permanently, not retried", async () => {
    const h = ingestHarness({ processingBudgetMs: 0 });
    const { document } = h.service.submit(admin, { title: "x", format: "markdown", content: "line\n".repeat(50_000) });
    await h.queue.tick();
    const status = h.service.status(admin, document.id);
    expect(status.document).toMatchObject({ status: "failed", error: expect.stringContaining("CPU time") });
    expect(status.job).toMatchObject({ status: "dead", attempts: 1 });
  }, 30_000);
});
