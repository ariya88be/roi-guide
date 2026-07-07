import { describe, it, expect } from "vitest";
import { RentCastClient } from "./client";
import { InMemoryCache } from "./cache";
import {
  RentCastConfigError,
  RentCastHttpError,
  RentCastValidationError,
  RentCastRetryExhaustedError,
} from "./errors";

/** A recorded fetch call. */
interface Call {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build a fake fetch that returns a queued sequence of responses. Each item is
 * either a Response or a factory throwing to simulate a network error.
 */
function fakeFetch(queue: Array<() => Response | never>) {
  const calls: Call[] = [];
  let i = 0;
  const fn = (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const step = queue[Math.min(i, queue.length - 1)];
    i++;
    return Promise.resolve().then(() => step());
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): () => Response {
  return () => new Response(JSON.stringify(body), { status, headers });
}

function netError(): never {
  throw new Error("simulated network failure");
}

const MARKET_OK = { zipCode: "90020", rentalData: { averageRent: 2124, medianRent: 1850, minRent: 809, maxRent: 9998 } };

/** Deterministic client: no real sleep, zero jitter, tiny base delay. */
function makeClient(fetchImpl: typeof fetch, cache = new InMemoryCache()) {
  return new RentCastClient({
    apiKey: "test-key-123",
    fetchImpl,
    cache,
    sleep: async () => {},
    random: () => 0,
    retry: { maxRetries: 4, baseDelayMs: 1, maxDelayMs: 10 },
  });
}

describe("RentCastClient — auth & happy path", () => {
  it("sends the key in the X-Api-Key header and returns validated data", async () => {
    const { fn, calls } = fakeFetch([json(200, MARKET_OK)]);
    const client = makeClient(fn);
    const market = await client.getRentalMarket("90020");

    expect(market.rentalData.medianRent).toBe(1850);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers["X-Api-Key"]).toBe("test-key-123");
    expect(calls[0].url).toContain("zipCode=90020");
    expect(calls[0].url).toContain("dataType=Rental");
  });

  it("does not leak the key into the request URL", async () => {
    const { fn, calls } = fakeFetch([json(200, MARKET_OK)]);
    await makeClient(fn).getRentalMarket("90020");
    expect(calls[0].url).not.toContain("test-key-123");
  });
});

describe("RentCastClient — caching (protects the paid-API budget)", () => {
  it("serves a repeat call from cache without a second fetch", async () => {
    const { fn, calls } = fakeFetch([json(200, MARKET_OK)]);
    const client = makeClient(fn);
    await client.getRentalMarket("90020");
    await client.getRentalMarket("90020");
    expect(calls).toHaveLength(1); // second call hit the cache
  });

  it("different params miss the cache and fetch separately", async () => {
    const { fn, calls } = fakeFetch([json(200, MARKET_OK), json(200, { ...MARKET_OK, zipCode: "90027" })]);
    const client = makeClient(fn);
    await client.getRentalMarket("90020");
    await client.getRentalMarket("90027");
    expect(calls).toHaveLength(2);
  });
});

describe("RentCastClient — retry/backoff (QA §15.G)", () => {
  it("retries on 429 then succeeds", async () => {
    const { fn, calls } = fakeFetch([json(429, { error: "rate limited" }), json(200, MARKET_OK)]);
    const client = makeClient(fn);
    const market = await client.getRentalMarket("90020");
    expect(market.rentalData.medianRent).toBe(1850);
    expect(calls).toHaveLength(2);
  });

  it("honours Retry-After and still succeeds", async () => {
    const { fn, calls } = fakeFetch([json(429, {}, { "Retry-After": "1" }), json(200, MARKET_OK)]);
    const market = await makeClient(fn).getRentalMarket("90020");
    expect(market.rentalData.medianRent).toBe(1850);
    expect(calls).toHaveLength(2);
  });

  it("retries on a transient network error then succeeds", async () => {
    const { fn, calls } = fakeFetch([netError, json(200, MARKET_OK)]);
    const market = await makeClient(fn).getRentalMarket("90020");
    expect(market.zipCode).toBe("90020");
    expect(calls).toHaveLength(2);
  });

  it("gives up after maxRetries on persistent 429", async () => {
    const { fn, calls } = fakeFetch([json(429, {})]); // always 429
    const client = makeClient(fn);
    await expect(client.getRentalMarket("90020")).rejects.toBeInstanceOf(RentCastRetryExhaustedError);
    expect(calls).toHaveLength(5); // initial + 4 retries
  });

  it("does NOT retry a non-retryable 4xx and fails fast", async () => {
    const { fn, calls } = fakeFetch([json(401, { error: "unauthorized" })]);
    const client = makeClient(fn);
    await expect(client.getRentalMarket("90020")).rejects.toBeInstanceOf(RentCastHttpError);
    expect(calls).toHaveLength(1);
  });
});

describe("RentCastClient — response validation", () => {
  it("throws RentCastValidationError when a required field is missing", async () => {
    const bad = { zipCode: "90020", rentalData: { averageRent: 2124 } }; // no medianRent
    const { fn } = fakeFetch([json(200, bad)]);
    await expect(makeClient(fn).getRentalMarket("90020")).rejects.toBeInstanceOf(RentCastValidationError);
  });
});

describe("RentCastClient — config guard", () => {
  it("throws when no API key is available", () => {
    const original = process.env.RENTCAST_API_KEY;
    delete process.env.RENTCAST_API_KEY;
    try {
      expect(() => new RentCastClient({ fetchImpl: fakeFetch([json(200, MARKET_OK)]).fn })).toThrow(
        RentCastConfigError,
      );
    } finally {
      if (original !== undefined) process.env.RENTCAST_API_KEY = original;
    }
  });
});
