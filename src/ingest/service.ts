import { ConflictError, NotFoundError, PermanentJobError, ValidationError } from "../errors.js";
import type { AuditLog } from "../audit/chain.js";
import { redactStatic } from "../privacy/pii.js";
import { type Embedder, EmbedderError } from "../retrieval/embedder.js";
import { type Chunk, type HybridRetriever } from "../retrieval/retriever.js";
import { type Actor, assertCan } from "../tenancy/roles.js";
import { ScopedCollection } from "../tenancy/scoped.js";
import { type Clock, type IdGen, randomId, sha256Hex, systemClock } from "../util.js";
import { type ChunkOptions, chunkSections } from "./chunk.js";
import { type DocFormat, detectFormat, normalizeContent, parseDocument } from "./parse.js";
import type { Job, JobQueue } from "./queue.js";

export type DocumentStatus = "queued" | "processing" | "ready" | "failed";

export interface DocumentRecord {
  id: string;
  tenantId: string;
  title: string;
  format: DocFormat;
  contentHash: string;
  bytes: number;
  status: DocumentStatus;
  jobId: string | null;
  chunkCount: number;
  error: string | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** Source text, kept so a failed job can be retried. Never returned by the API. */
  raw: string;
}

export type DocumentView = Omit<DocumentRecord, "raw">;

export interface DocumentStatusView {
  document: DocumentView;
  job: Pick<Job, "id" | "status" | "attempts" | "maxAttempts" | "stage" | "lastError" | "runAt" | "history"> | null;
}

export const INGEST_JOB = "ingest_document";
export const MAX_DOCUMENT_BYTES = 1_000_000;
export const MAX_DOCUMENTS_PER_TENANT = 500;
const EMBED_BATCH = 32;

export interface IngestDeps {
  queue: JobQueue;
  retriever: HybridRetriever;
  embedder: Embedder;
  audit: AuditLog;
  clock?: Clock;
  newId?: IdGen;
  chunking?: ChunkOptions;
}

function view(record: DocumentRecord): DocumentView {
  const { raw: _raw, ...rest } = record;
  return rest;
}

export class IngestService {
  readonly documents = new ScopedCollection<DocumentRecord>("Document");
  private readonly clock: Clock;
  private readonly newId: IdGen;

  constructor(private readonly deps: IngestDeps) {
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? randomId;
    deps.queue.setHandler(INGEST_JOB, (job, ctx) => this.process(job, ctx.setStage));
    deps.queue.subscribe((event) => {
      if (event.jobType !== INGEST_JOB) return;
      const job = deps.queue.get(event.tenantId, event.jobId);
      const documentId = job?.payload.documentId;
      if (!documentId || !this.documents.has(event.tenantId, documentId)) return;
      const now = this.clock();
      if (event.type === "started") this.documents.update(event.tenantId, documentId, { status: "processing", updatedAt: now });
      else if (event.type === "retry_scheduled") this.documents.update(event.tenantId, documentId, { status: "queued", error: event.error ?? null, updatedAt: now });
      else if (event.type === "dead") this.documents.update(event.tenantId, documentId, { status: "failed", error: event.error ?? "failed", updatedAt: now });
    });
  }

  /** Content hash used for idempotency: same tenant + same normalised content + same format = same document. */
  static contentHash(content: string, format: DocFormat): string {
    return sha256Hex(`${format}\n${normalizeContent(content).trim()}`);
  }

  submit(actor: Actor, input: { title: string; content: string; format?: DocFormat | "auto" }): { document: DocumentView; jobId: string; duplicate: boolean } {
    assertCan(actor, "documents:write");
    const title = typeof input.title === "string" ? input.title.trim() : "";
    if (title.length === 0 || title.length > 200) throw new ValidationError("title must be 1-200 characters.");
    if (typeof input.content !== "string" || input.content.trim().length === 0) throw new ValidationError("content must be a non-empty string.");
    const bytes = Buffer.byteLength(input.content, "utf8");
    if (bytes > MAX_DOCUMENT_BYTES) throw new ValidationError(`content is larger than ${MAX_DOCUMENT_BYTES} bytes.`);
    const requested = input.format ?? "auto";
    if (!["auto", "markdown", "text", "html"].includes(requested)) throw new ValidationError("format must be auto, markdown, text or html.");
    const format: DocFormat = requested === "auto" ? detectFormat(normalizeContent(input.content)) : requested;
    const contentHash = IngestService.contentHash(input.content, format);

    const existing = this.documents.findBy(actor.tenantId, (d) => d.contentHash === contentHash);
    if (existing && existing.status !== "failed") {
      this.deps.audit.append({
        tenantId: actor.tenantId,
        actor: actor.keyId,
        action: "document.ingest",
        target: existing.id,
        details: { duplicate: true, title, bytes },
      });
      return { document: view(existing), jobId: existing.jobId ?? "", duplicate: true };
    }
    if (!existing && this.documents.count(actor.tenantId) >= MAX_DOCUMENTS_PER_TENANT) {
      throw new ConflictError(`Document limit of ${MAX_DOCUMENTS_PER_TENANT} reached.`);
    }

    const now = this.clock();
    const record: DocumentRecord = existing
      ? { ...existing, title, status: "queued", error: null, updatedAt: now, raw: input.content }
      : {
          id: this.newId("doc"),
          tenantId: actor.tenantId,
          title,
          format,
          contentHash,
          bytes,
          status: "queued",
          jobId: null,
          chunkCount: 0,
          error: null,
          createdBy: actor.keyId,
          createdAt: now,
          updatedAt: now,
          raw: input.content,
        };
    const job = this.deps.queue.enqueue({ tenantId: actor.tenantId, type: INGEST_JOB, payload: { documentId: record.id } });
    record.jobId = job.id;
    this.documents.put(actor.tenantId, record);
    this.deps.audit.append({
      tenantId: actor.tenantId,
      actor: actor.keyId,
      action: "document.ingest",
      target: record.id,
      details: { duplicate: false, retriedFailed: Boolean(existing), title, bytes, contentHash: contentHash.slice(0, 16), format },
    });
    return { document: view(record), jobId: job.id, duplicate: false };
  }

