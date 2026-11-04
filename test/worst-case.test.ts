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
 * scanners each finishes in tens of milliseconds. The tests compare the CPU time for an input and one eight times
 * larger instead of using a wall-clock cap: linear work gives a ratio of about 8, quadratic work about 64, and a slow
 * or busy machine changes neither.
 */

const MB = 990_000;

/** `make(n)` builds a hostile document of about `n` bytes. */
interface Hostile {
  name: string;
  format: DocFormat | "auto";
  make: (n: number) => string;
}

const HOSTILE: Hostile[] = [
  { name: "unclosed comment openers", format: "markdown", make: (n) => "<!--".repeat(n / 4) },
  { name: "unclosed <script> openers", format: "markdown", make: (n) => "<script>".repeat(n / 8) },
  { name: "bracket openers", format: "markdown", make: (n) => "[".repeat(n) },
  { name: "unfinished links", format: "markdown", make: (n) => "[a](".repeat(n / 4) },
  { name: "unclosed emphasis", format: "markdown", make: (n) => " *a".repeat(n / 3) },
  { name: "heading with a hash run", format: "markdown", make: (n) => `# ${"#".repeat(n)}x` },
  { name: "long whitespace run before text", format: "markdown", make: (n) => `a${" ".repeat(n)}x` },
  { name: "html: long whitespace run", format: "html", make: (n) => `<p>a${" ".repeat(n)}x</p>` },
  { name: "html: unclosed <script> openers", format: "html", make: (n) => "<script>".repeat(n / 8) },
  { name: "html: closed <script> pairs", format: "html", make: (n) => "<script></script>".repeat(n / 17) },
  { name: "html: very many tags", format: "html", make: (n) => "<b>a</b>".repeat(n / 8) },
  { name: "auto: tag openers", format: "auto", make: (n) => "<a ".repeat(n / 3) },
  { name: "auto: newlines then text", format: "auto", make: (n) => `${"\n".repeat(n)}x` },
  { name: "single token of phone-like text", format: "text", make: (n) => "415-555-2671,".repeat(n / 13) },
  { name: "single 990 KB word", format: "text", make: (n) => "x".repeat(n) },
];

/** Parse and chunk; a rejection is fine (no text, too many chunks), what matters is the cost, which `growth` measures. */
async function parseAndChunk(content: string, format: DocFormat | "auto"): Promise<void> {
  const budget = new ProcessingBudget(60_000);
  try {
    const parsed = await parseDocument(content, format, budget);
    await chunkSections(parsed.sections, {}, budget);
  } catch (err) {
    expect((err as Error).name).toBe("PermanentJobError");
  }
}

/** An 8x larger input may cost at most this many times the CPU time of the small one: linear is about 8, quadratic about 64. */
const MAX_GROWTH = 24;

/**
 * CPU microseconds of the calling thread. Not the whole process: V8's parallel garbage-collector threads spin while waiting when the
 * machine is oversubscribed, which inflates process-wide CPU time for allocation-heavy (larger) inputs and has nothing to do with the code.
 */
function threadCpuMicros(): number {
  const used = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : process.cpuUsage();
  return used.user + used.system;
}

/** CPU milliseconds used by `fn`; the best of five runs, so a busy machine does not inflate it. */
async function cpuMs(fn: () => unknown): Promise<number> {
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const before = threadCpuMicros();
    await fn();
    best = Math.min(best, (threadCpuMicros() - before) / 1000);
  }
  return best;
}

/**
 * CPU time of `fn` on `make(8 * n)` divided by its CPU time on `make(n)`. Unlike a wall-clock cap this does not depend on how fast or
 * busy the machine is. The small time is floored at 10 ms so timer granularity and one-off hiccups cannot inflate the ratio.
 */
async function growth<T>(make: (size: number) => T, n: number, fn: (input: T) => unknown): Promise<number> {
  const small = make(n);
  const large = make(8 * n);
  await fn(small);
  return (await cpuMs(() => fn(large))) / Math.max(await cpuMs(() => fn(small)), 10);
}

describe("hostile document content is processed in linear time", () => {
  it.each(HOSTILE.map((h) => [h.name, h] as const))("%s (about 1 MB) parses and chunks in linear time", async (_name, hostile) => {
    expect(await growth(hostile.make, MB / 8, (content) => parseAndChunk(content, hostile.format))).toBeLessThan(MAX_GROWTH);
  }, 120_000);

  it("detects the format of hostile 1 MB inputs in linear time", async () => {
    const inputs: Array<(n: number) => string> = [(n) => "<a ".repeat(n / 3), (n) => `${"\n".repeat(n)}x`, (n) => "<".repeat(n), (n) => "- ".repeat(n / 2), (n) => `${" ".repeat(n)}#`];
    for (const make of inputs) expect(await growth(make, MB / 8, (content) => detectFormat(content))).toBeLessThan(MAX_GROWTH);
  }, 120_000);

  it("resolves PII overlaps in linear time: tens of thousands of phone numbers in one span", async () => {
    expect(findPii("415-555-2671,".repeat(60_000))).toHaveLength(60_000);
    expect(await growth((n) => "415-555-2671,".repeat(n), 7500, (text) => findPii(text))).toBeLessThan(MAX_GROWTH);
  }, 120_000);

  it("chunks a million-character token into bounded pieces instead of one giant chunk", async () => {
    const parsed = await parseDocument("a".repeat(500_000), "text");
    const chunks = await chunkSections(parsed.sections, { maxChunks: 5000 });
    expect(Math.max(...chunks.map((c) => c.text.length))).toBeLessThanOrEqual(600);
  }, 30_000);
});

describe("one tenant's hostile document does not stall the others", () => {
  const admin = actorFor("t1", "admin");

  /**
   * Most CPU time (ms) spent between two ticks of a 1 ms timer while `work` runs: how long everything else was blocked by work that
   * never yielded. CPU time rather than elapsed time, so a busy machine that deschedules the process does not look like a stall.
   */
  async function longestStall(work: () => Promise<void>): Promise<number> {
    const cpu = () => threadCpuMicros() / 1000;
    let last = cpu();
    let worst = 0;
    const beat = setInterval(() => {
      const now = cpu();
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
