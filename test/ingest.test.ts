import { describe, expect, it } from "vitest";
import { PermanentJobError } from "../src/errors.js";
import { chunkSections } from "../src/ingest/chunk.js";
import { decodeEntities, detectFormat, htmlToText, parseDocument } from "../src/ingest/parse.js";
import { InMemoryJobQueue, type JobEvent, exponentialBackoff } from "../src/ingest/queue.js";
import { IngestService } from "../src/ingest/service.js";
import { EmbedderError, HashingEmbedder } from "../src/retrieval/embedder.js";
import { FakeClock, actorFor, ingestHarness, settle } from "./helpers.js";

describe("HTML to text", () => {
  it("drops script, style, comments and event-handler attributes, keeping visible text", () => {
    const html = `<html><head><title>x</title><style>p{color:red}</style></head><body onload="evil()">
      <!-- hidden --><h1>Refunds</h1><p onclick="steal()">You can <a href="javascript:alert(1)">request a refund</a> within 30 days.</p>
      <script>document.cookie</script></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("# Refunds");
    expect(text).toContain("You can request a refund within 30 days.");
    expect(text).not.toMatch(/evil|steal|javascript|cookie|color:red|hidden|<|>/);
  });

  it("does not let split-tag evasions produce a tag", () => {
    for (const evil of ["<scr<script>ipt>alert(1)</scr</script>ipt>", "<<script>script>alert(1)<</script>/script>", "<img src=x onerror=alert(1)//", "<svg><script>alert(1)</script></svg>after"]) {
      const text = htmlToText(`<p>safe</p>${evil}`);
      expect(text, evil).not.toMatch(/<\/?[a-z!?]/i);
      expect(text, evil).not.toContain("onerror");
    }
    expect(htmlToText("<script>alert(1)")).toBe("");
  });

  it("decodes entities once, so an escaped tag stays literal text", () => {
    expect(htmlToText("<p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>").trim()).toBe("1 < 2 && 3 > 2");
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&#65;&#x42;&bogus;&#0;&#1114112;")).toBe("AB&bogus;  ");
  });

  it("keeps lists, headings and a lone '<' in text", () => {
    const text = htmlToText("<h2>Steps</h2><ul><li>one</li><li>two</li></ul><p>a < b</p>");
    expect(text).toContain("## Steps");
    expect(text).toContain("- one");
    expect(text).toContain("- two");
    expect(text).toContain("a < b");
  });

  it("handles unterminated tags and quoted '>' inside attributes", () => {
    expect(htmlToText('<a title="a > b">link</a> after <div class="x')).toContain("link after");
    expect(htmlToText('<a title="a > b">link</a>')).toBe("link");
  });
});

describe("document parsing", () => {
  it("detects formats", () => {
    expect(detectFormat("<html><body><p>hi</p></body></html>")).toBe("html");
    expect(detectFormat("# Title\n\nbody")).toBe("markdown");
    expect(detectFormat("just some plain words")).toBe("text");
  });

  it("builds heading paths from nested markdown headings and strips inline syntax", () => {
    const md = "# Billing\nIntro **text** with a [link](https://x.example).\n\n## Refunds\nSee `refund` rules.\n\n### Cards\nCard refunds take 5 days.\n\n## Invoices\nDownload from the *dashboard*.";
    const parsed = parseDocument(md, "markdown");
    expect(parsed.title).toBe("Billing");
    expect(parsed.sections.map((s) => s.heading)).toEqual(["Billing", "Billing > Refunds", "Billing > Refunds > Cards", "Billing > Invoices"]);
    expect(parsed.sections[0]!.text).toBe("Intro text with a link.");
    expect(parsed.sections[3]!.text).toBe("Download from the dashboard.");
  });

  it("keeps fenced code, including lines that start with #", () => {
    const parsed = parseDocument("# Doc\n```sh\n# not a heading\nnpm install\n```\n", "markdown");
    expect(parsed.sections).toHaveLength(1);
    expect(parsed.sections[0]!.text).toContain("# not a heading");
  });

  it("strips inline HTML from markdown, including split-tag evasions", () => {
    const parsed = parseDocument("# T\nHello <b>world</b> <scr<script>ipt>alert(1)</script> <!-- c --> done", "markdown");
    expect(parsed.sections[0]!.text).not.toMatch(/<\/?(?:b|script)|alert|<!--/i);
    expect(parsed.sections[0]!.text).toContain("Hello world");
  });

  it("treats plain text as one section and normalises control characters and CRLF", () => {
    const parsed = parseDocument("line one\r\nline\u0000 two\u0007", "text");
    expect(parsed.sections).toEqual([{ heading: "", text: "line one\nline two" }]);
  });

  it("rejects content with no extractable text as a permanent failure", () => {
    expect(() => parseDocument("   \n\n  ", "text")).toThrow(PermanentJobError);
    expect(() => parseDocument("<script>x()</script>", "html")).toThrow(PermanentJobError);
    expect(() => parseDocument("# \n---\n", "markdown")).toThrow(PermanentJobError);
  });
});

