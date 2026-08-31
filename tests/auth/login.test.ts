/** CONTRACT.md §3.2 (login, logout, password change), §3.7 (rate limiting), §5. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as login } from '../../src/routes/api/auth/login/+server';
import { POST as logout } from '../../src/routes/api/auth/logout/+server';
import { POST as changePassword } from '../../src/routes/api/auth/password/+server';
import { cookieName } from '$lib/server/auth/cookies';
import { hashToken, resolveSession } from '$lib/server/auth/session';
import { limiters } from '$lib/server/auth/ratelimit';
import { streamCount, subscribe } from '$lib/server/realtime/bus';
import type { ZembilEvent } from '$lib/types';
import {
	authHarness,
	bodyOf,
	cookiesWithSession,
	fakeCookies,
	localsOf,
	routeEvent,
	seedUser,
	signIn,
	type AuthHarness,
	type SeededUser
} from './_support';

let h: AuthHarness;
let ayse: SeededUser;

beforeEach(async () => {
	h = authHarness();
	ayse = await seedUser(h.db, { password: 'correct-horse-battery' });
});
afterEach(() => h.close());

const loginEvent = (body: unknown, extra = {}) =>
	routeEvent({ path: '/api/auth/login', body, ...extra });

describe('POST /api/auth/login (§3.2)', () => {
	it('signs a member in and sets the session cookie', async () => {
		const cookies = fakeCookies();
		const response = await login(loginEvent(
			{ username: 'ayse', password: 'correct-horse-battery' },
			{ cookies }
		) as any);
		expect(response.status).toBe(200);
		const body = await bodyOf(response);
		expect(body.user.username).toBe('ayse');
		expect(body.mustChangePassword).toBe(false);
		// The response carries no hash, no id of anyone else, and no token.
		expect(JSON.stringify(body)).not.toContain('scrypt$');

		const token = cookies.get(cookieName());
		expect(token).toBeTruthy();
		expect(resolveSession(h.db, token!)?.user.id).toBe(ayse.id);
	});

	it('sets __Host-zembil_session over HTTPS with Secure written literally (§5)', async () => {
		const cookies = fakeCookies();
		await login(loginEvent({ username: 'ayse', password: 'correct-horse-battery' }, { cookies }) as any);
		const entry = cookies.jar.get('__Host-zembil_session');
		expect(entry).toBeDefined();
		expect(entry!.opts).toMatchObject({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax'
		});
		// `__Host-` requires it: a browser silently rejects the cookie without the
		// attribute and login fails with no error anywhere.
		expect(entry!.opts.secure).toBe(true);
		expect(entry!.opts.domain).toBeUndefined();
		expect(Number(entry!.opts.maxAge)).toBeGreaterThan(29 * 24 * 3600);
	});

	it('is looked up case- and NFKC-insensitively (§1.1)', async () => {
		const response = await login(loginEvent({
			username: 'AYSE',
			password: 'correct-horse-battery'
		}) as any);
		expect(response.status).toBe(200);
	});

	it('rejects a wrong password with 401 INVALID_CREDENTIALS', async () => {
		const response = await login(loginEvent({ username: 'ayse', password: 'wrong-wrong-wrong' }) as any);
		expect(response.status).toBe(401);
		expect((await bodyOf(response)).error.code).toBe('INVALID_CREDENTIALS');
	});

	it('gives an unknown username, a wrong password and a DISABLED account the identical response', async () => {
		await seedUser(h.db, {
			username: 'suspended',
			password: 'correct-horse-battery',
			isActive: false
		});

		const unknown = await login(loginEvent({ username: 'nobody', password: 'correct-horse-battery' }) as any);
		const wrong = await login(loginEvent({ username: 'ayse', password: 'wrong-wrong-wrong' }) as any);
		const disabled = await login(loginEvent({
			username: 'suspended',
			password: 'correct-horse-battery'
		}) as any);

		expect([unknown.status, wrong.status, disabled.status]).toEqual([401, 401, 401]);
		const bodies = await Promise.all([unknown, wrong, disabled].map(bodyOf));
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[2]).toEqual(bodies[0]);
	});

	it('does not distinguish a known from an unknown username by timing (§3.2)', async () => {
		// The disabled path is the one that is easy to get wrong: returning early
		// on is_active=0 skips scrypt entirely and the gap announces which
		// usernames exist and are suspended.
		await seedUser(h.db, {
			username: 'suspended',
			password: 'correct-horse-battery',
			isActive: false
		});
		limiters.loginByUsername.reset();
		limiters.loginByIp.reset();

		const time = async (username: string, password: string) => {
			const samples: number[] = [];
			for (let i = 0; i < 5; i++) {
				limiters.loginByUsername.reset();
				limiters.loginByIp.reset();
				const t0 = process.hrtime.bigint();
				await login(loginEvent({ username, password }) as any);
				samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
			}
			return samples.sort((a, b) => a - b)[2]; // median
		};

		const unknown = await time('nobody-at-all', 'correct-horse-battery');
		const wrongPassword = await time('ayse', 'wrong-wrong-wrong');
		const disabled = await time('suspended', 'correct-horse-battery');

		// All three must be dominated by one scrypt. A skipped scrypt is orders of
		// magnitude faster, so a generous ratio still catches the defect.
		for (const [name, value] of [
			['unknown', unknown],
			['wrong password', wrongPassword],
			['disabled', disabled]
		] as const) {
			expect(value, `${name} took ${value}ms`).toBeGreaterThan(wrongPassword / 3);
			expect(value, `${name} took ${value}ms`).toBeLessThan(wrongPassword * 3);
		}
	});

	it('rejects a malformed body without skipping the work (§3.1)', async () => {
		for (const body of [{}, { username: 5, password: 'x'.repeat(20) }, { username: 'ayse' }]) {
			const response = await login(loginEvent(body) as any);
			expect(response.status).toBe(401);
			expect((await bodyOf(response)).error.code).toBe('INVALID_CREDENTIALS');
		}
	});

	it('rotates the session token, destroying the old row (§5)', async () => {
		const existing = signIn(h.db, ayse.id);
		const cookies = cookiesWithSession(existing.token);
		const response = await login(loginEvent(
			{ username: 'ayse', password: 'correct-horse-battery' },
			{ cookies, locals: localsOf(ayse, existing.sessionId) }
		) as any);
		expect(response.status).toBe(200);

		const fresh = cookies.get(cookieName())!;
		expect(fresh).not.toBe(existing.token);
		expect(resolveSession(h.db, existing.token)).toBeNull();
		expect(resolveSession(h.db, fresh)).not.toBeNull();
	});

	it('reports mustChangePassword so the client cannot miss the flag', async () => {
		await seedUser(h.db, {
			username: 'yeni',
			password: 'temporary-one-time',
			mustChangePassword: true
		});
		const body = await bodyOf(
			await login(loginEvent({ username: 'yeni', password: 'temporary-one-time' }) as any)
		);
		expect(body.mustChangePassword).toBe(true);
		expect(body.user.mustChangePassword).toBe(true);
	});
});

describe('login rate limiting (§3.7)', () => {
	it('returns 429 with Retry-After after 10 attempts on one username', async () => {
		for (let i = 0; i < 10; i++) {
			const response = await login(loginEvent({ username: 'ayse', password: 'nope-nope-nope' }) as any);
			expect(response.status).toBe(401);
		}
		const limited = await login(loginEvent({ username: 'ayse', password: 'nope-nope-nope' }) as any);
		expect(limited.status).toBe(429);
		expect((await bodyOf(limited)).error.code).toBe('RATE_LIMITED');
		expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
	});

	it('keys the username bucket by username_key, so casing is not a way around it', async () => {
		for (let i = 0; i < 10; i++) {
			await login(loginEvent({ username: 'ayse', password: 'nope-nope-nope' }) as any);
		}
		const limited = await login(loginEvent({ username: 'AySe', password: 'nope-nope-nope' }) as any);
		expect(limited.status).toBe(429);
	});

	it('does not let one member exhaust another member\'s bucket', async () => {
		await seedUser(h.db, { username: 'mehmet', password: 'correct-horse-battery' });
		for (let i = 0; i < 10; i++) {
			await login(loginEvent({ username: 'ayse', password: 'nope-nope-nope' }) as any);
		}
		const other = await login(loginEvent({
			username: 'mehmet',
			password: 'correct-horse-battery'
		}) as any);
		expect(other.status).toBe(200);
	});
});

describe('POST /api/auth/logout (§3.2)', () => {
	it('destroys the session, clears the cookie and revokes the stream', async () => {
		const session = signIn(h.db, ayse.id);
		const cookies = cookiesWithSession(session.token);
		const received: ZembilEvent[] = [];
		subscribe(ayse.id, session.sessionId, (e) => received.push(e), () => {});

		const response = await logout(routeEvent({
			path: '/api/auth/logout',
			cookies,
			locals: localsOf(ayse, session.sessionId)
		}) as any);

		expect(response.status).toBe(204);
		expect(resolveSession(h.db, session.token)).toBeNull();
		expect(cookies.deleted).toContain(cookieName());
		expect(received).toEqual([{ v: 1, type: 'session.revoked' }]);
		expect(streamCount(session.sessionId)).toBe(0);
	});

	it('is a no-op, not a 401, without a session', async () => {
		const response = await logout(routeEvent({ path: '/api/auth/logout' }) as any);
		expect(response.status).toBe(204);
	});
});

describe('POST /api/auth/password (§3.2, D-004)', () => {
	const change = (body: unknown, session: { token: string; sessionId: string }, cookies = cookiesWithSession(session.token)) =>
		changePassword(routeEvent({
			path: '/api/auth/password',
			body,
			cookies,
			locals: localsOf(ayse, session.sessionId)
		}) as any);

	it('changes the password, rotates the current session and destroys the others', async () => {
		const current = signIn(h.db, ayse.id);
		const other = signIn(h.db, ayse.id);
		const received: ZembilEvent[] = [];
		subscribe(ayse.id, other.sessionId, (e) => received.push(e), () => {});
		const cookies = cookiesWithSession(current.token);

		const response = await change(
			{ currentPassword: 'correct-horse-battery', newPassword: 'a-much-longer-secret' },
			current,
			cookies
		);
		expect(response.status).toBe(204);

		// Other sessions: gone, and told so.
		expect(resolveSession(h.db, other.token)).toBeNull();
		expect(received).toEqual([{ v: 1, type: 'session.revoked' }]);

		// Current session: rotated, not merely kept.
		const rotated = cookies.get(cookieName())!;
		expect(rotated).not.toBe(current.token);
		expect(resolveSession(h.db, current.token)).toBeNull();
		expect(resolveSession(h.db, rotated)?.user.id).toBe(ayse.id);

		// And the new password is the one that works now.
		const after = await login(loginEvent({ username: 'ayse', password: 'a-much-longer-secret' }) as any);
		expect(after.status).toBe(200);
		const before = await login(loginEvent({
			username: 'ayse',
			password: 'correct-horse-battery'
		}) as any);
		expect(before.status).toBe(401);
	});

	it('clears must_change_password (§3.2)', async () => {
		h.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(ayse.id);
		const session = signIn(h.db, ayse.id);
		await change(
			{ currentPassword: 'correct-horse-battery', newPassword: 'a-much-longer-secret' },
			session
		);
		const row = h.db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(ayse.id) as any;
		expect(row.must_change_password).toBe(0);
	});

	it('rejects a wrong current password with 401 and changes nothing', async () => {
		const session = signIn(h.db, ayse.id);
		const response = await change(
			{ currentPassword: 'not-the-password', newPassword: 'a-much-longer-secret' },
			session
		);
		expect(response.status).toBe(401);
		expect((await bodyOf(response)).error.code).toBe('INVALID_CREDENTIALS');
		expect(resolveSession(h.db, session.token)).not.toBeNull();
	});

	it('enforces the 12-256 character bounds (§3.2)', async () => {
		const session = signIn(h.db, ayse.id);
		for (const newPassword of ['short', 'x'.repeat(11), 'x'.repeat(257)]) {
			const response = await change(
				{ currentPassword: 'correct-horse-battery', newPassword },
				session
			);
			expect(response.status).toBe(400);
			expect((await bodyOf(response)).error.code).toBe('VALIDATION_FAILED');
		}
		const okLength = await change(
			{ currentPassword: 'correct-horse-battery', newPassword: 'x'.repeat(12) },
			session
		);
		expect(okLength.status).toBe(204);
	});

	it('requires a session', async () => {
		const response = await changePassword(routeEvent({
			path: '/api/auth/password',
			body: { currentPassword: 'a', newPassword: 'a-much-longer-secret' }
		}) as any);
		expect(response.status).toBe(401);
		expect((await bodyOf(response)).error.code).toBe('UNAUTHENTICATED');
	});
});

describe('token storage', () => {
	it('never writes the raw token anywhere in the database (I-9)', async () => {
		const cookies = fakeCookies();
		await login(loginEvent({ username: 'ayse', password: 'correct-horse-battery' }, { cookies }) as any);
		const token = cookies.get(cookieName())!;
		const rows = h.db.prepare('SELECT * FROM sessions').all() as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(hashToken(token));
		for (const value of Object.values(rows[0])) {
			expect(String(value)).not.toContain(token);
		}
	});
});
