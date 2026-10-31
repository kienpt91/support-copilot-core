import { createHash, randomBytes } from "node:crypto";

/** Milliseconds since the epoch. Injected so tests can control time. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();

/** Generates an opaque, URL-safe identifier with a readable prefix. */
export type IdGen = (prefix: string) => string;
export const randomId: IdGen = (prefix) => `${prefix}_${randomBytes(12).toString("base64url")}`;

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON with object keys sorted recursively, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}
