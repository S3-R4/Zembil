/** CONTRACT.md §3.2 (passkeys), §1.1 (`credentials`, `webauthn_challenges`), §3.7, D-029. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST as registerOptions } from '../../src/routes/api/auth/passkey/register/options/+server';
import { POST as registerVerify } from '../../src/routes/api/auth/passkey/register/verify/+server';
import { POST as loginOptions } from '../../src/routes/api/auth/passkey/login/options/+server';
import { POST as loginVerify } from '../../src/routes/api/auth/passkey/login/verify/+server';
import { DELETE as deleteOwnPasskeyRoute } from '../../src/routes/api/auth/passkey/[credentialId]/+server';
import { GET as meRoute } from '../../src/routes/api/me/+server';
import { CHALLENGE_TTL_MS, reapExpiredChallenges } from '$lib/server/auth/webauthn';
import { cookieName } from '$lib/server/auth/cookies';
import { resolveSession } from '$lib/server/auth/session';
import { limiters } from '$lib/server/auth/ratelimit';
import { SoftAuthenticator } from './_authenticator';
import {
	authHarness,
	bodyOf,
	fakeCookies,
	localsOf,
	routeEvent,
	seedUser,
	TEST_ORIGIN,
	TEST_RP_ID,
	type AuthHarness,
	type SeededUser
} from './_support';

let h: AuthHarness;
let ayse: SeededUser;

beforeEach(async () => {
	h = authHarness();
	ayse = await seedUser(h.db);
});
afterEach(() => h.close());

const asAyse = () => ({ locals: localsOf(ayse, 'session-1') });

const userHandleOf = (userId: string) =>
	(h.db.prepare('SELECT webauthn_user_handle FROM users WHERE id = ?').get(userId) as any)
		.webauthn_user_handle as Uint8Array;

async function beginRegistration() {
	const response = await registerOptions(routeEvent({
		path: '/api/auth/passkey/register/options',
		...asAyse()
	}) as any);
	expect(response.status).toBe(200);
	return bodyOf(response);
}

async function registerPasskey(device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN }), label = 'iPhone') {
	const { options, challengeId } = await beginRegistration();
	const response = await registerVerify(routeEvent({
		path: '/api/auth/passkey/register/verify',
		body: { challengeId, response: device.register(options.challenge), label },
		...asAyse()
	}) as any);
	return { device, response };
}

describe('registration options (§3.2, D-029)', () => {
	it('pins residentKey:required — the library default would allow a passkey that cannot log in', async () => {
		const { options } = await beginRegistration();
		// v13 defaults residentKey to 'preferred', under which an authenticator may
		// create a NON-discoverable credential. Registration then succeeds, the
		// account screen lists the passkey, and the usernameless login flow — which
		// sends an empty allowCredentials by design — can never find it.
		expect(options.authenticatorSelection.residentKey).toBe('required');
		expect(options.authenticatorSelection.userVerification).toBe('preferred');
	});

	it('uses the account\'s webauthn_user_handle, never the username or an integer', async () => {
		const { options } = await beginRegistration();
		const handle = Buffer.from(userHandleOf(ayse.id));
		expect(options.user.id).toBe(handle.toString('base64url'));
		expect(Buffer.from(options.user.id, 'base64url')).toHaveLength(32);
		expect(options.user.id).not.toBe('ayse');
		expect(options.user.name).toBe('ayse');
	});

	it('names the relying party from the configuration', async () => {
		const { options } = await beginRegistration();
		expect(options.rp).toEqual({ id: TEST_RP_ID, name: 'Zembil' });
	});

	it('excludes credentials the account already has', async () => {
		const before = await beginRegistration();
		expect(before.options.excludeCredentials).toEqual([]);
		const { device } = await registerPasskey();
		const after = await beginRegistration();
		expect(after.options.excludeCredentials.map((c: any) => c.id)).toEqual([
			device.credentialId.toString('base64url')
		]);
	});

	it('stores a single-use challenge row and requires a session', async () => {
		const { challengeId } = await beginRegistration();
		const row = h.db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(challengeId) as any;
		expect(row.purpose).toBe('registration');
		expect(row.user_id).toBe(ayse.id);
		// The literal, not the constant: asserting against CHALLENGE_TTL_MS moves
		// with any change to it and pins nothing. §3.2 wants a short-lived row.
		expect(Number(row.expires_at) - Number(row.created_at)).toBe(5 * 60_000);
		expect(CHALLENGE_TTL_MS).toBe(5 * 60_000);

		const anonymous = await registerOptions(routeEvent({
			path: '/api/auth/passkey/register/options'
		}) as any);
		expect(anonymous.status).toBe(401);
	});
});

describe('registration verify (§3.2)', () => {
	it('registers a real signed credential and returns the Passkey', async () => {
		const { device, response } = await registerPasskey(undefined, '  Ayse’s iPhone  ');
		expect(response.status).toBe(201);
		const { passkey } = await bodyOf(response);
		expect(passkey.id).toBe(device.credentialId.toString('base64url'));
		expect(passkey.deviceLabel).toBe('Ayse’s iPhone'); // trimmed per §3.1c
		expect(passkey.lastUsedAt).toBeNull();
		expect(passkey.createdAt).toBeGreaterThan(0);

		const row = h.db.prepare('SELECT * FROM credentials WHERE id = ?').get(passkey.id) as any;
		expect(row.user_id).toBe(ayse.id);
		expect(row.public_key.byteLength).toBeGreaterThan(30); // the COSE key, raw
		expect(JSON.parse(row.transports)).toContain('internal');
	});

	it('answers 409 for a credential id already registered, not 500', async () => {
		// With attestationType 'none' (D-029) the response is unattested, so the
		// caller names the id. `credentials.id` is a TEXT PRIMARY KEY and the
		// violation used to escape as INTERNAL — §3.1a says a constraint is never
		// what rejects user input. Ownership is unaffected either way: there is no
		// UPSERT, so the original row keeps its user.
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		expect((await registerPasskey(device, 'iPhone')).response.status).toBe(201);

		const again = await registerPasskey(device, 'iPhone again');
		expect(again.response.status).toBe(409);
		expect((await bodyOf(again.response)).error.code).toBe('CREDENTIAL_EXISTS');

		// One row, still owned by the original account, still with its first label.
		const rows = h.db.prepare('SELECT * FROM credentials WHERE id = ?')
			.all(device.credentialId.toString('base64url')) as any[];
		expect(rows).toHaveLength(1);
		expect(rows[0].user_id).toBe(ayse.id);
		expect(rows[0].device_label).toBe('iPhone');
	});

	it('shows up on GET /api/me', async () => {
		await registerPasskey();
		const body = await bodyOf(await meRoute(routeEvent({ method: 'GET', path: '/api/me', ...asAyse() }) as any));
		expect(body.passkeys).toHaveLength(1);
	});

	it('consumes the challenge on FIRST use, so a response cannot be replayed', async () => {
		const { options, challengeId } = await beginRegistration();
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		const attestation = device.register(options.challenge);

		const first = await registerVerify(routeEvent({
			path: '/api/auth/passkey/register/verify',
			body: { challengeId, response: attestation, label: 'iPhone' },
			...asAyse()
		}) as any);
		expect(first.status).toBe(201);

		const replay = await registerVerify(routeEvent({
			path: '/api/auth/passkey/register/verify',
			body: { challengeId, response: attestation, label: 'iPhone again' },
			...asAyse()
		}) as any);
		expect(replay.status).toBe(401);
	});

	it('deletes the challenge even when verification FAILS', async () => {
		const { challengeId } = await beginRegistration();
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		const failed = await registerVerify(routeEvent({
			path: '/api/auth/passkey/register/verify',
			body: { challengeId, response: device.register('a-different-challenge'), label: 'iPhone' },
			...asAyse()
		}) as any);
		expect(failed.status).toBe(401);
		expect(h.db.prepare('SELECT * FROM webauthn_challenges WHERE id = ?').get(challengeId)).toBeUndefined();
	});

	it('rejects an attestation signed for another origin or another rpId', async () => {
		for (const overrides of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }]) {
			const { options, challengeId } = await beginRegistration();
			const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
			const response = await registerVerify(routeEvent({
				path: '/api/auth/passkey/register/verify',
				body: { challengeId, response: device.register(options.challenge, overrides), label: 'x' },
				...asAyse()
			}) as any);
			expect(response.status, JSON.stringify(overrides)).toBe(401);
		}
	});

	it('refuses a challenge that was issued to a different account', async () => {
		const other = await seedUser(h.db, { username: 'mehmet' });
		const { options, challengeId } = await beginRegistration(); // issued to ayse
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		const response = await registerVerify(routeEvent({
			path: '/api/auth/passkey/register/verify',
			body: { challengeId, response: device.register(options.challenge), label: 'x' },
			locals: localsOf(other, 'session-2')
		}) as any);
		expect(response.status).toBe(401);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toMatchObject({ n: 0 });
	});

	it('refuses a REGISTRATION challenge used to authenticate', async () => {
		// The direction that matters. A registration challenge carries a user_id,
		// so without the purpose check `consumeChallenge` would hand it straight to
		// the assertion path and a member could sign in with a challenge that was
		// only ever issued to add a device.
		const { device } = await registerPasskey();
		const { options, challengeId } = await beginRegistration();
		const response = await loginVerify(routeEvent({
			path: '/api/auth/passkey/login/verify',
			body: {
				challengeId,
				response: device.authenticate(options.challenge, userHandleOf(ayse.id))
			}
		}) as any);
		expect(response.status).toBe(401);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toMatchObject({ n: 0 });
	});

	it('refuses an authentication challenge used for registration', async () => {
		const { challengeId } = await bodyOf(
			await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any)
		);
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		const response = await registerVerify(routeEvent({
			path: '/api/auth/passkey/register/verify',
			body: { challengeId, response: device.register('x'), label: 'x' },
			...asAyse()
		}) as any);
		expect(response.status).toBe(401);
	});

	it('requires a 1-64 character label (§3.2)', async () => {
		for (const label of ['', '   ', 'x'.repeat(65), 5, null]) {
			const { options, challengeId } = await beginRegistration();
			const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
			const response = await registerVerify(routeEvent({
				path: '/api/auth/passkey/register/verify',
				body: { challengeId, response: device.register(options.challenge), label },
				...asAyse()
			}) as any);
			expect(response.status, JSON.stringify(label)).toBe(400);
		}
	});
});

describe('login options (§3.2, §3.7)', () => {
	it('sends an EMPTY allowCredentials, which is what makes it enumeration-safe', async () => {
		await registerPasskey();
		const body = await bodyOf(await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any));
		expect(body.options.allowCredentials ?? []).toEqual([]);
		expect(body.options.rpId).toBe(TEST_RP_ID);
	});

	it('answers identically whether or not anybody exists', async () => {
		const shapeOf = (o: any) => Object.keys(o).sort();
		const empty = await bodyOf(await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any));
		await registerPasskey();
		const populated = await bodyOf(await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any));
		expect(shapeOf(populated.options)).toEqual(shapeOf(empty.options));
		expect(populated.options.allowCredentials ?? []).toEqual(empty.options.allowCredentials ?? []);
	});

	it('is rate-limited, because it is public AND writes a row (§3.7)', async () => {
		limiters.passkeyOptionsByIp.reset();
		for (let i = 0; i < 300; i++) {
			const response = await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any);
			expect(response.status, `attempt ${i}`).toBe(200);
		}
		const limited = await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any);
		expect(limited.status).toBe(429);
		expect(limited.headers.get('Retry-After')).toBeTruthy();
	});
});

describe('login verify (§3.2)', () => {
	async function assertLogin(
		device: SoftAuthenticator,
		overrides: Parameters<SoftAuthenticator['authenticate']>[2] = {},
		cookies = fakeCookies()
	) {
		const { options, challengeId } = await bodyOf(
			await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any)
		);
		return loginVerify(routeEvent({
			path: '/api/auth/passkey/login/verify',
			body: {
				challengeId,
				response: device.authenticate(options.challenge, userHandleOf(ayse.id), overrides)
			},
			cookies
		}) as any);
	}

	it('signs the member in with auth_method=passkey and no username anywhere', async () => {
		const { device } = await registerPasskey();
		const cookies = fakeCookies();
		const response = await assertLogin(device, {}, cookies);
		expect(response.status).toBe(200);
		expect((await bodyOf(response)).user.id).toBe(ayse.id);

		const token = cookies.get(cookieName())!;
		const resolved = resolveSession(h.db, token);
		expect(resolved?.user.id).toBe(ayse.id);
		const row = h.db.prepare('SELECT auth_method FROM sessions WHERE id = ?').get(resolved!.sessionId) as any;
		expect(row.auth_method).toBe('passkey');
	});

	it('writes the counter back and stamps last_used_at (§3.2)', async () => {
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN, counter: 0 });
		await registerPasskey(device);
		const before = h.db.prepare('SELECT counter, last_used_at FROM credentials').get() as any;
		expect([before.counter, before.last_used_at]).toEqual([0, null]);

		expect((await assertLogin(device, { counter: 7 })).status).toBe(200);
		const after = h.db.prepare('SELECT counter, last_used_at FROM credentials').get() as any;
		// Without this write the clone check below compares every future assertion
		// against a permanently-zero stored value and can never fire.
		expect(after.counter).toBe(7);
		expect(after.last_used_at).toBeGreaterThan(0);
	});

	it('accepts a permanently-zero counter, which most platform authenticators report', async () => {
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN, counter: 0 });
		await registerPasskey(device);
		expect((await assertLogin(device, { counter: 0 })).status).toBe(200);
		expect((await assertLogin(device, { counter: 0 })).status).toBe(200);
	});

	it('rejects a non-increasing non-zero counter as a possible clone', async () => {
		const device = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		await registerPasskey(device);
		expect((await assertLogin(device, { counter: 5 })).status).toBe(200);
		expect((await assertLogin(device, { counter: 5 })).status).toBe(401);
		expect((await assertLogin(device, { counter: 4 })).status).toBe(401);
		expect((await assertLogin(device, { counter: 6 })).status).toBe(200);
	});

	it('rejects a tampered signature, a foreign origin and a foreign rpId', async () => {
		const { device } = await registerPasskey();
		expect((await assertLogin(device, { tamper: true })).status).toBe(401);
		expect((await assertLogin(device, { origin: 'https://evil.example' })).status).toBe(401);
		expect((await assertLogin(device, { rpId: 'evil.example' })).status).toBe(401);
	});

	it('rejects an unknown credential with the same 401 as everything else', async () => {
		const stranger = new SoftAuthenticator({ rpId: TEST_RP_ID, origin: TEST_ORIGIN });
		const response = await assertLogin(stranger);
		expect(response.status).toBe(401);
		expect((await bodyOf(response)).error.code).toBe('INVALID_CREDENTIALS');
	});

	it('refuses when the owning account is disabled', async () => {
		const { device } = await registerPasskey();
		h.db.prepare('UPDATE users SET is_active = 0, disabled_at = ? WHERE id = ?').run(Date.now(), ayse.id);
		const response = await assertLogin(device);
		expect(response.status).toBe(401);
		expect((await bodyOf(response)).error.code).toBe('INVALID_CREDENTIALS');
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toMatchObject({ n: 0 });
	});

	it('consumes the challenge on first use, success or failure', async () => {
		const { device } = await registerPasskey();
		const { options, challengeId } = await bodyOf(
			await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any)
		);
		const assertion = device.authenticate(options.challenge, userHandleOf(ayse.id));
		const body = { challengeId, response: assertion };
		expect((await loginVerify(routeEvent({ path: '/api/auth/passkey/login/verify', body }) as any)).status).toBe(200);
		expect((await loginVerify(routeEvent({ path: '/api/auth/passkey/login/verify', body }) as any)).status).toBe(401);
	});

	it('refuses an expired challenge regardless of whether the reaper has run', async () => {
		const { device } = await registerPasskey();
		const { options, challengeId } = await bodyOf(
			await loginOptions(routeEvent({ path: '/api/auth/passkey/login/options' }) as any)
		);
		h.db
			.prepare('UPDATE webauthn_challenges SET created_at = ?, expires_at = ? WHERE id = ?')
			.run(Date.now() - 10_000, Date.now() - 1, challengeId);
		const response = await loginVerify(routeEvent({
			path: '/api/auth/passkey/login/verify',
			body: { challengeId, response: device.authenticate(options.challenge, userHandleOf(ayse.id)) }
		}) as any);
		expect(response.status).toBe(401);
	});

	it('refuses a garbage or missing challengeId', async () => {
		const { device } = await registerPasskey();
		for (const challengeId of [undefined, null, '', 5, 'no-such-challenge']) {
			const response = await loginVerify(routeEvent({
				path: '/api/auth/passkey/login/verify',
				body: { challengeId, response: device.authenticate('x', userHandleOf(ayse.id)) }
			}) as any);
			expect(response.status, JSON.stringify(challengeId)).toBe(401);
		}
	});
});

describe('DELETE /api/auth/passkey/{credentialId} (§3.2)', () => {
	it('removes the caller\'s own passkey', async () => {
		const { device } = await registerPasskey();
		const id = device.credentialId.toString('base64url');
		const response = await deleteOwnPasskeyRoute(routeEvent({
			method: 'DELETE',
			params: { credentialId: id },
			...asAyse()
		}) as any);
		expect(response.status).toBe(204);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toMatchObject({ n: 0 });
	});

	it('will not remove somebody else\'s, and says 404 rather than 403', async () => {
		const { device } = await registerPasskey();
		const other = await seedUser(h.db, { username: 'mehmet' });
		const response = await deleteOwnPasskeyRoute(routeEvent({
			method: 'DELETE',
			params: { credentialId: device.credentialId.toString('base64url') },
			locals: localsOf(other, 'session-2')
		}) as any);
		expect(response.status).toBe(404);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM credentials').get()).toMatchObject({ n: 1 });
	});

	it('401 without a session', async () => {
		const response = await deleteOwnPasskeyRoute(routeEvent({
			method: 'DELETE',
			params: { credentialId: 'anything' }
		}) as any);
		expect(response.status).toBe(401);
	});
});

describe('the §3.7 buckets these routes actually consult', () => {
	// `login/options` was the only passkey bucket any test reached through a
	// route. An audit deleted the `enforce(...)` line from `login/verify` and
	// from `register/options` and all 170 auth tests stayed green — D-030's
	// failure mode, twice, on two public-facing brakes.
	//
	// Drained through the limiter rather than by 300 real ceremonies: each of
	// those is an ECDSA verification. If these keys stopped matching what the
	// routes compute, the assertions below fail loudly rather than silently
	// passing.
	const drain = (limiter: { reset: () => void; consume: (k: string) => number | null }) => {
		limiter.reset();
		for (let i = 0; i < 300; i++) {
			expect(limiter.consume('198.51.100.7'), `drain ${i}`).toBeNull();
		}
	};

	it('brakes login/verify on the assertion bucket', async () => {
		drain(limiters.passkeyAssertionByIp);
		const limited = await loginVerify(routeEvent({
			path: '/api/auth/passkey/login/verify',
			body: { challengeId: 'whatever', response: {} }
		}) as any);
		expect(limited.status).toBe(429);
		expect((await bodyOf(limited)).error.code).toBe('RATE_LIMITED');
		expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
	});

	it('brakes register/options on the options bucket, session or no session', async () => {
		// Authenticated, and still braked: this endpoint writes a challenge row,
		// so a signed-in member looping on it is a way to grow the table.
		drain(limiters.passkeyOptionsByIp);
		const limited = await registerOptions(routeEvent({
			path: '/api/auth/passkey/register/options',
			...asAyse()
		}) as any);
		expect(limited.status).toBe(429);
		expect((await bodyOf(limited)).error.code).toBe('RATE_LIMITED');
		expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
	});

	it('keys them by address, so one flooding client cannot lock the family out', async () => {
		drain(limiters.passkeyOptionsByIp);
		const elsewhere = await registerOptions(routeEvent({
			path: '/api/auth/passkey/register/options',
			address: '203.0.113.9',
			...asAyse()
		}) as any);
		expect(elsewhere.status).toBe(200);
	});
});

describe('challenge reaping (§3.7)', () => {
	it('deletes expired rows and leaves live ones', async () => {
		await beginRegistration();
		const { challengeId } = await beginRegistration();
		h.db
			.prepare('UPDATE webauthn_challenges SET created_at = ?, expires_at = ? WHERE id = ?')
			.run(Date.now() - 10_000, Date.now() - 1, challengeId);
		expect(reapExpiredChallenges(h.db)).toBe(1);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get()).toMatchObject({ n: 1 });
	});

	it('cascades when the user row goes', async () => {
		await beginRegistration();
		h.db.prepare('DELETE FROM users WHERE id = ?').run(ayse.id);
		expect(h.db.prepare('SELECT COUNT(*) AS n FROM webauthn_challenges').get()).toMatchObject({ n: 0 });
	});
});
