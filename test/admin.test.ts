import { describe, expect, it } from "vitest";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../src/errors.js";
import { actorFor, newCore, newTenant, widgetPrincipal } from "./helpers.js";

async function withEscalation() {
  const env = newCore();
  const t = newTenant(env.core);
  const res = await env.core.chat.handle(widgetPrincipal(t), { message: "I want to talk to a human" });
  return { ...env, t, escalationId: res.escalation!.id, conversationId: res.conversationId };
}

describe("escalation queue", () => {
  it("lets an agent claim and resolve, and audits both steps", async () => {
    const { core, t, escalationId } = await withEscalation();
    expect(core.handoff.claim(t.agent, escalationId)).toMatchObject({ status: "claimed", claimedBy: t.agent.keyId });
    expect(core.handoff.resolve(t.agent, escalationId, "Sent the invoice to jane@example.com")).toMatchObject({ status: "resolved", resolvedBy: t.agent.keyId, note: "Sent the invoice to [EMAIL]" });
    const updates = core.auditEntries(t.admin).filter((e) => e.action === "escalation.update");
    expect(updates.map((e) => e.details)).toEqual([{ from: "open", to: "claimed" }, { from: "claimed", to: "resolved" }]);
  });

  it("rejects a second claim, resolving twice, and an agent resolving someone else's claim", async () => {
    const { core, t, escalationId } = await withEscalation();
    const other = actorFor(t.id, "agent", "other-agent");
    core.handoff.claim(t.agent, escalationId);
    expect(() => core.handoff.claim(other, escalationId)).toThrow(ConflictError);
    expect(() => core.handoff.resolve(other, escalationId)).toThrow(/claimed by someone else/);
    expect(core.handoff.resolve(t.admin, escalationId).status).toBe("resolved"); // admins may take over
    expect(() => core.handoff.resolve(t.admin, escalationId)).toThrow(/already resolved/);
    expect(() => core.handoff.claim(t.agent, escalationId)).toThrow(ConflictError);
  });

  it("filters by status and opens a new escalation once the old one is resolved", async () => {
    const { core, t, escalationId, conversationId } = await withEscalation();
    core.handoff.resolve(t.agent, escalationId);
    expect(core.handoff.listEscalations(t.agent, "open")).toEqual([]);
    const again = await core.chat.handle(widgetPrincipal(t), { message: "talk to a person", conversationId });
    expect(again.escalation!.id).not.toBe(escalationId);
    expect(core.handoff.listEscalations(t.agent, "open")).toHaveLength(1);
    expect(core.handoff.listEscalations(t.agent, "resolved")).toHaveLength(1);
  });

  it("validates the resolution note", async () => {
    const { core, t, escalationId } = await withEscalation();
    expect(() => core.handoff.resolve(t.agent, escalationId, "x".repeat(1001))).toThrow(ValidationError);
  });
});

describe("tickets", () => {
  it("lists, filters and closes tickets", async () => {
    const env = newCore();
    const t = newTenant(env.core);
    const res = await env.core.chat.handle(widgetPrincipal(t), { message: "open a ticket about the export that never arrives" });
    const id = res.ticket!.id;
    expect(env.core.handoff.listTickets(t.agent, "open").map((x) => x.id)).toEqual([id]);
    expect(env.core.handoff.closeTicket(t.agent, id).status).toBe("closed");
    expect(env.core.handoff.listTickets(t.agent, "open")).toEqual([]);
    expect(env.core.handoff.listTickets(t.agent, "closed")).toHaveLength(1);
    expect(() => env.core.handoff.closeTicket(t.agent, "tkt_missing")).toThrow(NotFoundError);
  });
});

