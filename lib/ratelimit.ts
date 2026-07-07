/**
 * Fixed-window rate limiter backed by Redis (brief §9: rate-limit every
 * endpoint; this also protects the paid-API budget downstream).
 *
 * Fail-OPEN by design: if Redis is unavailable, requests are allowed rather than
 * blocked — a cache outage must not take the site down. Abuse protection is
 * best-effort here; the hard budget guard lives at the provider layer.
 */
import { getRedis } from "@/lib/redis/client";

export interface RateLimitResult {
  ok: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

/**
 * Consume one unit from `key`'s window. `limit` requests per `windowSeconds`.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const redis = getRedis();
  if (!redis) {
    return { ok: true, limit, remaining: limit, resetSeconds: windowSeconds };
  }
  const redisKey = `rl:${key}`;
  try {
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, windowSeconds);
    }
    const ttl = await redis.ttl(redisKey);
    const resetSeconds = ttl >= 0 ? ttl : windowSeconds;
    return {
      ok: count <= limit,
      limit,
      remaining: Math.max(0, limit - count),
      resetSeconds,
    };
  } catch {
    // Redis hiccup -> fail open.
    return { ok: true, limit, remaining: limit, resetSeconds: windowSeconds };
  }
}

/** Best-effort client IP from proxy headers (Railway sets x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}
