/**
 * RentCast API client — SERVER-SIDE ONLY.
 *
 * The browser must never hold or send the RentCast key (brief §9); this module
 * reads it from `process.env.RENTCAST_API_KEY`, which is not exposed to the
 * client bundle (no NEXT_PUBLIC_ prefix). All provider traffic goes through the
 * backend and this client.
 *
 * Responsibilities:
 *  - authenticate via the X-Api-Key header (never logged, never thrown);
 *  - retry 429 / 5xx / network errors with exponential backoff + jitter,
 *    honouring Retry-After when present (QA §15.G);
 *  - cache responses to protect the paid-API budget;
 *  - validate every response with Zod before returning it upstream.
 *
 * Everything time-, randomness- and network-related is injectable so the client
 * is fully deterministic under test.
 */

import type { ZodType } from "zod";
import { InMemoryCache, type ProviderCache } from "./cache";
import {
  RentCastConfigError,
  RentCastHttpError,
  RentCastRetryExhaustedError,
  RentCastValidationError,
} from "./errors";
import {
  RentalMarketSchema,
  SaleListingsSchema,
  RentEstimateSchema,
  type RentalMarket,
  type SaleListing,
  type RentEstimate,
} from "./schemas";

const DEFAULT_BASE_URL = "https://api.rentcast.io/v1";

/** Sensible per-endpoint cache TTLs (seconds). Market/AVM change slowly. */
const TTL = {
  rentalMarket: 6 * 60 * 60,
  saleListings: 60 * 60,
  rentEstimate: 6 * 60 * 60,
} as const;

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY: RetryOptions = { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 20_000 };

export interface RentCastClientOptions {
  apiKey?: string;
  baseUrl?: string;
  cache?: ProviderCache;
  retry?: Partial<RetryOptions>;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Injectable delay (defaults to setTimeout). Tests pass a no-op. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1) (defaults to Math.random). */
  random?: () => number;
}

type QueryValue = string | number | boolean | undefined | null;
type Query = Record<string, QueryValue>;

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parse a Retry-After header expressed in integer seconds; else undefined. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

function stableQueryString(query: Query): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) {
    const v = query[key];
    if (v === undefined || v === null || v === "") continue;
    params.set(key, String(v));
  }
  return params.toString();
}

export class RentCastClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cache: ProviderCache;
  private readonly retry: RetryOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(opts: RentCastClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.RENTCAST_API_KEY;
    if (!apiKey) {
      throw new RentCastConfigError(
        "RENTCAST_API_KEY is not set (server-side env). Refusing to make an unauthenticated call.",
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.cache = opts.cache ?? new InMemoryCache();
    this.retry = { ...DEFAULT_RETRY, ...opts.retry };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  /** Exponential backoff with full jitter, capped at maxDelayMs. */
  private backoffMs(attempt: number): number {
    const exp = this.retry.baseDelayMs * 2 ** attempt;
    const capped = Math.min(exp, this.retry.maxDelayMs);
    return Math.floor(this.random() * capped);
  }

  /**
   * Core request: cache-aware GET with retry and schema validation.
   * The cache key is derived from path+query ONLY — never the API key.
   */
  private async get<T>(path: string, query: Query, schema: ZodType<T>, ttlSeconds: number): Promise<T> {
    const qs = stableQueryString(query);
    const cacheKey = `rentcast:${path}?${qs}`;
    const cached = await this.cache.get<T>(cacheKey);
    if (cached !== undefined) return cached;

    const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    let lastStatus: number | undefined;

    for (let attempt = 0; attempt <= this.retry.maxRetries; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: "GET",
          headers: { "X-Api-Key": this.apiKey, Accept: "application/json" },
        });
      } catch {
        // Network/transport failure — retryable. Do not surface the cause
        // (could contain the URL/key); back off and try again.
        if (attempt < this.retry.maxRetries) {
          await this.sleep(this.backoffMs(attempt));
          continue;
        }
        throw new RentCastRetryExhaustedError(url, attempt + 1, lastStatus);
      }

      if (res.ok) {
        const json: unknown = await res.json();
        const parsed = schema.safeParse(json);
        if (!parsed.success) {
          throw new RentCastValidationError(url, parsed.error.issues);
        }
        await this.cache.set(cacheKey, parsed.data, ttlSeconds);
        return parsed.data;
      }

      lastStatus = res.status;
      if (isRetryableStatus(res.status) && attempt < this.retry.maxRetries) {
        const retryAfter = parseRetryAfterMs(res.headers.get("Retry-After"));
        await this.sleep(retryAfter ?? this.backoffMs(attempt));
        continue;
      }

      if (isRetryableStatus(res.status)) {
        throw new RentCastRetryExhaustedError(url, attempt + 1, lastStatus);
      }
      // Non-retryable 4xx (bad params, auth, quota-hard-stop): fail fast.
      throw new RentCastHttpError(res.status, url, false);
    }

    // Loop exits only via return/throw above; this satisfies the type checker.
    throw new RentCastRetryExhaustedError(url, this.retry.maxRetries + 1, lastStatus);
  }

  /** Aggregate rental market stats for a ZIP (median/mean/spread). */
  getRentalMarket(zipCode: string): Promise<RentalMarket> {
    return this.get("/markets", { zipCode, dataType: "Rental" }, RentalMarketSchema, TTL.rentalMarket);
  }

  /** For-sale listings matching a query (viewport/city/zip + filters). */
  getSaleListings(params: {
    city?: string;
    state?: string;
    zipCode?: string;
    latitude?: number;
    longitude?: number;
    radius?: number;
    propertyType?: string;
    status?: string;
    limit?: number;
    offset?: number;
  }): Promise<SaleListing[]> {
    return this.get("/listings/sale", { ...params }, SaleListingsSchema, TTL.saleListings);
  }

  /** RentCast's long-term rent AVM plus the comps behind it. */
  getRentEstimate(params: {
    address?: string;
    latitude?: number;
    longitude?: number;
    propertyType?: string;
    bedrooms?: number;
    bathrooms?: number;
    squareFootage?: number;
    maxRadius?: number;
    daysOld?: number;
    compCount?: number;
  }): Promise<RentEstimate> {
    return this.get("/avm/rent/long-term", { ...params }, RentEstimateSchema, TTL.rentEstimate);
  }
}

/**
 * Factory. Reads the key from the server-side env unless one is injected.
 * Prefer this over `new RentCastClient()` at call sites.
 */
export function createRentCastClient(opts: RentCastClientOptions = {}): RentCastClient {
  return new RentCastClient(opts);
}
