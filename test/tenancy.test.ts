import { describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, TenantMismatchError, ValidationError } from "../src/errors.js";
import { ApiKeyService } from "../src/tenancy/keys.js";
import { DEFAULT_SETTINGS, TenantRegistry, normalizeOrigin } from "../src/tenancy/registry.js";
import { type Actor, ROLES, assertCan, can } from "../src/tenancy/roles.js";
import { ScopedCollection } from "../src/tenancy/scoped.js";

interface Thing {
  id: string;
  tenantId: string;
  label: string;
}
const thing = (tenantId: string, id = "x1", label = "secret"): Thing => ({ id, tenantId, label });

describe("ScopedCollection: tenant isolation through every method", () => {
  // Tenant A owns record x1. Every call below is made as tenant B and must not see or change it.
  const attacks: Record<string, (c: ScopedCollection<Thing>) => unknown> = {
    put: (c) => c.put("B", thing("B", "x1", "overwrite")),
    get: (c) => expect(c.get("B", "x1")).toBeUndefined(),
    require: (c) => expect(() => c.require("B", "x1")).toThrow(NotFoundError),
    has: (c) => expect(c.has("B", "x1")).toBe(false),
    list: (c) => expect(c.list("B")).toEqual([]),
    findBy: (c) => expect(c.findBy("B", (t) => t.label === "secret")).toBeUndefined(),
    update: (c) => expect(() => c.update("B", "x1", { label: "hacked" })).toThrow(NotFoundError),
    delete: (c) => expect(c.delete("B", "x1")).toBe(false),
    count: (c) => expect(c.count("B")).toBe(0),
    clearTenant: (c) => expect(c.clearTenant("B")).toBe(0),
  };

  it("covers every public method of the collection", () => {
    const methods = Object.getOwnPropertyNames(ScopedCollection.prototype).filter((n) => n !== "constructor" && n !== "partition");
    expect(Object.keys(attacks).sort()).toEqual(methods.sort());
  });

  it.each(Object.keys(attacks))("%s as another tenant leaves tenant A's record intact", (method) => {
    const c = new ScopedCollection<Thing>("thing");
    c.put("A", thing("A"));
    attacks[method]!(c);
    expect(c.get("A", "x1")).toEqual(thing("A"));
    expect(c.count("A")).toBe(1);
  });

  it("refuses to store a record whose tenant id differs from the partition", () => {
    const c = new ScopedCollection<Thing>("thing");
    expect(() => c.put("A", thing("B"))).toThrow(TenantMismatchError);
    expect(c.count("A")).toBe(0);
    expect(c.count("B")).toBe(0);
  });

  it("keeps colliding ids in separate partitions", () => {
    const c = new ScopedCollection<Thing>("thing");
    c.put("A", thing("A", "same", "from A"));
    c.put("B", thing("B", "same", "from B"));
    expect(c.get("A", "same")?.label).toBe("from A");
    expect(c.get("B", "same")?.label).toBe("from B");
  });

  it("update cannot move a record to another tenant or change its id", () => {
    const c = new ScopedCollection<Thing>("thing");
    c.put("A", thing("A"));
    const updated = c.update("A", "x1", { tenantId: "B", id: "y", label: "new" } as unknown as Partial<Thing>);
    expect(updated).toEqual({ id: "x1", tenantId: "A", label: "new" });
    expect(c.get("B", "x1")).toBeUndefined();
  });

  it("returns copies so callers cannot mutate stored state", () => {
    const c = new ScopedCollection<Thing>("thing");
    c.put("A", thing("A"));
    c.get("A", "x1")!.label = "mutated";
    c.list("A")[0]!.label = "mutated";
    expect(c.get("A", "x1")!.label).toBe("secret");
  });

  it("rejects an empty tenant id", () => {
    const c = new ScopedCollection<Thing>("thing");
    expect(() => c.get("", "x1")).toThrow(TypeError);
    expect(() => c.list("")).toThrow(TypeError);
  });

  it("clearTenant only clears that tenant", () => {
    const c = new ScopedCollection<Thing>("thing");
    c.put("A", thing("A"));
    c.put("B", thing("B", "y1"));
    expect(c.clearTenant("A")).toBe(1);
    expect(c.count("B")).toBe(1);
  });
});

