/** CONTRACT.md §3 (origin check), §5 (security headers), §3.2 (password gate). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHandle } from '$lib/server/auth/handle';
import { cookieName } from '$lib/server/auth/cookies';
import type { Handle } from '@sveltejs/kit';
import {
	authHarness,
	bodyOf,
	cookiesWithSession,
	fakeCookies,
	routeEvent,
	seedUser,
	signIn,
	TEST_ORIGIN,
	type AuthHarness,
	type SeededUser
} from './_support';

let h: AuthHarness;
let ayse: SeededUser;
let handle: Handle;

beforeEach(async () => {
	h = authHarness();
	ayse = await seedUser(h.db);
	handle = createHandle(h.db, h.config);
});
afterEach(() => h.close());

const resolved = async () => new Response('{"ok":true}', { status: 200 });

function run(options: Parameters<typeof routeEvent>[0], resolveFn = resolved) {
	const event = routeEvent(options);
	return (handle as any)({ event, resolve: resolveFn });
}

describe('Origin check (§3)', () => {
	it('allows a mutation carrying the configured origin', async () => {
		const response = await run({ method: 'POST', path: '/api/stores' });
		expect(response.status).toBe(200);
	});

	it('REJECTS a mutation with a missing Origin, never letting it through', async () => {
		const response = await run({ method: 'POST', path: '/api/stores', origin: null });
		expect(response.status).toBe(403);
		expect((await bodyOf(response)).error.code).toBe('ORIGIN_MISMATCH');
	});

	it('rejects a foreign origin', async () => {
		for (const origin of [
			'https://evil.example',
			'https://zembil.test.evil.example',
			'http://zembil.test',
			`${TEST_ORIGIN}.evil`,
			''
		]) {
			const response = await run({ method: 'POST', path: '/api/stores', origin });
			expect(response.status, origin).toBe(403);
		}
	});

	it('covers every mutating method, not only POST', async () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			const response = await run({ method, path: '/api/items/x', origin: null });
			expect(response.status, method).toBe(403);
		}
	});

	it('covers a JSON content type, which SvelteKit\'s own check ignores entirely', async () => {
		const response = await run({
			method: 'POST',
			path: '/api/stores',
			origin: null,
			headers: { 'content-type': 'application/json' }
		});
		expect(response.status).toBe(403);
	});

	it('does not apply to GET', async () => {
		const response = await run({ method: 'GET', path: '/api/stores', origin: null });
		expect(response.status).toBe(200);
	});

	it('exempts GET /api/health alone (§3.8)', async () => {
		expect((await run({ method: 'GET', path: '/api/health', origin: null })).status).toBe(200);
		// And the exemption is the health PATH, not a prefix of it.
		expect(
			(await run({ method: 'POST', path: '/api/healthcheck', origin: null })).status
		).toBe(403);
	});
});

describe('session resolution (§5)', () => {
	it('populates locals.user and locals.sessionId from the cookie', async () => {
		const session = signIn(h.db, ayse.id);
		const event = routeEvent({
			method: 'GET',
			path: '/api/me',
			cookies: cookiesWithSession(session.token)
		});
		await (handle as any)({ event, resolve: resolved });
		expect(event.locals.user.id).toBe(ayse.id);
		expect(event.locals.sessionId).toBe(session.sessionId);
	});

	it('never takes the user from anywhere but the cookie', async () => {
		const event = routeEvent({
			method: 'GET',
			path: '/api/me',
			headers: { 'x-user-id': ayse.id },
			body: undefined
		});
		await (handle as any)({ event, resolve: resolved });
		expect(event.locals.user).toBeNull();
		expect(event.locals.sessionId).toBeNull();
	});

	it('clears a stale cookie rather than leaving the browser sending it', async () => {
		const cookies = fakeCookies({ [cookieName()]: 'not-a-real-token' });
		const event = routeEvent({ method: 'GET', path: '/api/me', cookies });
		await (handle as any)({ event, resolve: resolved });
		expect(event.locals.user).toBeNull();
		expect(cookies.deleted).toContain(cookieName());
	});

	it('refreshes the cookie when the idle window slid', async () => {
		const session = signIn(h.db, ayse.id);
		h.db
			.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?')
			.run(Date.now() - 61 * 60_000, session.sessionId);
		const cookies = cookiesWithSession(session.token);
		cookies.jar.get(cookieName())!.opts = {};
		await (handle as any)({
			event: routeEvent({ method: 'GET', path: '/api/me', cookies }),
			resolve: resolved
		});
		expect(Number(cookies.jar.get(cookieName())!.opts.maxAge)).toBeGreaterThan(29 * 24 * 3600);
	});
});

describe('security headers (§5)', () => {
	it('sets the four headers on every response', async () => {
		const response = await run({ method: 'GET', path: '/api/health', origin: null });
		expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		const permissions = response.headers.get('Permissions-Policy')!;
		// Passkeys break without these two being explicitly allowed.
		expect(permissions).toContain('publickey-credentials-get=(self)');
		expect(permissions).toContain('publickey-credentials-create=(self)');
		expect(permissions).toContain('camera=()');
	});

	it('never sets Content-Security-Policy — kit.csp owns it and nothing else', async () => {
		// A static CSP here either replaces SvelteKit's generated header, losing
		// its inline hydration hash, or is sent as a second header, which a
		// browser intersects — losing the hash either way. The app then renders,
		// never hydrates, and only in the production build.
		const response = await run({ method: 'GET', path: '/', origin: null });
		expect(response.headers.get('Content-Security-Policy')).toBeNull();
	});

	it('sets Cache-Control: no-store for an authenticated request, HTML and JSON alike', async () => {
		const session = signIn(h.db, ayse.id);
		for (const path of ['/api/stores', '/']) {
			const response = await run({
				method: 'GET',
				path,
				cookies: cookiesWithSession(session.token)
			});
			expect(response.headers.get('Cache-Control'), path).toBe('no-store');
		}
	});

	it('does not force no-store on an unauthenticated response', async () => {
		const response = await run({ method: 'GET', path: '/', origin: null });
		expect(response.headers.get('Cache-Control')).toBeNull();
	});

	it('applies the headers to a response the hook itself produced', async () => {
		const response = await run({ method: 'POST', path: '/api/stores', origin: null });
		expect(response.status).toBe(403);
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
	});
});

describe('must_change_password (§3.2)', () => {
	beforeEach(() => {
		h.db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(ayse.id);
	});

	const withFlag = (method: string, path: string, routeId?: string) => {
		const session = signIn(h.db, ayse.id);
		return run({ method, path, routeId, cookies: cookiesWithSession(session.token) });
	};

	it('blocks every other API endpoint with 403 PASSWORD_CHANGE_REQUIRED', async () => {
		for (const [method, path] of [
			['GET', '/api/stores'],
			['POST', '/api/stores'],
			['GET', '/api/events'],
			['GET', '/api/admin/users'],
			['POST', '/api/auth/passkey/register/options']
		] as const) {
			const response = await withFlag(method, path);
			expect(response.status, path).toBe(403);
			expect((await bodyOf(response)).error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
		}
	});

	it('blocks an endpoint reached through a percent-encoded path', async () => {
		// The gate used to read `event.url.pathname`, which SvelteKit leaves
		// encoded, while routing on a decoded copy. `/%61pi/admin/users` does not
		// start with `/api/` and still reaches `/api/admin/users` — an audit
		// confirmed against the production build that a bootstrapped admin who
		// had never changed the password could read the account list and create
		// another admin this way. Every case above uses an already-canonical
		// literal path, so none of them could see it.
		for (const [method, path, routeId] of [
			['GET', '/%61pi/stores', '/api/stores'],
			['GET', '/%61pi/admin/users', '/api/admin/users'],
			['POST', '/%61pi/admin/users', '/api/admin/users'],
			['GET', '/ap%69/stores', '/api/stores'],
			['GET', '/api/stores/%61bc/list', '/api/stores/[storeId]/list']
		] as const) {
			const response = await withFlag(method, path, routeId);
			expect(response.status, path).toBe(403);
			expect((await bodyOf(response)).error.code, path).toBe('PASSWORD_CHANGE_REQUIRED');
		}
	});

	it('blocks a parameterised route, whose id is never its path', async () => {
		// `route.id` carries `[itemId]`, not the value. A gate that compared the
		// id against the exempt set would be fine, but one that assumed id and
		// path are interchangeable would not — pin the distinction.
		const response = await withFlag('POST', '/api/items/xyz/tick', '/api/items/[itemId]/tick');
		expect(response.status).toBe(403);
	});

	it('does not block the public endpoints, which cannot clear or use the flag', async () => {
		// §3.2 makes these public. A flagged session presenting itself at
		// /api/auth/login was being told to change its password before it could
		// sign in. Safe to exempt: the flag is re-read from `users` on every
		// request, so signing in again cannot clear it.
		for (const [method, path] of [
			['POST', '/api/auth/login'],
			['POST', '/api/auth/passkey/login/options'],
			['POST', '/api/auth/passkey/login/verify']
		] as const) {
			expect((await withFlag(method, path)).status, path).toBe(200);
		}
	});

	it('lets through exactly the three endpoints that can clear it, plus health', async () => {
		for (const [method, path] of [
			['GET', '/api/me'],
			['POST', '/api/auth/password'],
			['POST', '/api/auth/logout'],
			['GET', '/api/health']
		] as const) {
			expect((await withFlag(method, path)).status, path).toBe(200);
		}
	});

	it('does not block the HTML shell, which is where the change screen lives', async () => {
		expect((await withFlag('GET', '/')).status).toBe(200);
		expect((await withFlag('GET', '/account')).status).toBe(200);
	});

	it('stops blocking once the flag is cleared', async () => {
		h.db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(ayse.id);
		expect((await withFlag('GET', '/api/stores')).status).toBe(200);
	});

	it('does not apply to an unauthenticated request', async () => {
		expect((await run({ method: 'GET', path: '/api/stores' })).status).toBe(200);
	});
});
