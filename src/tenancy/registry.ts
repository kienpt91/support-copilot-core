import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { type Clock, type IdGen, randomId, systemClock } from "../util.js";
import { ANSWER_THRESHOLD, CAUTION_MARGIN } from "../assistant/calibration.js";

export type PiiRestorePolicy = "none" | "user" | "all";

export interface TenantSettings {
  /** Exact origins (scheme + host + optional port) allowed to call the widget endpoint. */
  allowedOrigins: string[];
  /** Which redaction placeholders may be turned back into real values in the final reply. */
  piiRestore: PiiRestorePolicy;
  /** Retrieval confidence below this value means "not enough evidence": refuse. */
  answerThreshold: number;
  /** Answers with confidence in [answerThreshold, answerThreshold + cautionMargin) carry a caution. */
  cautionMargin: number;
  /** Hand low-confidence questions to the human queue automatically. */
  escalateOnLowConfidence: boolean;
  /** Number of chunks used as evidence for an answer. */
  retrievalK: number;
}

export interface Tenant {
  id: string;
  name: string;
  createdAt: number;
  settings: TenantSettings;
}

export const DEFAULT_SETTINGS: Readonly<TenantSettings> = Object.freeze({
  allowedOrigins: [],
  piiRestore: "user",
  answerThreshold: ANSWER_THRESHOLD,
  cautionMargin: CAUTION_MARGIN,
  escalateOnLowConfidence: true,
  retrievalK: 4,
});

export function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError(`Invalid origin: ${JSON.stringify(value.slice(0, 80))}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ValidationError("Origins must use http or https.");
  }
  const hasExtra = url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "");
  if (hasExtra || value.endsWith("/")) {
    throw new ValidationError("Origins must be scheme://host[:port] with no path, query or credentials.");
  }
  return url.origin;
}

function validateSettings(patch: Partial<TenantSettings>): Partial<TenantSettings> {
  const out: Partial<TenantSettings> = {};
  if (patch.allowedOrigins !== undefined) {
    if (!Array.isArray(patch.allowedOrigins) || patch.allowedOrigins.length > 20) {
      throw new ValidationError("allowedOrigins must be an array of at most 20 origins.");
    }
    out.allowedOrigins = [...new Set(patch.allowedOrigins.map((o) => normalizeOrigin(String(o))))];
  }
  if (patch.piiRestore !== undefined) {
    if (!["none", "user", "all"].includes(patch.piiRestore)) throw new ValidationError("piiRestore must be none, user or all.");
    out.piiRestore = patch.piiRestore;
  }
  for (const key of ["answerThreshold", "cautionMargin"] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw new ValidationError(`${key} must be a number between 0 and 1.`);
    out[key] = v;
  }
  if (patch.escalateOnLowConfidence !== undefined) {
    if (typeof patch.escalateOnLowConfidence !== "boolean") throw new ValidationError("escalateOnLowConfidence must be a boolean.");
    out.escalateOnLowConfidence = patch.escalateOnLowConfidence;
  }
  if (patch.retrievalK !== undefined) {
    if (!Number.isInteger(patch.retrievalK) || patch.retrievalK < 1 || patch.retrievalK > 10) {
      throw new ValidationError("retrievalK must be an integer between 1 and 10.");
    }
    out.retrievalK = patch.retrievalK;
  }
  return out;
}

/** The list of tenants. Tenants are the one global collection; everything else hangs off a tenant id. */
export class TenantRegistry {
  private readonly tenants = new Map<string, Tenant>();

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly newId: IdGen = randomId,
  ) {}

  create(input: { name: string; settings?: Partial<TenantSettings> }): Tenant {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (name.length === 0 || name.length > 120) throw new ValidationError("Tenant name must be 1-120 characters.");
    const tenant: Tenant = {
      id: this.newId("ten"),
      name,
      createdAt: this.clock(),
      settings: { ...DEFAULT_SETTINGS, allowedOrigins: [], ...validateSettings(input.settings ?? {}) },
    };
    if (this.tenants.has(tenant.id)) throw new ConflictError("Tenant id collision.");
    this.tenants.set(tenant.id, tenant);
    return structuredClone(tenant);
  }

  get(id: string): Tenant | undefined {
    const t = this.tenants.get(id);
    return t ? structuredClone(t) : undefined;
  }

  require(id: string): Tenant {
    const t = this.get(id);
    if (!t) throw new NotFoundError("Tenant");
    return t;
  }

  updateSettings(id: string, patch: Partial<TenantSettings>): Tenant {
    const current = this.tenants.get(id);
    if (!current) throw new NotFoundError("Tenant");
    current.settings = { ...current.settings, ...validateSettings(patch) };
    return structuredClone(current);
  }

  list(): Tenant[] {
    return [...this.tenants.values()].map((t) => structuredClone(t));
  }
}