describe("roles", () => {
  const actor = (role: Actor["role"]): Actor => ({ tenantId: "t", keyId: "k", role });

  it("grants agents read and ticket access but not content or admin actions", () => {
    expect(can("agent", "documents:read")).toBe(true);
    expect(can("agent", "escalations:handle")).toBe(true);
    for (const p of ["documents:write", "documents:delete", "analytics:read", "audit:read", "settings:write", "keys:write", "roles:change"] as const) {
      expect(can("agent", p), p).toBe(false);
    }
  });

  it("grants admins content, analytics, audit and settings but not key issuing or role changes", () => {
    for (const p of ["documents:write", "documents:delete", "analytics:read", "audit:read", "settings:write", "keys:read"] as const) {
      expect(can("admin", p), p).toBe(true);
    }
    expect(can("admin", "keys:write")).toBe(false);
    expect(can("admin", "roles:change")).toBe(false);
  });

  it("grants owners everything, and each role includes the one below", () => {
    expect(can("owner", "roles:change")).toBe(true);
    expect(can("owner", "keys:write")).toBe(true);
    const order = ["agent", "admin", "owner"] as const;
    const perms = ["documents:read", "documents:write", "keys:write"] as const;
    for (let i = 1; i < order.length; i++) {
      for (const p of perms) if (can(order[i - 1]!, p)) expect(can(order[i]!, p)).toBe(true);
    }
    expect(ROLES).toEqual(["owner", "admin", "agent"]);
  });

  it("assertCan throws Forbidden for missing permissions", () => {
    expect(() => assertCan(actor("agent"), "documents:delete")).toThrow(ForbiddenError);
    expect(() => assertCan(actor("admin"), "documents:delete")).not.toThrow();
  });
});

describe("API keys", () => {
  const build = () => {
    let now = 100;
    return new ApiKeyService(() => now++);
  };

  it("issues keys whose secret is not stored and authenticates them", () => {
    const keys = build();
    const issued = keys.issue("t1", { kind: "secret", role: "admin", label: "ci" });
    expect(issued.key).toMatch(/^scs_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(issued.record)).not.toContain(issued.key.split("_").slice(2).join("_"));
    expect(JSON.stringify(keys.list("t1"))).not.toMatch(/secretHash/);
    expect(keys.authenticate(issued.key)).toMatchObject({ tenantId: "t1", role: "admin", kind: "secret" });
  });

  it("stores only a hash of the secret", () => {
    const keys = build();
    const issued = keys.issue("t1", { kind: "secret", role: "agent" });
    const secret = issued.key.split("_").slice(2).join("_");
    const stored = JSON.stringify(keys.collection.list("t1"));
    expect(stored).not.toContain(secret);
    expect(stored).toContain("secretHash");
  });

  it("rejects wrong secrets, malformed keys, unknown ids and revoked keys", () => {
    const keys = build();
    keys.issue("t1", { kind: "secret", role: "owner" });
    const agent = keys.issue("t1", { kind: "secret", role: "agent" });
    const [prefix, id] = agent.key.split("_");
    expect(keys.authenticate(`${prefix}_${id}_${"A".repeat(43)}`)).toBeNull();
    expect(keys.authenticate(`${prefix}_ffffffffffff_${"A".repeat(43)}`)).toBeNull();
    expect(keys.authenticate("not-a-key")).toBeNull();
    expect(keys.authenticate("")).toBeNull();
    expect(keys.authenticate(agent.key.replace(/^scs/, "scp"))).toBeNull();
    keys.revoke("t1", agent.record.id);
    expect(keys.authenticate(agent.key)).toBeNull();
  });

  it("public keys carry no role and are rejected where a secret key is expected", () => {
    const keys = build();
    const pub = keys.issue("t1", { kind: "public", label: "widget" });
    expect(pub.record.role).toBeNull();
    expect(keys.authenticatePublic(pub.key)).toMatchObject({ kind: "public" });
    expect(keys.authenticate(pub.key, "secret")).toBeNull();
    expect(() => keys.issue("t1", { kind: "public", role: "admin" })).toThrow(ValidationError);
    expect(() => keys.issue("t1", { kind: "secret" })).toThrow(ValidationError);
  });

  it("protects the last active owner key from demotion and revocation", () => {
    const keys = build();
    const owner = keys.issue("t1", { kind: "secret", role: "owner" });
    expect(() => keys.setRole("t1", owner.record.id, "admin")).toThrow(ConflictError);
    expect(() => keys.revoke("t1", owner.record.id)).toThrow(ConflictError);
    const second = keys.issue("t1", { kind: "secret", role: "owner" });
    expect(keys.setRole("t1", owner.record.id, "admin").after.role).toBe("admin");
    expect(() => keys.revoke("t1", second.record.id)).toThrow(ConflictError);
  });

  it("reports before and after on role changes", () => {
    const keys = build();
    keys.issue("t1", { kind: "secret", role: "owner" });
    const a = keys.issue("t1", { kind: "secret", role: "agent" });
    const change = keys.setRole("t1", a.record.id, "admin");
    expect(change.before.role).toBe("agent");
    expect(change.after.role).toBe("admin");
    expect(keys.authenticate(a.key)?.role).toBe("admin");
  });

  it("cannot reach another tenant's keys through list, get, require, setRole or revoke", () => {
    const keys = build();
    keys.issue("A", { kind: "secret", role: "owner" });
    const second = keys.issue("A", { kind: "secret", role: "agent" });
    keys.issue("B", { kind: "secret", role: "owner" });
    expect(keys.list("B").every((k) => k.tenantId === "B")).toBe(true);
    expect(() => keys.get("B", second.record.id)).toThrow(NotFoundError);
    expect(() => keys.require("B", second.record.id)).toThrow(NotFoundError);
    expect(() => keys.setRole("B", second.record.id, "admin")).toThrow(NotFoundError);
    expect(() => keys.revoke("B", second.record.id)).toThrow(NotFoundError);
    expect(keys.authenticate(second.key)).toMatchObject({ role: "agent", tenantId: "A" });
  });
});

