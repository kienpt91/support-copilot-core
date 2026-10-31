export { Core, type CoreOptions } from "./core.js";
export { buildApp, type ApiOptions } from "./api/app.js";
export { TokenBucketLimiter } from "./api/ratelimit.js";

export { type Actor, type Permission, type Role, can } from "./tenancy/roles.js";
export { ScopedCollection } from "./tenancy/scoped.js";
export { ApiKeyService } from "./tenancy/keys.js";
export { type Tenant, type TenantSettings, TenantRegistry } from "./tenancy/registry.js";

export { InMemoryJobQueue, type Job, type JobEvent, type JobQueue } from "./ingest/queue.js";
export { IngestService, type DocumentView } from "./ingest/service.js";
export { chunkSections } from "./ingest/chunk.js";
export { htmlToText, parseDocument } from "./ingest/parse.js";

export { Bm25Index } from "./retrieval/bm25.js";
export { type Embedder, HashingEmbedder, OpenAiCompatibleEmbedder, RedactingEmbedder } from "./retrieval/embedder.js";
export { reciprocalRankFusion } from "./retrieval/fusion.js";
export { HybridRetriever, type Hit, type SearchMode } from "./retrieval/retriever.js";

export { ChatService, type ChatResult } from "./assistant/chat.js";
export { ExtractiveGenerator, type Generator, OpenAiCompatibleGenerator, RedactingGenerator } from "./assistant/generator.js";
export { type IntentRouter, RuleBasedRouter } from "./assistant/router.js";
export { ToolRegistry, createTicketTool, type Tool } from "./assistant/tools.js";
export { calibrateThreshold, evaluateThreshold, retrievalConfidence } from "./assistant/confidence.js";

export { PiiVault } from "./privacy/vault.js";
export { findPii, redactStatic } from "./privacy/pii.js";

export { JsonlAuditLog, MemoryAuditLog, type AuditLog, verifyEntries, verifyJsonlFile } from "./audit/chain.js";
export { AnalyticsService } from "./analytics.js";
export { runEval, type EvalReport } from "./eval/evaluate.js";
