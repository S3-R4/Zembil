/** CONTRACT.md §3.3 (admin), §3.0 (revocation effects), §3.7 (creation bucket). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as listUsersRoute, POST as createUserRoute } from '../../src/routes/api/admin/users/+server';
import { PATCH as patchUserRoute } from '../../src/routes/api/admin/users/[userId]/+server';
import { POST as resetPasswordRoute } from '../../src/routes/api/admin/users/[userId]/reset-password/+server';
import { DELETE as adminDeletePasskeys } from '../../src/routes/api/admin/users/[userId]/passkeys/+server';
import { POST as login } from '../../src/routes/api/auth/login/+server';
import { GET as meRoute } from '../../src/routes/api/me/+server';
import { assertAdminsRemain, countActiveAdmins } from '$lib/server/auth/users';
import { resolveSession } from '$lib/server/auth/session';
import { limiters } from '$lib/server/auth/ratelimit';
import { streamCount, subscribe } from '$lib/server/realtime/bus';
import type { ZembilEvent } from '$lib/types';
import {
	authHarness,
	bodyOf,
	localsOf,
	routeEvent,
	seedUser,
	signIn,
	type AuthHarness,
	type SeededUser
} from './_support';

let h: AuthHarness;
let admin: SeededUser;
let member: SeededUser;

beforeEach(async () => {
	h = authHarness();
	admin = await seedUser(h.db, { username: 'admin', displayName: 'Admin', isAdmin: true });
	member = await seedUser(h.db, { username: 'ayse', displayName: 'Ayse' });
});
afterEach(() => h.close());

const asAdmin = (over: Record<string, unknown> = {}) => ({ locals: localsOf(admin, 'admin-session'), ...over });
const asMember = (over: Record<string, unknown> = {}) => ({ locals: localsOf(member, 'member-session'), ...over });

describe('authorization (§3)', () => {
	it('rejects every admin route for a non-admin session with 403 FORBIDDEN', async () => {
		const cases: Array<[string, Response | Promise<Response>]> = [
			['GET /users', listUsersRoute(routeEvent({ method: 'GET', path: '/api/admin/users', ...asMember() }) as any)],
			['POST /users', createUserRoute(routeEvent({
				path: '/api/admin/users',
				body: { username: 'x', displayName: 'X', isAdmin: false },
				...asMember()
			}) as any)],
			['PATCH /users/{id}', patchUserRoute(routeEvent({
				method: 'PATCH',
				body: { displayName: 'Nope' },
				params: { userId: admin.id },
				...asMember()
			}) as any)],
			['POST reset-password', resetPasswordRoute(routeEvent({
				params: { userId: admin.id },
				...asMember()
			}) as any)],
			['DELETE passkeys', adminDeletePasskeys(routeEvent({
				method: 'DELETE',
				params: { userId: admin.id },
				...asMember()
			}) as any)]
		];
		for (const [name, promise] of cases) {
			const response = await promise;
			expect(response.status, name).toBe(403);
			expect((await bodyOf(response)).error.code, name).toBe('FORBIDDEN');
		}
	});

	it('rejects them for no session at all with 401', async () => {
		const response = await listUsersRoute(routeEvent({ method: 'GET', path: '/api/admin/users' }) as any);
		expect(response.status).toBe(401);
		expect((await bodyOf(response)).error.code).toBe('UNAUTHENTICATED');
	});
});

describe('POST /api/admin/users (§3.3)', () => {
	const create = (body: unknown, over = {}) =>
		createUserRoute(routeEvent({ path: '/api/admin/users', body, ...asAdmin(over) }) as any);

	it('creates an account and returns the temporary password exactly once', async () => {
		const response = await create({ username: 'Mehmet', displayName: 'Mehmet', isAdmin: false });
		expect(response.status).toBe(201);
		const body = await bodyOf(response);
		expect(body.user.username).toBe('Mehmet');
		expect(body.user.mustChangePassword).toBe(true);
		expect(body.temporaryPassword).toHaveLength(20);

		// Never stored in plaintext...
		const row = h.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(body.user.id) as any;
		expect(row.password_hash).not.toContain(body.temporaryPassword);
		expect(row.password_hash).toMatch(/^scrypt\$/);

		// ...but it does work, and the flag really is enforced by the login reply.
		const signedIn = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'mehmet', password: body.temporaryPassword }
		}) as any);
		expect(signedIn.status).toBe(200);
		expect((await bodyOf(signedIn)).mustChangePassword).toBe(true);
	});

	it('gives every account a distinct 32-byte webauthn_user_handle (§1.1)', async () => {
		await create({ username: 'a-user', displayName: 'A', isAdmin: false });
		await create({ username: 'b-user', displayName: 'B', isAdmin: false });
		const rows = h.db.prepare('SELECT webauthn_user_handle FROM users').all() as any[];
		const handles = rows.map((r) => Buffer.from(r.webauthn_user_handle).toString('hex'));
		expect(new Set(handles).size).toBe(rows.length);
		for (const handle of handles) expect(handle).toHaveLength(64);
	});

	it('409 USERNAME_TAKEN on a username_key collision, including a case variant', async () => {
		const response = await create({ username: 'AYSE', displayName: 'Ayse again', isAdmin: false });
		expect(response.status).toBe(409);
		expect((await bodyOf(response)).error.code).toBe('USERNAME_TAKEN');
	});

	it('validates the fields (§1.1, §3.1a)', async () => {
		for (const body of [
			{ username: '', displayName: 'X', isAdmin: false },
			{ username: '   ', displayName: 'X', isAdmin: false },
			{ username: 'x'.repeat(33), displayName: 'X', isAdmin: false },
			{ username: 'ok-user', displayName: '', isAdmin: false },
			{ username: 'ok-user', displayName: 'x'.repeat(61), isAdmin: false },
			{ username: 'ok-user', displayName: 'X', isAdmin: 'yes' },
			{ username: 'ok-user', displayName: 'X' }
		]) {
			const response = await create(body);
			expect(response.status, JSON.stringify(body)).toBe(400);
			expect((await bodyOf(response)).error.code).toBe('VALIDATION_FAILED');
		}
	});

	it('rate-limits creation to 20 per hour per acting admin (§3.7)', async () => {
		limiters.adminUserCreateByActor.reset();
		for (let i = 0; i < 20; i++) {
			const response = await create({ username: `member-${i}`, displayName: `M${i}`, isAdmin: false });
			expect(response.status, `attempt ${i}`).toBe(201);
		}
		const limited = await create({ username: 'one-too-many', displayName: 'X', isAdmin: false });
		expect(limited.status).toBe(429);
		expect(limited.headers.get('Retry-After')).toBeTruthy();
	});
});

describe('GET /api/admin/users (§3.3, §7)', () => {
	it('lists every account with its passkey count, disabledAt and lastSeenAt', async () => {
		signIn(h.db, member.id);
		h.db
			.prepare(
				`INSERT INTO credentials (id, user_id, public_key, counter, transports, device_label,
				                          backed_up, created_at, last_used_at)
				 VALUES (?, ?, ?, 0, NULL, ?, 0, ?, NULL)`
			)
			.run('cred-1', member.id, new Uint8Array([1, 2, 3]), 'iPhone', Date.now());

		const body = await bodyOf(
			await listUsersRoute(routeEvent({ method: 'GET', path: '/api/admin/users', ...asAdmin() }) as any)
		);
		const listed = body.users.find((u: any) => u.id === member.id);
		expect(listed.passkeyCount).toBe(1);
		expect(listed.disabledAt).toBeNull();
		expect(listed.lastSeenAt).toBeGreaterThan(0);
		// Never the hash, at any privilege level.
		expect(JSON.stringify(body)).not.toContain('scrypt$');
	});
});

describe('PATCH /api/admin/users/{userId} (§3.3, §3.0)', () => {
	const patch = (userId: string, body: unknown, over = {}) =>
		patchUserRoute(routeEvent({ method: 'PATCH', body, params: { userId }, ...asAdmin(over) }) as any);

	it('renames', async () => {
		const body = await bodyOf(await patch(member.id, { displayName: '  Ayse K.  ' }));
		expect(body.user.displayName).toBe('Ayse K.');
	});

	it('disables: sets disabled_at in the SAME statement, kills sessions, revokes streams', async () => {
		const session = signIn(h.db, member.id);
		const received: ZembilEvent[] = [];
		subscribe(member.id, session.sessionId, (e) => received.push(e), () => {});

		const response = await patch(member.id, { isActive: false });
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).user.isActive).toBe(false);

		const row = h.db.prepare('SELECT is_active, disabled_at FROM users WHERE id = ?').get(member.id) as any;
		expect(row.is_active).toBe(0);
		expect(row.disabled_at).toBeGreaterThan(0);

		expect(resolveSession(h.db, session.token)).toBeNull();
		expect(received).toEqual([{ v: 1, type: 'session.revoked' }]);
		expect(streamCount(session.sessionId)).toBe(0);
	});

	it('re-enables in one statement, which the CHECK constraint requires', async () => {
		await patch(member.id, { isActive: false });
		// Writing is_active=1 without clearing disabled_at aborts on
		// `CHECK ((is_active = 0) = (disabled_at IS NOT NULL))`, so the Enable
		// button would be a 500 rather than a 200.
		const response = await patch(member.id, { isActive: true });
		expect(response.status).toBe(200);
		const row = h.db.prepare('SELECT is_active, disabled_at FROM users WHERE id = ?').get(member.id) as any;
		expect([row.is_active, row.disabled_at]).toEqual([1, null]);
	});

	it('grants and revokes admin', async () => {
		expect((await bodyOf(await patch(member.id, { isAdmin: true }))).user.isAdmin).toBe(true);
		expect((await bodyOf(await patch(member.id, { isAdmin: false }))).user.isAdmin).toBe(false);
	});

	it('409 CANNOT_DISABLE_SELF', async () => {
		const response = await patch(admin.id, { isActive: false });
		expect(response.status).toBe(409);
		expect((await bodyOf(response)).error.code).toBe('CANNOT_DISABLE_SELF');
		expect(countActiveAdmins(h.db)).toBe(1);
	});

	it('409 CANNOT_DEMOTE_SELF', async () => {
		const response = await patch(admin.id, { isAdmin: false });
		expect(response.status).toBe(409);
		expect((await bodyOf(response)).error.code).toBe('CANNOT_DEMOTE_SELF');
		expect(countActiveAdmins(h.db)).toBe(1);
	});

	it('LAST_ADMIN guards the invariant the self-guards only guard one path to', () => {
		// §3.3: "the system must never reach zero active admins." Through the HTTP
		// API this is unreachable — the acting admin is itself active and admin,
		// so the count can only fall to zero if it targets itself, which the two
		// guards above refuse. The assertion is the property's own enforcement and
		// is therefore tested directly; nothing else can reach it.
		expect(() => assertAdminsRemain(h.db)).not.toThrow();
		h.db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(admin.id);
		expect(() => assertAdminsRemain(h.db)).toThrowError(/at least one active admin/);
		h.db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(admin.id);
		h.db.prepare('UPDATE users SET is_active = 0, disabled_at = ? WHERE id = ?').run(1, admin.id);
		expect(() => assertAdminsRemain(h.db)).toThrowError(/at least one active admin/);
	});

	it('404 for an unknown user', async () => {
		const response = await patch('no-such-id', { displayName: 'X' });
		expect(response.status).toBe(404);
		expect((await bodyOf(response)).error.code).toBe('USER_NOT_FOUND');
	});

	it('400 when nothing was asked for, and on a bad field type', async () => {
		expect((await patch(member.id, {})).status).toBe(400);
		expect((await patch(member.id, { isAdmin: 'yes' })).status).toBe(400);
		expect((await patch(member.id, { isActive: 1 })).status).toBe(400);
		expect((await patch(member.id, { displayName: '   ' })).status).toBe(400);
	});
});

describe('POST /api/admin/users/{userId}/reset-password (§3.3, §3.0)', () => {
	it('issues a working temporary password, sets the flag and destroys every session', async () => {
		const session = signIn(h.db, member.id);
		const received: ZembilEvent[] = [];
		subscribe(member.id, session.sessionId, (e) => received.push(e), () => {});

		const response = await resetPasswordRoute(routeEvent({
			params: { userId: member.id },
			...asAdmin()
		}) as any);
		expect(response.status).toBe(200);
		const { temporaryPassword } = await bodyOf(response);
		expect(temporaryPassword).toHaveLength(20);

		expect(resolveSession(h.db, session.token)).toBeNull();
		expect(received).toEqual([{ v: 1, type: 'session.revoked' }]);

		const signedIn = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'ayse', password: temporaryPassword }
		}) as any);
		expect(signedIn.status).toBe(200);
		expect((await bodyOf(signedIn)).mustChangePassword).toBe(true);

		// The old password no longer works.
		const old = await login(routeEvent({
			path: '/api/auth/login',
			body: { username: 'ayse', password: member.password }
		}) as any);
		expect(old.status).toBe(401);
	});

	it('404 for an unknown user', async () => {
		const response = await resetPasswordRoute(routeEvent({
			params: { userId: 'nope' },
			...asAdmin()
		}) as any);
		expect(response.status).toBe(404);
	});
});

describe('DELETE /api/admin/users/{userId}/passkeys (§3.3)', () => {
	it('removes all of that user\'s passkeys and nobody else\'s', async () => {
		const insert = h.db.prepare(
			`INSERT INTO credentials (id, user_id, public_key, counter, transports, device_label,
			                          backed_up, created_at, last_used_at)
			 VALUES (?, ?, ?, 0, NULL, ?, 0, ?, NULL)`
		);
		insert.run('m1', member.id, new Uint8Array([1]), 'iPhone', Date.now());
		insert.run('m2', member.id, new Uint8Array([2]), 'iPad', Date.now());
		insert.run('a1', admin.id, new Uint8Array([3]), 'Laptop', Date.now());

		const response = await adminDeletePasskeys(routeEvent({
			method: 'DELETE',
			params: { userId: member.id },
			...asAdmin()
		}) as any);
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).removed).toBe(2);

		const remaining = h.db.prepare('SELECT id FROM credentials').all() as any[];
		expect(remaining.map((r) => r.id)).toEqual(['a1']);
	});

	it('404 for an unknown user rather than a silent "removed 0"', async () => {
		const response = await adminDeletePasskeys(routeEvent({
			method: 'DELETE',
			params: { userId: 'nope' },
			...asAdmin()
		}) as any);
		expect(response.status).toBe(404);
	});
});

describe('GET /api/me (§3.2)', () => {
	it('returns the caller and only the caller\'s passkeys', async () => {
		const insert = h.db.prepare(
			`INSERT INTO credentials (id, user_id, public_key, counter, transports, device_label,
			                          backed_up, created_at, last_used_at)
			 VALUES (?, ?, ?, 0, NULL, ?, 0, ?, NULL)`
		);
		insert.run('m1', member.id, new Uint8Array([1]), 'iPhone', 1000);
		insert.run('a1', admin.id, new Uint8Array([2]), 'Laptop', 2000);

		const body = await bodyOf(
			await meRoute(routeEvent({ method: 'GET', path: '/api/me', ...asMember() }) as any)
		);
		expect(body.user.id).toBe(member.id);
		expect(body.passkeys.map((p: any) => p.id)).toEqual(['m1']);
		expect(JSON.stringify(body)).not.toContain('scrypt$');
	});

	it('shows an admin their own passkeys, not everybody\'s', async () => {
		h.db
			.prepare(
				`INSERT INTO credentials (id, user_id, public_key, counter, transports, device_label,
				                          backed_up, created_at, last_used_at)
				 VALUES (?, ?, ?, 0, NULL, ?, 0, ?, NULL)`
			)
			.run('m1', member.id, new Uint8Array([1]), 'iPhone', 1000);
		const body = await bodyOf(
			await meRoute(routeEvent({ method: 'GET', path: '/api/me', ...asAdmin() }) as any)
		);
		expect(body.passkeys).toEqual([]);
	});

	it('401 without a session', async () => {
		expect((await meRoute(routeEvent({ method: 'GET', path: '/api/me' }) as any)).status).toBe(401);
	});
});
