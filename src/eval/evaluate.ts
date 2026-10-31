import { ANSWER_THRESHOLD } from "../assistant/calibration.js";
import { type LabelledScore, calibrateThreshold, evaluateThreshold, retrievalConfidence, type ThresholdReport } from "../assistant/confidence.js";
import { Core, type CoreOptions } from "../core.js";
import type { SearchMode } from "../retrieval/retriever.js";
import { CORPUS, type CorpusDoc } from "./corpus.js";
import { type LabelledQuestion, QUESTIONS, type QuestionKind } from "./questions.js";

export const MODES: readonly SearchMode[] = ["bm25", "vector", "hybrid"];
const ANSWERABLE_KINDS: readonly QuestionKind[] = ["keyword", "paraphrase", "typo"];
const CHUNKS_PER_QUERY = 10;

export interface RankingMetrics {
  questions: number;
  hitAt1: number;
  hitAt3: number;
  hitAt5: number;
  mrr: number;
}

export interface PerQuestionRank {
  question: string;
  kind: QuestionKind;
  /** 1-based rank of the first relevant document per mode; null when it is not in the top results. */
  rank: Record<SearchMode, number | null>;
}

export interface EvalReport {
  corpusDocuments: number;
  corpusChunks: number;
  answerableQuestions: number;
  unanswerableQuestions: number;
  overall: Record<SearchMode, RankingMetrics>;
  byKind: Record<string, Record<SearchMode, RankingMetrics>>;
  perQuestion: PerQuestionRank[];
  /** Questions where hybrid ranked the right document lower than the better of the two single rankers. */
  hybridLosses: PerQuestionRank[];
  confidence: {
    answerableMean: number;
    unanswerableMean: number;
    /** Threshold calibrated on every question. */
    calibrated: ThresholdReport;
    /** The default shipped in `calibration.ts`, measured on every question. */
    shipped: ThresholdReport;
    /** Threshold calibrated on even-numbered questions and measured on odd-numbered ones, and vice versa. */
    heldOut: { calibratedOnEven: ThresholdReport; testedOnOdd: ThresholdReport; calibratedOnOdd: ThresholdReport; testedOnEven: ThresholdReport };
    scores: (LabelledScore & { question: string; kind: QuestionKind })[];
  };
}

function metrics(ranks: readonly (number | null)[]): RankingMetrics {
  const n = ranks.length || 1;
  const within = (k: number) => ranks.filter((r) => r !== null && r <= k).length / n;
  return {
    questions: ranks.length,
    hitAt1: within(1),
    hitAt3: within(3),
    hitAt5: within(5),
    mrr: ranks.reduce<number>((sum, r) => sum + (r === null ? 0 : 1 / r), 0) / n,
  };
}

function modeRecord<T>(make: (mode: SearchMode) => T): Record<SearchMode, T> {
  return { bm25: make("bm25"), vector: make("vector"), hybrid: make("hybrid") };
}

export interface EvalOptions {
  core?: CoreOptions;
  corpus?: readonly CorpusDoc[];
  questions?: readonly LabelledQuestion[];
}

/** Ingests the corpus through the real pipeline, then measures each retrieval mode against the labelled questions. */
export async function runEval(opts: EvalOptions = {}): Promise<EvalReport> {
  const corpus = opts.corpus ?? CORPUS;
  const questions = opts.questions ?? QUESTIONS;
  const core = new Core(opts.core);
  const { tenant, ownerKey } = core.createTenant({ name: "eval" });
  const actor = { tenantId: tenant.id, keyId: ownerKey.record.id, role: "owner" } as const;

  const docIdByCorpusId = new Map<string, string>();
  for (const doc of corpus) {
    const { document } = core.ingest.submit(actor, { title: doc.title, content: doc.content, format: "markdown" });
    docIdByCorpusId.set(doc.id, document.id);
  }
  await core.queue.tick();
  const failed = core.ingest.list(actor).filter((d) => d.status !== "ready");
  if (failed.length) throw new Error(`${failed.length} corpus documents failed to ingest`);
  const corpusIdByDocId = new Map([...docIdByCorpusId].map(([corpusId, docId]) => [docId, corpusId]));

  const perQuestion: PerQuestionRank[] = [];
  const scores: EvalReport["confidence"]["scores"] = [];
  for (const q of questions) {
    const answerable = q.relevant.length > 0;
    const rank = modeRecord(() => null as number | null);
    for (const mode of MODES) {
      const hits = await core.retriever.search(tenant.id, q.question, { mode, k: CHUNKS_PER_QUERY });
      const docs: string[] = [];
      for (const h of hits) {
        const id = corpusIdByDocId.get(h.chunk.documentId)!;
        if (!docs.includes(id)) docs.push(id);
      }
      const at = docs.findIndex((d) => q.relevant.includes(d));
      rank[mode] = at === -1 ? null : at + 1;
      if (mode === "hybrid") {
        const top = hits[0];
        scores.push({ question: q.question, kind: q.kind, answerable, confidence: top ? retrievalConfidence({ coverage: top.coverage, cosine: top.cosine }) : 0 });
      }
    }
    if (answerable) perQuestion.push({ question: q.question, kind: q.kind, rank });
  }

  const overall = modeRecord((mode) => metrics(perQuestion.map((p) => p.rank[mode])));
  const byKind: EvalReport["byKind"] = {};
  for (const kind of ANSWERABLE_KINDS) {
    const rows = perQuestion.filter((p) => p.kind === kind);
    if (rows.length) byKind[kind] = modeRecord((mode) => metrics(rows.map((p) => p.rank[mode])));
  }
  const hybridLosses = perQuestion.filter((p) => {
    const best = Math.min(p.rank.bm25 ?? Infinity, p.rank.vector ?? Infinity);
    return (p.rank.hybrid ?? Infinity) > best;
  });

  const answerableScores = scores.filter((s) => s.answerable);
  const unanswerableScores = scores.filter((s) => !s.answerable);
  const mean = (xs: readonly LabelledScore[]) => (xs.length ? xs.reduce((a, s) => a + s.confidence, 0) / xs.length : 0);
  const even = scores.filter((_, i) => i % 2 === 0);
  const odd = scores.filter((_, i) => i % 2 === 1);
  const calibratedOnEven = calibrateThreshold(even);
  const calibratedOnOdd = calibrateThreshold(odd);

  return {
    corpusDocuments: corpus.length,
    corpusChunks: core.retriever.chunkCount(tenant.id),
    answerableQuestions: answerableScores.length,
    unanswerableQuestions: unanswerableScores.length,
    overall,
    byKind,
    perQuestion,
    hybridLosses,
    confidence: {
      answerableMean: mean(answerableScores),
      unanswerableMean: mean(unanswerableScores),
      calibrated: calibrateThreshold(scores),
      shipped: evaluateThreshold(scores, ANSWER_THRESHOLD),
      heldOut: {
        calibratedOnEven,
        testedOnOdd: evaluateThreshold(odd, calibratedOnEven.threshold),
        calibratedOnOdd,
        testedOnEven: evaluateThreshold(even, calibratedOnOdd.threshold),
      },
      scores,
    },
  };
}
