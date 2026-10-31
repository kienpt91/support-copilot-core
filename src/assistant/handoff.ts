import { ConflictError, ValidationError } from "../errors.js";
import type { AuditLog } from "../audit/chain.js";
import { redactStatic } from "../privacy/pii.js";
import { type Actor, assertCan } from "../tenancy/roles.js";
import { ScopedCollection } from "../tenancy/scoped.js";
import { type Clock, type IdGen, randomId, systemClock } from "../util.js";

export interface TicketRecord {
  id: string;
  tenantId: string;
  conversationId: string | null;
  subject: string;
  /** Stored with PII replaced by static tags. The contact detail the customer gave is kept separately in `contact`. */
  body: string;
  /** The email address or phone number the customer gave, kept so a human can reply. */
  contact: string | null;
  status: "open" | "closed";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export type EscalationReason = "user_request" | "low_confidence";
export type EscalationStatus = "open" | "claimed" | "resolved";

export interface EscalationRecord {
  id: string;
  tenantId: string;
  conversationId: string;
  reason: EscalationReason;
  status: EscalationStatus;
  /** Redacted description of what the customer needs. */
  summary: string;
  createdAt: number;
  updatedAt: number;
  claimedBy: string | null;
  resolvedBy: string | null;
  note: string | null;
}

/** Open items per tenant. Anonymous widget traffic can create these, so they are capped; closing or resolving frees room. */
export const MAX_OPEN_TICKETS_PER_TENANT = 1000;
export const MAX_OPEN_ESCALATIONS_PER_TENANT = 1000;

/** Tickets and the human escalation queue, both tenant-scoped. */
export class HandoffService {
  readonly tickets = new ScopedCollection<TicketRecord>("Ticket");
  readonly escalations = new ScopedCollection<EscalationRecord>("Escalation");

  constructor(
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
    private readonly newId: IdGen = randomId,
  ) {}

  /** True when the tenant already has the maximum number of open tickets. */
  ticketQueueFull(tenantId: string): boolean {
    return this.tickets.countWhere(tenantId, (t) => t.status === "open") >= MAX_OPEN_TICKETS_PER_TENANT;
  }

  /** True when an escalation can be opened (or already is open) for this conversation. */
  canEscalate(tenantId: string, conversationId: string): boolean {
    if (this.escalations.findBy(tenantId, (e) => e.conversationId === conversationId && e.status !== "resolved")) return true;
    return this.escalations.countWhere(tenantId, (e) => e.status !== "resolved") < MAX_OPEN_ESCALATIONS_PER_TENANT;
  }

  /** Called by the create_ticket tool; permission is enforced on the tool, not here. */
  createTicket(tenantId: string, input: { conversationId: string | null; subject: string; body: string; contact: string | null; createdBy: string }): TicketRecord {
    if (this.ticketQueueFull(tenantId)) throw new ConflictError("The ticket queue is full.");
    const now = this.clock();
    return this.tickets.put(tenantId, {
      id: this.newId("tkt"),
      tenantId,
      conversationId: input.conversationId,
      subject: redactStatic(input.subject),
      body: redactStatic(input.body),
      contact: input.contact,
      status: "open",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  listTickets(actor: Actor, status?: TicketRecord["status"]): TicketRecord[] {
    assertCan(actor, "tickets:read");
    return this.tickets.list(actor.tenantId, (t) => !status || t.status === status).sort((a, b) => b.createdAt - a.createdAt);
  }

  getTicket(actor: Actor, id: string): TicketRecord {
    assertCan(actor, "tickets:read");
    return this.tickets.require(actor.tenantId, id);
  }

  closeTicket(actor: Actor, id: string): TicketRecord {
    assertCan(actor, "tickets:write");
    this.tickets.require(actor.tenantId, id);
    return this.tickets.update(actor.tenantId, id, { status: "closed", updatedAt: this.clock() });
  }

  /** Opens an escalation, or returns the one already open for this conversation. */
  escalate(
    tenantId: string,
    actorLabel: string,
    input: { conversationId: string; reason: EscalationReason; summary: string },
  ): { escalation: EscalationRecord; created: boolean } {
    const existing = this.escalations.findBy(tenantId, (e) => e.conversationId === input.conversationId && e.status !== "resolved");
    if (existing) return { escalation: existing, created: false };
    if (!this.canEscalate(tenantId, input.conversationId)) throw new ConflictError("The escalation queue is full.");
    const now = this.clock();
    const escalation = this.escalations.put(tenantId, {
      id: this.newId("esc"),
      tenantId,
      conversationId: input.conversationId,
      reason: input.reason,
      status: "open",
      summary: redactStatic(input.summary).slice(0, 500),
      createdAt: now,
      updatedAt: now,
      claimedBy: null,
      resolvedBy: null,
      note: null,
    });
    this.audit.append({
      tenantId,
      actor: actorLabel,
      action: "escalation.create",
      target: escalation.id,
      details: { reason: input.reason, conversationId: input.conversationId },
    });
    return { escalation, created: true };
  }

  listEscalations(actor: Actor, status?: EscalationStatus): EscalationRecord[] {
    assertCan(actor, "escalations:read");
    return this.escalations.list(actor.tenantId, (e) => !status || e.status === status).sort((a, b) => b.createdAt - a.createdAt);
  }

  getEscalation(actor: Actor, id: string): EscalationRecord {
    assertCan(actor, "escalations:read");
    return this.escalations.require(actor.tenantId, id);
  }

  claim(actor: Actor, id: string): EscalationRecord {
    assertCan(actor, "escalations:handle");
    const current = this.escalations.require(actor.tenantId, id);
    if (current.status !== "open") throw new ConflictError(`Escalation is already ${current.status}.`);
    const next = this.escalations.update(actor.tenantId, id, { status: "claimed", claimedBy: actor.keyId, updatedAt: this.clock() });
    this.audit.append({ tenantId: actor.tenantId, actor: actor.keyId, action: "escalation.update", target: id, details: { from: current.status, to: "claimed" } });
    return next;
  }

  resolve(actor: Actor, id: string, note?: string): EscalationRecord {
    assertCan(actor, "escalations:handle");
    const current = this.escalations.require(actor.tenantId, id);
    if (current.status === "resolved") throw new ConflictError("Escalation is already resolved.");
    if (current.status === "claimed" && current.claimedBy !== actor.keyId && actor.role === "agent") {
      throw new ConflictError("Escalation is claimed by someone else.");
    }
    if (note !== undefined && (typeof note !== "string" || note.length > 1000)) throw new ValidationError("note must be a string of at most 1000 characters.");
    const next = this.escalations.update(actor.tenantId, id, {
      status: "resolved",
      resolvedBy: actor.keyId,
      note: note ? redactStatic(note) : null,
      updatedAt: this.clock(),
    });
    this.audit.append({ tenantId: actor.tenantId, actor: actor.keyId, action: "escalation.update", target: id, details: { from: current.status, to: "resolved" } });
    return next;
  }
}