describe("tenant registry and settings", () => {
  it("creates tenants with defaults and validates names", () => {
    const reg = new TenantRegistry(() => 5);
    const t = reg.create({ name: "  Acme  " });
    expect(t).toMatchObject({ name: "Acme", createdAt: 5, settings: { ...DEFAULT_SETTINGS, allowedOrigins: [] } });
    expect(() => reg.create({ name: "" })).toThrow(ValidationError);
    expect(() => reg.create({ name: "x".repeat(121) })).toThrow(ValidationError);
  });

  it("normalises and validates allowed origins", () => {
    expect(normalizeOrigin("https://Example.com")).toBe("https://example.com");
    expect(normalizeOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    for (const bad of ["*", "null", "https://example.com/", "https://example.com/path", "ftp://example.com", "https://user:pw@example.com", "example.com"]) {
      expect(() => normalizeOrigin(bad), bad).toThrow(ValidationError);
    }
  });

  it("validates settings patches and does not share state with callers", () => {
    const reg = new TenantRegistry();
    const t = reg.create({ name: "Acme" });
    const updated = reg.updateSettings(t.id, { allowedOrigins: ["https://a.example", "https://a.example"], answerThreshold: 0.5 });
    expect(updated.settings.allowedOrigins).toEqual(["https://a.example"]);
    expect(() => reg.updateSettings(t.id, { answerThreshold: 2 })).toThrow(ValidationError);
    expect(() => reg.updateSettings(t.id, { retrievalK: 0 })).toThrow(ValidationError);
    expect(() => reg.updateSettings(t.id, { piiRestore: "everything" as never })).toThrow(ValidationError);
    expect(() => reg.updateSettings("missing", {})).toThrow(NotFoundError);
    updated.settings.allowedOrigins.push("https://evil.example");
    expect(reg.require(t.id).settings.allowedOrigins).toEqual(["https://a.example"]);
  });

  it("gives each tenant its own settings object", () => {
    const reg = new TenantRegistry();
    const a = reg.create({ name: "A" });
    const b = reg.create({ name: "B" });
    reg.updateSettings(a.id, { retrievalK: 7 });
    expect(reg.require(b.id).settings.retrievalK).toBe(DEFAULT_SETTINGS.retrievalK);
  });
});
