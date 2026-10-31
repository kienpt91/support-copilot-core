# Security policy

## Status of this project

`support-copilot-core` is an example / educational project. It has not been audited, it has no production deployments that I know of, and it should not be exposed to the public internet without your own review. See "Known limitations" below.

## Reporting a vulnerability

Please report suspected vulnerabilities privately:

- Use GitHub's private vulnerability reporting ("Security" tab, "Report a vulnerability") on this repository, or
- email kienphan.dev@gmail.com.

Please do not open a public issue for a vulnerability. I will acknowledge a report when I can; this is a personal project and there is no response-time guarantee.

## Dependency policy

- Runtime dependencies are intentionally few (currently Fastify only). Everything else (BM25, vector search, queue, rate limiter, redaction, audit chain) is implemented in this repository.
- All npm versions, direct and transitive, are exact-pinned through `package-lock.json`, and every locked version (direct and transitive) was published on or before 2026-10-24, the cutoff date used when the lockfile was generated (checked with a script that compares the lockfile against registry publish times). Installs use `npm ci --ignore-scripts`, so no dependency lifecycle scripts run.
- Dependabot opens weekly update PRs with a 7-day cooldown.
- GitHub Actions are pinned to full commit SHAs and the workflow token is read-only.

## Known limitations

- State (documents, vectors, queue, conversations, keys) is in memory and is lost on restart. Only the audit log can optionally be written to a JSONL file.
- The hash-chained audit log is tamper-evident, not tamper-proof: someone who can rewrite the whole file can recompute the chain. Anchor the head hash somewhere you trust if you need stronger guarantees.
- PII redaction is pattern based. It will miss PII that does not match its patterns (names, addresses, free-text descriptions) and can produce false positives.
- API-key hashing uses a plain SHA-256 of a 256-bit random secret, which is appropriate for high-entropy keys only.
- The rate limiter is per process and in memory.
- The bundled embedder is a toy (hashed n-grams). The OpenAI-compatible HTTP embedder and generator are exercised against fakes only; they have not been run against a real provider.
- Retrieved document text is passed to the generator as untrusted data, but prompt injection cannot be ruled out with any LLM-backed generator.
