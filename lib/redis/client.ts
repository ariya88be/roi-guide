/**
 * Redis client — SERVER-SIDE ONLY. Reads REDIS_URL from the server env.
 * Used for rate limiting and (later) provider-response caching.
 *
 * Lazily connected and memoised. When REDIS_URL is unset (e.g. a dev machine
 * without Redis), returns null so callers can degrade gracefully.
 */
import Redis from "ioredis";

let client: Redis | null | undefined;

export function getRedis(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.REDIS_URL;
  if (!url) {
    client = null;
    return null;
  }
  client = new Redis(url, {
    lazyConnect: false,
    maxRetriesPerRequest: 2,
    // Fail fast rather than hang a request if Redis is unreachable.
    connectTimeout: 3000,
  });
  // Don't let a Redis error crash the process; rate limiting fails open.
  client.on("error", () => {});
  return client;
}
