import { JsonlAuditLog, MemoryAuditLog } from "./audit/chain.js";
import { OpenAiCompatibleGenerator } from "./assistant/generator.js";
import { buildApp } from "./api/app.js";
import { Core, type CoreOptions } from "./core.js";
import { CORPUS } from "./eval/corpus.js";
import { OpenAiCompatibleEmbedder } from "./retrieval/embedder.js";

/**
 * Starts the HTTP API.
 *
 *   PORT, HOST              listen address (default 127.0.0.1:3000)
 *   OPERATOR_TOKEN          enables POST /v1/operator/tenants (omit to disable it)
 *   AUDIT_LOG_PATH          write the audit log to this JSONL file as well as keeping it in memory; an existing file is
 *                           verified on start and the process refuses to start if a chain is broken
 *   AUDIT_HMAC_KEY          at least 32 characters; makes the audit chain an HMAC so editing the file is not enough to forge it
 *   TRUSTED_PROXIES         X-Forwarded-For hops to believe: a number of proxies (e.g. 1) or comma-separated addresses/CIDRs.
 *                           Leave unset unless a proxy you control overwrites or appends the header
 *   EMBEDDINGS_BASE_URL, EMBEDDINGS_MODEL, EMBEDDINGS_DIMENSIONS, EMBEDDINGS_API_KEY
 *                           use an OpenAI-compatible embeddings endpoint instead of the offline embedder
 *   LLM_BASE_URL, LLM_MODEL, LLM_API_KEY
 *                           use an OpenAI-compatible chat endpoint instead of the extractive generator
 *   --demo                  create a demo tenant with the fixture help-centre documents and print its keys
 *   DEMO_ORIGIN             origin allowed for the demo widget key (default http://localhost:8080)
 */
/** A bare number means that many proxy hops; anything else is a comma-separated list of proxy addresses or CIDRs. */
function parseTrustedProxies(value: string | undefined): number | string[] | undefined {
  if (value === undefined) return undefined;
  if (/^\d+$/.test(value)) return Number(value);
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function env(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : undefined;
}

function buildCoreOptions(): CoreOptions {
  const opts: CoreOptions = {};
  const auditPath = env("AUDIT_LOG_PATH");
  const hmacKey = env("AUDIT_HMAC_KEY");
  if (hmacKey !== undefined && hmacKey.length < 32) throw new Error("AUDIT_HMAC_KEY must be at least 32 characters");
  if (auditPath) opts.audit = new JsonlAuditLog(auditPath, { hmacKey });
  else if (hmacKey) opts.audit = new MemoryAuditLog({ hmacKey });

  const embeddingsUrl = env("EMBEDDINGS_BASE_URL");
  if (embeddingsUrl) {
    const dimensions = Number(env("EMBEDDINGS_DIMENSIONS"));
    const model = env("EMBEDDINGS_MODEL");
    if (!model || !Number.isInteger(dimensions) || dimensions < 1) {
      throw new Error("EMBEDDINGS_BASE_URL needs EMBEDDINGS_MODEL and an integer EMBEDDINGS_DIMENSIONS");
    }
    opts.embedder = new OpenAiCompatibleEmbedder({ baseUrl: embeddingsUrl, model, dimensions, apiKey: env("EMBEDDINGS_API_KEY") });
  }

  const llmUrl = env("LLM_BASE_URL");
  if (llmUrl) {
    const model = env("LLM_MODEL");
    if (!model) throw new Error("LLM_BASE_URL needs LLM_MODEL");
    opts.generator = new OpenAiCompatibleGenerator({ baseUrl: llmUrl, model, apiKey: env("LLM_API_KEY") });
  }
  return opts;
}

async function seedDemo(core: Core): Promise<void> {
  const origin = env("DEMO_ORIGIN") ?? "http://localhost:8080";
  const { tenant, ownerKey, publicKey } = core.createTenant({ name: "Ledgerly demo", settings: { allowedOrigins: [origin] } });
  const actor = { tenantId: tenant.id, keyId: ownerKey.record.id, role: "owner" } as const;
  for (const doc of CORPUS) core.ingest.submit(actor, { title: doc.title, content: doc.content, format: "markdown" });
  await core.queue.tick();
  console.log(JSON.stringify({ demo: { tenantId: tenant.id, allowedOrigin: origin, ownerKey: ownerKey.key, publicKey: publicKey.key, note: "keys are random per start and only valid until the process exits" } }));
}

const core = new Core(buildCoreOptions());
core.start();
if (process.argv.includes("--demo")) await seedDemo(core);

const app = buildApp(core, {
  operatorToken: env("OPERATOR_TOKEN"),
  trustProxy: parseTrustedProxies(env("TRUSTED_PROXIES")),
  logger: true,
});
const port = Number(env("PORT") ?? 3000);
const host = env("HOST") ?? "127.0.0.1";
await app.listen({ port, host });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    core.stop();
    void app.close().then(() => process.exit(0));
  });
}
