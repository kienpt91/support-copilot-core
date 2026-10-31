import type { ChatService, ConversationRecord, Turn } from "./assistant/chat.js";
import type { EscalationReason, HandoffService } from "./assistant/handoff.js";
import { type Actor, assertCan } from "./tenancy/roles.js";

export interface Window {
  /** Inclusive lower bound, epoch ms. */
  from?: number;
  /** Exclusive upper bound, epoch ms. */
  to?: number;
}

export interface AnalyticsSummary {
  window: { from: number | null; to: number | null };
  conversations: number;
  /** Conversations with at least one question, ticket request or human request (not just "hello"). */
  engagedConversations: number;
  /** Engaged conversations that got at least one answer and ended without a ticket or escalation. */
  deflectedConversations: number;
  /** deflected / engaged, or null when there are no engaged conversations. */
  deflectionRate: number | null;
  turns: number;
  questions: number;
  answered: number;
  answeredWithCaution: number;
  refused: number;
  /** Refusals plus cautioned answers: turns where retrieval confidence was low. */
  lowConfidenceAnswers: number;
  lowConfidenceRate: number | null;
  averageConfidence: number | null;
  ticketsCreated: number;
  escalations: { total: number; open: number; byReason: Record<EscalationReason, number> };
}

export interface DailyPoint {
  date: string;
  conversations: number;
  questions: number;
  answered: number;
  refused: number;
  escalations: number;
  tickets: number;
}

export interface UnansweredQuestion {
  question: string;
  count: number;
  lastAt: number;
}

function inWindow(at: number, w: Window): boolean {
  return (w.from === undefined || at >= w.from) && (w.to === undefined || at < w.to);
}

function turnsIn(conversations: readonly ConversationRecord[], w: Window): { conversation: ConversationRecord; turns: Turn[] }[] {
  return conversations
    .map((conversation) => ({ conversation, turns: conversation.turns.filter((t) => inWindow(t.at, w)) }))
    .filter((c) => c.turns.length > 0);
}

const ANSWERED: ReadonlySet<Turn["outcome"]> = new Set(["answered", "answered_with_caution"]);

/** Admin dashboard numbers, computed from stored conversation records and the escalation queue. JSON only; no UI. */
export class AnalyticsService {
  constructor(
    private readonly chat: ChatService,
    private readonly handoff: HandoffService,
  ) {}

  summary(actor: Actor, window: Window = {}): AnalyticsSummary {
    assertCan(actor, "analytics:read");
    const scoped = turnsIn(this.chat.conversations.list(actor.tenantId), window);
    const allTurns = scoped.flatMap((c) => c.turns);
    const questions = allTurns.filter((t) => t.intent === "question");
    const confidences = questions.map((t) => t.confidence).filter((c): c is number => c !== null);

    const engaged = scoped.filter((c) => c.turns.some((t) => t.intent !== "greeting" && t.intent !== "thanks"));
    const deflected = engaged.filter(
      (c) => c.turns.some((t) => ANSWERED.has(t.outcome)) && !c.turns.some((t) => t.escalationId !== null || t.ticketId !== null),
    );

    const escalations = this.handoff.escalations.list(actor.tenantId, (e) => inWindow(e.createdAt, window));
    const byReason: Record<EscalationReason, number> = { user_request: 0, low_confidence: 0 };
    for (const e of escalations) byReason[e.reason] += 1;

    const lowConfidence = allTurns.filter((t) => t.lowConfidence).length;
    return {
      window: { from: window.from ?? null, to: window.to ?? null },
      conversations: scoped.length,
      engagedConversations: engaged.length,
      deflectedConversations: deflected.length,
      deflectionRate: engaged.length ? deflected.length / engaged.length : null,
      turns: allTurns.length,
      questions: questions.length,
      answered: allTurns.filter((t) => t.outcome === "answered").length,
      answeredWithCaution: allTurns.filter((t) => t.outcome === "answered_with_caution").length,
      refused: allTurns.filter((t) => t.outcome === "refused").length,
      lowConfidenceAnswers: lowConfidence,
      lowConfidenceRate: questions.length ? lowConfidence / questions.length : null,
      averageConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
      ticketsCreated: allTurns.filter((t) => t.ticketId !== null).length,
      escalations: { total: escalations.length, open: escalations.filter((e) => e.status !== "resolved").length, byReason },
    };
  }

  /** Per-day (UTC) counts, oldest first. Days with no activity are omitted. */
  timeseries(actor: Actor, window: Window = {}): DailyPoint[] {
    assertCan(actor, "analytics:read");
    const days = new Map<string, { point: DailyPoint; conversations: Set<string> }>();
    const bucket = (at: number) => {
      const date = new Date(at).toISOString().slice(0, 10);
      let entry = days.get(date);
      if (!entry) {
        entry = { point: { date, conversations: 0, questions: 0, answered: 0, refused: 0, escalations: 0, tickets: 0 }, conversations: new Set() };
        days.set(date, entry);
      }
      return entry;
    };
    for (const { conversation, turns } of turnsIn(this.chat.conversations.list(actor.tenantId), window)) {
      for (const t of turns) {
        const entry = bucket(t.at);
        entry.conversations.add(conversation.id);
        if (t.intent === "question") entry.point.questions += 1;
        if (ANSWERED.has(t.outcome)) entry.point.answered += 1;
        if (t.outcome === "refused") entry.point.refused += 1;
        if (t.escalationId !== null) entry.point.escalations += 1;
        if (t.ticketId !== null) entry.point.tickets += 1;
      }
    }
    return [...days.values()]
      .map(({ point, conversations }) => ({ ...point, conversations: conversations.size }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Questions the assistant refused, most frequent first: a to-do list of missing documentation. */
  unanswered(actor: Actor, window: Window = {}, limit = 20): UnansweredQuestion[] {
    assertCan(actor, "analytics:read");
    const counts = new Map<string, UnansweredQuestion>();
    for (const { turns } of turnsIn(this.chat.conversations.list(actor.tenantId), window)) {
      for (const t of turns) {
        if (t.outcome !== "refused") continue;
        const key = t.userMessage.toLowerCase().replace(/\s+/g, " ").trim();
        const current = counts.get(key);
        if (current) {
          current.count += 1;
          current.lastAt = Math.max(current.lastAt, t.at);
        } else counts.set(key, { question: t.userMessage, count: 1, lastAt: t.at });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt).slice(0, limit);
  }
}