  list(actor: Actor): DocumentView[] {
    assertCan(actor, "documents:read");
    return this.documents.list(actor.tenantId).sort((a, b) => b.createdAt - a.createdAt).map(view);
  }

  /** Document plus the state of its ingestion job: what the polled status endpoint returns. */
  status(actor: Actor, documentId: string): DocumentStatusView {
    assertCan(actor, "documents:read");
    const record = this.documents.require(actor.tenantId, documentId);
    const job = record.jobId ? this.deps.queue.get(actor.tenantId, record.jobId) : undefined;
    return {
      document: view(record),
      job: job
        ? { id: job.id, status: job.status, attempts: job.attempts, maxAttempts: job.maxAttempts, stage: job.stage, lastError: job.lastError, runAt: job.runAt, history: job.history }
        : null,
    };
  }

  delete(actor: Actor, documentId: string): { removedChunks: number } {
    assertCan(actor, "documents:delete");
    const record = this.documents.require(actor.tenantId, documentId);
    const removedChunks = this.deps.retriever.removeDocument(actor.tenantId, documentId);
    this.documents.delete(actor.tenantId, documentId);
    this.deps.audit.append({
      tenantId: actor.tenantId,
      actor: actor.keyId,
      action: "document.delete",
      target: documentId,
      details: { title: record.title, removedChunks },
    });
    return { removedChunks };
  }

  getJob(actor: Actor, jobId: string): Job {
    assertCan(actor, "jobs:read");
    const job = this.deps.queue.get(actor.tenantId, jobId);
    if (!job) throw new NotFoundError("Job");
    return job;
  }

  listJobs(actor: Actor, status?: Job["status"]): Job[] {
    assertCan(actor, "jobs:read");
    return this.deps.queue.list(actor.tenantId, { status });
  }

  retryJob(actor: Actor, jobId: string): Job {
    assertCan(actor, "jobs:retry");
    const retried = this.deps.queue.retryDead(actor.tenantId, jobId);
    const documentId = retried.payload.documentId;
    if (documentId && this.documents.has(actor.tenantId, documentId)) {
      this.documents.update(actor.tenantId, documentId, { status: "queued", error: null, updatedAt: this.clock() });
    }
    this.deps.audit.append({ tenantId: actor.tenantId, actor: actor.keyId, action: "job.retry", target: jobId, details: { documentId } });
    return retried;
  }

  /** The job handler: parse -> chunk -> embed -> index. */
  private async process(job: Job, setStage: (stage: string) => void): Promise<void> {
    const { tenantId } = job;
    const documentId = job.payload.documentId ?? "";
    const doc = this.documents.get(tenantId, documentId);
    if (!doc) return; // deleted while queued: nothing to do

    setStage("parse");
    const parsed = parseDocument(doc.raw, doc.format);

    setStage("chunk");
    const drafts = chunkSections(parsed.sections, this.deps.chunking);

    setStage("embed");
    const chunks: Chunk[] = drafts.map((d, ordinal) => ({
      id: `${documentId}:${ordinal}`,
      tenantId,
      documentId,
      ordinal,
      heading: redactStatic(d.heading ? `${doc.title} > ${d.heading}` : doc.title),
      text: d.text,
      indexText: redactStatic(d.text),
    }));
    const vectors: Float32Array[] = [];
    try {
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const batch = chunks.slice(i, i + EMBED_BATCH);
        vectors.push(...(await this.deps.embedder.embed(batch.map((c) => `${c.heading}\n${c.indexText}`))));
      }
    } catch (err) {
      if (err instanceof EmbedderError && !err.retryable) throw new PermanentJobError(err.message);
      throw err;
    }

    setStage("index");
    const current = this.documents.get(tenantId, documentId);
    if (!current || current.contentHash !== doc.contentHash) return; // deleted while embedding: do not resurrect it
    this.deps.retriever.commit(tenantId, documentId, chunks, vectors);
    this.documents.update(tenantId, documentId, { status: "ready", chunkCount: chunks.length, error: null, updatedAt: this.clock() });
  }
}
