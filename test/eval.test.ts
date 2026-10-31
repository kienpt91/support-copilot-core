import { beforeAll, describe, expect, it } from "vitest";
import { ANSWER_THRESHOLD } from "../src/assistant/calibration.js";
import { calibrateThreshold, evaluateThreshold, retrievalConfidence } from "../src/assistant/confidence.js";
import { CORPUS } from "../src/eval/corpus.js";
import { type EvalReport, runEval } from "../src/eval/evaluate.js";
import { QUESTIONS } from "../src/eval/questions.js";

describe("fixtures", () => {
  it("only reference documents that exist, with unique ids", () => {
    const ids = CORPUS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of QUESTIONS) for (const r of q.relevant) expect(ids, q.question).toContain(r);
  });

  it("has answerable and unanswerable questions in every kind", () => {
    const count = (kind: string) => QUESTIONS.filter((q) => q.kind === kind).length;
    expect([count("keyword"), count("paraphrase"), count("typo"), count("off-topic"), count("near-miss")]).toEqual([23, 20, 8, 6, 6]);
    expect(QUESTIONS.filter((q) => q.relevant.length === 0).every((q) => q.kind === "off-topic" || q.kind === "near-miss")).toBe(true);
  });
});

describe("retrieval evaluation (fixture corpus, hashing embedder)", () => {
  let report: EvalReport;
  beforeAll(async () => {
    report = await runEval();
  });

  it("ingests every fixture document through the real pipeline", () => {
    expect(report.corpusDocuments).toBe(CORPUS.length);
    expect(report.corpusChunks).toBeGreaterThanOrEqual(CORPUS.length);
    expect(report.answerableQuestions).toBe(51);
    expect(report.unanswerableQuestions).toBe(12);
  });

  // These numbers are quoted in the README. If retrieval changes, update both.
  it("reproduces the numbers published in the README", () => {
    const r = (m: "bm25" | "vector" | "hybrid") => report.overall[m];
    expect(r("bm25").mrr).toBeCloseTo(0.676, 3);
    expect(r("vector").mrr).toBeCloseTo(0.636, 3);
    expect(r("hybrid").mrr).toBeCloseTo(0.728, 3);
    expect([r("bm25").hitAt1, r("vector").hitAt1, r("hybrid").hitAt1].map((x) => Number((x * 100).toFixed(1)))).toEqual([60.8, 54.9, 66.7]);
    expect([r("bm25").hitAt3, r("vector").hitAt3, r("hybrid").hitAt3].map((x) => Number((x * 100).toFixed(1)))).toEqual([76.5, 66.7, 76.5]);
    expect([r("bm25").hitAt5, r("vector").hitAt5, r("hybrid").hitAt5].map((x) => Number((x * 100).toFixed(1)))).toEqual([76.5, 74.5, 80.4]);
  });

  it("does not claim hybrid wins everywhere: some questions rank worse than the better single ranker, mostly paraphrases", () => {
    expect(report.hybridLosses).toHaveLength(6);
    expect(report.hybridLosses.filter((p) => p.kind === "paraphrase").length).toBeGreaterThanOrEqual(5);
    expect(report.byKind.paraphrase!.hybrid.hitAt3).toBeLessThan(0.5);
    expect(report.byKind.keyword!.bm25.hitAt3).toBe(1);
  });

  it("is deterministic", async () => {
    const again = await runEval();
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it("calibrated threshold separates answerable from unanswerable questions, and the shipped default matches it", () => {
    const c = report.confidence;
    expect(c.answerableMean).toBeGreaterThan(c.unanswerableMean + 0.15);
    expect(Math.abs(c.calibrated.threshold - ANSWER_THRESHOLD)).toBeLessThan(0.02);
    expect(c.shipped.refusedRate).toBeGreaterThanOrEqual(0.9);
    expect(c.shipped.answeredRate).toBeGreaterThanOrEqual(0.6);
    expect(c.shipped.balancedAccuracy).toBeGreaterThanOrEqual(0.8);
  });

  it("holds up when calibrated on half the questions and tested on the other half", () => {
    const { heldOut } = report.confidence;
    expect(heldOut.testedOnOdd.balancedAccuracy).toBeGreaterThanOrEqual(0.7);
    expect(heldOut.testedOnEven.balancedAccuracy).toBeGreaterThanOrEqual(0.7);
  });
});

describe("confidence", () => {
  it("combines lexical coverage and cosine, clamped to 0..1", () => {
    expect(retrievalConfidence({ coverage: 1, cosine: 0.5 })).toBe(1);
    expect(retrievalConfidence({ coverage: 0, cosine: 0 })).toBe(0);
    expect(retrievalConfidence({ coverage: 1, cosine: 5 })).toBe(1);
    expect(retrievalConfidence({ coverage: -1, cosine: -1 })).toBe(0);
    expect(retrievalConfidence({ coverage: 0.4, cosine: 0.25 })).toBeCloseTo(0.45, 10);
    expect(retrievalConfidence({ coverage: 0.6, cosine: null })).toBe(0.6);
  });

  it("increases with either signal", () => {
    const base = retrievalConfidence({ coverage: 0.3, cosine: 0.2 });
    expect(retrievalConfidence({ coverage: 0.5, cosine: 0.2 })).toBeGreaterThan(base);
    expect(retrievalConfidence({ coverage: 0.3, cosine: 0.3 })).toBeGreaterThan(base);
  });

  it("calibrates a threshold between perfectly separated groups", () => {
    const scores = [0.1, 0.2, 0.3].map((confidence) => ({ confidence, answerable: false })).concat([0.6, 0.7, 0.8].map((confidence) => ({ confidence, answerable: true })));
    const best = calibrateThreshold(scores);
    expect(best.threshold).toBeGreaterThan(0.3);
    expect(best.threshold).toBeLessThanOrEqual(0.6);
    expect(best).toMatchObject({ answeredRate: 1, refusedRate: 1, balancedAccuracy: 1 });
  });

  it("picks the more cautious threshold on ties and copes with overlap", () => {
    const scores = [
      { confidence: 0.2, answerable: false },
      { confidence: 0.5, answerable: true },
      { confidence: 0.5, answerable: false },
      { confidence: 0.9, answerable: true },
    ];
    const best = calibrateThreshold(scores);
    expect(best.balancedAccuracy).toBeGreaterThan(0.7);
    expect(evaluateThreshold(scores, 0.95)).toMatchObject({ answeredRate: 0, refusedRate: 1 });
    expect(evaluateThreshold(scores, 0)).toMatchObject({ answeredRate: 1, refusedRate: 0 });
  });

  it("handles empty input", () => {
    expect(evaluateThreshold([], 0.5).balancedAccuracy).toBe(0);
    expect(calibrateThreshold([]).threshold).toBe(0.5);
  });
});
