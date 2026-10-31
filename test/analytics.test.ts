import { describe, expect, it } from "vitest";
import { ForbiddenError } from "../src/errors.js";
import { ingestCorpus, newCore, newTenant, widgetPrincipal } from "./helpers.js";

const DAY = 86_400_000;

async function scenario() {
  const env = newCore();
  const tenant = newTenant(env.core);
  await ingestCorpus(env.core, tenant);
  const day1 = env.clock.now;
  const say = (message: string, conversationId?: string) => env.core.chat.handle(widgetPrincipal(tenant), { message, conversationId });

  await say("How do I reset my password?"); // A: answered, deflected
  await say("What is the weather in Berlin today?"); // B: refused + escalation
  await say("hello"); // C: smalltalk only
  await say("I want to talk to a human"); // D: user escalation
  const e = await say("How do I cancel my subscription?"); // E: answered, then ticket
  await say("open a ticket", e.conversationId);
  await say("what is the weather in berlin today?"); // F: same refused question again (new conversation)

  env.clock.advance(DAY);
  const day2 = env.clock.now;
  await say("What is the API rate limit?"); // G: answered, deflected
  return { ...env, tenant, day1, day2 };
}

describe("analytics", () => {
  it("computes deflection, low-confidence and escalation figures from conversation records", async () => {
    const { core, tenant } = await scenario();
    const s = core.analytics.summary(tenant.admin);
    expect(s).toMatchObject({
      conversations: 7,
      engagedConversations: 6,
      deflectedConversations: 2,
      turns: 8,
      questions: 5,
      answered: 3,
      answeredWithCaution: 0,
      refused: 2,
      lowConfidenceAnswers: 2,
      ticketsCreated: 1,
      escalations: { total: 3, open: 3, byReason: { user_request: 1, low_confidence: 2 } },
    });
    expect(s.deflectionRate).toBeCloseTo(2 / 6, 10);
    expect(s.lowConfidenceRate).toBeCloseTo(2 / 5, 10);
    expect(s.averageConfidence).toBeGreaterThan(0);
    expect(s.averageConfidence).toBeLessThan(1);
  });

  it("counts a cautioned answer as low confidence but still as deflected", async () => {
    const env = newCore();
    const tenant = newTenant(env.core, "Cautious", { answerThreshold: 0.2, cautionMargin: 1 });
    await ingestCorpus(env.core, tenant);
    await env.core.chat.handle(widgetPrincipal(tenant), { message: "How do I reset my password?" });
    expect(env.core.analytics.summary(tenant.admin)).toMatchObject({
      answeredWithCaution: 1,
      answered: 0,
      lowConfidenceAnswers: 1,
      lowConfidenceRate: 1,
      deflectionRate: 1,
    });
  });

  it("restricts figures to a time window", async () => {
    const { core, tenant, day1, day2 } = await scenario();
    const first = core.analytics.summary(tenant.admin, { from: day1, to: day2 });
    expect(first).toMatchObject({ conversations: 6, turns: 7 });
    const second = core.analytics.summary(tenant.admin, { from: day2 });
    expect(second).toMatchObject({ conversations: 1, answered: 1, refused: 0, deflectionRate: 1, escalations: { total: 0 } });
    expect(core.analytics.summary(tenant.admin, { from: day2 + 10 * DAY }).deflectionRate).toBeNull();
  });

  it("buckets activity per UTC day", async () => {
    const { core, tenant } = await scenario();
    const series = core.analytics.timeseries(tenant.admin);
    expect(series).toHaveLength(2);
    expect(series[0]!.date < series[1]!.date).toBe(true);
    expect(series[0]).toMatchObject({ conversations: 6, questions: 4, answered: 2, refused: 2, escalations: 3, tickets: 1 });
    expect(series[1]).toMatchObject({ conversations: 1, questions: 1, answered: 1, refused: 0, escalations: 0, tickets: 0 });
  });

  it("lists the questions it could not answer, merging repeats", async () => {
    const { core, tenant } = await scenario();
    expect(core.analytics.unanswered(tenant.admin)).toEqual([{ question: "What is the weather in Berlin today?", count: 2, lastAt: expect.any(Number) }]);
    expect(core.analytics.unanswered(tenant.admin, {}, 0)).toEqual([]);
  });

  it("reports null rates when there is no data", () => {
    const env = newCore();
    const tenant = newTenant(env.core);
    expect(env.core.analytics.summary(tenant.admin)).toMatchObject({ conversations: 0, deflectionRate: null, lowConfidenceRate: null, averageConfidence: null });
    expect(env.core.analytics.timeseries(tenant.admin)).toEqual([]);
  });

  it("is limited to admins and owners", async () => {
    const { core, tenant } = await scenario();
    expect(() => core.analytics.summary(tenant.agent)).toThrow(ForbiddenError);
    expect(() => core.analytics.timeseries(tenant.agent)).toThrow(ForbiddenError);
    expect(() => core.analytics.unanswered(tenant.agent)).toThrow(ForbiddenError);
    expect(core.analytics.summary(tenant.owner).conversations).toBe(7);
  });

  it("never mixes tenants", async () => {
    const { core } = await scenario();
    const other = newTenant(core, "Other");
    expect(core.analytics.summary(other.admin)).toMatchObject({ conversations: 0, turns: 0, escalations: { total: 0 } });
    expect(core.analytics.timeseries(other.admin)).toEqual([]);
    expect(core.analytics.unanswered(other.admin)).toEqual([]);
  });
});
