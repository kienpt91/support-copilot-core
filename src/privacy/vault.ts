import { randomBytes } from "node:crypto";
import type { PiiRestorePolicy } from "../tenancy/registry.js";
import { type PiiKind, findPii } from "./pii.js";

export type PiiOrigin = "user" | "evidence";

interface Entry {
  kind: PiiKind;
  value: string;
  origin: PiiOrigin;
}

/** Card numbers and national ids are never turned back into real values, whatever the tenant policy says. */
const NEVER_RESTORED: ReadonlySet<PiiKind> = new Set(["CARD", "NATIONAL_ID"]);

/**
 * Letters only, on purpose: a placeholder is re-scanned by the redaction wrappers in front of embedders and
 * generators, and a random hex nonce would sometimes contain a run that passes the IBAN or card checksums and
 * get mangled. Without digits in the nonce, no detector can match inside a placeholder.
 */
function randomNonce(): string {
  let nonce = "";
  for (const byte of randomBytes(24)) nonce += String.fromCharCode(97 + (byte % 26));
  return nonce;
}

/**
 * Per-request store of reversible placeholders.
 *
 * Text sent to a generator is redacted with `[KIND_n:nonce]` placeholders. The nonce is random per
 * request, so text from a document or from the user cannot forge a placeholder that
 * resolves to something else. `restore` is the only way real values come back, and it applies the
 * tenant's policy.
 */
export class PiiVault {
  private readonly entries = new Map<string, Entry>();
  private readonly byValue = new Map<string, string>();
  private readonly counters = new Map<PiiKind, number>();

  private readonly nonce: string;

  /** The default nonce is 24 random letters (about 113 bits) per request. Tests pass a fixed one. */
  constructor(nonce: string = randomNonce()) {
    this.nonce = nonce.replace(/[^A-Za-z0-9]/g, "");
  }

  get size(): number {
    return this.entries.size;
  }

  redact(text: string, origin: PiiOrigin): string {
    const matches = findPii(text);
    if (matches.length === 0) return text;
    let out = "";
    let cursor = 0;
    for (const m of matches) {
      const dedupeKey = `${m.kind}\u0000${m.value}`;
      let placeholder = this.byValue.get(dedupeKey);
      if (!placeholder) {
        const n = (this.counters.get(m.kind) ?? 0) + 1;
        this.counters.set(m.kind, n);
        placeholder = `[${m.kind}_${n}:${this.nonce}]`;
        this.byValue.set(dedupeKey, placeholder);
        this.entries.set(placeholder, { kind: m.kind, value: m.value, origin });
      } else if (origin === "user") {
        // The user supplied this value too, so it counts as user-supplied.
        this.entries.get(placeholder)!.origin = "user";
      }
      out += text.slice(cursor, m.start) + placeholder;
      cursor = m.end;
    }
    return out + text.slice(cursor);
  }

  /**
   * Turns permitted placeholders back into the original values. Every placeholder that is not
   * restored is replaced by its static tag (`[EMAIL]`), so a nonce-bearing token never leaves the service.
   */
  restore(text: string, policy: PiiRestorePolicy): string {
    const re = new RegExp(`\\[(EMAIL|PHONE|CARD|IBAN|NATIONAL_ID)_(\\d+):${this.nonce}\\]`, "g");
    return text.replace(re, (whole, kind: PiiKind) => {
      const entry = this.entries.get(whole);
      if (!entry) return `[${kind}]`;
      const allowed =
        policy !== "none" && !NEVER_RESTORED.has(entry.kind) && (policy === "all" || entry.origin === "user");
      return allowed ? entry.value : `[${entry.kind}]`;
    });
  }
}
