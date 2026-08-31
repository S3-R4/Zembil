/** CONTRACT.md §1.3 — password hash encoding. */
import { describe, expect, it } from 'vitest';
import {
	SCRYPT_TARGET,
	dummyVerify,
	generateTemporaryPassword,
	hashPassword,
	needsRehash,
	usernameKey,
	verifyPassword
} from '$lib/server/auth/password';

describe('password hashing', () => {
	it('encodes every parameter in the string, per §1.3', async () => {
		const encoded = await hashPassword('correct-horse-battery');
		expect(encoded).toMatch(/^scrypt\$N=65536,r=8,p=1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
		const [, , salt, key] = encoded.split('$');
		expect(Buffer.from(salt, 'base64url')).toHaveLength(16);
		expect(Buffer.from(key, 'base64url')).toHaveLength(32);
	});

	it('salts, so the same password hashes differently every time', async () => {
		const a = await hashPassword('correct-horse-battery');
		const b = await hashPassword('correct-horse-battery');
		expect(a).not.toBe(b);
	});

	it('verifies the right password and rejects the wrong one', async () => {
		const encoded = await hashPassword('correct-horse-battery');
		expect(await verifyPassword('correct-horse-battery', encoded)).toBe(true);
		expect(await verifyPassword('correct-horse-batterz', encoded)).toBe(false);
		expect(await verifyPassword('', encoded)).toBe(false);
	});

	it('returns false rather than throwing on a malformed encoding', async () => {
		for (const bad of ['', 'nonsense', 'scrypt$N=x,r=8,p=1$aa$bb', 'argon2$a$b$c']) {
			expect(await verifyPassword('anything', bad)).toBe(false);
		}
	});

	it('flags a weaker stored hash for rehash, and leaves the current target alone', async () => {
		const current = await hashPassword('correct-horse-battery');
		expect(needsRehash(current)).toBe(false);
		const weak = await hashPassword('correct-horse-battery', { N: 16384, r: 8, p: 1 });
		expect(needsRehash(weak)).toBe(true);
		expect(needsRehash('not-a-hash')).toBe(true);
		// The parameters really are the target ones, not merely self-consistent.
		expect(SCRYPT_TARGET).toEqual({ N: 65536, r: 8, p: 1 });
	});

	it('dummyVerify costs about the same as a real verification (§3.2)', async () => {
		const encoded = await hashPassword('correct-horse-battery');
		await dummyVerify('warm'); // the fixed hash is computed lazily, once
		const t0 = process.hrtime.bigint();
		await verifyPassword('correct-horse-battery', encoded);
		const real = Number(process.hrtime.bigint() - t0);
		const t1 = process.hrtime.bigint();
		await dummyVerify('correct-horse-battery');
		const dummy = Number(process.hrtime.bigint() - t1);
		// Loose on purpose: the assertion is "same order of magnitude", which is
		// what defeats timing enumeration. A dummy path that skipped scrypt would
		// be a hundred times faster, not thirty percent.
		expect(dummy).toBeGreaterThan(real / 4);
	});
});

describe('temporary passwords (§3.3)', () => {
	it('is 20 characters from an alphabet with no ambiguous glyphs', () => {
		for (let i = 0; i < 50; i++) {
			const password = generateTemporaryPassword();
			expect(password).toHaveLength(20);
			expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
			expect(password).not.toMatch(/[0O1lI]/);
		}
	});

	it('does not repeat', () => {
		const seen = new Set(Array.from({ length: 200 }, generateTemporaryPassword));
		expect(seen.size).toBe(200);
	});
});

describe('usernameKey (§1.1)', () => {
	it('is NFKC-normalized then lowercased', () => {
		expect(usernameKey('Ayse')).toBe('ayse');
		expect(usernameKey('AYSE')).toBe('ayse');
		// NFKC folds the compatibility form to the plain one.
		expect(usernameKey('ﬁgen')).toBe(usernameKey('figen'));
		expect(usernameKey('Å')).toBe(usernameKey('Å'));
	});
});
