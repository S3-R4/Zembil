/**
 * `scripts/bootstrap-admin.js` — CONTRACT.md §3.8 (the lockout recovery path).
 *
 * The script is plain JavaScript so it can run from the shipped image with no
 * build step, which means it writes the §1.3 hash encoding a second time. These
 * tests are what stop the two copies drifting: a hash the script produces must
 * verify under the application's own `verifyPassword`, and its `usernameKey`
 * must agree with the application's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as login } from '../../src/routes/api/auth/login/+server';
import { usernameKey, verifyPassword } from '$lib/server/auth/password';
import {
	bootstrapAdmin,
	generatePassword,
	hashPassword as scriptHashPassword,
	parseArgs,
	usernameKey as scriptUsernameKey
} from '../../scripts/bootstrap-admin.js';
import { authHarness, bodyOf, routeEvent, seedUser, type AuthHarness } from './_support';

let h: AuthHarness;
beforeEach(() => {
	h = authHarness();
});
afterEach(() => h.close());

describe('drift with src/lib/server/auth/password.ts', () => {
	it('produces a hash the application accepts', async () => {
		const encoded = await scriptHashPassword('a-recovery-password');
		expect(encoded).toMatch(/^scrypt\$N=65536,r=8,p=1\$/);
		expect(await verifyPassword('a-recovery-password', encoded)).toBe(true);
		expect(await verifyPassword('a-different-password', encoded)).toBe(false);
	});

	it('normalizes usernames the same way', () => {
		for (const raw of ['Ayse', 'AYSE', 'ﬁgen', 'Mehmet']) {
			expect(scriptUsernameKey(raw)).toBe(usernameKey(raw));
		}
	});

	it('generates a password of the same shape as the app\'s', () => {
		const password = generatePassword();
		expect(password).toHaveLength(20);
		expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]+$/);
	});
});

describe('bootstrapAdmin', () => {
	it('creates an active admin that can sign in and must change the password', async () => {
		const result = await bootstrapAdmin(h.db, 'baba', 'a-recovery-password');
		expect(result.created).toBe(true);

		const row = h.db.prepare('SELECT * FROM users').get() as any;
		expect([row.is_admin, row.is_active, row.must_change_password]).toEqual([1, 1, 1]);
		expect(Buffer.from(row.webauthn_user_handle)).toHaveLength(32);

		const response = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'baba', password: 'a-recovery-password' }
		}) as any);
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).mustChangePassword).toBe(true);
	});

	it('re-enables, re-promotes and resets an EXISTING account rather than duplicating it', async () => {
		const ayse = await seedUser(h.db, { username: 'Ayse', isActive: false });
		const result = await bootstrapAdmin(h.db, 'ayse', 'a-recovery-password');
		expect(result.created).toBe(false);

		const rows = h.db.prepare('SELECT * FROM users').all() as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(ayse.id);
		// One statement for is_active and disabled_at, or the DDL's CHECK aborts.
		expect([rows[0].is_admin, rows[0].is_active, rows[0].disabled_at]).toEqual([1, 1, null]);
		expect(rows[0].must_change_password).toBe(1);

		const response = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'AYSE', password: 'a-recovery-password' }
		}) as any);
		expect(response.status).toBe(200);
	});

	it('keeps the webauthn_user_handle, so existing passkeys survive a recovery', async () => {
		const ayse = await seedUser(h.db, { username: 'ayse' });
		const before = h.db.prepare('SELECT webauthn_user_handle FROM users WHERE id = ?').get(ayse.id) as any;
		await bootstrapAdmin(h.db, 'ayse', 'a-recovery-password');
		const after = h.db.prepare('SELECT webauthn_user_handle FROM users WHERE id = ?').get(ayse.id) as any;
		expect(Buffer.from(after.webauthn_user_handle).toString('hex')).toBe(
			Buffer.from(before.webauthn_user_handle).toString('hex')
		);
	});
});

describe('parseArgs', () => {
	it('defaults to admin and the configured data directory', () => {
		const args = parseArgs([]);
		expect(args.username).toBe('admin');
		expect(args.password).toBeNull();
	});

	it('reads the flags', () => {
		const args = parseArgs(['--username', 'baba', '--password', 'a-recovery-password', '--data-dir', '/tmp/x']);
		expect(args).toMatchObject({ username: 'baba', password: 'a-recovery-password', dataDir: '/tmp/x' });
	});

	it('refuses a short password rather than writing a weak admin', () => {
		expect(() => parseArgs(['--password', 'short'])).toThrow(/at least 12/);
	});

	it('refuses an empty username and an unknown flag', () => {
		expect(() => parseArgs(['--username', '  '])).toThrow(/cannot be empty/);
		expect(() => parseArgs(['--wat'])).toThrow(/Unknown argument/);
	});
});
