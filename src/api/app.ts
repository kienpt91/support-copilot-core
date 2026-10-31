import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Core } from "../core.js";
import {
  AppError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  ValidationError,
} from "../errors.js";
import type { EscalationStatus, TicketRecord } from "../assistant/handoff.js";
import type { ChatPrincipal } from "../assistant/chat.js";
import type { SearchMode } from "../retrieval/retriever.js";
import type { PublicKeyInfo } from "../tenancy/keys.js";
import type { TenantSettings } from "../tenancy/registry.js";
import { type Actor, type Role, assertCan } from "../tenancy/roles.js";
import { type Clock, isRecord, sha256Hex, systemClock } from "../util.js";
import { TokenBucketLimiter } from "./ratelimit.js";

export interface ApiOptions {
  /** Enables `POST /v1/operator/tenants` when set. Without it that route does not exist. */
  operatorToken?: string;
  /** Largest accepted request body in bytes (document uploads). Chat requests have their own, much smaller, limit. */
  bodyLimitBytes?: number;
  /** Honour X-Forwarded-For. Only enable behind a proxy you control, or clients can pick their own rate-limit key. */
  trustProxy?: boolean;
  logger?: boolean;
  clock?: Clock;
  limits?: Partial<{
    ipBurst: number;
    ipPerMinute: number;
    keyBurst: number;
    keyPerMinute: number;
    chatBurst: number;
    chatPerMinute: number;
    authFailureBurst: number;
    authFailurePerMinute: number;
  }>;
}

const CHAT_BODY_LIMIT = 16 * 1024;
const ID = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } as const;
const ID_PARAMS = { type: "object", properties: { id: ID }, required: ["id"] } as const;

type IdRoute = { Params: { id: string } };
type ChatRoute = { Body: { message: string; conversationId?: string } };
type OperatorRoute = { Body: { name: string; allowedOrigins?: string[] } };
type DocumentRoute = { Body: { title: string; content: string; format?: "auto" | "markdown" | "text" | "html" } };
type SearchRoute = { Body: { query: string; mode?: SearchMode; k?: number } };
type ResolveRoute = { Params: { id: string }; Body?: { note?: string } };
type IssueKeyRoute = { Body: { kind: "secret" | "public"; role?: Role; label?: string } };
type RoleRoute = { Params: { id: string }; Body: { role: Role } };
type SettingsRoute = { Body: Partial<TenantSettings> };

const WIDGET_SOURCE = readFileSync(new URL("../widget/widget.js", import.meta.url));

function readCredential(req: FastifyRequest): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth);
    return m ? m[1]! : null;
  }
  const header = req.headers["x-api-key"];
  return typeof header === "string" && header.length <= 200 ? header : null;
}

function queryString(req: FastifyRequest, name: string): string | undefined {
  const q = req.query;
  if (!isRecord(q)) return undefined;
  const v = q[name];
  return typeof v === "string" ? v : undefined;
}

function queryInt(req: FastifyRequest, name: string, min: number, max: number): number | undefined {
  const raw = queryString(req, name);
  if (raw === undefined) return undefined;
  if (!/^\d{1,9}$/.test(raw)) throw new ValidationError(`${name} must be an integer.`);
  const n = Number(raw);
  if (n < min || n > max) throw new ValidationError(`${name} must be between ${min} and ${max}.`);
  return n;
}

function queryTime(req: FastifyRequest, name: string): number | undefined {
  const raw = queryString(req, name);
  if (raw === undefined) return undefined;
  const t = /^\d{1,15}$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(t)) throw new ValidationError(`${name} must be epoch milliseconds or an ISO 8601 date.`);
  return t;
}

function queryEnum<T extends string>(req: FastifyRequest, name: string, values: readonly T[]): T | undefined {
  const raw = queryString(req, name);
  if (raw === undefined) return undefined;
  const found = values.find((v) => v === raw);
  if (!found) throw new ValidationError(`${name} must be one of: ${values.join(", ")}.`);
  return found;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: "Invalid request.",
  413: "Request body is too large.",
  415: "Unsupported content type. Send application/json.",
};

