/**
 * Pluggable response cache for provider calls.
 *
 * Brief §9: "Cache provider responses to avoid redundant calls" — this both
 * cuts latency and protects the paid-API budget. The production cache is Redis
 * (Upstash/Railway); until that is provisioned we ship an in-memory TTL cache
 * so the client is fully functional and testable. Swapping to Redis later means
 * implementing this one interface — no client changes.
 */

export interface ProviderCache {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSeconds: number): Promise<void>;
}

interface Entry {
  value: unknown;
  /** Epoch ms when this entry expires. */
  expiresAt: number;
}

/**
 * Simple in-memory TTL cache. DEV/TEST ONLY — not shared across processes and
 * lost on restart. Time is injectable so tests stay deterministic (no real
 * clock dependency).
 */
export class InMemoryCache implements ProviderCache {
  private store = new Map<string, Entry>();
  constructor(private now: () => number = () => Date.now()) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
  }

  /** Test helper: current live entry count. */
  get size(): number {
    return this.store.size;
  }
}

/** A no-op cache (every call misses). Useful for tests that bypass caching. */
export class NoopCache implements ProviderCache {
  async get<T>(): Promise<T | undefined> {
    return undefined;
  }
  async set(): Promise<void> {
    /* intentionally empty */
  }
}
