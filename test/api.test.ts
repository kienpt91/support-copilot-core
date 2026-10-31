import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Core } from "../src/core.js";
import { type ApiOptions, buildApp } from "../src/api/app.js";
import { TokenBucketLimiter, clientKey } from "../src/api/ratelimit.js";
import { EmbedderError, HashingEmbedder } from "../src/retrieval/embedder.js";
import { CORPUS } from "../src/eval/corpus.js";
import { FakeClock, newCore, settle } from "./helpers.js";

const OPERATOR = `op-${"z9".repeat(16)}`;
const ORIGIN = "https://shop.example";

interface Created {
  tenant: { id: string; name: string };
  ownerKey: string;
  publicKey: string;
}

type Body = Record<string, unknown>;
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });
const body = (res: { json: () => unknown }): Body => res.json() as Body;
const errorOf = (res: { json: () => unknown }) => (body(res).error ?? {}) as { code?: string; message?: string };

interface Env {
  app: FastifyInstance;
  core: Core;
  clock: FakeClock;
  createTenant(name: string, allowedOrigins?: string[]): Promise<Created>;
  issue(owner: Created, role: "admin" | "agent"): Promise<string>;
}

async function boot(apiOpts: ApiOptions = {}, coreOpts: Parameters<typeof newCore>[0] = {}): Promise<Env> {
  const env = newCore(coreOpts);
  const app = buildApp(env.core, { operatorToken: OPERATOR, clock: env.clock.read, ...apiOpts });
  await app.ready();
  const createTenant = async (name: string, allowedOrigins: string[] = [ORIGIN]): Promise<Created> => {
    const res = await app.inject({ method: "POST", url: "/v1/operator/tenants", headers: bearer(OPERATOR), payload: { name, allowedOrigins } });
    expect(res.statusCode).toBe(201);
    return body(res) as unknown as Created;
  };
  const issue = async (owner: Created, role: "admin" | "agent") => {
    const res = await app.inject({ method: "POST", url: "/v1/keys", headers: bearer(owner.ownerKey), payload: { kind: "secret", role } });
    expect(res.statusCode).toBe(201);
    return body(res).key as string;
  };
  return { ...env, app, createTenant, issue };
}

describe("basics and safe errors", () => {
  it("serves health and returns JSON 404s with security headers", async () => {
    const { app } = await boot();
    const ok = await app.inject({ url: "/healthz" });
    expect(ok.statusCode).toBe(200);
    expect(body(ok)).toEqual({ status: "ok" });
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["cache-control"]).toBe("no-store");
    const missing = await app.inject({ url: "/nope" });
    expect(missing.statusCode).toBe(404);
    expect(errorOf(missing).code).toBe("not_found");
  });

  it("hides internal error details behind a generic 500", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    vi.spyOn(env.core.ingest, "list").mockImplementation(() => {
      throw new Error("db password=hunter2 at /srv/app/secret.ts:42");
    });
    const res = await env.app.inject({ url: "/v1/documents", headers: bearer(t.ownerKey) });
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe(JSON.stringify({ error: { code: "internal_error", message: "Internal server error." } }));
    expect(res.body).not.toMatch(/hunter2|secret\.ts/);
  });

  it("returns 400 for malformed JSON and schema violations without echoing the input", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const bad = await env.app.inject({ method: "POST", url: "/v1/documents", headers: { ...bearer(t.ownerKey), "content-type": "application/json" }, payload: "{not json" });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).code).toBe("invalid_request");
    const missing = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "x" } });
    expect(missing.statusCode).toBe(400);
    const extra = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "x", content: "y", tenantId: "someone-else" } });
    expect(extra.statusCode).toBe(400);
    const wrongType = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: 5, content: "y" } });
    expect(wrongType.statusCode).toBe(400);
    expect(wrongType.body).not.toContain("hunter2");
  });

  it("rejects oversized bodies with 413 (global limit for uploads, 16 KiB for chat)", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const big = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "big", content: "x".repeat(1_600_000) } });
    expect(big.statusCode).toBe(413);
    expect(errorOf(big).code).toBe("payload_too_large");
    const chat = await env.app.inject({ method: "POST", url: "/v1/chat", headers: bearer(t.ownerKey), payload: { message: "x".repeat(20_000) } });
    expect(chat.statusCode).toBe(413);
  });

  it("rejects document content over the 1 MB limit even when the request body fits", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const res = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "big", content: "é".repeat(600_000) } });
    expect(res.statusCode).toBe(400);
  });

  it("only accepts application/json bodies, so a text/plain cross-origin request cannot skip the preflight", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const res = await env.app.inject({
      method: "POST",
      url: `/v1/chat?pk=${t.publicKey}`,
      headers: { origin: ORIGIN, "content-type": "text/plain" },
      payload: JSON.stringify({ message: "hi" }),
    });
    expect(res.statusCode).toBe(415);
    expect(errorOf(res).code).toBe("unsupported_media_type");
  });

  it("serves the widget script with nosniff and a short cache lifetime", async () => {
    const { app } = await boot();
    const res = await app.inject({ url: "/widget.js" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("public, max-age=300");
    expect(res.body).toBe(readFileSync(new URL("../src/widget/widget.js", import.meta.url), "utf8"));
  });
});

