import { type Clock, systemClock } from "../util.js";

export interface RateLimitDecision {
  ok: boolean;
  /** Seconds until one more request would be allowed (0 when ok). */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket limiter keyed by an arbitrary string (IP address, key id). Holds at most `maxKeys`
 * buckets and drops the least recently used ones beyond that, so a flood of distinct keys cannot
 * grow memory without bound. In-process only: with several server instances each has its own counts.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    /** Burst size: the most requests that can arrive at once. */
    private readonly capacity: number,
    /** Sustained rate: tokens added per minute. */
    private readonly perMinute: number,
    private readonly clock: Clock = systemClock,
    private readonly maxKeys = 10_000,
  ) {}

  private refill(key: string): Bucket {
    const now = this.clock();
    const existing = this.buckets.get(key);
    const bucket = existing ?? { tokens: this.capacity, updatedAt: now };
    const elapsedMinutes = Math.max(0, now - bucket.updatedAt) / 60_000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsedMinutes * this.perMinute);
    bucket.updatedAt = now;
    // Re-insert so the Map's iteration order is least-recently-used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
    return bucket;
  }

  take(key: string): RateLimitDecision {
    const bucket = this.refill(key);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, retryAfterSeconds: 0 };
    }
    const missing = 1 - bucket.tokens;
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((missing / this.perMinute) * 60)) };
  }

  get size(): number {
    return this.buckets.size;
  }
}
