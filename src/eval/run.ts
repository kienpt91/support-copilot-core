import { type EvalReport, MODES, type RankingMetrics, runEval } from "./evaluate.js";

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const row = (label: string, m: RankingMetrics) => `| ${label} | ${m.questions} | ${pct(m.hitAt1)} | ${pct(m.hitAt3)} | ${pct(m.hitAt5)} | ${m.mrr.toFixed(3)} |`;
const HEADER = "| Retriever | Questions | hit@1 | hit@3 | hit@5 | MRR |\n|---|---|---|---|---|---|";

function print(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`Corpus: ${report.corpusDocuments} documents, ${report.corpusChunks} chunks.`);
  lines.push(`Questions: ${report.answerableQuestions} answerable, ${report.unanswerableQuestions} unanswerable.`);
  lines.push("", "### All answerable questions", HEADER);
  for (const mode of MODES) lines.push(row(mode, report.overall[mode]));
  for (const [kind, byMode] of Object.entries(report.byKind)) {
    lines.push("", `### ${kind} questions`, HEADER);
    for (const mode of MODES) lines.push(row(mode, byMode[mode]));
  }
  lines.push("", `### Questions where hybrid ranked the right document lower than the better single ranker (${report.hybridLosses.length})`);
  for (const p of report.hybridLosses) {
    lines.push(`- "${p.question}" (${p.kind}): bm25 ${p.rank.bm25 ?? "miss"}, vector ${p.rank.vector ?? "miss"}, hybrid ${p.rank.hybrid ?? "miss"}`);
  }
  const c = report.confidence;
  lines.push(
    "",
    "### Confidence and refusal",
    `Mean confidence: answerable ${c.answerableMean.toFixed(3)}, unanswerable ${c.unanswerableMean.toFixed(3)}.`,
    "",
    "| Threshold | Answered (answerable) | Refused (unanswerable) | Balanced accuracy |",
    "|---|---|---|---|",
    `| calibrated on all ${c.calibrated.threshold.toFixed(3)} | ${pct(c.calibrated.answeredRate)} | ${pct(c.calibrated.refusedRate)} | ${pct(c.calibrated.balancedAccuracy)} |`,
    `| shipped default ${c.shipped.threshold.toFixed(3)} | ${pct(c.shipped.answeredRate)} | ${pct(c.shipped.refusedRate)} | ${pct(c.shipped.balancedAccuracy)} |`,
    `| calibrated on even ${c.heldOut.calibratedOnEven.threshold.toFixed(3)}, tested on odd | ${pct(c.heldOut.testedOnOdd.answeredRate)} | ${pct(c.heldOut.testedOnOdd.refusedRate)} | ${pct(c.heldOut.testedOnOdd.balancedAccuracy)} |`,
    `| calibrated on odd ${c.heldOut.calibratedOnOdd.threshold.toFixed(3)}, tested on even | ${pct(c.heldOut.testedOnEven.answeredRate)} | ${pct(c.heldOut.testedOnEven.refusedRate)} | ${pct(c.heldOut.testedOnEven.balancedAccuracy)} |`,
  );
  return lines.join("\n");
}

const report = await runEval();
console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : print(report));