describe("authentication", () => {
  it("rejects missing, malformed, unknown and wrong-secret keys with the same 401 body", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const [prefix, id] = t.ownerKey.split("_");
    const attempts = [
      {},
      bearer("garbage"),
      bearer(`${prefix}_${id}_${"A".repeat(43)}`),
      bearer(`${prefix}_ffffffffffff_${"A".repeat(43)}`),
      { "x-api-key": "nope" },
      { authorization: "Basic abc" },
    ];
    const bodies = new Set<string>();
    for (const headers of attempts) {
      const res = await env.app.inject({ url: "/v1/documents", headers });
      expect(res.statusCode).toBe(401);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toContain("Missing or invalid API key.");
  });

  it("accepts Authorization: Bearer and X-API-Key", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(t.ownerKey) })).statusCode).toBe(200);
    expect((await env.app.inject({ url: "/v1/documents", headers: { "x-api-key": t.ownerKey } })).statusCode).toBe(200);
  });

  it("rejects public keys on management endpoints and secret keys in the query string", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(t.publicKey) })).statusCode).toBe(401);
    expect((await env.app.inject({ url: `/v1/documents?pk=${t.publicKey}` })).statusCode).toBe(401);
    const res = await env.app.inject({ method: "POST", url: `/v1/chat?pk=${t.ownerKey}`, headers: { origin: ORIGIN }, payload: { message: "hi" } });
    expect(res.statusCode).toBe(401);
  });

  it("stops accepting a revoked key immediately", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const agent = await env.issue(t, "agent");
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(agent) })).statusCode).toBe(200);
    const keys = body(await env.app.inject({ url: "/v1/keys", headers: bearer(t.ownerKey) })).keys as { id: string; role: string }[];
    const agentId = keys.find((k) => k.role === "agent")!.id;
    expect((await env.app.inject({ method: "DELETE", url: `/v1/keys/${agentId}`, headers: bearer(t.ownerKey) })).statusCode).toBe(200);
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(agent) })).statusCode).toBe(401);
  });

  it("enforces roles: agents read, admins manage content, only owners manage keys", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const admin = await env.issue(t, "admin");
    const agent = await env.issue(t, "agent");
    const post = (key: string) => env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(key), payload: { title: "T", content: "hello world" } });
    expect((await post(agent)).statusCode).toBe(403);
    expect((await post(admin)).statusCode).toBe(202);
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(agent) })).statusCode).toBe(200);
    expect((await env.app.inject({ url: "/v1/analytics/summary", headers: bearer(agent) })).statusCode).toBe(403);
    expect((await env.app.inject({ url: "/v1/analytics/summary", headers: bearer(admin) })).statusCode).toBe(200);
    expect((await env.app.inject({ method: "POST", url: "/v1/keys", headers: bearer(admin), payload: { kind: "secret", role: "agent" } })).statusCode).toBe(403);
    expect((await env.app.inject({ url: "/v1/keys", headers: bearer(agent) })).statusCode).toBe(403);
    const forbidden = await env.app.inject({ url: "/v1/audit", headers: bearer(agent) });
    expect(errorOf(forbidden).code).toBe("forbidden");
  });

  it("scopes everything to the key's tenant; ids from another tenant are 404", async () => {
    const env = await boot();
    const a = await env.createTenant("A");
    const b = await env.createTenant("B");
    const created = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(a.ownerKey), payload: { title: "A doc", content: "alpha only text" } });
    const docId = (body(created).document as { id: string }).id;
    const jobId = body(created).jobId as string;
    await env.core.queue.tick();
    expect((await env.app.inject({ url: `/v1/documents/${docId}`, headers: bearer(b.ownerKey) })).statusCode).toBe(404);
    expect((await env.app.inject({ method: "DELETE", url: `/v1/documents/${docId}`, headers: bearer(b.ownerKey) })).statusCode).toBe(404);
    expect((await env.app.inject({ url: `/v1/jobs/${jobId}`, headers: bearer(b.ownerKey) })).statusCode).toBe(404);
    expect(body(await env.app.inject({ url: "/v1/documents", headers: bearer(b.ownerKey) })).documents).toEqual([]);
    const search = await env.app.inject({ method: "POST", url: "/v1/search", headers: bearer(b.ownerKey), payload: { query: "alpha only text" } });
    expect(body(search).hits).toEqual([]);
    expect((await env.app.inject({ url: `/v1/documents/${docId}`, headers: bearer(a.ownerKey) })).statusCode).toBe(200);
  });

  it("validates id path parameters", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const res = await env.app.inject({ url: "/v1/documents/..%2F..%2Fetc", headers: bearer(t.ownerKey) });
    expect([400, 404]).toContain(res.statusCode);
  });
});