export function buildApp(core: Core, opts: ApiOptions = {}): FastifyInstance {
  const clock = opts.clock ?? systemClock;
  const limits = opts.limits ?? {};
  const ipLimiter = new TokenBucketLimiter(limits.ipBurst ?? 60, limits.ipPerMinute ?? 120, clock);
  const keyLimiter = new TokenBucketLimiter(limits.keyBurst ?? 120, limits.keyPerMinute ?? 300, clock);
  const chatLimiter = new TokenBucketLimiter(limits.chatBurst ?? 10, limits.chatPerMinute ?? 30, clock);
  const authFailures = new TokenBucketLimiter(limits.authFailureBurst ?? 10, limits.authFailurePerMinute ?? 10, clock);
  const operatorHash = opts.operatorToken ? Buffer.from(sha256Hex(opts.operatorToken), "hex") : null;

  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: opts.bodyLimitBytes ?? 1_500_000,
    trustProxy: opts.trustProxy ?? false,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false, allErrors: false } },
  });
  // A text/plain body is a "simple" cross-origin request that browsers send without a preflight, so only JSON is accepted.
  app.removeContentTypeParser("text/plain");

  // --- cross-cutting -------------------------------------------------------------------------

  app.addHook("onRequest", async (req) => {
    const decision = ipLimiter.take(req.ip);
    if (!decision.ok) throw new RateLimitedError(decision.retryAfterSeconds);
  });

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      if (err instanceof RateLimitedError) reply.header("retry-after", String(err.retryAfterSeconds));
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const status = isRecord(err) && typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status >= 400 && status < 500) {
      const validation = isRecord(err) && Array.isArray(err.validation);
      const message = validation && err instanceof Error ? err.message : (STATUS_MESSAGES[status] ?? "Request could not be processed.");
      const code = status === 413 ? "payload_too_large" : status === 415 ? "unsupported_media_type" : "invalid_request";
      return reply.code(status).send({ error: { code, message: status === 400 && !validation ? "Request body is not valid JSON." : message } });
    }
    // Never echo internal error text; the log has it (without request bodies).
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "Internal server error." } });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Route not found." } }));

  // --- authentication --------------------------------------------------------------------------

  /**
   * Failed authentication attempts draw from a small per-IP budget; past it the response becomes 429.
   * Valid credentials are never blocked by this, so one noisy client cannot lock out others behind the same address.
   */
  function failAuth(req: FastifyRequest): never {
    const decision = authFailures.take(req.ip);
    if (!decision.ok) throw new RateLimitedError(decision.retryAfterSeconds);
    throw new UnauthorizedError("Missing or invalid API key.");
  }

  function limitKey(record: PublicKeyInfo): void {
    const decision = keyLimiter.take(record.id);
    if (!decision.ok) throw new RateLimitedError(decision.retryAfterSeconds);
  }

  /** Authenticates a secret key and returns the actor. The tenant id comes only from the key. */
  function requireActor(req: FastifyRequest): Actor {
    const presented = readCredential(req);
    const record = presented ? core.keys.authenticate(presented, "secret") : null;
    if (!record || !record.role) return failAuth(req);
    limitKey(record);
    return { tenantId: record.tenantId, keyId: record.id, role: record.role };
  }

  function requireOperator(req: FastifyRequest): void {
    if (!operatorHash) throw new NotFoundError("Route");
    const presented = readCredential(req);
    const ok = presented !== null && timingSafeEqual(Buffer.from(sha256Hex(presented), "hex"), operatorHash);
    if (!ok) failAuth(req);
  }

  // --- public ----------------------------------------------------------------------------------

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/widget.js", async (_req, reply) => {
    reply.header("content-type", "text/javascript; charset=utf-8");
    reply.header("cache-control", "public, max-age=300");
    return WIDGET_SOURCE;
  });

  // Chat: public (widget) keys travel in the query string so the CORS preflight, which carries no custom headers, can be checked too.
  function widgetKeyFromQuery(req: FastifyRequest): PublicKeyInfo | null {
    const pk = queryString(req, "pk");
    return pk && pk.length <= 200 ? core.keys.authenticatePublic(pk) : null;
  }

  function originAllowed(record: PublicKeyInfo, origin: unknown): origin is string {
    if (typeof origin !== "string") return false;
    return core.tenants.require(record.tenantId).settings.allowedOrigins.includes(origin);
  }

  function corsHeaders(reply: FastifyReply, origin: string): void {
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
  }

  app.options("/v1/chat", async (req, reply) => {
    const record = widgetKeyFromQuery(req);
    const origin = req.headers.origin;
    if (!record || !originAllowed(record, origin)) {
      if (!record) authFailures.take(req.ip);
      return reply.code(403).send({ error: { code: "origin_not_allowed", message: "Origin is not allowed for this key." } });
    }
    corsHeaders(reply, origin);
    reply.header("access-control-allow-methods", "POST, OPTIONS");
    reply.header("access-control-allow-headers", "content-type");
    reply.header("access-control-max-age", "600");
    return reply.code(204).send();
  });

  app.post<ChatRoute>(
    "/v1/chat",
    {
      bodyLimit: CHAT_BODY_LIMIT,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: { message: { type: "string", minLength: 1, maxLength: 2000 }, conversationId: { type: "string", maxLength: 64 } },
        },
      },
    },
    async (req, reply) => {
      const presented = readCredential(req);
      let principal: ChatPrincipal;
      if (presented) {
        const record = core.keys.authenticate(presented);
        if (!record) return failAuth(req);
        limitKey(record);
        principal = { tenantId: record.tenantId, keyId: record.id, kind: record.kind === "secret" ? "api" : "widget" };
        if (record.kind === "public") {
          if (!originAllowed(record, req.headers.origin)) throw new ForbiddenError("Origin is not allowed for this key.");
          corsHeaders(reply, req.headers.origin as string);
        }
      } else {
        const record = widgetKeyFromQuery(req);
        if (!record) return failAuth(req);
        if (!originAllowed(record, req.headers.origin)) throw new ForbiddenError("Origin is not allowed for this key.");
        corsHeaders(reply, req.headers.origin as string);
        limitKey(record);
        principal = { tenantId: record.tenantId, keyId: record.id, kind: "widget" };
      }
      const decision = chatLimiter.take(`${principal.tenantId}:${principal.keyId}`);
      if (!decision.ok) throw new RateLimitedError(decision.retryAfterSeconds);
      const { message, conversationId } = req.body;
      return core.chat.handle(principal, { message, conversationId });
    },
  );

  // --- operator --------------------------------------------------------------------------------

  app.post<OperatorRoute>(
    "/v1/operator/tenants",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            allowedOrigins: { type: "array", maxItems: 20, items: { type: "string", maxLength: 200 } },
          },
        },
      },
    },
    async (req, reply) => {
      requireOperator(req);
      const body = req.body;
      const { tenant, ownerKey, publicKey } = core.createTenant({ name: body.name, settings: body.allowedOrigins ? { allowedOrigins: body.allowedOrigins } : {} });
      return reply.code(201).send({ tenant: { id: tenant.id, name: tenant.name }, ownerKey: ownerKey.key, publicKey: publicKey.key });
    },
  );

  // --- documents -------------------------------------------------------------------------------

  app.post<DocumentRoute>(
    "/v1/documents",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["title", "content"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            content: { type: "string", minLength: 1, maxLength: 1_000_000 },
            format: { enum: ["auto", "markdown", "text", "html"] },
          },
        },
      },
    },
    async (req, reply) => {
      const actor = requireActor(req);
      const result = core.ingest.submit(actor, req.body);
      return reply.code(result.duplicate ? 200 : 202).send({ ...result, statusUrl: `/v1/documents/${result.document.id}` });
    },
  );

  app.get("/v1/documents", async (req) => ({ documents: core.ingest.list(requireActor(req)) }));
  app.get<IdRoute>("/v1/documents/:id", { schema: { params: ID_PARAMS } }, async (req) => core.ingest.status(requireActor(req), req.params.id));
  app.delete<IdRoute>("/v1/documents/:id", { schema: { params: ID_PARAMS } }, async (req) => core.ingest.delete(requireActor(req), req.params.id));

  app.get("/v1/jobs", async (req) => {
    const actor = requireActor(req);
    const status = queryEnum(req, "status", ["queued", "running", "succeeded", "dead"] as const);
    return { jobs: core.ingest.listJobs(actor, status) };
  });
  app.get<IdRoute>("/v1/jobs/:id", { schema: { params: ID_PARAMS } }, async (req) => core.ingest.getJob(requireActor(req), req.params.id));
  app.post<IdRoute>("/v1/jobs/:id/retry", { schema: { params: ID_PARAMS } }, async (req) => core.ingest.retryJob(requireActor(req), req.params.id));

  app.post<SearchRoute>(
    "/v1/search",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: { type: "string", minLength: 1, maxLength: 1000 },
            mode: { enum: ["bm25", "vector", "hybrid"] },
            k: { type: "integer", minimum: 1, maximum: 20 },
          },
        },
      },
    },
    async (req) => {
      const actor = requireActor(req);
      assertCan(actor, "search:run");
      const body = req.body;
      const hits = await core.retriever.search(actor.tenantId, body.query, { mode: body.mode, k: body.k });
      return {
        hits: hits.map((h) => ({
          documentId: h.chunk.documentId,
          chunkId: h.chunk.id,
          heading: h.chunk.heading,
          text: h.chunk.text.slice(0, 400),
          score: h.score,
          bm25Rank: h.bm25Rank,
          vectorRank: h.vectorRank,
          cosine: h.cosine,
          coverage: h.coverage,
        })),
      };
    },
  );

  // --- conversations, tickets, escalations -----------------------------------------------------

  app.get("/v1/conversations", async (req) => ({ conversations: core.chat.listConversations(requireActor(req)) }));
  app.get<IdRoute>("/v1/conversations/:id", { schema: { params: ID_PARAMS } }, async (req) => core.chat.getConversation(requireActor(req), req.params.id));

  app.get("/v1/tickets", async (req) => {
    const actor = requireActor(req);
    return { tickets: core.handoff.listTickets(actor, queryEnum<TicketRecord["status"]>(req, "status", ["open", "closed"])) };
  });
  app.get<IdRoute>("/v1/tickets/:id", { schema: { params: ID_PARAMS } }, async (req) => core.handoff.getTicket(requireActor(req), req.params.id));
  app.post<IdRoute>("/v1/tickets/:id/close", { schema: { params: ID_PARAMS } }, async (req) => core.handoff.closeTicket(requireActor(req), req.params.id));

  app.get("/v1/escalations", async (req) => {
    const actor = requireActor(req);
    return { escalations: core.handoff.listEscalations(actor, queryEnum<EscalationStatus>(req, "status", ["open", "claimed", "resolved"])) };
  });
  app.post<IdRoute>("/v1/escalations/:id/claim", { schema: { params: ID_PARAMS } }, async (req) => core.handoff.claim(requireActor(req), req.params.id));
  app.post<ResolveRoute>(
    "/v1/escalations/:id/resolve",
    {
      schema: {
        params: ID_PARAMS,
        body: { type: "object", additionalProperties: false, properties: { note: { type: "string", maxLength: 1000 } } },
      },
    },
    async (req) => {
      const actor = requireActor(req);
      return core.handoff.resolve(actor, req.params.id, req.body?.note);
    },
  );

  // --- analytics, audit ------------------------------------------------------------------------

  app.get("/v1/analytics/summary", async (req) => core.analytics.summary(requireActor(req), { from: queryTime(req, "from"), to: queryTime(req, "to") }));
  app.get("/v1/analytics/timeseries", async (req) => ({ days: core.analytics.timeseries(requireActor(req), { from: queryTime(req, "from"), to: queryTime(req, "to") }) }));
  app.get("/v1/analytics/unanswered", async (req) => {
    const actor = requireActor(req);
    return { questions: core.analytics.unanswered(actor, { from: queryTime(req, "from"), to: queryTime(req, "to") }, queryInt(req, "limit", 1, 100) ?? 20) };
  });

  app.get("/v1/audit", async (req) => {
    const actor = requireActor(req);
    return { entries: core.auditEntries(actor, { limit: queryInt(req, "limit", 1, 500) ?? 100, afterSeq: queryInt(req, "afterSeq", 0, 1_000_000_000) }) };
  });
  app.get("/v1/audit/verify", async (req) => core.verifyAudit(requireActor(req)));

  // --- keys and settings -----------------------------------------------------------------------

  app.get("/v1/keys", async (req) => ({ keys: core.listKeys(requireActor(req)) }));
  app.post<IssueKeyRoute>(
    "/v1/keys",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { enum: ["secret", "public"] }, role: { enum: ["owner", "admin", "agent"] }, label: { type: "string", maxLength: 80 } },
        },
      },
    },
    async (req, reply) => {
      const actor = requireActor(req);
      const issued = core.issueKey(actor, req.body);
      return reply.code(201).send({ key: issued.key, record: issued.record });
    },
  );
  app.patch<RoleRoute>(
    "/v1/keys/:id",
    {
      schema: { params: ID_PARAMS, body: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { enum: ["owner", "admin", "agent"] } } } },
    },
    async (req) => core.changeRole(requireActor(req), req.params.id, req.body.role),
  );
  app.delete<IdRoute>("/v1/keys/:id", { schema: { params: ID_PARAMS } }, async (req) => core.revokeKey(requireActor(req), req.params.id));

  app.get("/v1/settings", async (req) => core.getSettings(requireActor(req)));
  app.patch<SettingsRoute>(
    "/v1/settings",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            allowedOrigins: { type: "array", maxItems: 20, items: { type: "string", maxLength: 200 } },
            piiRestore: { enum: ["none", "user", "all"] },
            answerThreshold: { type: "number", minimum: 0, maximum: 1 },
            cautionMargin: { type: "number", minimum: 0, maximum: 1 },
            escalateOnLowConfidence: { type: "boolean" },
            retrievalK: { type: "integer", minimum: 1, maximum: 10 },
          },
        },
      },
    },
    async (req) => core.updateSettings(requireActor(req), req.body),
  );

  return app;
}
