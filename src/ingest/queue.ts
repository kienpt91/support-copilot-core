import { NotFoundError, PermanentJobError } from "../errors.js";
import { redactStatic } from "../privacy/pii.js";
import { ScopedCollection } from "../tenancy/scoped.js";
import { type Clock, type IdGen, randomId, systemClock } from "../util.js";

export type JobStatus = "queued" | "running" | "succeeded" | "dead";

export interface JobHistoryEntry {
  at: number;
  status: JobStatus;
  attempt: number;
  stage: string | null;
  error: string | null;
}

export interface Job {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, string>;
  status: JobStatus;
  /** Number of times the handler has been started. */
  attempts: number;
  maxAttempts: number;
  /** Earliest time the job may (next) run. */
  runAt: number;
  createdAt: number;
  updatedAt: number;
  /** Last pipeline stage the handler reported. */
  stage: string | null;
  lastError: string | null;
  history: JobHistoryEntry[];
}

export type JobEventType = "queued" | "started" | "stage" | "retry_scheduled" | "succeeded" | "dead";

export interface JobEvent {
  type: JobEventType;
  tenantId: string;
  jobId: string;
  jobType: string;
  attempt: number;
  at: number;
  stage?: string;
  error?: string;
  nextRunAt?: number;
}

export interface JobContext {
  /** Reports which pipeline stage the job is in; visible through status polling and events. */
  setStage(stage: string): void;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<void>;

export interface JobQueue {
  enqueue(input: { tenantId: string; type: string; payload: Record<string, string> }, opts?: { maxAttempts?: number }): Job;
  get(tenantId: string, id: string): Job | undefined;
  list(tenantId: string, filter?: { status?: JobStatus }): Job[];
  deadLetters(tenantId: string): Job[];
  /** Puts a dead job back in the queue with a fresh attempt budget. */
  retryDead(tenantId: string, id: string): Job;
  setHandler(type: string, handler: JobHandler): void;
  subscribe(listener: (event: JobEvent) => void): () => void;
  /** Runs every job that is due now (and any that become due while it runs); resolves with the number of attempts made. */
  tick(): Promise<number>;
  start(intervalMs?: number): void;
  stop(): void;
}

export interface InMemoryQueueOptions {
  clock?: Clock;
  newId?: IdGen;
  maxAttempts?: number;
  /** Delay before attempt number `attempt + 1`, given the number of attempts made so far. */
  backoffMs?: (attemptsMade: number) => number;
  concurrency?: number;
}

const HISTORY_LIMIT = 30;

export function exponentialBackoff(baseMs = 250, capMs = 10_000): (attemptsMade: number) => number {
  return (attemptsMade) => Math.min(capMs, baseMs * 2 ** Math.max(0, attemptsMade - 1));
}

function describeError(err: unknown): string {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : "non-error thrown";
  return redactStatic(message.length > 300 ? `${message.slice(0, 300)}...` : message);
}

/**
 * Single-process queue with retries, exponential backoff, a dead-letter state and status events.
 * It is the reference implementation of the `JobQueue` interface, not a durable queue: jobs live in
 * memory and are lost on restart. Time comes from the injected clock, and `tick()` is explicit,
 * so tests run retries without sleeping.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly jobs = new ScopedCollection<Job>("Job");
  private readonly tenants = new Set<string>();
  private readonly handlers = new Map<string, JobHandler>();
  private readonly listeners = new Set<(event: JobEvent) => void>();
  private readonly clock: Clock;
  private readonly newId: IdGen;
  private readonly maxAttempts: number;
  private readonly backoffMs: (attemptsMade: number) => number;
  private readonly concurrency: number;
  private ticking: Promise<number> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: InMemoryQueueOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.newId = opts.newId ?? randomId;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.backoffMs = opts.backoffMs ?? exponentialBackoff();
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
  }

  setHandler(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  subscribe(listener: (event: JobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(job: Job, type: JobEventType, extra: Partial<JobEvent> = {}): void {
    const event: JobEvent = { type, tenantId: job.tenantId, jobId: job.id, jobType: job.type, attempt: job.attempts, at: this.clock(), ...extra };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A broken subscriber must not break the queue.
      }
    }
  }

  private record(job: Job, patch: Partial<Job>): Job {
    const now = this.clock();
    const status = patch.status ?? job.status;
    const attempt = patch.attempts ?? job.attempts;
    const stage = patch.stage === undefined ? job.stage : patch.stage;
    const error = patch.lastError === undefined ? job.lastError : patch.lastError;
    const history = [...job.history, { at: now, status, attempt, stage, error }];
    return this.jobs.update(job.tenantId, job.id, { ...patch, updatedAt: now, history: history.slice(-HISTORY_LIMIT) });
  }

  enqueue(input: { tenantId: string; type: string; payload: Record<string, string> }, opts: { maxAttempts?: number } = {}): Job {
    const now = this.clock();
    const job: Job = {
      id: this.newId("job"),
      tenantId: input.tenantId,
      type: input.type,
      payload: { ...input.payload },
      status: "queued",
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? this.maxAttempts,
      runAt: now,
      createdAt: now,
      updatedAt: now,
      stage: null,
      lastError: null,
      history: [{ at: now, status: "queued", attempt: 0, stage: null, error: null }],
    };
    this.tenants.add(input.tenantId);
    const stored = this.jobs.put(input.tenantId, job);
    this.emit(stored, "queued");
    return stored;
  }

  get(tenantId: string, id: string): Job | undefined {
    return this.jobs.get(tenantId, id);
  }

  list(tenantId: string, filter: { status?: JobStatus } = {}): Job[] {
    return this.jobs.list(tenantId, (j) => !filter.status || j.status === filter.status).sort((a, b) => b.createdAt - a.createdAt);
  }

  deadLetters(tenantId: string): Job[] {
    return this.list(tenantId, { status: "dead" });
  }

  retryDead(tenantId: string, id: string): Job {
    const job = this.jobs.get(tenantId, id);
    if (!job) throw new NotFoundError("Job");
    if (job.status !== "dead") throw new NotFoundError("Dead-lettered job");
    const next = this.record(job, { status: "queued", attempts: 0, runAt: this.clock(), lastError: null, stage: null });
    this.emit(next, "queued");
    return next;
  }

  private due(): Job[] {
    const now = this.clock();
    const out: Job[] = [];
    for (const tenantId of this.tenants) out.push(...this.jobs.list(tenantId, (j) => j.status === "queued" && j.runAt <= now));
    return out.sort((a, b) => a.runAt - b.runAt || a.createdAt - b.createdAt);
  }

  tick(): Promise<number> {
    if (!this.ticking) {
      this.ticking = this.drain().finally(() => {
        this.ticking = null;
      });
    }
    return this.ticking;
  }

  private async drain(): Promise<number> {
    let attempts = 0;
    for (;;) {
      const batch = this.due().slice(0, this.concurrency);
      if (batch.length === 0) return attempts;
      attempts += batch.length;
      await Promise.all(batch.map((j) => this.run(j)));
    }
  }

  private async run(queued: Job): Promise<void> {
    const handler = this.handlers.get(queued.type);
    let job = this.record(queued, { status: "running", attempts: queued.attempts + 1 });
    this.emit(job, "started");
    try {
      if (!handler) throw new PermanentJobError(`no handler registered for job type ${queued.type}`);
      await handler(job, {
        setStage: (stage) => {
          job = this.record(job, { stage });
          this.emit(job, "stage", { stage });
        },
      });
      job = this.record(job, { status: "succeeded", lastError: null });
      this.emit(job, "succeeded");
    } catch (err) {
      const error = describeError(err);
      const permanent = err instanceof PermanentJobError;
      if (permanent || job.attempts >= job.maxAttempts) {
        job = this.record(job, { status: "dead", lastError: error });
        this.emit(job, "dead", { error });
      } else {
        const runAt = this.clock() + this.backoffMs(job.attempts);
        job = this.record(job, { status: "queued", lastError: error, runAt });
        this.emit(job, "retry_scheduled", { error, nextRunAt: runAt });
      }
    }
  }

  start(intervalMs = 200): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