describe("chunking", () => {
  it("never mixes sections and respects the size budget", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} says something useful.`).join(" ");
    const chunks = chunkSections([{ heading: "A", text: long }, { heading: "B", text: "short one" }], { maxChars: 200 });
    expect(chunks.filter((c) => c.heading === "A").length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.text.length <= 200)).toBe(true);
    expect(chunks.at(-1)).toEqual({ heading: "B", text: "short one" });
  });

  it("packs short paragraphs together and splits an over-long word run at word boundaries", () => {
    expect(chunkSections([{ heading: "", text: "one\n\ntwo\n\nthree" }], { maxChars: 100 })).toEqual([{ heading: "", text: "one\ntwo\nthree" }]);
    const words = Array.from({ length: 100 }, () => "word").join(" ");
    const chunks = chunkSections([{ heading: "", text: words }], { maxChars: 50 });
    expect(chunks.length).toBeGreaterThan(5);
    expect(chunks.every((c) => c.text.length <= 50)).toBe(true);
    expect(chunks.map((c) => c.text).join(" ")).toBe(words);
  });

  it("refuses documents that would explode into too many chunks", () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join("\n\n");
    expect(() => chunkSections([{ heading: "", text }], { maxChars: 12, maxChunks: 10 })).toThrow(PermanentJobError);
  });
});

describe("job queue", () => {
  const make = (opts: ConstructorParameters<typeof InMemoryJobQueue>[0] = {}) => {
    const clock = new FakeClock(0);
    const queue = new InMemoryJobQueue({ clock: clock.read, backoffMs: exponentialBackoff(100, 1000), ...opts });
    const events: JobEvent[] = [];
    queue.subscribe((e) => events.push(e));
    return { clock, queue, events };
  };

  it("runs a job once and emits queued, started, stage and succeeded events", async () => {
    const { queue, events } = make();
    queue.setHandler("t", async (_job, ctx) => ctx.setStage("work"));
    const job = queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    expect(await queue.tick()).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["queued", "started", "stage", "succeeded"]);
    expect(queue.get("a", job.id)).toMatchObject({ status: "succeeded", attempts: 1, stage: "work" });
  });

  it("retries with exponential backoff, only when the backoff has elapsed", async () => {
    const { queue, clock, events } = make();
    let calls = 0;
    queue.setHandler("t", async () => {
      if (++calls < 3) throw new Error("flaky");
    });
    const job = queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    await queue.tick();
    expect(queue.get("a", job.id)).toMatchObject({ status: "queued", attempts: 1, runAt: 100 });
    expect(await queue.tick()).toBe(0); // not due yet
    clock.advance(100);
    await queue.tick();
    expect(queue.get("a", job.id)).toMatchObject({ status: "queued", attempts: 2, runAt: 100 + 200 });
    clock.advance(200);
    await queue.tick();
    expect(queue.get("a", job.id)).toMatchObject({ status: "succeeded", attempts: 3, lastError: null });
    expect(events.filter((e) => e.type === "retry_scheduled").map((e) => e.nextRunAt)).toEqual([100, 300]);
  });

  it("moves a job to the dead-letter state after maxAttempts and lets an admin retry it", async () => {
    const { queue, clock, events } = make({ maxAttempts: 2 });
    let fail = true;
    queue.setHandler("t", async () => {
      if (fail) throw new Error("always");
    });
    const job = queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    await queue.tick();
    clock.advance(1000);
    await queue.tick();
    expect(queue.get("a", job.id)).toMatchObject({ status: "dead", attempts: 2, lastError: "Error: always" });
    expect(queue.deadLetters("a").map((j) => j.id)).toEqual([job.id]);
    expect(events.at(-1)?.type).toBe("dead");
    fail = false;
    queue.retryDead("a", job.id);
    await queue.tick();
    expect(queue.get("a", job.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    expect(queue.deadLetters("a")).toEqual([]);
  });

  it("dead-letters permanent errors immediately and jobs without a handler", async () => {
    const { queue } = make();
    queue.setHandler("t", async () => {
      throw new PermanentJobError("bad input");
    });
    const a = queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    const b = queue.enqueue({ tenantId: "a", type: "unknown", payload: {} });
    await queue.tick();
    expect(queue.get("a", a.id)).toMatchObject({ status: "dead", attempts: 1 });
    expect(queue.get("a", b.id)).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("redacts PII out of stored error messages", async () => {
    const { queue } = make({ maxAttempts: 1 });
    queue.setHandler("t", async () => {
      throw new Error("failed for jane@example.com");
    });
    const job = queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    await queue.tick();
    expect(queue.get("a", job.id)?.lastError).toBe("Error: failed for [EMAIL]");
  });

  it("keeps working when an event subscriber throws, and supports unsubscribe", async () => {
    const { queue } = make();
    queue.subscribe(() => {
      throw new Error("bad subscriber");
    });
    const seen: string[] = [];
    const off = queue.subscribe((e) => seen.push(e.type));
    queue.setHandler("t", async () => undefined);
    queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    await queue.tick();
    off();
    queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    await queue.tick();
    expect(seen).toEqual(["queued", "started", "succeeded"]);
  });

  it("limits concurrency and processes every job", async () => {
    const { queue } = make({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    queue.setHandler("t", async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    for (let i = 0; i < 6; i++) queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    expect(await queue.tick()).toBe(6);
    expect(peak).toBe(2);
  });

  it("keeps a bounded history and scopes jobs to their tenant", async () => {
    const { queue } = make();
    queue.setHandler("t", async (_j, ctx) => {
      for (let i = 0; i < 100; i++) ctx.setStage(`s${i}`);
    });
    const job = queue.enqueue({ tenantId: "a", type: "t", payload: {} });
    await queue.tick();
    expect(queue.get("a", job.id)!.history.length).toBeLessThanOrEqual(30);
    expect(queue.get("b", job.id)).toBeUndefined();
    expect(queue.list("b")).toEqual([]);
    expect(() => queue.retryDead("b", job.id)).toThrow();
  });

  it("exponentialBackoff doubles and caps", () => {
    const f = exponentialBackoff(100, 500);
    expect([1, 2, 3, 4, 5].map(f)).toEqual([100, 200, 400, 500, 500]);
  });
});

describe("ingestion service", () => {
  const admin = actorFor("t1", "admin");

  it("runs parse, chunk, embed and index, and reports status through polling", async () => {
    const h = ingestHarness();
    const { document, jobId, duplicate } = h.service.submit(admin, { title: "Refunds", content: "# Refunds\nYou can request a refund within 30 days of purchase." });
    expect(duplicate).toBe(false);
    expect(h.service.status(admin, document.id)).toMatchObject({ document: { status: "queued" }, job: { id: jobId, status: "queued" } });
    await h.queue.tick();
    const done = h.service.status(admin, document.id);
    expect(done.document).toMatchObject({ status: "ready", chunkCount: 1 });
    expect(done.job).toMatchObject({ status: "succeeded", stage: "index" });
    expect([...new Set(done.job!.history.map((e) => e.stage).filter(Boolean))]).toEqual(["parse", "chunk", "embed", "index"]);
    expect(h.retriever.chunkCount("t1")).toBe(1);
    expect(JSON.stringify(done)).not.toContain("request a refund"); // raw text is never returned
  });

  it("is idempotent by content hash, per tenant", async () => {
    const h = ingestHarness();
    const first = h.service.submit(admin, { title: "A", content: "Same content here." });
    const second = h.service.submit(admin, { title: "Other title", content: "Same content here.\n" });
    expect(second.duplicate).toBe(true);
    expect(second.document.id).toBe(first.document.id);
    expect(second.jobId).toBe(first.jobId);
    await h.queue.tick();
    expect(h.service.submit(admin, { title: "A", content: "Same content here." }).duplicate).toBe(true);
    expect(h.retriever.chunkCount("t1")).toBe(1);
    expect(h.queue.list("t1")).toHaveLength(1);
    const other = h.service.submit(actorFor("t2", "admin"), { title: "A", content: "Same content here." });
    expect(other.duplicate).toBe(false);
    expect(other.document.id).not.toBe(first.document.id);
  });

  it("retries transient embedder failures and succeeds", async () => {
    let failures = 2;
    const flaky = new HashingEmbedder(256);
    const h = ingestHarness({
      embedder: {
        id: flaky.id,
        dimensions: flaky.dimensions,
        embed: async (t) => {
          if (failures-- > 0) throw new EmbedderError("HTTP 503", true);
          return flaky.embed(t);
        },
      },
    });
    const { document } = h.service.submit(admin, { title: "T", content: "some searchable text" });
    await h.queue.tick();
    expect(h.service.status(admin, document.id)).toMatchObject({ document: { status: "queued", error: expect.stringContaining("503") }, job: { attempts: 1 } });
    await settle(h);
    expect(h.service.status(admin, document.id)).toMatchObject({ document: { status: "ready", error: null }, job: { status: "succeeded", attempts: 3 } });
  });

  it("dead-letters after exhausting retries, marks the document failed, and allows retry", async () => {
    let broken = true;
    const base = new HashingEmbedder(256);
    const h = ingestHarness({
      queue: { maxAttempts: 3 },
      embedder: {
        id: base.id,
        dimensions: base.dimensions,
        embed: async (t) => {
          if (broken) throw new EmbedderError("HTTP 500", true);
          return base.embed(t);
        },
      },
    });
    const { document, jobId } = h.service.submit(admin, { title: "T", content: "some searchable text" });
    await settle(h);
    expect(h.service.status(admin, document.id)).toMatchObject({ document: { status: "failed" }, job: { status: "dead", attempts: 3 } });
    expect(h.service.listJobs(admin, "dead").map((j) => j.id)).toEqual([jobId]);
    broken = false;
    h.service.retryJob(admin, jobId);
    await settle(h);
    expect(h.service.status(admin, document.id).document.status).toBe("ready");
    expect(h.audit.list("t1").map((e) => e.action)).toEqual(["document.ingest", "job.retry"]);
  });

  it("does not retry a non-retryable embedder error", async () => {
    const base = new HashingEmbedder(256);
    const h = ingestHarness({ embedder: { id: base.id, dimensions: base.dimensions, embed: async () => { throw new EmbedderError("HTTP 401", false); } } });
    const { document } = h.service.submit(admin, { title: "T", content: "text" });
    await settle(h);
    expect(h.service.status(admin, document.id)).toMatchObject({ document: { status: "failed" }, job: { attempts: 1 } });
  });

  it("fails an empty-after-parsing document without retrying", async () => {
    const h = ingestHarness();
    const { document } = h.service.submit(admin, { title: "Empty", content: "<script>only()</script>", format: "html" });
    await settle(h);
    expect(h.service.status(admin, document.id)).toMatchObject({ document: { status: "failed", error: expect.stringContaining("no extractable text") }, job: { attempts: 1, status: "dead" } });
  });

  it("re-queues a failed document when the same content is submitted again", async () => {
    const h = ingestHarness();
    const bad = h.service.submit(admin, { title: "Empty", content: "<script>only()</script>", format: "html" });
    await settle(h);
    const again = h.service.submit(admin, { title: "Empty", content: "<script>only()</script>", format: "html" });
    expect(again.duplicate).toBe(false);
    expect(again.document.id).toBe(bad.document.id);
    expect(again.jobId).not.toBe(bad.jobId);
  });

  it("does not index a document that is deleted while queued or while embedding", async () => {
    const h = ingestHarness();
    const queued = h.service.submit(admin, { title: "Q", content: "queued then deleted" });
    h.service.delete(admin, queued.document.id);
    await h.queue.tick();
    expect(h.retriever.chunkCount("t1")).toBe(0);

    const base = new HashingEmbedder(256);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const slow = ingestHarness({ embedder: { id: base.id, dimensions: base.dimensions, embed: async (t) => { await gate; return base.embed(t); } } });
    const doc = slow.service.submit(admin, { title: "S", content: "deleted mid-flight" });
    const running = slow.queue.tick();
    await new Promise((r) => setTimeout(r, 5));
    slow.service.delete(admin, doc.document.id);
    release();
    await running;
    expect(slow.retriever.chunkCount("t1")).toBe(0);
    expect(slow.service.documents.count("t1")).toBe(0);
  });

  it("deletes chunks with the document and audits ingest and delete", async () => {
    const h = ingestHarness();
    const { document } = h.service.submit(admin, { title: "D", content: "# D\nPara one.\n\n## Two\nPara two." });
    await h.queue.tick();
    expect(h.service.delete(admin, document.id)).toEqual({ removedChunks: 2 });
    expect(h.retriever.chunkCount("t1")).toBe(0);
    expect(h.audit.list("t1").map((e) => [e.action, e.target])).toEqual([["document.ingest", document.id], ["document.delete", document.id]]);
  });

  it("validates input and enforces roles", () => {
    const h = ingestHarness();
    expect(() => h.service.submit(admin, { title: "", content: "x" })).toThrow(/title/);
    expect(() => h.service.submit(admin, { title: "t", content: "   " })).toThrow(/content/);
    expect(() => h.service.submit(admin, { title: "t", content: "x".repeat(1_000_001) })).toThrow(/larger/);
    expect(() => h.service.submit(admin, { title: "t", content: "x", format: "pdf" as never })).toThrow(/format/);
    const agent = actorFor("t1", "agent");
    expect(() => h.service.submit(agent, { title: "t", content: "x" })).toThrow(/permission/);
    expect(() => h.service.delete(agent, "whatever")).toThrow(/permission/);
    expect(() => h.service.retryJob(agent, "whatever")).toThrow(/permission/);
    expect(h.service.list(agent)).toEqual([]);
  });

  it("redacts PII from what is indexed and embedded while keeping the original chunk text", async () => {
    const seen: string[] = [];
    const base = new HashingEmbedder(256);
    const h = ingestHarness({ embedder: { id: base.id, dimensions: base.dimensions, embed: async (t) => { seen.push(...t); return base.embed(t); } } });
    h.service.submit(admin, { title: "Contact jane@example.com", content: "Email jane@example.com or call +1 415 555 2671." });
    await h.queue.tick();
    expect(seen.join(" ")).not.toMatch(/jane@example|555 2671/);
    expect(seen.join(" ")).toContain("[EMAIL]");
    const [chunk] = h.retriever.chunks.list("t1");
    expect(chunk!.indexText).toBe("Email [EMAIL] or call [PHONE].");
    expect(chunk!.heading).toBe("Contact [EMAIL]");
    expect(chunk!.text).toContain("jane@example.com");
  });

  it("content hash ignores newline style but depends on format", () => {
    expect(IngestService.contentHash("a\r\nb", "text")).toBe(IngestService.contentHash("a\nb\n", "text"));
    expect(IngestService.contentHash("a", "text")).not.toBe(IngestService.contentHash("a", "markdown"));
  });
});
