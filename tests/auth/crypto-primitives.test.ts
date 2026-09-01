/**
 * The three primitives in §1.3 and §3.3 that no functional test can pin.
 *
 * An audit found each of these could be removed or weakened without turning a
 * single one of 371 tests red:
 *
 *   - `timingSafeEqual(derived, parsed.hash)` → `a.toString('hex') === b.toString('hex')`
 *   - `randomBytes(32)` → `randomBytes(4)`
 *   - `randomInt(n)` → `Math.floor(Math.random() * n)`
 *
 * The first and third are *functionally* identical to the correct code — the
 * difference is a timing side channel and a predictable stream, neither of
 * which an assertion on the return value can see. A timing assertion would be
 * flaky; a statistical one would pass for `Math.random` too. So these are
 * structural: they assert which primitive was called, which is the only thing
 * that actually distinguishes right from wrong here.
 *
 * `node:crypto` is mocked in this file alone, with every real implementation
 * kept — the two functions under test only get a spy wrapped around them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { timingSafeEqualSpy, randomIntSpy } = vi.hoisted(() => ({
	timingSafeEqualSpy: vi.fn(),
	randomIntSpy: vi.fn()
}));

vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:crypto')>();
	timingSafeEqualSpy.mockImplementation(actual.timingSafeEqual);
	randomIntSpy.mockImplementation(actual.randomInt);
	return { ...actual, default: actual, timingSafeEqual: timingSafeEqualSpy, randomInt: randomIntSpy };
});

const { generateTemporaryPassword, hashPassword, verifyPassword } = await import(
	'$lib/server/auth/password'
);
const { createSession } = await import('$lib/server/auth/session');
const { authHarness, seedUser } = await import('./_support');

beforeEach(() => {
	timingSafeEqualSpy.mockClear();
	randomIntSpy.mockClear();
});

describe('verifyPassword (§1.3)', () => {
	it('compares the derived key with crypto.timingSafeEqual, not with ===', async () => {
		const encoded = await hashPassword('correct-horse-battery');
		expect(await verifyPassword('correct-horse-battery', encoded)).toBe(true);
		expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);

		// Both arguments are the full derived key, so the comparison cannot exit
		// early on the first differing byte.
		const [a, b] = timingSafeEqualSpy.mock.calls[0] as [Buffer, Buffer];
		expect(a.length).toBe(b.length);
		expect(a.length).toBeGreaterThanOrEqual(32);
	});

	it('uses it on the failing path too, which is the path an attacker times', async () => {
		const encoded = await hashPassword('correct-horse-battery');
		expect(await verifyPassword('wrong-horse-battery', encoded)).toBe(false);
		expect(timingSafeEqualSpy).toHaveBeenCalledTimes(1);
	});
});

describe('generateTemporaryPassword (§3.3)', () => {
	it('draws every character from the CSPRNG, never from Math.random', () => {
		const spy = vi.spyOn(Math, 'random');
		const password = generateTemporaryPassword();
		expect(password).toHaveLength(20);
		// One CSPRNG draw per character, and not one Math.random anywhere. These
		// 20 characters are the handoff credential for every account an admin
		// creates.
		expect(randomIntSpy).toHaveBeenCalledTimes(20);
		expect(spy).not.toHaveBeenCalled();
		spy.mockRestore();
	});
});

describe('createSession (§5)', () => {
	it('issues a 32-byte token, not merely a token that hashes to 64 hex', async () => {
		// `session.test.ts` asserts the stored id is 64 hex characters, which is
		// true of a 4-byte token as well: SHA-256 does not care how much entropy
		// went in. The bearer token is the whole of authentication.
		const h = authHarness();
		try {
			const ayse = await seedUser(h.db);
			const session = createSession(h.db, ayse.id, 'password', 'test');
			expect(Buffer.from(session.token, 'base64url')).toHaveLength(32);
		} finally {
			h.close();
		}
	});
});
