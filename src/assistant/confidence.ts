import { clamp } from "../util.js";

export interface ConfidenceSignals {
  /** idf-weighted share of query terms found in the top chunk, 0..1. */
  coverage: number;
  /** Cosine similarity of the query and the top chunk, or null when no vector was computed. */
  cosine: number | null;
}

/** Cosine value treated as "as similar as these toy vectors realistically get" when scaling. */
const COSINE_FULL = 0.5;

/**
 * Confidence that the top retrieved chunk answers the question, in 0..1.
 *
 * Fused RRF scores only encode rank, so they cannot say whether the best result is any good. This
 * combines two absolute signals instead: how much of the question's vocabulary the chunk covers
 * (lexical) and how close the vectors are (fuzzy). The 50/50 weighting is a plain average chosen
 * in advance, not fitted; only the decision threshold is calibrated (see `src/eval`).
 */
export function retrievalConfidence(signals: ConfidenceSignals): number {
  const lexical = clamp(signals.coverage, 0, 1);
  if (signals.cosine === null) return lexical;
  const semantic = clamp(signals.cosine / COSINE_FULL, 0, 1);
  return 0.5 * lexical + 0.5 * semantic;
}

export interface LabelledScore {
  confidence: number;
  answerable: boolean;
}

export interface ThresholdReport {
  threshold: number;
  /** Share of answerable questions at or above the threshold (they would be answered). */
  answeredRate: number;
  /** Share of unanswerable questions below the threshold (they would be refused). */
  refusedRate: number;
  balancedAccuracy: number;
}

export function evaluateThreshold(scores: readonly LabelledScore[], threshold: number): ThresholdReport {
  const pos = scores.filter((s) => s.answerable);
  const neg = scores.filter((s) => !s.answerable);
  const answeredRate = pos.length ? pos.filter((s) => s.confidence >= threshold).length / pos.length : 0;
  const refusedRate = neg.length ? neg.filter((s) => s.confidence < threshold).length / neg.length : 0;
  return { threshold, answeredRate, refusedRate, balancedAccuracy: (answeredRate + refusedRate) / 2 };
}

/**
 * Picks the threshold that maximises balanced accuracy (the mean of the answered rate on answerable
 * questions and the refusal rate on unanswerable ones). Candidates are midpoints between sorted
 * scores; ties go to the higher threshold, i.e. the more cautious choice.
 */
export function calibrateThreshold(scores: readonly LabelledScore[]): ThresholdReport {
  const sorted = [...new Set(scores.map((s) => s.confidence))].sort((a, b) => a - b);
  const candidates = sorted.slice(1).map((v, i) => (v + sorted[i]!) / 2);
  let best = evaluateThreshold(scores, candidates[0] ?? 0.5);
  for (const t of candidates) {
    const r = evaluateThreshold(scores, t);
    if (r.balancedAccuracy >= best.balancedAccuracy) best = r;
  }
  return best;
}
