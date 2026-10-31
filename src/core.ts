import { type AuditLog, MemoryAuditLog } from "./audit/chain.js";
import { AnalyticsService } from "./analytics.js";
import { ChatService } from "./assistant/chat.js";
import { ExtractiveGenerator, type Generator, RedactingGenerator } from "./assistant/generator.js";
import { HandoffService } from "./assistant/handoff.js";
import { type IntentRouter, RuleBasedRouter } from "./assistant/router.js";
import { ToolRegistry, createTicketTool } from "./assistant/tools.js";
import { type InMemoryQueueOptions, InMemoryJobQueue, type JobQueue } from "./ingest/queue.js";
import { IngestService } from "./ingest/service.js";
import { type Embedder, HashingEmbedder, RedactingEmbedder } from "./retrieval/embedder.js";
import { HybridRetriever } from "./retrieval/retriever.js";
import { ApiKeyService, type IssuedKey } from "./tenancy/keys.js";
import { type Tenant, TenantRegistry, type TenantSettings } from "./tenancy/registry.js";
import type { Actor, Role } from "./tenancy/roles.js";
import { assertCan } from "./tenancy/roles.js";
import { type Clock, type IdGen, randomId, systemClock } from "./util.js";

export interface CoreOptions {
  /** Defaults to the offline hashing embedder. Whatever is passed is wrapped so text is redacted first. */
  embedder?: Embedder;
  /** Defaults to the extractive generator. Whatever is passed is wrapped so text is redacted first. */
  generator?: Generator;
  router?: IntentRouter;
  audit?: AuditLog;
  queue?: JobQueue;
  queueOptions?: InMemoryQueueOptions;
  clock?: Clock;
  newId?: IdGen;
}

/** All services, wired together. This is the library's entry point; the HTTP API is a thin layer over it. */
export class Core {
  readonly tenants: TenantRegistry;
  readonly keys: ApiKeyService;
  readonly audit: AuditLog;
  readonly queue: JobQueue;
  readonly retriever: HybridRetriever;
  readonly ingest: IngestService;
  readonly handoff: HandoffService;
  readonly tools: ToolRegistry;
  readonly chat: ChatService;
  readonly analytics: AnalyticsService;

  constructor(opts: CoreOptions = {}) {
    const clock = opts.clock ?? systemClock;
    const newId = opts.newId ?? randomId;
    this.audit = opts.audit ?? new MemoryAuditLog(clock);
    this.tenants = new TenantRegistry(clock, newId);
    this.keys = new ApiKeyService(clock);
    this.queue = opts.queue ?? new InMemoryJobQueue({ clock, newId, ...opts.queueOptions });
    const embedder = new RedactingEmbedder(opts.embedder ?? new HashingEmbedder());
    this.retriever = new HybridRetriever(embedder);
    this.ingest = new IngestService({ queue: this.queue, retriever: this.retriever, embedder, audit: this.audit, clock, newId });
    this.handoff = new HandoffService(this.audit, clock, newId);
    this.tools = new ToolRegistry(this.audit).register(createTicketTool(this.handoff));
    this.chat = new ChatService({
      tenants: this.tenants,
      retriever: this.retriever,
      generator: new RedactingGenerator(opts.generator ?? new ExtractiveGenerator()),
      fallbackGenerator: new ExtractiveGenerator(),
      router: opts.router ?? new RuleBasedRouter(),
      tools: this.tools,
      handoff: this.handoff,
      clock,
      newId,
    });
    this.analytics = new AnalyticsService(this.chat, this.handoff);
  }

  /** Creates a tenant with a first owner key and a public widget key. The keys are returned once. */
  createTenant(input: { name: string; settings?: Partial<TenantSettings> }): { tenant: Tenant; ownerKey: IssuedKey; publicKey: IssuedKey } {
    const tenant = this.tenants.create(input);
    const ownerKey = this.keys.issue(tenant.id, { kind: "secret", role: "owner", label: "initial owner" });
    const publicKey = this.keys.issue(tenant.id, { kind: "public", label: "widget" });
    this.audit.append({ tenantId: tenant.id, actor: "system", action: "tenant.create", target: tenant.id, details: { name: tenant.name } });
    return { tenant, ownerKey, publicKey };
  }

  issueKey(actor: Actor, input: { kind: "secret" | "public"; role?: Role; label?: string }): IssuedKey {
    assertCan(actor, "keys:write");
    const issued = this.keys.issue(actor.tenantId, input);
    this.audit.append({
      tenantId: actor.tenantId,
      actor: actor.keyId,
      action: "key.issue",
      target: issued.record.id,
      details: { kind: input.kind, role: input.role ?? null },
    });
    return issued;
  }

  listKeys(actor: Actor) {
    assertCan(actor, "keys:read");
    return this.keys.list(actor.tenantId);
  }

  revokeKey(actor: Actor, keyId: string) {
    assertCan(actor, "keys:write");
    const revoked = this.keys.revoke(actor.tenantId, keyId);
    this.audit.append({ tenantId: actor.tenantId, actor: actor.keyId, action: "key.revoke", target: keyId });
    return revoked;
  }

  changeRole(actor: Actor, keyId: string, role: Role) {
    assertCan(actor, "roles:change");
    const change = this.keys.setRole(actor.tenantId, keyId, role);
    this.audit.append({
      tenantId: actor.tenantId,
      actor: actor.keyId,
      action: "role.change",
      target: keyId,
      details: { from: change.before.role, to: change.after.role },
    });
    return change.after;
  }

  getSettings(actor: Actor): TenantSettings {
    assertCan(actor, "settings:read");
    return this.tenants.require(actor.tenantId).settings;
  }

  updateSettings(actor: Actor, patch: Partial<TenantSettings>): TenantSettings {
    assertCan(actor, "settings:write");
    const { settings } = this.tenants.updateSettings(actor.tenantId, patch);
    this.audit.append({ tenantId: actor.tenantId, actor: actor.keyId, action: "settings.update", target: actor.tenantId, details: { fields: Object.keys(patch) } });
    return settings;
  }

  auditEntries(actor: Actor, opts: { limit?: number; afterSeq?: number } = {}) {
    assertCan(actor, "audit:read");
    return this.audit.list(actor.tenantId, opts);
  }

  verifyAudit(actor: Actor) {
    assertCan(actor, "audit:read");
    return this.audit.verify(actor.tenantId);
  }

  /** Starts background job processing (for the HTTP server). Tests call `queue.tick()` instead. */
  start(intervalMs = 200): void {
    this.queue.start(intervalMs);
  }

  stop(): void {
    this.queue.stop();
  }
}
