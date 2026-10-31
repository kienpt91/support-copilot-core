/**
 * Default confidence thresholds.
 *
 * ANSWER_THRESHOLD is `calibrated.threshold` from `npm run eval` (0.369 on the fixture corpus),
 * rounded to two decimals. It was fitted on the fixture questions with the hashing embedder; a
 * different embedder, corpus or language needs its own calibration. A test checks that this value
 * still separates answerable from unanswerable fixture questions.
 */
export const ANSWER_THRESHOLD = 0.37;
/** Answers scoring within this margin above the threshold are shown with a caution. */
export const CAUTION_MARGIN = 0.1;