describe("operator endpoint", () => {
  it("does not exist unless an operator token is configured", async () => {
    const env = newCore();
    const app = buildApp(env.core);
    const res = await app.inject({ method: "POST", url: "/v1/operator/tenants", headers: bearer(OPERATOR), payload: { name: "A" } });
    expect(res.statusCode).toBe(404);
  });

  it("requires the exact operator token and returns usable keys once", async () => {
    const env = await boot();
    const wrong = await env.app.inject({ method: "POST", url: "/v1/operator/tenants", headers: bearer(`${OPERATOR}x`), payload: { name: "A" } });
    expect(wrong.statusCode).toBe(401);
    const none = await env.app.inject({ method: "POST", url: "/v1/operator/tenants", payload: { name: "A" } });
    expect(none.statusCode).toBe(401);
    const t = await env.createTenant("Acme");
    expect(t.ownerKey).toMatch(/^scs_/);
    expect(t.publicKey).toMatch(/^scp_/);
    expect((await env.app.inject({ url: "/v1/settings", headers: bearer(t.ownerKey) })).statusCode).toBe(200);
  });

  it("rejects invalid tenant input", async () => {
    const env = await boot();
    const res = await env.app.inject({ method: "POST", url: "/v1/operator/tenants", headers: bearer(OPERATOR), payload: { name: "A", allowedOrigins: ["*"] } });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).message).toContain("origin");
  });

  it("an operator token cannot be used as a tenant key and vice versa", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(OPERATOR) })).statusCode).toBe(401);
    expect((await env.app.inject({ method: "POST", url: "/v1/operator/tenants", headers: bearer(t.ownerKey), payload: { name: "B" } })).statusCode).toBe(401);
  });
});

describe("rate limiting", () => {
  it("limits requests per IP with Retry-After, and recovers as time passes", async () => {
    const env = await boot({ limits: { ipBurst: 3, ipPerMinute: 6 } });
    const hit = () => env.app.inject({ url: "/healthz" });
    expect([(await hit()).statusCode, (await hit()).statusCode, (await hit()).statusCode]).toEqual([200, 200, 200]);
    const limited = await hit();
    expect(limited.statusCode).toBe(429);
    expect(errorOf(limited).code).toBe("rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    env.clock.advance(10_000); // 6/min => one token per 10 s
    expect((await hit()).statusCode).toBe(200);
  });

  it("limits per key, independently for different keys", async () => {
    const env = await boot({ limits: { keyBurst: 2, keyPerMinute: 1 } });
    const a = await env.createTenant("A");
    const b = await env.createTenant("B");
    const get = (key: string) => env.app.inject({ url: "/v1/documents", headers: bearer(key) });
    expect([(await get(a.ownerKey)).statusCode, (await get(a.ownerKey)).statusCode, (await get(a.ownerKey)).statusCode]).toEqual([200, 200, 429]);
    expect((await get(b.ownerKey)).statusCode).toBe(200);
  });

  it("limits chat messages per key", async () => {
    const env = await boot({ limits: { chatBurst: 2, chatPerMinute: 1 } });
    const t = await env.createTenant("A");
    const chat = () => env.app.inject({ method: "POST", url: `/v1/chat?pk=${t.publicKey}`, headers: { origin: ORIGIN }, payload: { message: "hello" } });
    expect([(await chat()).statusCode, (await chat()).statusCode, (await chat()).statusCode]).toEqual([200, 200, 429]);
  });

  it("throttles repeated failed authentication, but never blocks valid keys", async () => {
    const env = await boot({ limits: { authFailureBurst: 3, authFailurePerMinute: 1 } });
    const t = await env.createTenant("A");
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await env.app.inject({ url: "/v1/documents", headers: bearer("wrong") })).statusCode);
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    expect((await env.app.inject({ url: "/v1/documents", headers: bearer(t.ownerKey) })).statusCode).toBe(200);
  });

  it("token bucket: burst, refill, independent keys and bounded memory", () => {
    let now = 0;
    const limiter = new TokenBucketLimiter(2, 60, () => now, 3);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    const denied = limiter.take("a");
    expect(denied).toEqual({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take("b").ok).toBe(true);
    now += 1000;
    expect(limiter.take("a").ok).toBe(true);
    for (const k of ["c", "d", "e", "f"]) limiter.take(k);
    expect(limiter.size).toBe(3);
    now += 3_600_000;
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(false); // refill is capped at the burst size
  });
});

