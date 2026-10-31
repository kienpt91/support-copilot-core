// Measures how long hostile document content keeps the Node event loop busy.
//
//   node scripts/worst-case.mjs [--dist dist] [--sizes 16384,65536] [--timeout 120] [--cases a,b]
//
// Every case runs in its own child process (so a runaway case can be killed) and does exactly what
// the API does for POST /v1/documents followed by one queue tick: Core.ingest.submit(...) and then
// Core.queue.tick(). Reported per case and size:
//   submit  wall time of submit() (runs in the request handler)
//   tick    wall time of the queue tick (parse, chunk, redact, embed, index)
//   stall   the longest stretch during which the event loop could not run anything else
//   result  the document status after the tick
// It needs a compiled build (npm run build). The numbers are for the machine they were run on.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const CASES = {
  "md-comment-opens": (n) => ({ format: "markdown", content: "<!--".repeat(n >> 2) }),
  "md-script-opens": (n) => ({ format: "markdown", content: "<script>".repeat(n >> 3) }),
  "md-bracket-opens": (n) => ({ format: "markdown", content: "[".repeat(n) }),
  "md-link-opens": (n) => ({ format: "markdown", content: "[a](".repeat(n >> 2) }),
  "md-italic-opens": (n) => ({ format: "markdown", content: " *a".repeat(n / 3) }),
  "md-heading-hashes": (n) => ({ format: "markdown", content: `# ${"#".repeat(n)}x` }),
  "md-trailing-spaces": (n) => ({ format: "markdown", content: `a${" ".repeat(n)}x` }),
  "md-many-short-lines": (n) => ({ format: "markdown", content: "a\n".repeat(n >> 1) }),
  "html-script-opens": (n) => ({ format: "html", content: "<script>".repeat(n >> 3) }),
  "html-script-pairs": (n) => ({ format: "html", content: "<script></script>".repeat(n / 17) }),
  "html-trailing-spaces": (n) => ({ format: "html", content: `<p>a${" ".repeat(n)}x</p>` }),
  "html-many-tags": (n) => ({ format: "html", content: "<b>a</b>".repeat(n >> 3) }),
  "auto-detect-tag-opens": (n) => ({ format: "auto", content: "<a ".repeat(n / 3) }),
  "auto-detect-newlines": (n) => ({ format: "auto", content: `${"\n".repeat(n)}x` }),
  "text-phone-like-token": (n) => ({ format: "text", content: "1234567890.".repeat(n / 11) }),
  // Every "415-555-2671," is a phone number and there is no whitespace, so the old chunker kept it all as one chunk.
  "text-comma-separated-phones": (n) => ({ format: "text", content: "415-555-2671,".repeat(n / 13) }),
  "text-one-long-word": (n) => ({ format: "text", content: "x".repeat(n) }),
  "baseline-text": (n) => ({ format: "text", content: "refunds are paid to the original method within five days. ".repeat(n / 56) }),
  "baseline-markdown": (n) => ({
    format: "markdown",
    content: "## Section\nSome **bold** text with a [link](https://example.test) and `code`.\n\n".repeat(n / 75),
  }),
};

async function runCase(name, size, dist) {
  const { Core } = await import(pathToFileURL(resolve(dist, "index.js")).href);
  const core = new Core();
  const { tenant, ownerKey } = core.createTenant({ name: "worst-case" });
  const actor = { tenantId: tenant.id, keyId: ownerKey.record.id, role: "owner" };
  const { format, content } = CASES[name](size);

  // Stall meter: a 1 ms timer records the longest gap between its own callbacks. While the main thread
  // is busy no timer callback can run, so the biggest gap is how long everything else was blocked.
  let lastBeat = performance.now();
  let stallMs = 0;
  const beat = setInterval(() => {
    const now = performance.now();
    stallMs = Math.max(stallMs, now - lastBeat);
    lastBeat = now;
  }, 1);
  const t0 = performance.now();
  let submitMs;
  let document;
  try {
    document = core.ingest.submit(actor, { title: name, content, format }).document;
    submitMs = performance.now() - t0;
  } catch (err) {
    clearInterval(beat);
    console.log(JSON.stringify({ name, size, bytes: Buffer.byteLength(content), submit: Math.round(performance.now() - t0), result: `rejected: ${err.message}` }));
    return;
  }
  const t1 = performance.now();
  await core.queue.tick();
  const tickMs = performance.now() - t1;
  await new Promise((resolveBeat) => setTimeout(resolveBeat, 20)); // let the timer record the final gap
  clearInterval(beat);
  const status = core.ingest.status(actor, document.id).document;
  console.log(
    JSON.stringify({
      name,
      size,
      bytes: Buffer.byteLength(content),
      submit: Math.round(submitMs),
      tick: Math.round(tickMs),
      stall: Math.round(stallMs),
      result: status.status === "ready" ? `ready (${status.chunkCount} chunks)` : `${status.status}: ${status.error}`,
    }),
  );
}

if (argv.includes("--case")) {
  await runCase(opt("case"), Number(opt("size")), opt("dist", "dist"));
} else {
  const dist = opt("dist", "dist");
  const sizes = opt("sizes", "16384,65536").split(",").map(Number);
  const timeoutS = Number(opt("timeout", "120"));
  const only = opt("cases", "").split(",").filter(Boolean);
  const names = Object.keys(CASES).filter((n) => only.length === 0 || only.includes(n));
  console.log(`node ${process.version}, timeout ${timeoutS}s per case`);
  console.log("case | chars | submit ms | tick ms | max event-loop stall ms | result");
  for (const name of names) {
    for (const size of sizes) {
      const started = performance.now();
      const run = spawnSync(process.execPath, [process.argv[1], "--case", name, "--size", String(size), "--dist", dist], {
        encoding: "utf8",
        timeout: timeoutS * 1000,
        killSignal: "SIGKILL",
      });
      if (run.error || run.status !== 0) {
        const waited = Math.round((performance.now() - started) / 1000);
        console.log(`${name} | ${size} | - | - | - | KILLED after ${waited}s (timeout ${timeoutS}s)`);
        continue;
      }
      const r = JSON.parse(run.stdout.trim());
      console.log(`${r.name} | ${r.size} | ${r.submit} | ${r.tick ?? "-"} | ${r.stall ?? "-"} | ${r.result}`);
    }
  }
}
