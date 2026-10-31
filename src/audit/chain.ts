import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactStatic } from "../privacy/pii.js";
import { type Clock, canonicalJson, sha256Hex, systemClock } from "../util.js";

export type AuditAction =
  | "tenant.create"
  | "document.ingest"
  | "document.delete"
  | "job.retry"
  | "tool.call"
  | "escalation.create"
  | "escalation.update"
  | "role.change"
  | "key.issue"
  | "key.revoke"
  | "settings.update";

export interface AuditInput {
  tenantId: string;
  /** Who did it: an API key id, or `system` / `widget:<keyId>`. */
  actor: string;
  action: AuditAction;
  target?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditEntry {
  /** 1-based position in this tenant's chain. */
  seq: number;
  at: number;
  tenantId: string;
  actor: string;
  action: AuditAction;
  target: string | null;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export type VerifyResult =
  | { ok: true; entries: number; head: ChainHead | null }
  | { ok: false; entries: number; brokenAtSeq: number; reason: string };

export const GENESIS_HASH = "0".repeat(64);

export interface ChainKeyOptions {
  /**
   * Secret for an HMAC-SHA-256 chain. Without it, anyone who can write the log file can recompute every hash after
   * editing it. With it, they would also need this key, which should live outside the log's storage (an environment
   * variable or secret manager). Verifying a keyed chain needs the same key.
   */
  hmacKey?: string;
}

function hashEntry(e: Omit<AuditEntry, "hash">, hmacKey?: string): string {
  const canonical = canonicalJson({
    seq: e.seq,
    at: e.at,
    tenantId: e.tenantId,
    actor: e.actor,
    action: e.action,
    target: e.target,
    details: e.details,
    prevHash: e.prevHash,
  });
  return hmacKey ? createHmac("sha256", hmacKey).update(canonical).digest("hex") : sha256Hex(canonical);
}

/**
 * Verifies one tenant's chain: contiguous sequence numbers, each entry linked to the previous
 * hash, each hash recomputed from the entry contents. If `expectedHead` is given (a head recorded
 * somewhere the log writer cannot rewrite), a truncated tail or a rewritten chain is detected too.
 */
export function verifyEntries(entries: readonly AuditEntry[], opts: ChainKeyOptions & { tenantId?: string; expectedHead?: ChainHead } = {}): VerifyResult {
  let prev = GENESIS_HASH;
  let seq = 0;
  for (const entry of entries) {
    seq += 1;
    const fail = (reason: string): VerifyResult => ({ ok: false, entries: entries.length, brokenAtSeq: seq, reason });
    if (!entry || typeof entry !== "object") return fail("entry is not an object");
    if (opts.tenantId !== undefined && entry.tenantId !== opts.tenantId) return fail("entry belongs to another tenant");
    if (entry.seq !== seq) return fail(`expected seq ${seq}, found ${String(entry.seq)}`);
    if (entry.prevHash !== prev) return fail("prevHash does not match the previous entry");
    const { hash, ...rest } = entry;
    if (hashEntry(rest, opts.hmacKey) !== hash) return fail("hash does not match entry contents");
    prev = hash;
  }
  const head: ChainHead | null = entries.length ? { seq: entries.length, hash: prev } : null;
  const expected = opts.expectedHead;
  if (expected) {
    if (!head || head.seq < expected.seq) {
      return { ok: false, entries: entries.length, brokenAtSeq: head ? head.seq + 1 : 1, reason: "log is shorter than the recorded head (truncated)" };
    }
    const at = entries[expected.seq - 1];
    if (!at || at.hash !== expected.hash) {
      return { ok: false, entries: entries.length, brokenAtSeq: expected.seq, reason: "entry at the recorded head does not match" };
    }
  }
  return { ok: true, entries: entries.length, head };
}

function sanitize(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactStatic(value.length > 500 ? `${value.slice(0, 500)}...` : value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === "object" && value !== undefined) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
      if (v !== undefined) out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return null;
}

export interface AuditLog {
  append(input: AuditInput): AuditEntry;
  /** Newest last. Only the given tenant's entries are returned. */
  list(tenantId: string, opts?: { limit?: number; afterSeq?: number }): AuditEntry[];
  head(tenantId: string): ChainHead | null;
  verify(tenantId: string, opts?: { expectedHead?: ChainHead }): VerifyResult;
}

export interface MemoryAuditLogOptions extends ChainKeyOptions {
  clock?: Clock;
}

/**
 * Append-only audit log. Each tenant has its own hash chain; entries carry the hash of the previous
 * entry (SHA-256, or HMAC-SHA-256 when a key is configured). String values in `details` are redacted
 * before they are hashed or stored, so the log cannot become a PII sink.
 */
export class MemoryAuditLog implements AuditLog {
  private readonly chains = new Map<string, AuditEntry[]>();
  protected readonly clock: Clock;
  protected readonly hmacKey: string | undefined;

  constructor(opts: MemoryAuditLogOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.hmacKey = opts.hmacKey;
  }

  append(input: AuditInput): AuditEntry {
    const chain = this.chains.get(input.tenantId) ?? [];
    const last = chain[chain.length - 1];
    const base: Omit<AuditEntry, "hash"> = {
      seq: (last?.seq ?? 0) + 1,
      at: this.clock(),
      tenantId: input.tenantId,
      actor: input.actor,
      action: input.action,
      target: input.target ?? null,
      details: sanitize(input.details ?? {}) as Record<string, unknown>,
      prevHash: last?.hash ?? GENESIS_HASH,
    };
    const entry: AuditEntry = { ...base, hash: hashEntry(base, this.hmacKey) };
    this.persist(entry);
    chain.push(entry);
    this.chains.set(input.tenantId, chain);
    return structuredClone(entry);
  }

  /** Hook for subclasses that write entries somewhere durable. Runs before the entry is kept in memory. */
  protected persist(_entry: AuditEntry): void {}

  protected load(entry: AuditEntry): void {
    const chain = this.chains.get(entry.tenantId) ?? [];
    chain.push(entry);
    this.chains.set(entry.tenantId, chain);
  }

  list(tenantId: string, opts: { limit?: number; afterSeq?: number } = {}): AuditEntry[] {
    const chain = this.chains.get(tenantId) ?? [];
    const after = opts.afterSeq ?? 0;
    const slice = chain.filter((e) => e.seq > after);
    const limited = opts.limit !== undefined ? slice.slice(0, opts.limit) : slice;
    return structuredClone(limited);
  }

  head(tenantId: string): ChainHead | null {
    const last = this.chains.get(tenantId)?.at(-1);
    return last ? { seq: last.seq, hash: last.hash } : null;
  }

  verify(tenantId: string, opts: { expectedHead?: ChainHead } = {}): VerifyResult {
    return verifyEntries(this.chains.get(tenantId) ?? [], { tenantId, hmacKey: this.hmacKey, ...opts });
  }
}

export class AuditIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditIntegrityError";
  }
}