describe("documents over HTTP", () => {
  it("ingests asynchronously and exposes progress through the status endpoint", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const post = await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "Refunds", content: CORPUS.find((d) => d.id === "billing-refunds")!.content, format: "markdown" } });
    expect(post.statusCode).toBe(202);
    const created = body(post);
    expect(created).toMatchObject({ duplicate: false, document: { status: "queued", title: "Refunds" } });
    const url = created.statusUrl as string;
    const before = body(await env.app.inject({ url, headers: bearer(t.ownerKey) }));
    expect(before).toMatchObject({ document: { status: "queued" }, job: { status: "queued" } });
    await env.core.queue.tick();
    const after = body(await env.app.inject({ url, headers: bearer(t.ownerKey) }));
    expect(after).toMatchObject({ document: { status: "ready", chunkCount: 3 }, job: { status: "succeeded", stage: "index", attempts: 1 } });
    expect(JSON.stringify(after)).not.toContain("original payment method"); // source text is not returned
  });

  it("returns 200 with the existing document for duplicate content", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const send = () => env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "T", content: "same text" } });
    const first = body(await send());
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(body(second)).toMatchObject({ duplicate: true, document: { id: (first.document as { id: string }).id } });
  });

  it("lists, searches and deletes", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    for (const d of CORPUS.slice(0, 4)) await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: d.title, content: d.content, format: "markdown" } });
    await env.core.queue.tick();
    const list = body(await env.app.inject({ url: "/v1/documents", headers: bearer(t.ownerKey) })).documents as { id: string; status: string; title: string }[];
    expect(list).toHaveLength(4);
    expect(list.every((d) => d.status === "ready")).toBe(true);
    const hits = body(await env.app.inject({ method: "POST", url: "/v1/search", headers: bearer(t.ownerKey), payload: { query: "refund within 14 days", mode: "hybrid", k: 3 } })).hits as { heading: string; bm25Rank: number | null }[];
    expect(hits[0]!.heading).toContain("Refund policy");
    expect(hits.length).toBeLessThanOrEqual(3);
    const refund = list.find((d) => d.title === "Refund policy")!;
    const del = await env.app.inject({ method: "DELETE", url: `/v1/documents/${refund.id}`, headers: bearer(t.ownerKey) });
    expect(del.statusCode).toBe(200);
    const after = body(await env.app.inject({ method: "POST", url: "/v1/search", headers: bearer(t.ownerKey), payload: { query: "refund within 14 days" } })).hits as { heading: string }[];
    expect(after.every((h) => !h.heading.includes("Refund policy"))).toBe(true);
  });

  it("validates search requests and redacts PII in queries before retrieval", async () => {
    const seen: string[] = [];
    const base = new HashingEmbedder(256);
    const env = await boot({}, { embedder: { id: base.id, dimensions: base.dimensions, embed: async (x) => (seen.push(...x), base.embed(x)) } });
    const t = await env.createTenant("A");
    const bad = await env.app.inject({ method: "POST", url: "/v1/search", headers: bearer(t.ownerKey), payload: { query: "x", mode: "magic" } });
    expect(bad.statusCode).toBe(400);
    await env.app.inject({ method: "POST", url: "/v1/search", headers: bearer(t.ownerKey), payload: { query: "email jane@example.com about refunds" } });
    expect(seen.join()).not.toContain("jane@example.com");
  });

  it("shows dead-lettered jobs and lets an admin retry them", async () => {
    let broken = true;
    const base = new HashingEmbedder(256);
    const env = await boot({}, {
      queueOptions: { maxAttempts: 2, backoffMs: () => 10 },
      embedder: { id: base.id, dimensions: base.dimensions, embed: async (x) => { if (broken) throw new EmbedderError("HTTP 503", true); return base.embed(x); } },
    });
    const t = await env.createTenant("A");
    const created = body(await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "T", content: "some text to index" } }));
    await settle({ queue: env.core.queue, clock: env.clock }, 4);
    const dead = body(await env.app.inject({ url: "/v1/jobs?status=dead", headers: bearer(t.ownerKey) })).jobs as { id: string; lastError: string }[];
    expect(dead).toHaveLength(1);
    expect(dead[0]!.id).toBe(created.jobId);
    expect(dead[0]!.lastError).toContain("503");
    const statusRes = body(await env.app.inject({ url: created.statusUrl as string, headers: bearer(t.ownerKey) }));
    expect(statusRes).toMatchObject({ document: { status: "failed" } });
    broken = false;
    const agent = await env.issue(t, "agent");
    expect((await env.app.inject({ method: "POST", url: `/v1/jobs/${dead[0]!.id}/retry`, headers: bearer(agent) })).statusCode).toBe(403);
    expect((await env.app.inject({ method: "POST", url: `/v1/jobs/${dead[0]!.id}/retry`, headers: bearer(t.ownerKey) })).statusCode).toBe(200);
    await settle({ queue: env.core.queue, clock: env.clock }, 2);
    expect(body(await env.app.inject({ url: created.statusUrl as string, headers: bearer(t.ownerKey) }))).toMatchObject({ document: { status: "ready" } });
    expect(env.clock).toBeInstanceOf(FakeClock);
  });

  it("rejects unknown job status filters", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    expect((await env.app.inject({ url: "/v1/jobs?status=weird", headers: bearer(t.ownerKey) })).statusCode).toBe(400);
  });
});