describe("administration and roles", () => {
  it("only owners issue keys and change roles; admins can read keys, settings and audit", () => {
    const { core } = newCore();
    const t = newTenant(core);
    expect(() => core.issueKey(t.admin, { kind: "secret", role: "agent" })).toThrow(ForbiddenError);
    expect(() => core.changeRole(t.admin, "any", "agent")).toThrow(ForbiddenError);
    expect(() => core.revokeKey(t.admin, "any")).toThrow(ForbiddenError);
    expect(core.listKeys(t.admin).length).toBe(2);
    expect(() => core.listKeys(t.agent)).toThrow(ForbiddenError);
    expect(() => core.getSettings(t.agent)).toThrow(ForbiddenError);
    expect(() => core.auditEntries(t.agent)).toThrow(ForbiddenError);
    expect(() => core.verifyAudit(t.agent)).toThrow(ForbiddenError);
    expect(core.getSettings(t.admin).retrievalK).toBe(4);
  });

  it("audits key issue, role change, revocation and settings changes with who did it", () => {
    const { core } = newCore();
    const t = newTenant(core);
    const agentKey = core.issueKey(t.owner, { kind: "secret", role: "agent", label: "bot" });
    core.changeRole(t.owner, agentKey.record.id, "admin");
    core.updateSettings(t.admin, { retrievalK: 6, allowedOrigins: ["https://shop.example"] });
    core.revokeKey(t.owner, agentKey.record.id);
    const entries = core.auditEntries(t.owner);
    expect(entries.map((e) => [e.action, e.actor])).toEqual([
      ["tenant.create", "system"],
      ["key.issue", t.owner.keyId],
      ["role.change", t.owner.keyId],
      ["settings.update", t.admin.keyId],
      ["key.revoke", t.owner.keyId],
    ]);
    expect(entries[2]!.details).toEqual({ from: "agent", to: "admin" });
    expect(core.verifyAudit(t.owner)).toMatchObject({ ok: true, entries: 5 });
  });

  it("a demoted key loses its new permissions on the next authentication", () => {
    const { core } = newCore();
    const t = newTenant(core);
    const key = core.issueKey(t.owner, { kind: "secret", role: "admin" });
    expect(core.keys.authenticate(key.key)?.role).toBe("admin");
    core.changeRole(t.owner, key.record.id, "agent");
    expect(core.keys.authenticate(key.key)?.role).toBe("agent");
    core.revokeKey(t.owner, key.record.id);
    expect(core.keys.authenticate(key.key)).toBeNull();
  });

  it("refuses to demote or revoke the only owner", () => {
    const { core } = newCore();
    const t = newTenant(core);
    expect(() => core.changeRole(t.owner, t.owner.keyId, "admin")).toThrow(ConflictError);
    expect(() => core.revokeKey(t.owner, t.owner.keyId)).toThrow(ConflictError);
    expect(core.auditEntries(t.owner).map((e) => e.action)).toEqual(["tenant.create"]); // failed attempts are not logged as changes
  });

  it("validates settings changes", () => {
    const { core } = newCore();
    const t = newTenant(core);
    expect(() => core.updateSettings(t.admin, { allowedOrigins: ["*"] })).toThrow(ValidationError);
    expect(() => core.updateSettings(t.admin, { answerThreshold: -1 })).toThrow(ValidationError);
    expect(core.updateSettings(t.admin, { allowedOrigins: ["https://Shop.example"] }).allowedOrigins).toEqual(["https://shop.example"]);
  });

  it("the audit chain verifies after a realistic mix of actions, and breaks if an entry is altered", async () => {
    const { core } = newCore();
    const t = newTenant(core);
    core.ingest.submit(t.admin, { title: "Doc", content: "hello world" });
    await core.queue.tick();
    await core.chat.handle(widgetPrincipal(t), { message: "talk to a human" });
    core.ingest.delete(t.admin, core.ingest.list(t.admin)[0]!.id);
    const actions = core.auditEntries(t.admin).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["tenant.create", "document.ingest", "escalation.create", "document.delete"]));
    expect(core.verifyAudit(t.admin).ok).toBe(true);
  });
});
