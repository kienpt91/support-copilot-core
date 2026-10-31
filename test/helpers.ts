import { MemoryAuditLog } from "../src/audit/chain.js";
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
