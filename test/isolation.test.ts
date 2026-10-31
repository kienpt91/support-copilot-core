import { describe, expect, it } from "vitest";
import { AnalyticsService } from "../src/analytics.js";
import { ChatService } from "../src/assistant/chat.js";
import { HandoffService } from "../src/assistant/handoff.js";
import { Core } from "../src/core.js";
import { CORPUS } from "../src/eval/corpus.js";
import { IngestService } from "../src/ingest/service.js";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import { ApiKeyService } from "../src/tenancy/keys.js";
import { ingestCorpus, newCore, newTenant, widgetPrincipal } from "./helpers.js";

/**
 * Two tenants, each with documents, a conversation, a ticket, an escalation, jobs and keys.
 * Tenant B's most privileged actor (owner) then tries to use tenant A's identifiers through every
 * service method that takes an id. Nothing may be readable, changeable or deletable.
 */
async function world() {
  const env = newCore();
  const a = newTenant(env.core, "A");
  const b = newTenant(env.core, "B");
  const docsA = await ingestCorpus(env.core, a);
  // B gets different content so leakage would be visible.
  env.core.ingest.submit(b.admin, { title: "B secrets", content: "# B secrets\nThe vault code for tenant B is pelican." });
  await env.core.queue.tick();

  const convA = await env.core.chat.handle(widgetPrincipal(a), { message: "I want to talk to a human" }); // makes an escalation
  const ticketRes = await env.core.chat.handle(widgetPrincipal(a), { message: "Please open a ticket about my A-only invoice problem" });
  const escalationA = env.core.handoff.listEscalations(a.agent)[0]!;
  const ticketA = env.core.handoff.listTickets(a.agent)[0]!;
  const docA = docsA.get("account-password")!;
  const jobA = env.core.ingest.status(a.admin, docA).job!;
  const keyA = env.core.keys.list(a.id).find((k) => k.kind === "public")!;
  const agentKeyA = env.core.issueKey(a.owner, { kind: "secret", role: "agent" });
  return { ...env, a, b, docA, jobA, convA, ticketRes, escalationA, ticketA, keyA, agentKeyA };
}

