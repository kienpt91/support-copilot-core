export type Intent = "question" | "create_ticket" | "human" | "greeting" | "thanks";

export interface RoutedIntent {
  intent: Intent;
  /** For create_ticket: the text left after the request phrase is removed ("about my invoice"). */
  detail?: string;
}

export interface IntentRouter {
  route(message: string): RoutedIntent;
}

const HUMAN_PATTERNS: readonly RegExp[] = [
  /\b(?:talk|speak|chat|connect|transfer|pass|hand)\b[^.?!]{0,25}\b(?:human|real person|live (?:agent|person|chat)|representative|operator|someone|somebody|a person|your team|support team|customer service)\b/i,
  /\b(?:i (?:want|need|would like)|can i|let me|get me|give me|put me)\b[^.?!]{0,30}\b(?:human|real person|live agent|representative)\b/i,
  /\bescalate\b/i,
];

const TICKET_PATTERN = /\b(?:open|create|file|raise|submit|log|make|start|need|want|send)\b[^.?!:]{0,25}?\b(?:ticket|support (?:request|case))\b/i;
const QUESTION_LEAD = /^\s*(?:how|what|where|why|when|which)\b/i;
const GREETING = /^\s*(?:hi|hello|hey|hiya|good (?:morning|afternoon|evening))(?:\s+(?:there|team|support))?\s*[!.,]*\s*$/i;
const THANKS = /^\s*(?:ok(?:ay)?,?\s+)?(?:thanks|thank you|thx|cheers)(?:\s+(?:a lot|so much|very much|again))?\s*[!.,]*\s*$/i;

/**
 * Keyword and pattern router. Deterministic, easy to audit and to unit test, and wrong in
 * predictable ways: it only recognises the phrasings it was written for. Anything it does not
 * recognise is a question for the knowledge base, which is the safe default.
 */
export class RuleBasedRouter implements IntentRouter {
  route(message: string): RoutedIntent {
    if (GREETING.test(message)) return { intent: "greeting" };
    if (THANKS.test(message)) return { intent: "thanks" };
    if (HUMAN_PATTERNS.some((p) => p.test(message))) return { intent: "human" };
    const ticket = TICKET_PATTERN.exec(message);
    if (ticket && !QUESTION_LEAD.test(message)) {
      const rest = message
        .replace(ticket[0], " ")
        .replace(/^[\s,.:;-]*(?:please|pls)?[\s,.:;-]*(?:(?:about|for|regarding|re|saying|that|to say)\b[\s:,-]*)?/i, "")
        .replace(/\s+/g, " ")
        .trim();
      return { intent: "create_ticket", detail: rest };
    }
    return { intent: "question" };
  }
}
