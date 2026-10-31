import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { findPii, redactStatic } from "../privacy/pii.js";
import { PiiVault } from "../privacy/vault.js";
import type { HybridRetriever } from "../retrieval/retriever.js";
import type { TenantRegistry } from "../tenancy/registry.js";
import type { Actor } from "../tenancy/roles.js";
import { assertCan } from "../tenancy/roles.js";
import { ScopedCollection } from "../tenancy/scoped.js";
import { type Clock, type IdGen, randomId, systemClock } from "../util.js";
import { type Citation, type EvidenceChunk, composeAnswer } from "./compose.js";
import { retrievalConfidence } from "./confidence.js";
import type { Generator } from "./generator.js";
import type { EscalationReason, HandoffService } from "./handoff.js";
import { type Intent, type IntentRouter } from "./router.js";
import type { ToolRegistry } from "./tools.js";

export type Outcome = "answered" | "answered_with_caution" | "refused" | "escalated" | "ticket_created" | "needs_detail" | "smalltalk";

export interface Turn {
  at: number;
  intent: Intent;
  outcome: Outcome;
  /** The customer's message with PII replaced by static tags. The original text is not kept. */
  userMessage: string;
  /** The reply as stored: any redaction placeholder is replaced by its static tag. */
  answer: string;
  /** Retrieval confidence for question turns, else null. */
  confidence: number | null;
  /** True for refusals and cautioned answers. */
  lowConfidence: boolean;
  citations: { n: number; documentId: string; chunkId: string }[];
  escalationId: string | null;
  ticketId: string | null;
  /** True when the configured generator failed and the extractive fallback answered. */
  generatorFallback: boolean;
}

export interface ConversationRecord {
  id: string;
  tenantId: string;
  channel: "widget" | "api";
  createdAt: number;
  updatedAt: number;
  /** Set after "open a ticket" with no description: the next message becomes the ticket. */
  pendingTicket: boolean;
  turns: Turn[];
}

export type ConversationSummary = Omit<ConversationRecord, "turns"> & { turnCount: number };

export interface ChatPrincipal {
  tenantId: string;
  keyId: string;
  /** `widget` for public keys, `api` for secret keys. */
  kind: "widget" | "api";
}

export interface ChatResult {
  conversationId: string;
  intent: Intent;
  outcome: Outcome;
  answer: string;
  confidence: number | null;
  citations: Citation[];
  escalation: { id: string; reason: EscalationReason } | null;
  ticket: { id: string } | null;
}

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_TURNS_PER_CONVERSATION = 50;

const REFUSAL = "I couldn't find a reliable answer to that in the documentation, so I won't guess.";
const CAUTION = "I'm not fully certain this answers your question. Based on the documentation: ";

export interface ChatDeps {
  tenants: TenantRegistry;
  retriever: HybridRetriever;
  generator: Generator;
  /** Used when `generator` throws. Must not call out to anything. */
  fallbackGenerator: Generator;
  router: IntentRouter;
  tools: ToolRegistry;
  handoff: HandoffService;
  clock?: Clock;
  newId?: IdGen;
}

export class ChatService {
  readonly conversations = new ScopedCollection<ConversationRecord>("Conversation");
  private readonly clock: Clock;
  private readonly newId: IdGen;

  constructor(private readonly deps: ChatDeps) {
    this.clock = deps.clock ?? systemClock;
    this.newId = deps.newId ?? randomId;
  }

