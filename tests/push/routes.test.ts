/**
 * The `/api/push/*` routes — CONTRACT.md §8.7.
 *
 * The handlers are called directly with a minimal RequestEvent, the way
 * `tests/domain/routes.test.ts` does. `getConfig()` reads `process.env`, so each
 * test sets the environment it needs and resets the cached config afterwards.
 *
 * PROJECT.md §11 warns that "the route seam deserves its own pass": a guard
 * reachable only through a query string or a raw JSON body is exercised by no
 * domain-level test, however thorough. Everything below is that seam.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	bodyOf,
	call,
	endpointFor,
	harness,
	jsonRequest,
	localsFor,
	makeSubscription,
	makeUser
} from './_support';
import { setDb } from '$lib/server/db';
import { resetConfig } from '$lib/server/auth/config';
import { resetAllLimiters } from '$lib/server/auth/ratelimit';
import { MAX_SUBSCRIPTIONS_PER_USER, getVapidKeys, resetVapidKeyCache } from '$lib/server/push';

import * as keyRoute from '../../src/routes/api/push/key/+server';
import * as subRoute from '../../src/routes/api/push/subscription/+server';

const ORIGIN = 'https://zembil.example.com';

beforeEach(() => {
	process.env.ZEMBIL_ORIGIN = ORIGIN;
	delete process.env.ZEMBIL_PUSH_ENABLED;
	resetConfig();
	resetVapidKeyCache();
	resetAllLimiters();
});

afterEach(() => {
	resetAllLimiters();
	setDb(null);
	resetConfig();
	resetVapidKeyCache();
	delete process.env.ZEMBIL_PUSH_ENABLED;
});

const url = (query = '') => new URL(`http://localhost/api/push/subscription${query}`);

function ctx() {
	const h = harness();
	setDb(h.db);
	const user = makeUser(h.db);
	return { h, user, locals: localsFor(user) };
}

const validBody = (endpoint = endpointFor()) => ({
	endpoint,
	keys: { p256dh: 'BPublicKeyMaterialAAAA', auth: 'AuthSecretAAAA' }
});

describe('GET /api/push/key', () => {
	test('returns a public key and provisions the pair on first call', async () => {
		const { h, locals } = ctx();
		try {
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM server_keys').get() as any).n)
			).toBe(0);

			const res = await call(keyRoute.GET, { locals });
			expect(res.status).toBe(200);
			const body = await bodyOf(res);
			expect(typeof body.publicKey).toBe('string');
			expect(body.publicKey.length).toBeGreaterThan(20);

			// D-038: generated on first use, so there is nothing to provision.
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM server_keys').get() as any).n)
			).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a second call returns the SAME key — a new pair would orphan every subscription', async () => {
		const { h, locals } = ctx();
		try {
			const first = (await bodyOf(await call(keyRoute.GET, { locals }))).publicKey;
			resetVapidKeyCache();
			const second = (await bodyOf(await call(keyRoute.GET, { locals }))).publicKey;
			expect(second).toBe(first);
		} finally {
			h.close();
		}
	});

	test('requires a session', async () => {
		const { h } = ctx();
		try {
			const res = await call(keyRoute.GET, { locals: localsFor(null) });
			expect(res.status).toBe(401);
		} finally {
			h.close();
		}
	});

	test('503 PUSH_DISABLED when the operator turned push off', async () => {
		process.env.ZEMBIL_PUSH_ENABLED = '0';
		resetConfig();
		const { h, locals } = ctx();
		try {
			const res = await call(keyRoute.GET, { locals });
			expect(res.status).toBe(503);
			expect((await bodyOf(res)).error.code).toBe('PUSH_DISABLED');
		} finally {
			h.close();
		}
	});
});

describe('the private key never leaves the server', () => {
	test('no /api/push/* response body contains it', async () => {
		const { h, user, locals } = ctx();
		try {
			const { privateKey } = getVapidKeys(h.db);
			expect(privateKey.length).toBeGreaterThan(20);

			const endpoint = endpointFor();
			const bodies = [
				await (await call(keyRoute.GET, { locals })).text(),
				await (await call(subRoute.GET, { locals, url: url() })).text(),
				await (
					await call(subRoute.POST, { locals, request: jsonRequest(validBody(endpoint)) })
				).text(),
				await (
					await call(subRoute.DELETE, {
						locals,
						request: jsonRequest({ endpoint }, 'DELETE')
					})
				).text()
			];

			// A structural assertion, in the spirit of D-037: the property is real,
			// load-bearing, and invisible to any test that only checks the shape of
			// a successful response.
			for (const body of bodies) expect(body).not.toContain(privateKey);
			expect(user.id).toBeTruthy();
		} finally {
			h.close();
		}
	});
});

describe('POST /api/push/subscription', () => {
	test('201 on a new registration, 200 on a repeat', async () => {
		const { h, locals } = ctx();
		try {
			const body = validBody();
			const first = await call(subRoute.POST, { locals, request: jsonRequest(body) });
			expect(first.status).toBe(201);
			const second = await call(subRoute.POST, { locals, request: jsonRequest(body) });
			expect(second.status).toBe(200);
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n)
			).toBe(1);
		} finally {
			h.close();
		}
	});

	test('an endpoint registered to ANOTHER member moves to the caller (I-17)', async () => {
		const { h, user, locals } = ctx();
		try {
			const previous = makeUser(h.db);
			const endpoint = endpointFor('shared-browser');
			makeSubscription(h.db, previous.id, endpoint);

			// The same browser profile, signed in as somebody else. Leaving the row
			// where it was would keep sending this device's notifications to the
			// member who last used it.
			const res = await call(subRoute.POST, {
				locals,
				request: jsonRequest(validBody(endpoint))
			});
			expect(res.status).toBe(200);

			const row = h.db
				.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?')
				.get(endpoint) as any;
			expect(row.user_id).toBe(user.id);
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n)
			).toBe(1);
		} finally {
			h.close();
		}
	});

	test.each([
		['a non-https endpoint', { ...validBody(), endpoint: 'http://push.example.com/x' }],
		['a non-URL endpoint', { ...validBody(), endpoint: 'not-a-url' }],
		['an over-long endpoint', { ...validBody(), endpoint: `https://p.example.com/${'x'.repeat(2100)}` }],
		['a missing endpoint', { keys: { p256dh: 'a', auth: 'b' } }],
		['missing keys', { endpoint: 'https://push.example.com/a' }],
		['an empty p256dh', { endpoint: 'https://push.example.com/a', keys: { p256dh: '', auth: 'b' } }],
		['an over-long auth', { endpoint: 'https://push.example.com/a', keys: { p256dh: 'a', auth: 'x'.repeat(300) } }],
		['a non-object keys', { endpoint: 'https://push.example.com/a', keys: 'nope' }]
	])('400 VALIDATION_FAILED for %s, and nothing is written', async (_label, body) => {
		const { h, locals } = ctx();
		try {
			const res = await call(subRoute.POST, { locals, request: jsonRequest(body) });
			expect(res.status).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n)
			).toBe(0);
		} finally {
			h.close();
		}
	});

	test('requires a session', async () => {
		const { h } = ctx();
		try {
			const res = await call(subRoute.POST, {
				locals: localsFor(null),
				request: jsonRequest(validBody())
			});
			expect(res.status).toBe(401);
		} finally {
			h.close();
		}
	});
});

describe('GET /api/push/subscription', () => {
	test('scopes both fields to the caller', async () => {
		const { h, user, locals } = ctx();
		try {
			const stranger = makeUser(h.db);
			makeSubscription(h.db, stranger.id);
			makeSubscription(h.db, stranger.id);
			const mine = endpointFor('mine');
			makeSubscription(h.db, user.id, mine);

			const res = await call(subRoute.GET, { locals, url: url(`?endpoint=${encodeURIComponent(mine)}`) });
			const body = await bodyOf(res);
			expect(body.subscribed).toBe(true);
			// Never a count across the table.
			expect(body.deviceCount).toBe(1);
		} finally {
			h.close();
		}
	});

	test("another member's endpoint reads as NOT subscribed, not as a probe result", async () => {
		const { h, locals } = ctx();
		try {
			const stranger = makeUser(h.db);
			const theirs = endpointFor('theirs');
			makeSubscription(h.db, stranger.id, theirs);

			const res = await call(subRoute.GET, {
				locals,
				url: url(`?endpoint=${encodeURIComponent(theirs)}`)
			});
			// If this said `true`, the endpoint would be an oracle for "is this
			// device registered to anyone in the family?".
			expect((await bodyOf(res)).subscribed).toBe(false);
		} finally {
			h.close();
		}
	});

	test('no endpoint parameter is subscribed:false, not an error', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(subRoute.GET, { locals, url: url() });
			expect(res.status).toBe(200);
			expect((await bodyOf(res)).subscribed).toBe(false);
		} finally {
			h.close();
		}
	});
});

describe('DELETE /api/push/subscription', () => {
	test('removes the caller own row and is idempotent', async () => {
		const { h, user, locals } = ctx();
		try {
			const endpoint = endpointFor();
			makeSubscription(h.db, user.id, endpoint);

			const first = await call(subRoute.DELETE, {
				locals,
				request: jsonRequest({ endpoint }, 'DELETE')
			});
			expect(first.status).toBe(200);
			const second = await call(subRoute.DELETE, {
				locals,
				request: jsonRequest({ endpoint }, 'DELETE')
			});
			expect(second.status).toBe(200);
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n)
			).toBe(0);
		} finally {
			h.close();
		}
	});

	test("another member's endpoint is a 200 that deletes nothing", async () => {
		const { h, locals } = ctx();
		try {
			const stranger = makeUser(h.db);
			const theirs = endpointFor('theirs');
			makeSubscription(h.db, stranger.id, theirs);

			const res = await call(subRoute.DELETE, {
				locals,
				request: jsonRequest({ endpoint: theirs }, 'DELETE')
			});
			// Not a 404 and not a 403: reporting the difference would let a member
			// probe for another member's devices.
			expect(res.status).toBe(200);
			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n)
			).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a malformed endpoint is still a 400', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(subRoute.DELETE, {
				locals,
				request: jsonRequest({ endpoint: 'nope' }, 'DELETE')
			});
			expect(res.status).toBe(400);
		} finally {
			h.close();
		}
	});
});

describe('§8.7 — one member cannot make the subscription table unbounded', () => {
	/**
	 * The M6 audit found this endpoint was the one place an authenticated member
	 * could create rows without limit: `endpoint` is a client-supplied URL and is
	 * the row's identity, so every distinct URL is a new row — and `deliverBatch`
	 * later makes one serial outbound HTTPS request per row, to hosts the member
	 * chose. Same reasoning, and the same shape of cap, as MAX_ITEMS_PER_TRIP.
	 */
	test(`the ${MAX_SUBSCRIPTIONS_PER_USER + 1}th device is 409 PUSH_DEVICE_LIMIT`, async () => {
		const { h, locals } = ctx();
		try {
			for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i += 1) {
				const res = await call(subRoute.POST, {
					locals,
					request: jsonRequest(validBody(endpointFor(`d${i}`)))
				});
				expect(res.status, `device ${i}`).toBe(201);
			}

			const over = await call(subRoute.POST, {
				locals,
				request: jsonRequest(validBody(endpointFor('one-too-many')))
			});
			expect(over.status).toBe(409);
			expect((await bodyOf(over)).error.code).toBe('PUSH_DEVICE_LIMIT');

			expect(
				Number((h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n)
			).toBe(MAX_SUBSCRIPTIONS_PER_USER);
		} finally {
			h.close();
		}
	});

	test('a repeat registration still succeeds AT the limit — it writes no new row', async () => {
		const { h, locals } = ctx();
		try {
			const first = endpointFor('kept');
			await call(subRoute.POST, { locals, request: jsonRequest(validBody(first)) });
			for (let i = 1; i < MAX_SUBSCRIPTIONS_PER_USER; i += 1) {
				await call(subRoute.POST, { locals, request: jsonRequest(validBody(endpointFor(`d${i}`))) });
			}

			// Exactly R-17's shape: an idempotent repeat must not be refused by a
			// cap it does not push against.
			const again = await call(subRoute.POST, { locals, request: jsonRequest(validBody(first)) });
			expect(again.status).toBe(200);
		} finally {
			h.close();
		}
	});

	test('the cap is per member, not global', async () => {
		const { h, locals } = ctx();
		try {
			for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i += 1) {
				await call(subRoute.POST, { locals, request: jsonRequest(validBody(endpointFor(`a${i}`))) });
			}
			const other = makeUser(h.db);
			const res = await call(subRoute.POST, {
				locals: localsFor(other, 'session-2'),
				request: jsonRequest(validBody(endpointFor('theirs')))
			});
			expect(res.status).toBe(201);
		} finally {
			h.close();
		}
	});

	test('registering in a tight loop is rate limited, with Retry-After', async () => {
		const { h, locals } = ctx();
		try {
			let limited: Response | null = null;
			// Well past the bucket, and past the row cap too — whichever bites
			// first, the loop must not be able to run unbounded.
			for (let i = 0; i < 60 && limited === null; i += 1) {
				const res = await call(subRoute.POST, {
					locals,
					request: jsonRequest(validBody(endpointFor(`flood${i}`)))
				});
				if (res.status === 429) limited = res;
			}
			expect(limited, 'the flood was never rate limited').not.toBe(null);
			expect((await bodyOf(limited!)).error.code).toBe('RATE_LIMITED');
			// §3.7: the header, which cannot ride in the envelope.
			expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0);
		} finally {
			h.close();
		}
	});
});