/** Splits a JSONL audit file into entries. A torn final line (a write cut off by a crash) is reported, not fatal. */
function readJsonl(path: string): { entries: AuditEntry[]; tornLine: boolean; intactText: string } {
  const lines = readFileSync(path, "utf8").split("\n");
  while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
  const entries: AuditEntry[] = [];
  let tornLine = false;
  lines.forEach((line, i) => {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      if (i !== lines.length - 1) throw new AuditIntegrityError(`audit log line ${i + 1} is not valid JSON`);
      tornLine = true;
    }
  });
  const intact = tornLine ? lines.slice(0, -1) : lines;
  return { entries, tornLine, intactText: intact.length ? `${intact.join("\n")}\n` : "" };
}

function groupByTenant(entries: readonly AuditEntry[]): Map<string, AuditEntry[]> {
  const byTenant = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const list = byTenant.get(entry.tenantId) ?? [];
    list.push(entry);
    byTenant.set(entry.tenantId, list);
  }
  return byTenant;
}

/**
 * Same as the memory log, and also appends every entry as one JSON line to `path`.
 *
 * Opening an existing file verifies every tenant's chain first and throws `AuditIntegrityError` if one is broken, so a
 * tampered log stops the service instead of being extended. A torn last line is dropped (and the file rewritten
 * without it) because it is what a crash during an append leaves behind; `repairedTornLine` says so.
 */
export class JsonlAuditLog extends MemoryAuditLog {
  readonly repairedTornLine: boolean = false;

  constructor(
    private readonly path: string,
    opts: MemoryAuditLogOptions = {},
  ) {
    super(opts);
    if (existsSync(path)) {
      const { entries, tornLine, intactText } = readJsonl(path);
      for (const [tenantId, chain] of groupByTenant(entries)) {
        const result = verifyEntries(chain, { tenantId, hmacKey: this.hmacKey });
        if (!result.ok) throw new AuditIntegrityError(`audit log for tenant ${tenantId} failed verification at entry ${result.brokenAtSeq}: ${result.reason}`);
      }
      for (const entry of entries) this.load(entry);
      if (tornLine) {
        writeFileSync(path, intactText, { mode: 0o600 });
        this.repairedTornLine = true;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
  }

  protected override persist(entry: AuditEntry): void {
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }
}

/** Verifies a JSONL audit file as it is on disk, every tenant's chain, without trusting any in-memory state. */
export function verifyJsonlFile(path: string, expectedHeads: Record<string, ChainHead> = {}, opts: ChainKeyOptions = {}): Record<string, VerifyResult> {
  const byTenant = new Map<string, AuditEntry[]>();
  const results: Record<string, VerifyResult> = {};
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  lines.forEach((line, i) => {
    try {
      const entry = JSON.parse(line) as AuditEntry;
      const list = byTenant.get(entry.tenantId) ?? [];
      list.push(entry);
      byTenant.set(entry.tenantId, list);
    } catch {
      results[`line:${i + 1}`] = { ok: false, entries: lines.length, brokenAtSeq: i + 1, reason: `line ${i + 1} is not valid JSON` };
    }
  });
  for (const [tenantId, entries] of byTenant) {
    results[tenantId] = verifyEntries(entries, { tenantId, expectedHead: expectedHeads[tenantId], hmacKey: opts.hmacKey });
  }
  return results;
}