describe("chat endpoint, widget keys and CORS", () => {
  const chat = (env: Env, key: string, headers: Record<string, string> = {}, payload: unknown = { message: "How do I reset my password?" }) =>
    env.app.inject({ method: "POST", url: `/v1/chat?pk=${key}`, headers, payload: payload as Body });

  async function seeded() {
    const env = await boot();
    const t = await env.createTenant("A");
    for (const d of CORPUS) await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: d.title, content: d.content, format: "markdown" } });
    await env.core.queue.tick();
    return { env, t };
  }

  it("answers a widget request from an allowed origin and sets CORS headers", async () => {
    const { env, t } = await seeded();
    const res = await chat(env, t.publicKey, { origin: ORIGIN });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers.vary).toContain("Origin");
    expect(body(res)).toMatchObject({ outcome: "answered", intent: "question", citations: [expect.objectContaining({ n: 1 })] });
  });

  it("rejects origins that are not on the tenant's allow-list, with no CORS headers", async () => {
    const { env, t } = await seeded();
    const evil = await chat(env, t.publicKey, { origin: "https://evil.example" });
    expect(evil.statusCode).toBe(403);
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    expect(errorOf(evil).message).toContain("Origin");
    const none = await chat(env, t.publicKey, {});
    expect(none.statusCode).toBe(403);
    const lookalike = await chat(env, t.publicKey, { origin: `${ORIGIN}.evil.example` });
    expect(lookalike.statusCode).toBe(403);
    const http = await chat(env, t.publicKey, { origin: "http://shop.example" });
    expect(http.statusCode).toBe(403);
  });

  it("applies each tenant's own allow-list", async () => {
    const env = await boot();
    const a = await env.createTenant("A", ["https://a.example"]);
    const b = await env.createTenant("B", ["https://b.example"]);
    expect((await chat(env, a.publicKey, { origin: "https://a.example" })).statusCode).toBe(200);
    expect((await chat(env, a.publicKey, { origin: "https://b.example" })).statusCode).toBe(403);
    expect((await chat(env, b.publicKey, { origin: "https://b.example" })).statusCode).toBe(200);
    expect((await chat(env, b.publicKey, { origin: "https://a.example" })).statusCode).toBe(403);
  });

  it("denies all origins for a tenant with an empty allow-list", async () => {
    const env = await boot();
    const t = await env.createTenant("A", []);
    expect((await chat(env, t.publicKey, { origin: ORIGIN })).statusCode).toBe(403);
  });

  it("answers CORS preflight only for allowed origins", async () => {
    const { env, t } = await seeded();
    const ok = await env.app.inject({ method: "OPTIONS", url: `/v1/chat?pk=${t.publicKey}`, headers: { origin: ORIGIN, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(ok.headers["access-control-allow-methods"]).toBe("POST, OPTIONS");
    expect(ok.headers["access-control-allow-headers"]).toBe("content-type");
    const bad = await env.app.inject({ method: "OPTIONS", url: `/v1/chat?pk=${t.publicKey}`, headers: { origin: "https://evil.example" } });
    expect(bad.statusCode).toBe(403);
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
    const unknownKey = await env.app.inject({ method: "OPTIONS", url: `/v1/chat?pk=scp_ffffffffffff_${"A".repeat(43)}`, headers: { origin: ORIGIN } });
    expect(unknownKey.statusCode).toBe(403);
    const noKey = await env.app.inject({ method: "OPTIONS", url: "/v1/chat", headers: { origin: ORIGIN } });
    expect(noKey.statusCode).toBe(403);
  });

  it("lets a server-side secret key call chat without an origin", async () => {
    const { env, t } = await seeded();
    const res = await env.app.inject({ method: "POST", url: "/v1/chat", headers: bearer(t.ownerKey), payload: { message: "What is the API rate limit?" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(body(res).outcome).toBe("answered");
  });

  it("continues a conversation and refuses another tenant's conversation id", async () => {
    const { env, t } = await seeded();
    const other = await env.createTenant("B");
    const first = body(await chat(env, t.publicKey, { origin: ORIGIN }, { message: "hello" }));
    const next = await chat(env, t.publicKey, { origin: ORIGIN }, { message: "How do I cancel my subscription?", conversationId: first.conversationId });
    expect(body(next).conversationId).toBe(first.conversationId);
    const stolen = await chat(env, other.publicKey, { origin: ORIGIN }, { message: "hi", conversationId: first.conversationId });
    expect(stolen.statusCode).toBe(404);
  });

  it("validates the chat body", async () => {
    const { env, t } = await seeded();
    const headers = { origin: ORIGIN };
    expect((await chat(env, t.publicKey, headers, {})).statusCode).toBe(400);
    expect((await chat(env, t.publicKey, headers, { message: "" })).statusCode).toBe(400);
    expect((await chat(env, t.publicKey, headers, { message: "x".repeat(2001) })).statusCode).toBe(400);
    expect((await chat(env, t.publicKey, headers, { message: "hi", tenantId: "other" })).statusCode).toBe(400);
    expect((await chat(env, t.publicKey, headers, { message: 7 })).statusCode).toBe(400);
  });

  it("refuses to answer what the documents do not cover, over HTTP", async () => {
    const { env, t } = await seeded();
    const res = body(await chat(env, t.publicKey, { origin: ORIGIN }, { message: "What is the capital of France?" }));
    expect(res).toMatchObject({ outcome: "refused", citations: [], escalation: { reason: "low_confidence" } });
  });

  it("never returns PII-bearing placeholders or the customer's card number", async () => {
    const { env, t } = await seeded();
    const card = ["4111", "1111", "1111", "1111"].join(" ");
    const res = await chat(env, t.publicKey, { origin: ORIGIN }, { message: `my card ${card} was declined, will I lose access? email jane@example.com` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("4111");
    expect(res.body).not.toMatch(/\[[A-Z_]+_\d+:[a-z]{24}\]/);
  });
});

describe("management endpoints", () => {
  it("runs a support workflow: chat, escalation queue, tickets, analytics, audit", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const agent = await env.issue(t, "agent");
    const say = (message: string, conversationId?: string) => env.app.inject({ method: "POST", url: `/v1/chat?pk=${t.publicKey}`, headers: { origin: ORIGIN }, payload: { message, conversationId } });
    await env.app.inject({ method: "POST", url: "/v1/documents", headers: bearer(t.ownerKey), payload: { title: "Passwords", content: CORPUS[0]!.content, format: "markdown" } });
    await env.core.queue.tick();

    const a = body(await say("How do I reset my password?"));
    const b = body(await say("I want to talk to a human"));
    const c = body(await say("open a ticket about the export that never arrives"));
    expect(a.outcome).toBe("answered");
    expect(b.outcome).toBe("escalated");
    expect(c.outcome).toBe("ticket_created");

    const open = body(await env.app.inject({ url: "/v1/escalations?status=open", headers: bearer(agent) })).escalations as { id: string }[];
    expect(open).toHaveLength(1);
    const claim = await env.app.inject({ method: "POST", url: `/v1/escalations/${open[0]!.id}/claim`, headers: bearer(agent) });
    expect(body(claim)).toMatchObject({ status: "claimed" });
    const resolve = await env.app.inject({ method: "POST", url: `/v1/escalations/${open[0]!.id}/resolve`, headers: bearer(agent), payload: { note: "called back" } });
    expect(body(resolve)).toMatchObject({ status: "resolved", note: "called back" });

    const tickets = body(await env.app.inject({ url: "/v1/tickets", headers: bearer(agent) })).tickets as { id: string; status: string }[];
    expect(tickets).toHaveLength(1);
    expect(body(await env.app.inject({ method: "POST", url: `/v1/tickets/${tickets[0]!.id}/close`, headers: bearer(agent) }))).toMatchObject({ status: "closed" });
    expect(body(await env.app.inject({ url: `/v1/conversations/${b.conversationId as string}`, headers: bearer(agent) }))).toMatchObject({ turns: [expect.objectContaining({ outcome: "escalated" })] });

    const summary = body(await env.app.inject({ url: "/v1/analytics/summary", headers: bearer(t.ownerKey) }));
    expect(summary).toMatchObject({ conversations: 3, answered: 1, ticketsCreated: 1, escalations: { total: 1, byReason: { user_request: 1, low_confidence: 0 } } });
    const series = body(await env.app.inject({ url: "/v1/analytics/timeseries", headers: bearer(t.ownerKey) })).days as unknown[];
    expect(series).toHaveLength(1);
    expect((body(await env.app.inject({ url: "/v1/analytics/unanswered?limit=5", headers: bearer(t.ownerKey) })).questions as unknown[]).length).toBe(0);

    const audit = body(await env.app.inject({ url: "/v1/audit", headers: bearer(t.ownerKey) })).entries as { action: string }[];
    expect(audit.map((e) => e.action)).toEqual(expect.arrayContaining(["tenant.create", "key.issue", "document.ingest", "escalation.create", "escalation.update", "tool.call"]));
    expect(body(await env.app.inject({ url: "/v1/audit/verify", headers: bearer(t.ownerKey) }))).toMatchObject({ ok: true });
  });

  it("validates analytics parameters", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const get = (q: string) => env.app.inject({ url: `/v1/analytics/summary${q}`, headers: bearer(t.ownerKey) });
    expect((await get("?from=2026-01-01")).statusCode).toBe(200);
    expect((await get("?from=yesterday")).statusCode).toBe(400);
    expect((await env.app.inject({ url: "/v1/analytics/unanswered?limit=0", headers: bearer(t.ownerKey) })).statusCode).toBe(400);
    expect((await env.app.inject({ url: "/v1/audit?limit=abc", headers: bearer(t.ownerKey) })).statusCode).toBe(400);
  });

  it("manages keys and roles, and a role change takes effect immediately", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const admin = await env.issue(t, "admin");
    const keys = body(await env.app.inject({ url: "/v1/keys", headers: bearer(t.ownerKey) })).keys as { id: string; role: string | null; kind: string }[];
    expect(JSON.stringify(keys)).not.toMatch(/secretHash/);
    const adminId = keys.find((k) => k.role === "admin")!.id;
    expect((await env.app.inject({ url: "/v1/analytics/summary", headers: bearer(admin) })).statusCode).toBe(200);
    const patch = await env.app.inject({ method: "PATCH", url: `/v1/keys/${adminId}`, headers: bearer(t.ownerKey), payload: { role: "agent" } });
    expect(patch.statusCode).toBe(200);
    expect((await env.app.inject({ url: "/v1/analytics/summary", headers: bearer(admin) })).statusCode).toBe(403);
    const ownerId = keys.find((k) => k.role === "owner")!.id;
    const demote = await env.app.inject({ method: "PATCH", url: `/v1/keys/${ownerId}`, headers: bearer(t.ownerKey), payload: { role: "admin" } });
    expect(demote.statusCode).toBe(409);
    expect((await env.app.inject({ method: "PATCH", url: `/v1/keys/${adminId}`, headers: bearer(t.ownerKey), payload: { role: "root" } })).statusCode).toBe(400);
    expect((await env.app.inject({ method: "PATCH", url: "/v1/keys/doesnotexist", headers: bearer(t.ownerKey), payload: { role: "agent" } })).statusCode).toBe(404);
  });

  it("updates settings, including the origin allow-list, which the chat endpoint honours at once", async () => {
    const env = await boot();
    const t = await env.createTenant("A", []);
    const say = (origin: string) => env.app.inject({ method: "POST", url: `/v1/chat?pk=${t.publicKey}`, headers: { origin }, payload: { message: "hello" } });
    expect((await say("https://late.example")).statusCode).toBe(403);
    const patch = await env.app.inject({ method: "PATCH", url: "/v1/settings", headers: bearer(t.ownerKey), payload: { allowedOrigins: ["https://late.example"], piiRestore: "none" } });
    expect(patch.statusCode).toBe(200);
    expect(body(patch)).toMatchObject({ allowedOrigins: ["https://late.example"], piiRestore: "none" });
    expect((await say("https://late.example")).statusCode).toBe(200);
    expect((await env.app.inject({ method: "PATCH", url: "/v1/settings", headers: bearer(t.ownerKey), payload: { allowedOrigins: ["*"] } })).statusCode).toBe(400);
    expect((await env.app.inject({ method: "PATCH", url: "/v1/settings", headers: bearer(t.ownerKey), payload: {} })).statusCode).toBe(400);
    expect((await env.app.inject({ method: "PATCH", url: "/v1/settings", headers: bearer(t.ownerKey), payload: { answerThreshold: 7 } })).statusCode).toBe(400);
  });

  it("each tenant's settings and audit trail are separate", async () => {
    const env = await boot();
    const a = await env.createTenant("A", []);
    const b = await env.createTenant("B", []);
    await env.app.inject({ method: "PATCH", url: "/v1/settings", headers: bearer(a.ownerKey), payload: { retrievalK: 8 } });
    expect(body(await env.app.inject({ url: "/v1/settings", headers: bearer(b.ownerKey) })).retrievalK).toBe(4);
    const auditB = body(await env.app.inject({ url: "/v1/audit", headers: bearer(b.ownerKey) })).entries as { tenantId: string; action: string }[];
    expect(auditB.every((e) => e.tenantId === b.tenant.id)).toBe(true);
    expect(auditB.map((e) => e.action)).not.toContain("settings.update");
  });
});

describe("client addresses and chat abuse limits", () => {
  const chatAs = (env: Env, key: string, remoteAddress: string, origin: string = ORIGIN, headers: Record<string, string> = {}) =>
    env.app.inject({ method: "POST", url: `/v1/chat?pk=${key}`, remoteAddress, headers: { origin, ...headers }, payload: { message: "hello" } });

  it("clientKey keeps IPv4, unwraps IPv4-mapped IPv6 and reduces IPv6 to its /64", () => {
    expect(clientKey("203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(clientKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(clientKey("2001:DB8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(clientKey("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(clientKey("fe80::1%eth0")).toBe("fe80:0000:0000:0000::/64");
    expect(clientKey("64:ff9b::192.0.2.33")).toBe("0064:ff9b:0000:0000::/64");
    expect(clientKey("not-an-ip:::")).toBe("not-an-ip:::");
  });

  it("one client address cannot use up the chat quota that every other visitor shares", async () => {
    const env = await boot({ limits: { chatIpBurst: 2, chatIpPerMinute: 1, chatBurst: 50 } });
    const t = await env.createTenant("A");
    const attacker = "198.51.100.7";
    expect([(await chatAs(env, t.publicKey, attacker)).statusCode, (await chatAs(env, t.publicKey, attacker)).statusCode, (await chatAs(env, t.publicKey, attacker)).statusCode]).toEqual([200, 200, 429]);
    expect((await chatAs(env, t.publicKey, "198.51.100.8")).statusCode).toBe(200);
  });

  it("treats addresses inside one IPv6 /64 as the same client", async () => {
    const env = await boot({ limits: { chatIpBurst: 1, chatIpPerMinute: 1, chatBurst: 50 } });
    const t = await env.createTenant("A");
    expect((await chatAs(env, t.publicKey, "2001:db8:1:2::1")).statusCode).toBe(200);
    expect((await chatAs(env, t.publicKey, "2001:db8:1:2:ffff:ffff:ffff:ffff")).statusCode).toBe(429);
    expect((await chatAs(env, t.publicKey, "2001:db8:1:3::1")).statusCode).toBe(200);
  });

  it("requests with a wrong Origin spend none of the chat quota", async () => {
    const env = await boot({ limits: { chatIpBurst: 2, chatIpPerMinute: 1, chatBurst: 2, chatPerMinute: 1 } });
    const t = await env.createTenant("A");
    for (let i = 0; i < 10; i++) expect((await chatAs(env, t.publicKey, "198.51.100.7", "https://evil.example")).statusCode).toBe(403);
    expect((await chatAs(env, t.publicKey, "198.51.100.7")).statusCode).toBe(200);
  });

  it("server-side secret keys are not subject to the per-address widget limit", async () => {
    const env = await boot({ limits: { chatIpBurst: 1, chatIpPerMinute: 1 } });
    const t = await env.createTenant("A");
    const call = () => env.app.inject({ method: "POST", url: "/v1/chat", remoteAddress: "198.51.100.7", headers: bearer(t.ownerKey), payload: { message: "hello" } });
    expect([(await call()).statusCode, (await call()).statusCode, (await call()).statusCode]).toEqual([200, 200, 200]);
  });

  it("ignores X-Forwarded-For unless proxies are trusted, so a client cannot choose its own rate-limit key", async () => {
    const env = await boot({ limits: { ipBurst: 1, ipPerMinute: 1 } });
    const hit = (xff: string) => env.app.inject({ url: "/healthz", remoteAddress: "198.51.100.7", headers: { "x-forwarded-for": xff } });
    expect((await hit("1.1.1.1")).statusCode).toBe(200);
    expect((await hit("2.2.2.2")).statusCode).toBe(429);
  });

  it("with one trusted proxy only the address that proxy appended counts; entries the client adds are ignored", async () => {
    const env = await boot({ trustProxy: 1, limits: { ipBurst: 1, ipPerMinute: 1 } });
    // The proxy (10.0.0.1) appended the real client address 203.0.113.50; the client prepended forged ones.
    const hit = (forged: string, real: string) => env.app.inject({ url: "/healthz", remoteAddress: "10.0.0.1", headers: { "x-forwarded-for": `${forged}, ${real}` } });
    expect((await hit("9.9.9.1", "203.0.113.50")).statusCode).toBe(200);
    expect((await hit("9.9.9.2", "203.0.113.50")).statusCode).toBe(429);
    expect((await hit("9.9.9.3", "203.0.113.51")).statusCode).toBe(200);
  });

  it("an address list works as an alternative to a hop count", async () => {
    const env = await boot({ trustProxy: ["10.0.0.0/8"], limits: { ipBurst: 1, ipPerMinute: 1 } });
    const hit = (real: string, peer: string) => env.app.inject({ url: "/healthz", remoteAddress: peer, headers: { "x-forwarded-for": real } });
    expect((await hit("203.0.113.50", "10.1.2.3")).statusCode).toBe(200);
    expect((await hit("203.0.113.50", "10.9.9.9")).statusCode).toBe(429);
    // A peer outside the list is not a proxy: its header is not believed.
    expect((await hit("203.0.113.60", "198.51.100.1")).statusCode).toBe(200);
    expect((await hit("203.0.113.61", "198.51.100.1")).statusCode).toBe(429);
  });
});

describe("audit head anchoring over HTTP", () => {
  it("returns the chain head and verifies against a recorded head", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const head = body(await env.app.inject({ url: "/v1/audit/head", headers: bearer(t.ownerKey) })).head as { seq: number; hash: string };
    expect(head.seq).toBeGreaterThanOrEqual(1);
    expect(head.hash).toMatch(/^[0-9a-f]{64}$/);
    await env.app.inject({ method: "PATCH", url: "/v1/settings", headers: bearer(t.ownerKey), payload: { retrievalK: 6 } });
    const ok = body(await env.app.inject({ url: `/v1/audit/verify?headSeq=${head.seq}&headHash=${head.hash}`, headers: bearer(t.ownerKey) }));
    expect(ok).toMatchObject({ ok: true, entries: head.seq + 1 });
  });

  it("reports a recorded head that does not match the log, or one beyond its end", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const head = body(await env.app.inject({ url: "/v1/audit/head", headers: bearer(t.ownerKey) })).head as { seq: number; hash: string };
    const wrong = body(await env.app.inject({ url: `/v1/audit/verify?headSeq=${head.seq}&headHash=${"0".repeat(64)}`, headers: bearer(t.ownerKey) }));
    expect(wrong).toMatchObject({ ok: false, reason: expect.stringContaining("does not match") });
    const beyond = body(await env.app.inject({ url: `/v1/audit/verify?headSeq=${head.seq + 5}&headHash=${head.hash}`, headers: bearer(t.ownerKey) }));
    expect(beyond).toMatchObject({ ok: false, reason: expect.stringContaining("truncated") });
  });

  it("validates the head parameters and requires the audit permission", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    const agent = await env.issue(t, "agent");
    const get = (q: string) => env.app.inject({ url: `/v1/audit/verify${q}`, headers: bearer(t.ownerKey) });
    expect((await get("?headSeq=1")).statusCode).toBe(400);
    expect((await get(`?headHash=${"a".repeat(64)}`)).statusCode).toBe(400);
    expect((await get("?headSeq=1&headHash=nothex")).statusCode).toBe(400);
    expect((await get("?headSeq=0&headHash=" + "a".repeat(64))).statusCode).toBe(400);
    expect((await env.app.inject({ url: "/v1/audit/head", headers: bearer(agent) })).statusCode).toBe(403);
  });

  it("an empty tenant has no head", async () => {
    const env = await boot();
    const t = await env.createTenant("A");
    // createTenant itself audits, so use a fresh core-level tenant to see the empty case.
    const fresh = env.core.tenants.create({ name: "bare" });
    expect(env.core.auditHead({ tenantId: fresh.id, keyId: "k", role: "admin" })).toBeNull();
    expect(t.tenant.id).not.toBe(fresh.id);
  });
});