describe("cross-tenant isolation at the service layer", () => {
  it("documents and jobs", async () => {
    const w = await world();
    const { core, b } = w;
    expect(() => core.ingest.status(b.owner, w.docA)).toThrow(/not found/);
    expect(() => core.ingest.delete(b.owner, w.docA)).toThrow(/not found/);
    expect(() => core.ingest.getJob(b.owner, w.jobA.id)).toThrow(/not found/);
    expect(() => core.ingest.retryJob(b.owner, w.jobA.id)).toThrow(/not found/);
    expect(core.ingest.list(b.owner).map((d) => d.title)).toEqual(["B secrets"]);
    expect(core.ingest.listJobs(b.owner)).toHaveLength(1);
    expect(core.queue.get(b.id, w.jobA.id)).toBeUndefined();
    expect(core.queue.deadLetters(b.id)).toEqual([]);
    expect(core.ingest.status(w.a.admin, w.docA).document.status).toBe("ready"); // untouched
  });

  it("submitting identical content in another tenant neither reveals nor links to the existing document", async () => {
    const { core, b, docA } = await world();
    const copy = CORPUS.find((d) => d.id === "account-password")!;
    const res = core.ingest.submit(b.admin, { title: copy.title, content: copy.content, format: "markdown" });
    expect(res.duplicate).toBe(false);
    expect(res.document.id).not.toBe(docA);
    expect(res.document.tenantId).toBe(b.id);
  });

  it("conversations, tickets and escalations", async () => {
    const w = await world();
    const { core, b } = w;
    expect(() => core.chat.getConversation(b.owner, w.convA.conversationId)).toThrow(/not found/);
    expect(core.chat.listConversations(b.owner)).toEqual([]);
    await expect(core.chat.handle(widgetPrincipal(b), { message: "hi", conversationId: w.convA.conversationId })).rejects.toThrow(/not found/);
    expect(() => core.handoff.getTicket(b.owner, w.ticketA.id)).toThrow(/not found/);
    expect(() => core.handoff.closeTicket(b.owner, w.ticketA.id)).toThrow(/not found/);
    expect(core.handoff.listTickets(b.owner)).toEqual([]);
    expect(() => core.handoff.getEscalation(b.owner, w.escalationA.id)).toThrow(/not found/);
    expect(() => core.handoff.claim(b.owner, w.escalationA.id)).toThrow(/not found/);
    expect(() => core.handoff.resolve(b.owner, w.escalationA.id, "x")).toThrow(/not found/);
    expect(core.handoff.listEscalations(b.owner)).toEqual([]);
    expect(core.handoff.getTicket(w.a.agent, w.ticketA.id).status).toBe("open");
    expect(core.handoff.getEscalation(w.a.agent, w.escalationA.id).status).toBe("open");
  });

  it("keys and roles", async () => {
    const w = await world();
    const { core, b } = w;
    expect(() => core.revokeKey(b.owner, w.keyA.id)).toThrow(/not found/);
    expect(() => core.changeRole(b.owner, w.agentKeyA.record.id, "owner")).toThrow(/not found/);
    expect(core.listKeys(b.owner).every((k) => k.tenantId === b.id)).toBe(true);
    expect(core.keys.authenticate(w.agentKeyA.key)).toMatchObject({ tenantId: w.a.id, role: "agent" });
    expect(core.keys.authenticate(w.keyA.id)).toBeNull();
  });

  it("audit log, analytics and settings", async () => {
    const w = await world();
    const { core, b } = w;
    const entries = core.auditEntries(b.owner);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.tenantId === b.id)).toBe(true);
    expect(JSON.stringify(entries)).not.toContain(w.docA);
    expect(core.verifyAudit(b.owner)).toMatchObject({ ok: true });
    expect(core.analytics.summary(b.owner)).toMatchObject({ conversations: 0, escalations: { total: 0 } });
    core.updateSettings(b.owner, { retrievalK: 9 });
    expect(core.getSettings(w.a.owner).retrievalK).not.toBe(9);
  });

  it("retrieval", async () => {
    const w = await world();
    const { core, b } = w;
    const chunkA = core.retriever.chunks.list(w.a.id)[0]!;
    expect(core.retriever.chunks.get(b.id, chunkA.id)).toBeUndefined();
    for (const mode of ["bm25", "vector", "hybrid"] as const) {
      const hits = await core.retriever.search(b.id, "reset password forgot link", { mode, k: 10 });
      expect(hits.every((h) => h.chunk.tenantId === b.id), mode).toBe(true);
      expect(JSON.stringify(hits)).not.toContain("Forgot password");
    }
    const answer = await core.chat.handle(widgetPrincipal(b), { message: "How do I reset my password?" });
    expect(answer.outcome).toBe("refused");
    expect(answer.citations).toEqual([]);
    const own = await core.chat.handle(widgetPrincipal(b), { message: "What is the vault code?" });
    expect(own.answer).toContain("pelican");
  });

  it("deleting a document in one tenant does not touch another tenant's identical document", async () => {
    const w = await world();
    const copy = CORPUS.find((d) => d.id === "account-password")!;
    const mine = w.core.ingest.submit(w.b.admin, { title: copy.title, content: copy.content, format: "markdown" });
    await w.core.queue.tick();
    w.core.ingest.delete(w.b.admin, mine.document.id);
    expect(w.core.retriever.chunkCount(w.a.id)).toBeGreaterThan(0);
    expect(w.core.ingest.status(w.a.admin, w.docA).document.status).toBe("ready");
  });

  it("a key issued for one tenant authenticates only as that tenant", async () => {
    const w = await world();
    const principal = w.core.keys.authenticate(w.agentKeyA.key)!;
    expect(principal.tenantId).toBe(w.a.id);
    expect(principal.tenantId).not.toBe(w.b.id);
  });
});

describe("isolation coverage guard", () => {
  // Every method on these classes is either exercised above/in other suites or has no tenant-scoped id.
  const INTERNAL = ["constructor"];
  const publicMethods = (cls: { prototype: object }) =>
    Object.getOwnPropertyNames(cls.prototype)
      .filter((n) => !INTERNAL.includes(n))
      .sort();

  it("lists every method of the services so new ones must be classified", () => {
    expect(publicMethods(IngestService)).toEqual(["delete", "getJob", "list", "listJobs", "process", "retryJob", "status", "submit"]);
    expect(publicMethods(HandoffService)).toEqual([
      "canEscalate",
      "claim",
      "closeTicket",
      "createTicket",
      "escalate",
      "getEscalation",
      "getTicket",
      "listEscalations",
      "listTickets",
      "resolve",
      "ticketQueueFull",
    ]);
    expect(publicMethods(ChatService)).toEqual(["answerQuestion", "getConversation", "handle", "listConversations", "process", "pruneConversations"]);
    expect(publicMethods(AnalyticsService)).toEqual(["summary", "timeseries", "unanswered"]);
    expect(publicMethods(ApiKeyService)).toEqual(["activeOwners", "authenticate", "authenticatePublic", "collection", "get", "issue", "list", "require", "revoke", "setRole"]);
    expect(publicMethods(HybridRetriever)).toEqual(["chunkCount", "commit", "index", "removeDocument", "search"]);
    expect(publicMethods(Core)).toEqual([
      "auditEntries",
      "auditHead",
      "changeRole",
      "createTenant",
      "getSettings",
      "issueKey",
      "listKeys",
      "revokeKey",
      "start",
      "stop",
      "updateSettings",
      "verifyAudit",
    ]);
  });
});
