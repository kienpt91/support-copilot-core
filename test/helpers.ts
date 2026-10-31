import { MemoryAuditLog } from "../src/audit/chain.js";
import { Core, type CoreOptions } from "../src/core.js";
import { CORPUS } from "../src/eval/corpus.js";
import { IngestService } from "../src/ingest/service.js";
import { InMemoryJobQueue, type InMemoryQueueOptions } from "../src/ingest/queue.js";
import { type Embedder, HashingEmbedder, RedactingEmbedder } from "../src/retrieval/embedder.js";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import type { Actor } from "../src/tenancy/roles.js";

export class FakeClock {
  constructor(public now = 1_700_000_000_000) {}
  readonly read = () => this.now;
  advance(ms: number) {
    this.now += ms;
  }
}

export const actorFor = (tenantId: string, role: Actor["role"] = "admin", keyId = `key-${tenantId}-${role}`): Actor => ({ tenantId, role, keyId });

export function ingestHarness(opts: { embedder?: Embedder; queue?: InMemoryQueueOptions } = {}) {
  const clock = new FakeClock();
  const queue = new InMemoryJobQueue({ clock: clock.read, backoffMs: (n) => 1000 * n, ...opts.queue });
  const embedder = new RedactingEmbedder(opts.embedder ?? new HashingEmbedder(256));
  const retriever = new HybridRetriever(embedder);
  const audit = new MemoryAuditLog(clock.read);
  const service = new IngestService({ queue, retriever, embedder, audit, clock: clock.read });
  return { clock, queue, retriever, embedder, audit, service };
}

/** Runs the queue until nothing is due, advancing the fake clock past any retry backoff. */
export async function settle(h: { queue: InMemoryJobQueue; clock: FakeClock }, rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await h.queue.tick();
    h.clock.advance(60_000);
  }
}

// ---------------------------------------------------------------------------------------------
// Whole-core helpers

export interface TestTenant {
  id: string;
  owner: Actor;
  admin: Actor;
  agent: Actor;
  publicKey: string;
  ownerKey: string;
}

export function newCore(opts: CoreOptions = {}): { core: Core; clock: FakeClock } {
  const clock = new FakeClock();
  const core = new Core({ clock: clock.read, queueOptions: { backoffMs: (n) => 1000 * n }, ...opts });
  return { core, clock };
}

export function newTenant(core: Core, name = "Acme", settings: Parameters<Core["createTenant"]>[0]["settings"] = {}): TestTenant {
  const { tenant, ownerKey, publicKey } = core.createTenant({ name, settings });
  const mk = (role: Actor["role"]): Actor => ({ tenantId: tenant.id, keyId: `${ownerKey.record.id}-${role}`, role });
  return { id: tenant.id, owner: { tenantId: tenant.id, keyId: ownerKey.record.id, role: "owner" }, admin: mk("admin"), agent: mk("agent"), publicKey: publicKey.key, ownerKey: ownerKey.key };
}

export async function ingestCorpus(core: Core, tenant: TestTenant): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const doc of CORPUS) {
    ids.set(doc.id, core.ingest.submit(tenant.admin, { title: doc.title, content: doc.content, format: "markdown" }).document.id);
  }
  await core.queue.tick();
  return ids;
}

export const widgetPrincipal = (t: TestTenant, keyId = "pk-test") => ({ tenantId: t.id, keyId, kind: "widget" as const });
export const apiPrincipal = (t: TestTenant) => ({ tenantId: t.id, keyId: t.owner.keyId, kind: "api" as const });
