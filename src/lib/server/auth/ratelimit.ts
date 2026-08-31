/**
 * In-process token buckets and client-IP derivation — CONTRACT.md §3.7, D-007.
 *
 * Buckets are in memory and reset on restart, which §3.7 accepts because a
 * restart requires host access. There is deliberately no account lockout.
 */
import { DomainError } from '../domain/errors.js';
import { getConfig } from './config.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface Bucket {
	/** Fractional tokens remaining. */
	tokens: number;
	updatedAt: number;
}

/**
 * A continuously-refilling token bucket. Continuous rather than a fixed window
 * because a fixed window lets 2x the limit through across a boundary, and the
 * per-username bucket in §3.7 is the real credential-stuffing control.
 */
export class RateLimiter {
	readonly limit: number;
	readonly windowMs: number;
	/** Tokens restored per millisecond. */
	private readonly rate: number;
	private readonly buckets = new Map<string, Bucket>();
	/** Bound on distinct keys before a sweep. Keys are usernames and IPs, both
	 *  attacker-chosen, so the map must not be allowed to grow without limit. */
	private readonly maxKeys: number;

	constructor(limit: number, windowMs: number, maxKeys = 10_000) {
		this.limit = limit;
		this.windowMs = windowMs;
		this.rate = limit / windowMs;
		this.maxKeys = maxKeys;
	}

	/** Consumes one token. Returns `null` when allowed, or the `Retry-After`
	 *  value in seconds when the bucket is empty. */
	consume(key: string, now = Date.now()): number | null {
		const bucket = this.buckets.get(key);
		let tokens: number;
		if (bucket === undefined) {
			if (this.buckets.size >= this.maxKeys) this.sweep(now);
			tokens = this.limit;
		} else {
			tokens = Math.min(this.limit, bucket.tokens + (now - bucket.updatedAt) * this.rate);
		}

		if (tokens < 1) {
			// Store the refilled value so the retry-after we report stays honest
			// even when the caller hammers the endpoint.
			this.buckets.set(key, { tokens, updatedAt: now });
			return Math.max(1, Math.ceil((1 - tokens) / this.rate / 1000));
		}

		this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
		return null;
	}

	/** Drops every bucket that has refilled to full — it is indistinguishable
	 *  from a key that was never seen, so forgetting it changes nothing. */
	private sweep(now: number): void {
		for (const [key, bucket] of this.buckets) {
			if (bucket.tokens + (now - bucket.updatedAt) * this.rate >= this.limit) {
				this.buckets.delete(key);
			}
		}
	}

	/** Test seam. */
	reset(): void {
		this.buckets.clear();
	}
}

/** The five buckets of §3.7, keyed and limited exactly as the table states. */
export const limiters = {
	loginByUsername: new RateLimiter(10, 15 * MINUTE),
	loginByIp: new RateLimiter(300, 15 * MINUTE),
	passkeyAssertionByIp: new RateLimiter(300, 15 * MINUTE),
	passkeyOptionsByIp: new RateLimiter(300, 15 * MINUTE),
	adminUserCreateByActor: new RateLimiter(20, HOUR)
};

export function resetAllLimiters(): void {
	for (const limiter of Object.values(limiters)) limiter.reset();
}

/**
 * §3.7: exceeding a bucket is `429 RATE_LIMITED` with a `Retry-After` header.
 * `retryAfter` rides in `extra` only so the route can lift it into a header —
 * it is stripped before the envelope is written, because §3.1 permits exactly
 * three named sibling fields and this is not one of them.
 */
export class RateLimitedError extends DomainError {
	readonly retryAfter: number;

	constructor(retryAfter: number) {
		super('RATE_LIMITED', 429, 'Too many attempts. Please wait and try again.');
		this.retryAfter = retryAfter;
	}
}

export function enforce(limiter: RateLimiter, key: string): void {
	const retryAfter = limiter.consume(key);
	if (retryAfter !== null) throw new RateLimitedError(retryAfter);
}

/**
 * §3.7, normative and worked-example-pinned. Let `N = ZEMBIL_TRUST_PROXY` and
 * `parts` be `X-Forwarded-For` split on commas and trimmed; the client IP is
 * `parts[parts.length - N]`.
 *
 * `parts[parts.length - 1 - N]` is the natural-looking transcription and is
 * WRONG — it hands every visitor control of their own rate-limit identity by
 * reading one hop further left than the trusted proxy actually observed.
 *
 * The fallback, in every failing case, is the socket address. Falling back to
 * `undefined` (one shared bucket for everyone) or to `parts[0]` (attacker
 * controlled) is equally a defect.
 */
export function clientIp(
	headers: Headers,
	socketAddress: string,
	trustProxy = getConfig().trustProxy
): string {
	// Redundant by arithmetic and kept anyway: with N = 0 the index below is
	// `parts[parts.length]`, which is always `undefined` and falls through to the
	// same socket address. Deleting this line therefore changes no behaviour and
	// no test can distinguish it — but "0 disables header trust entirely" (§6) is
	// a promise, and leaving it to an out-of-range accident is how a later
	// refactor of the index breaks it silently.
	if (trustProxy <= 0) return socketAddress;
	const raw = headers.get('x-forwarded-for');
	if (!raw) return socketAddress;
	const parts = raw
		.split(',')
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (parts.length < trustProxy) return socketAddress;
	return parts[parts.length - trustProxy] ?? socketAddress;
}
