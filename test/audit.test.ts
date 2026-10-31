import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuditIntegrityError,
  type AuditEntry,
  GENESIS_HASH,
  JsonlAuditLog,
  MemoryAuditLog,
  verifyEntries,
  verifyJsonlFile,
} from "../src/audit/chain.js";
import { sha256Hex } from "../src/util.js";

function filled(n = 5, tenantId = "t1") {
  let now = 1_000;
  const log = new MemoryAuditLog({ clock: () => now++ });
  for (let i = 0; i < n; i++) {
    log.append({ tenantId, actor: "key1", action: "document.ingest", target: `doc${i}`, details: { n: i } });
  }
  return log;
}

describe("hash-chained audit log", () => {
  it("links each entry to the previous hash, starting from the genesis hash", () => {
    const log = filled(3);
    const entries = log.list("t1");
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(entries[0]!.prevHash).toBe(GENESIS_HASH);
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);
    expect(entries[2]!.prevHash).toBe(entries[1]!.hash);
    expect(log.head("t1")).toEqual({ seq: 3, hash: entries[2]!.hash });
  });

  it("verifies an untouched chain and an empty tenant", () => {
    const log = filled(4);
    expect(log.verify("t1")).toMatchObject({ ok: true, entries: 4 });
    expect(log.verify("nobody")).toEqual({ ok: true, entries: 0, head: null });
  });

  it.each([
    ["details", (e: AuditEntry) => ({ ...e, details: { n: 999 } })],
    ["actor", (e: AuditEntry) => ({ ...e, actor: "someone-else" })],
    ["action", (e: AuditEntry) => ({ ...e, action: "document.delete" as const })],
    ["target", (e: AuditEntry) => ({ ...e, target: "other" })],
    ["timestamp", (e: AuditEntry) => ({ ...e, at: e.at + 1 })],
  ])("detects a modified %s at the modified entry", (_name, mutate) => {
    const entries = filled(5).list("t1");
    entries[2] = mutate(entries[2]!);
    expect(verifyEntries(entries)).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });

  it("detects a deleted entry in the middle", () => {
    const entries = filled(5).list("t1");
    entries.splice(1, 1);
    expect(verifyEntries(entries)).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("detects reordered entries", () => {
    const entries = filled(5).list("t1");
    [entries[1], entries[2]] = [entries[2]!, entries[1]!];
    expect(verifyEntries(entries).ok).toBe(false);
  });

  it("detects a forged entry even when its own hash is recomputed correctly", () => {
    const entries = filled(4).list("t1");
    const forged = { ...entries[1]!, details: { n: 1234 } };
    const { hash: _old, ...rest } = forged;
    // Recompute the hash the same way the log does, using the public hash definition.
    const recomputed = sha256Hex(
      JSON.stringify({
        action: rest.action,
        actor: rest.actor,
        at: rest.at,
        details: rest.details,
        prevHash: rest.prevHash,
        seq: rest.seq,
        target: rest.target,
        tenantId: rest.tenantId,
      }),
    );
    entries[1] = { ...rest, hash: recomputed };
    // The forged entry is self-consistent, but entry 3 still points at the old hash.
    expect(verifyEntries(entries)).toMatchObject({ ok: false, brokenAtSeq: 3 });
  });

  it("detects truncation only when a head was recorded elsewhere", () => {
    const log = filled(5);
    const head = log.head("t1")!;
    const entries = log.list("t1").slice(0, 3);
    expect(verifyEntries(entries).ok).toBe(true); // a shorter valid chain looks fine on its own
    expect(verifyEntries(entries, { expectedHead: head })).toMatchObject({ ok: false });
    expect(verifyEntries([], { expectedHead: head })).toMatchObject({ ok: false });
  });

  it("detects a whole-chain rewrite against a recorded head", () => {
    const original = filled(3);
    const head = original.head("t1")!;
    const rewritten = new MemoryAuditLog({ clock: () => 5 });
    for (let i = 0; i < 3; i++) rewritten.append({ tenantId: "t1", actor: "key1", action: "document.ingest", target: `doc${i}` });
    expect(rewritten.verify("t1").ok).toBe(true);
    expect(rewritten.verify("t1", { expectedHead: head }).ok).toBe(false);
  });

  it("keeps a separate chain per tenant and never lists another tenant's entries", () => {
    const log = new MemoryAuditLog();
    log.append({ tenantId: "a", actor: "k", action: "document.ingest" });
    log.append({ tenantId: "b", actor: "k", action: "document.delete" });
    log.append({ tenantId: "a", actor: "k", action: "role.change" });
    expect(log.list("a").map((e) => e.action)).toEqual(["document.ingest", "role.change"]);
    expect(log.list("b").map((e) => e.action)).toEqual(["document.delete"]);
    expect(log.list("a")[0]!.seq).toBe(1);
    expect(log.list("b")[0]!.seq).toBe(1);
  });

  it("detects an entry from another tenant spliced into a chain", () => {
    const log = new MemoryAuditLog();
    log.append({ tenantId: "a", actor: "k", action: "document.ingest" });
    log.append({ tenantId: "b", actor: "k", action: "document.ingest" });
    const entries = [...log.list("a"), ...log.list("b")];
    expect(verifyEntries(entries, { tenantId: "a" }).ok).toBe(false);
  });

  it("redacts PII in string details before hashing and storing", () => {
    const log = new MemoryAuditLog();
    const entry = log.append({ tenantId: "t", actor: "k", action: "tool.call", details: { note: "contact jane@example.com", nested: { phone: "+1 415 555 2671" } } });
    expect(JSON.stringify(entry)).not.toMatch(/jane@example|555 2671/);
    expect(entry.details).toEqual({ note: "contact [EMAIL]", nested: { phone: "[PHONE]" } });
    expect(log.verify("t").ok).toBe(true);
  });

  it("hands out copies, so callers cannot rewrite history through list()", () => {
    const log = filled(2);
    const listed = log.list("t1");
    listed[0]!.actor = "evil";
    expect(log.list("t1")[0]!.actor).toBe("key1");
    expect(log.verify("t1").ok).toBe(true);
  });

  it("supports paging with afterSeq and limit", () => {
    const log = filled(6);
    expect(log.list("t1", { afterSeq: 2, limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
  });
});

describe("JSONL audit log", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "audit-"));
    return join(dir, "nested", "audit.jsonl");
  };

  it("writes one JSON line per entry and verifies from disk", () => {
    const path = setup();
    const log = new JsonlAuditLog(path);
    log.append({ tenantId: "a", actor: "k", action: "document.ingest" });
    log.append({ tenantId: "a", actor: "k", action: "document.delete" });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    expect(verifyJsonlFile(path)).toEqual({ a: expect.objectContaining({ ok: true, entries: 2 }) });
  });

  it("continues the chain after a restart", () => {
    const path = setup();
    new JsonlAuditLog(path).append({ tenantId: "a", actor: "k", action: "document.ingest" });
    const reopened = new JsonlAuditLog(path);
    const next = reopened.append({ tenantId: "a", actor: "k", action: "document.delete" });
    expect(next.seq).toBe(2);
    expect(verifyJsonlFile(path).a).toMatchObject({ ok: true, entries: 2 });
  });

  it("detects an edit made directly in the file", () => {
    const path = setup();
    const log = new JsonlAuditLog(path);
    for (let i = 0; i < 3; i++) log.append({ tenantId: "a", actor: "k", action: "document.ingest", target: `d${i}` });
    writeFileSync(path, readFileSync(path, "utf8").replace('"target":"d1"', '"target":"dX"'));
    expect(verifyJsonlFile(path).a).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });

  it("detects a deleted line and reports garbage lines", () => {
    const path = setup();
    const log = new JsonlAuditLog(path);
    for (let i = 0; i < 3; i++) log.append({ tenantId: "a", actor: "k", action: "document.ingest" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");
    expect(verifyJsonlFile(path).a).toMatchObject({ ok: false });
    writeFileSync(path, lines.join("\n") + "\nnot json\n");
    expect(verifyJsonlFile(path)["line:4"]).toMatchObject({ ok: false });
  });

  it("detects truncation of the file given the recorded head", () => {
    const path = setup();
    const log = new JsonlAuditLog(path);
    for (let i = 0; i < 3; i++) log.append({ tenantId: "a", actor: "k", action: "document.ingest" });
    const head = log.head("a")!;
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, lines.slice(0, 2).join("\n") + "\n");
    expect(verifyJsonlFile(path, { a: head }).a).toMatchObject({ ok: false });
  });
});

describe("keyed (HMAC) chains", () => {
  const KEY = "k".repeat(40);
  const keyed = (n = 3) => {
    const log = new MemoryAuditLog({ hmacKey: KEY });
    for (let i = 0; i < n; i++) log.append({ tenantId: "t1", actor: "key1", action: "document.ingest", target: `doc${i}` });
    return log;
  };

  it("verifies with the same key and fails without it or with another one", () => {
    const log = keyed();
    expect(log.verify("t1")).toMatchObject({ ok: true, entries: 3 });
    const entries = log.list("t1");
    expect(verifyEntries(entries, { hmacKey: KEY }).ok).toBe(true);
    expect(verifyEntries(entries).ok).toBe(false);
    expect(verifyEntries(entries, { hmacKey: "x".repeat(40) }).ok).toBe(false);
  });

  it("cannot be forged by someone who recomputes a plain SHA-256 chain", () => {
    const keyedEntries = keyed(3).list("t1");
    const plain = new MemoryAuditLog();
    for (const e of keyedEntries) plain.append({ tenantId: e.tenantId, actor: e.actor, action: e.action, target: e.target });
    // An attacker rewriting the file with the public hash definition produces a chain that is valid without the key...
    expect(verifyEntries(plain.list("t1")).ok).toBe(true);
    // ...but not one that verifies as the keyed chain.
    expect(verifyEntries(plain.list("t1"), { hmacKey: KEY }).ok).toBe(false);
  });

  it("still detects edits to a keyed chain", () => {
    const entries = keyed(4).list("t1");
    entries[1] = { ...entries[1]!, actor: "someone-else" };
    expect(verifyEntries(entries, { hmacKey: KEY })).toMatchObject({ ok: false, brokenAtSeq: 2 });
  });
});

describe("opening an existing JSONL audit log", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "audit-open-"));
    return join(dir, "audit.jsonl");
  };
  const fill = (path: string, hmacKey?: string, n = 3) => {
    const log = new JsonlAuditLog(path, { hmacKey });
    for (let i = 0; i < n; i++) log.append({ tenantId: "a", actor: "k", action: "document.ingest", target: `d${i}` });
    return log;
  };

  it("refuses to start on a file whose chain was edited, instead of extending it", () => {
    const path = setup();
    fill(path);
    writeFileSync(path, readFileSync(path, "utf8").replace('"target":"d1"', '"target":"dX"'));
    expect(() => new JsonlAuditLog(path)).toThrow(AuditIntegrityError);
    expect(() => new JsonlAuditLog(path)).toThrow(/tenant a failed verification at entry 2/);
  });

  it("refuses a file with a deleted middle line or a corrupt non-final line", () => {
    const path = setup();
    fill(path);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");
    expect(() => new JsonlAuditLog(path)).toThrow(AuditIntegrityError);
    writeFileSync(path, [lines[0], "{broken", lines[2]].join("\n") + "\n");
    expect(() => new JsonlAuditLog(path)).toThrow(/line 2 is not valid JSON/);
  });

  it("drops a torn final line left by a crash, rewrites the file, and keeps appending to a valid chain", () => {
    const path = setup();
    fill(path);
    const intact = readFileSync(path, "utf8");
    writeFileSync(path, `${intact}{"seq":4,"at":1,"tenantId":"a","actor":"k"`); // no closing brace, no newline
    const reopened = new JsonlAuditLog(path);
    expect(reopened.repairedTornLine).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(intact);
    const next = reopened.append({ tenantId: "a", actor: "k", action: "document.delete" });
    expect(next.seq).toBe(4);
    expect(verifyJsonlFile(path).a).toMatchObject({ ok: true, entries: 4 });
    expect(new JsonlAuditLog(path).repairedTornLine).toBe(false);
  });

  it("opens a file with a trailing blank line and an empty file", () => {
    const path = setup();
    fill(path);
    writeFileSync(path, `${readFileSync(path, "utf8")}\n\n`);
    expect(new JsonlAuditLog(path).head("a")?.seq).toBe(3);
    writeFileSync(path, "");
    expect(new JsonlAuditLog(path).head("a")).toBeNull();
  });

  it("needs the same HMAC key to reopen a keyed log, and verifies the file with it", () => {
    const path = setup();
    const key = "s".repeat(40);
    fill(path, key);
    expect(new JsonlAuditLog(path, { hmacKey: key }).head("a")?.seq).toBe(3);
    expect(() => new JsonlAuditLog(path)).toThrow(AuditIntegrityError);
    expect(() => new JsonlAuditLog(path, { hmacKey: "w".repeat(40) })).toThrow(AuditIntegrityError);
    expect(verifyJsonlFile(path, {}, { hmacKey: key }).a).toMatchObject({ ok: true });
    expect(verifyJsonlFile(path).a).toMatchObject({ ok: false });
  });

  it("a recorded head still catches truncation after a restart", () => {
    const path = setup();
    const head = fill(path).head("a")!;
    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, `${lines.slice(0, 2).join("\n")}\n`);
    const reopened = new JsonlAuditLog(path); // a shorter valid chain opens fine...
    expect(reopened.verify("a").ok).toBe(true);
    expect(reopened.verify("a", { expectedHead: head }).ok).toBe(false); // ...but not against the recorded head
  });
});