  listConversations(actor: Actor): ConversationSummary[] {
    assertCan(actor, "conversations:read");
    return this.conversations
      .list(actor.tenantId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ turns, ...rest }) => ({ ...rest, turnCount: turns.length }));
  }

  getConversation(actor: Actor, id: string): ConversationRecord {
    assertCan(actor, "conversations:read");
    return this.conversations.require(actor.tenantId, id);
  }

  async handle(principal: ChatPrincipal, req: { message: unknown; conversationId?: unknown }): Promise<ChatResult> {
    const message = req.message;
    if (typeof message !== "string" || message.trim().length === 0) throw new ValidationError("message must be a non-empty string.");
    if (message.length > MAX_MESSAGE_CHARS) throw new ValidationError(`message must be at most ${MAX_MESSAGE_CHARS} characters.`);
    const { tenantId } = principal;
    const tenant = this.deps.tenants.require(tenantId);
    const settings = tenant.settings;
    const actorLabel = principal.kind === "widget" ? `widget:${principal.keyId}` : principal.keyId;

    let conversation: ConversationRecord;
    if (req.conversationId !== undefined) {
      if (typeof req.conversationId !== "string") throw new ValidationError("conversationId must be a string.");
      const found = this.conversations.get(tenantId, req.conversationId);
      if (!found || (principal.kind === "widget" && found.channel !== "widget")) throw new NotFoundError("Conversation");
      if (found.turns.length >= MAX_TURNS_PER_CONVERSATION) throw new ConflictError("This conversation is too long; please start a new one.");
      conversation = found;
    } else {
      const now = this.clock();
      conversation = this.conversations.put(tenantId, {
        id: this.newId("conv"),
        tenantId,
        channel: principal.kind === "widget" ? "widget" : "api",
        createdAt: now,
        updatedAt: now,
        pendingTicket: false,
        turns: [],
      });
    }

    const vault = new PiiVault();
    const redactedMessage = vault.redact(message, "user");
    const routed = this.deps.router.route(redactedMessage);
    const stored = redactStatic(message).slice(0, 500);
    const turn: Turn = {
      at: this.clock(),
      intent: routed.intent,
      outcome: "smalltalk",
      userMessage: stored,
      answer: "",
      confidence: null,
      lowConfidence: false,
      citations: [],
      escalationId: null,
      ticketId: null,
      generatorFallback: false,
    };
    let answer = "";
    let citations: Citation[] = [];
    let escalation: ChatResult["escalation"] = null;
    let ticket: ChatResult["ticket"] = null;
    const lastQuestion = [...conversation.turns].reverse().find((t) => t.intent === "question");

    const escalate = (reason: EscalationReason, summary: string) => {
      const { escalation: record } = this.deps.handoff.escalate(tenantId, actorLabel, { conversationId: conversation.id, reason, summary });
      escalation = { id: record.id, reason: record.reason };
      turn.escalationId = record.id;
    };

    // A bare "open a ticket" asks for details; the next message then becomes the ticket text.
    let intent: Intent = routed.intent;
    // The router saw placeholders; the ticket text is rebuilt from the vault and redacted again by the ticket store.
    let ticketDetail = vault.restore(routed.detail ?? "", "all");
    if (conversation.pendingTicket && intent !== "human" && intent !== "create_ticket") {
      intent = "create_ticket";
      ticketDetail = message;
    }
    turn.intent = intent;
    conversation.pendingTicket = false;

    if (intent === "greeting") {
      answer = "Hello! Ask me a question about the product and I'll look it up in the documentation.";
    } else if (intent === "thanks") {
      answer = "You're welcome.";
    } else if (intent === "human") {
      turn.outcome = "escalated";
      escalate("user_request", `Customer asked for a person. Message: ${stored}${lastQuestion ? ` Earlier question: ${lastQuestion.userMessage}` : ""}`);
      answer = "I've passed this conversation to our support team. A person will pick it up from here.";
    } else if (intent === "create_ticket") {
      const detail = ticketDetail.trim().length >= 8 ? ticketDetail.trim() : lastQuestion ? "" : null;
      if (detail === null) {
        turn.outcome = "needs_detail";
        conversation.pendingTicket = true;
        answer = "Sure. What should the ticket say? Describe the problem in a sentence or two.";
      } else {
        const body = detail === "" ? (lastQuestion?.userMessage ?? "") : detail;
        const contact = findPii(message).find((m) => m.kind === "EMAIL" || m.kind === "PHONE")?.value;
        const outcome = await this.deps.tools.call({ tenantId, conversationId: conversation.id, actor: actorLabel }, "create_ticket", {
          subject: redactStatic(body).split("\n")[0]!.slice(0, 80),
          body,
          ...(contact ? { contact } : {}),
        });
        if (outcome.ok) {
          const ticketId = (outcome.result as { ticketId: string }).ticketId;
          ticket = { id: ticketId };
          turn.ticketId = ticketId;
          turn.outcome = "ticket_created";
          answer = `I've opened ticket ${ticketId}. Someone from the team will follow up.`;
        } else {
          turn.outcome = "escalated";
          escalate("user_request", `Ticket creation failed; customer message: ${stored}`);
          answer = "I couldn't open a ticket just now, so I've passed this to our support team instead.";
        }
      }
    } else {
      const result = await this.answerQuestion(tenantId, message, redactedMessage, vault, settings);
      turn.confidence = result.confidence;
      turn.generatorFallback = result.fallback;
      if (result.kind === "answer") {
        const caution = result.confidence < settings.answerThreshold + settings.cautionMargin;
        turn.outcome = caution ? "answered_with_caution" : "answered";
        turn.lowConfidence = caution;
        answer = (caution ? CAUTION : "") + result.text;
        citations = result.citations;
      } else {
        turn.outcome = "refused";
        turn.lowConfidence = true;
        answer = REFUSAL;
        if (settings.escalateOnLowConfidence) {
          escalate("low_confidence", `Customer question: ${stored}`);
          answer += " I've asked our support team to follow up.";
        }
      }
    }

    // Placeholders become real values only if the tenant policy allows it; the rest become static tags.
    const finalAnswer = vault.restore(answer, settings.piiRestore);
    const finalCitations = citations.map((c) => ({ ...c, title: vault.restore(c.title, settings.piiRestore), snippet: vault.restore(c.snippet, settings.piiRestore) }));
    turn.answer = vault.restore(answer, "none");
    turn.citations = citations.map((c) => ({ n: c.n, documentId: c.documentId, chunkId: c.chunkId }));
    conversation.turns.push(turn);
    this.conversations.put(tenantId, { ...conversation, updatedAt: this.clock() });

    return {
      conversationId: conversation.id,
      intent: turn.intent,
      outcome: turn.outcome,
      answer: finalAnswer,
      confidence: turn.confidence,
      citations: finalCitations,
      escalation,
      ticket,
    };
  }

  private async answerQuestion(
    tenantId: string,
    message: string,
    redactedMessage: string,
    vault: PiiVault,
    settings: { retrievalK: number; answerThreshold: number },
  ): Promise<
    | { kind: "answer"; text: string; citations: Citation[]; confidence: number; fallback: boolean }
    | { kind: "refused"; confidence: number; fallback: boolean }
  > {
    const hits = await this.deps.retriever.search(tenantId, redactStatic(message), { mode: "hybrid", k: settings.retrievalK });
    const top = hits[0];
    const confidence = top ? retrievalConfidence({ coverage: top.coverage, cosine: top.cosine }) : 0;
    if (!top || confidence < settings.answerThreshold) return { kind: "refused", confidence, fallback: false };

    const evidence: EvidenceChunk[] = hits.map((h, i) => ({
      n: i + 1,
      title: vault.redact(h.chunk.heading, "evidence"),
      text: vault.redact(h.chunk.text, "evidence"),
      chunkId: h.chunk.id,
      documentId: h.chunk.documentId,
    }));
    let fallback = false;
    let composed;
    try {
      composed = await composeAnswer(this.deps.generator, redactedMessage, evidence);
    } catch {
      fallback = true;
      composed = await composeAnswer(this.deps.fallbackGenerator, redactedMessage, evidence);
    }
    if (composed.kind === "ungrounded") return { kind: "refused", confidence, fallback };
    return { kind: "answer", text: composed.text, citations: composed.citations, confidence, fallback };
  }
}
