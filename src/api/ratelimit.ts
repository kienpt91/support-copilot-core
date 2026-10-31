import { type Clock, systemClock } from "../util.js";

/** The eight 16-bit groups of an IPv6 address as lower-case hex, or null if the text is not a valid IPv6 address. */
function expandIpv6(addr: string): string[] | null {
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (part: string): string[] | null => {
    if (part === "") return [];
    const out: string[] = [];
    for (const g of part.split(":")) {
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(g);
      if (v4) {
        const [a, b, c, d] = [v4[1], v4[2], v4[3], v4[4]].map(Number) as [number, number, number, number];
        if (a > 255 || b > 255 || c > 255 || d > 255) return null;
        out.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
      } else if (/^[0-9a-f]{1,4}$/.test(g)) out.push(g);
      else return null;
    }
    return out;
  };
  const head = groupsOf(halves[0]!);
  const tail = halves.length === 2 ? groupsOf(halves[1]!) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  return fill < 1 ? null : [...head, ...new Array<string>(fill).fill("0"), ...tail];
}

/**
 * The rate-limit key for a client address. IPv4 stays as it is, IPv4-mapped IPv6 becomes the IPv4 address, and any other
 * IPv6 address is reduced to its /64 prefix, because a single subscriber normally controls a whole /64 and could
 * otherwise rotate through addresses to get a fresh bucket each time.
 */
export function clientKey(ip: string): string {
  const addr = ip.split("%")[0]!.toLowerCase();
  if (!addr.includes(":")) return addr;
  const groups = expandIpv6(addr);
  if (!groups) return addr;
  if (groups.slice(0, 5).every((g) => g === "0") && groups[5] === "ffff") {
    const hi = Number.parseInt(groups[6]!, 16);
    const lo = Number.parseInt(groups[7]!, 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

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
