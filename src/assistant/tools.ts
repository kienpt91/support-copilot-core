import { ValidationError } from "../errors.js";
import type { AuditLog } from "../audit/chain.js";
import type { HandoffService } from "./handoff.js";

export interface ToolContext {
  /** Fixed by the server from the authenticated key. Tools never accept a tenant id as an argument. */
  tenantId: string;
  conversationId: string;
  /** Audit label of whoever (or whatever) triggered the call. */
  actor: string;
}

export interface Tool<Args = unknown, Result = unknown> {
  readonly name: string;
  readonly description: string;
  /** Throws ValidationError for anything that is not exactly the expected shape. */
  parse(raw: unknown): Args;
  execute(ctx: ToolContext, args: Args): Promise<Result>;
}

export type ToolOutcome<R = unknown> = { ok: true; result: R } | { ok: false; error: string };

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(private readonly audit: AuditLog) {}

  register(tool: Tool): this {
    if (this.tools.has(tool.name)) throw new Error(`tool ${tool.name} is already registered`);
    this.tools.set(tool.name, tool);
    return this;
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Validates arguments, runs the tool, and writes an audit entry whether or not it succeeded. */
  async call(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    let outcome: ToolOutcome;
    if (!tool) {
      outcome = { ok: false, error: "unknown tool" };
    } else {
      try {
        outcome = { ok: true, result: await tool.execute(ctx, tool.parse(rawArgs)) };
      } catch (err) {
        outcome = { ok: false, error: err instanceof ValidationError ? err.message : "tool failed" };
      }
    }
    this.audit.append({
      tenantId: ctx.tenantId,
      actor: ctx.actor,
      action: "tool.call",
      target: name,
      details: {
        tool: name,
        ok: outcome.ok,
        conversationId: ctx.conversationId,
        argKeys: rawArgs !== null && typeof rawArgs === "object" ? Object.keys(rawArgs).slice(0, 10) : [],
        ...(outcome.ok ? { result: outcome.result } : { error: outcome.error }),
      },
    });
    return outcome;
  }
}

export interface CreateTicketArgs {
  subject: string;
  body: string;
  contact?: string;
}

function asRecord(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new ValidationError("arguments must be an object");
  return raw as Record<string, unknown>;
}

export function createTicketTool(handoff: HandoffService): Tool<CreateTicketArgs, { ticketId: string }> {
  return {
    name: "create_ticket",
    description: "Open a support ticket for a human to follow up on.",
    parse(raw) {
      const obj = asRecord(raw);
      const extra = Object.keys(obj).filter((k) => !["subject", "body", "contact"].includes(k));
      if (extra.length) throw new ValidationError(`unexpected argument: ${extra[0]}`);
      const { subject, body, contact } = obj;
      if (typeof subject !== "string" || subject.trim().length === 0 || subject.length > 120) throw new ValidationError("subject must be 1-120 characters");
      if (typeof body !== "string" || body.trim().length === 0 || body.length > 2000) throw new ValidationError("body must be 1-2000 characters");
      if (contact !== undefined && (typeof contact !== "string" || contact.length > 200)) throw new ValidationError("contact must be a string of at most 200 characters");
      return { subject: subject.trim(), body: body.trim(), ...(contact ? { contact } : {}) };
    },
    async execute(ctx, args) {
      const ticket = handoff.createTicket(ctx.tenantId, {
        conversationId: ctx.conversationId,
        subject: args.subject,
        body: args.body,
        contact: args.contact ?? null,
        createdBy: ctx.actor,
      });
      return { ticketId: ticket.id };
    },
  };
}
