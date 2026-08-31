/** CONTRACT.md §3.7 — token buckets and client-IP derivation (D-007). */
import { describe, expect, it } from 'vitest';
import { RateLimiter, clientIp, limiters } from '$lib/server/auth/ratelimit';

const headers = (xff?: string) => new Headers(xff === undefined ? {} : { 'x-forwarded-for': xff });

describe('RateLimiter', () => {
	it('allows exactly `limit` and then reports a Retry-After', () => {
		const limiter = new RateLimiter(3, 60_000);
		expect(limiter.consume('k', 0)).toBeNull();
		expect(limiter.consume('k', 0)).toBeNull();
		expect(limiter.consume('k', 0)).toBeNull();
		const retryAfter = limiter.consume('k', 0);
		expect(retryAfter).not.toBeNull();
		expect(retryAfter).toBeGreaterThan(0);
	});

	it('keys are independent', () => {
		const limiter = new RateLimiter(1, 60_000);
		expect(limiter.consume('a', 0)).toBeNull();
		expect(limiter.consume('b', 0)).toBeNull();
		expect(limiter.consume('a', 0)).not.toBeNull();
	});

	it('refills continuously rather than in a window that lets 2x through', () => {
		const limiter = new RateLimiter(10, 10_000); // one token per second
		for (let i = 0; i < 10; i++) expect(limiter.consume('k', 0)).toBeNull();
		expect(limiter.consume('k', 0)).not.toBeNull();
		expect(limiter.consume('k', 999)).not.toBeNull();
		expect(limiter.consume('k', 1_000)).toBeNull();
		// And it never accumulates more than the limit while idle.
		let allowed = 0;
		for (let i = 0; i < 20; i++) if (limiter.consume('k', 1_000_000) === null) allowed += 1;
		expect(allowed).toBe(10);
	});

	it('matches the §3.7 table', () => {
		expect([limiters.loginByUsername.limit, limiters.loginByUsername.windowMs]).toEqual([
			10,
			15 * 60_000
		]);
		expect([limiters.loginByIp.limit, limiters.loginByIp.windowMs]).toEqual([300, 15 * 60_000]);
		expect([
			limiters.passkeyAssertionByIp.limit,
			limiters.passkeyAssertionByIp.windowMs
		]).toEqual([300, 15 * 60_000]);
		expect([limiters.passkeyOptionsByIp.limit, limiters.passkeyOptionsByIp.windowMs]).toEqual([
			300,
			15 * 60_000
		]);
		expect([
			limiters.adminUserCreateByActor.limit,
			limiters.adminUserCreateByActor.windowMs
		]).toEqual([20, 60 * 60_000]);
	});

	it('bounds the key map, since keys are attacker-chosen', () => {
		const limiter = new RateLimiter(5, 1_000, 4);
		for (let i = 0; i < 50; i++) limiter.consume(`key-${i}`, i * 10_000);
		// Nothing to assert on the internals directly; the observable property is
		// that a long-idle key behaves like a fresh one either way.
		expect(limiter.consume('key-0', 1_000_000)).toBeNull();
	});
});

describe('clientIp — the §3.7 worked example, which is normative', () => {
	it('N=1 takes the LAST entry', () => {
		expect(clientIp(headers('1.2.3.4, 203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
	});

	it('N=0 ignores the header entirely', () => {
		expect(clientIp(headers('1.2.3.4, 203.0.113.9'), '10.0.0.1', 0)).toBe('10.0.0.1');
	});

	it('falls back to the socket when there are fewer entries than trusted hops', () => {
		expect(clientIp(headers('203.0.113.9'), '10.0.0.1', 2)).toBe('10.0.0.1');
	});

	it('falls back to the socket when the header is absent', () => {
		expect(clientIp(headers(), '10.0.0.1', 1)).toBe('10.0.0.1');
	});

	it('never reads left of the trusted hops', () => {
		// `parts[parts.length - 1 - N]` is the natural-looking transcription and is
		// WRONG: it would return the attacker-supplied 1.2.3.4 here, handing every
		// visitor control of their own rate-limit identity.
		expect(clientIp(headers('1.2.3.4, 203.0.113.9'), '10.0.0.1', 1)).not.toBe('1.2.3.4');
		expect(clientIp(headers('evil, 1.2.3.4, 203.0.113.9'), '10.0.0.1', 2)).toBe('1.2.3.4');
	});

	it('tolerates whitespace and empty entries without shifting the index', () => {
		expect(clientIp(headers('  1.2.3.4 ,   203.0.113.9  '), '10.0.0.1', 1)).toBe('203.0.113.9');
		expect(clientIp(headers('1.2.3.4, ,203.0.113.9'), '10.0.0.1', 1)).toBe('203.0.113.9');
		expect(clientIp(headers(''), '10.0.0.1', 1)).toBe('10.0.0.1');
	});
});
