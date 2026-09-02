/**
 * Push subscriptions — CONTRACT.md §8.7, I-17, §3.1a.
 *
 * The two behaviours here that are security properties rather than
 * conveniences get their own describe blocks: the endpoint MOVING between
 * users, and DELETE never distinguishing "not yours" from "not there".
 */
import { afterEach, describe, expect, test } from 'vitest';
import {
	endpointFor,
	harness,
	makeSubscription,
	makeUser,
	type Harness,
	type TestUser
} from './_support';
import {
	MAX_ENDPOINT_LENGTH,
	MAX_KEY_LENGTH,
	countSubscriptions,
	deleteSubscription,
	hasSubscription,
	listSubscriptions,
	subscriptionStatus,
	truncateUserAgent,
	upsertSubscription,
	validateEndpoint,
	validateSubscriptionInput
} from '$lib/server/push';

let h: Harness | null = null;

afterEach(() => {
	h?.close();
	h = null;
});

function ctx(): { h: Harness; ayse: TestUser; mehmet: TestUser } {
	h = harness();
	return {
		h,
		ayse: makeUser(h.db, { username: 'ayse' }),
		mehmet: makeUser(h.db, { username: 'mehmet' })
	};
}

const input = (endpoint: string, userAgent: string | null = null) => ({
	endpoint,
	p256dh: 'BPublicKeyMaterial',
	auth: 'AuthSecret',
	userAgent
});

describe('validation — §3.1a, before the write', () => {
	const good = 'https://push.example.com/abc';

	test('accepts an https endpoint', () => {
		expect(validateEndpoint(good)).toBe(good);
	});

	test.each([
		['http', 'http://push.example.com/abc'],
		['file', 'file:///etc/passwd'],
		['no scheme', 'push.example.com/abc'],
		['empty', ''],
		['not a url', 'not a url at all']
	])('rejects %s', (_label, value) => {
		expect(() => validateEndpoint(value)).toThrowError(/endpoint/i);
	});

	test('rejects a non-string endpoint', () => {
		for (const value of [null, undefined, 42, {}, ['x']]) {
			expect(() => validateEndpoint(value)).toThrowError(/endpoint/i);
		}
	});

	test(`rejects an endpoint longer than ${MAX_ENDPOINT_LENGTH}`, () => {
		const long = `https://push.example.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`;
		expect(long.length).toBeGreaterThan(MAX_ENDPOINT_LENGTH);
		expect(() => validateEndpoint(long)).toThrowError(/too long/i);
		// And the one-under case is accepted, so the bound is the bound.
		const atLimit = `https://p.example.com/${'a'.repeat(MAX_ENDPOINT_LENGTH - 22)}`;
		expect(atLimit.length).toBe(MAX_ENDPOINT_LENGTH);
		expect(validateEndpoint(atLimit)).toBe(atLimit);
	});

	test('the DDL CHECK is never what rejects an over-long endpoint', () => {
		// §3.1a: a constraint reaching the user is a 500 where the contract
		// promises a 400. Validation runs first, so the insert is never attempted.
		const { h: hh, ayse } = ctx();
		const long = `https://push.example.com/${'a'.repeat(MAX_ENDPOINT_LENGTH)}`;
		expect(() =>
			validateSubscriptionInput({ endpoint: long, keys: { p256dh: 'A', auth: 'B' } })
		).toThrowError(/too long/i);
		expect(countSubscriptions(hh.db, ayse.id)).toBe(0);
	});

	test('rejects empty, over-long and non-base64url keys', () => {
		const body = (p256dh: unknown, auth: unknown) => ({ endpoint: good, keys: { p256dh, auth } });
		expect(() => validateSubscriptionInput(body('', 'A'))).toThrowError(/p256dh/);
		expect(() => validateSubscriptionInput(body('A', ''))).toThrowError(/auth/);
		expect(() => validateSubscriptionInput(body('a'.repeat(MAX_KEY_LENGTH + 1), 'A'))).toThrowError(
			/too long/i
		);
		expect(() => validateSubscriptionInput(body('has spaces', 'A'))).toThrowError(/base64url/);
		expect(() => validateSubscriptionInput(body('has/slash+plus', 'A'))).toThrowError(/base64url/);
		expect(() => validateSubscriptionInput(body(42, 'A'))).toThrowError(/p256dh/);
	});

	test('rejects a missing or non-object keys field', () => {
		expect(() => validateSubscriptionInput({ endpoint: good })).toThrowError(/keys/);
		expect(() => validateSubscriptionInput({ endpoint: good, keys: null })).toThrowError(/keys/);
		expect(() => validateSubscriptionInput({ endpoint: good, keys: ['a'] })).toThrowError(/keys/);
	});

	test('ignores extra fields the browser adds, such as expirationTime', () => {
		const parsed = validateSubscriptionInput({
			endpoint: good,
			expirationTime: null,
			keys: { p256dh: 'ABC', auth: 'DEF', unexpected: 'x' }
		});
		expect(parsed).toEqual({ endpoint: good, p256dh: 'ABC', auth: 'DEF', userAgent: null });
	});

	test('user_agent is truncated to 256 chars, like sessions.user_agent', () => {
		expect(truncateUserAgent('x'.repeat(400))).toHaveLength(256);
		expect(truncateUserAgent('  ')).toBeNull();
		expect(truncateUserAgent(null)).toBeNull();
		expect(truncateUserAgent(undefined)).toBeNull();
	});
});

describe('upsert', () => {
	test('a new endpoint creates a row (201 on the route)', () => {
		const { h: hh, ayse } = ctx();
		const e = endpointFor();
		const result = upsertSubscription(hh.db, ayse.id, input(e, 'Firefox'));
		expect(result.created).toBe(true);
		expect(result.moved).toBe(false);
		expect(countSubscriptions(hh.db, ayse.id)).toBe(1);
		const row = hh.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(e) as any;
		expect(row.user_id).toBe(ayse.id);
		expect(row.user_agent).toBe('Firefox');
		expect(row.failure_count).toBe(0);
	});

	test('re-registering the same endpoint updates rather than duplicating (200)', () => {
		const { h: hh, ayse } = ctx();
		const e = endpointFor();
		upsertSubscription(hh.db, ayse.id, input(e));
		const again = upsertSubscription(hh.db, ayse.id, {
			endpoint: e,
			p256dh: 'NewPublic',
			auth: 'NewAuth',
			userAgent: 'Safari'
		});
		expect(again.created).toBe(false);
		expect(countSubscriptions(hh.db, ayse.id)).toBe(1);
		const row = hh.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(e) as any;
		expect(row.p256dh).toBe('NewPublic');
		expect(row.user_agent).toBe('Safari');
	});

	test('one user may register several devices', () => {
		const { h: hh, ayse } = ctx();
		upsertSubscription(hh.db, ayse.id, input(endpointFor('phone')));
		upsertSubscription(hh.db, ayse.id, input(endpointFor('tablet')));
		expect(countSubscriptions(hh.db, ayse.id)).toBe(2);
		expect(listSubscriptions(hh.db, ayse.id)).toHaveLength(2);
	});
});

describe('I-17 — an endpoint registered to another user MOVES to the caller', () => {
	test('the row changes owner instead of duplicating', () => {
		const { h: hh, ayse, mehmet } = ctx();
		const shared = endpointFor('family-tablet');

		upsertSubscription(hh.db, ayse.id, input(shared));
		expect(countSubscriptions(hh.db, ayse.id)).toBe(1);

		// The same browser profile, now signed in as Mehmet.
		const moved = upsertSubscription(hh.db, mehmet.id, input(shared));

		expect(moved.created).toBe(false);
		expect(moved.moved).toBe(true);
		// The whole point: Ayşe must stop receiving that device's notifications.
		expect(countSubscriptions(hh.db, ayse.id)).toBe(0);
		expect(countSubscriptions(hh.db, mehmet.id)).toBe(1);
		expect(hh.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()).toMatchObject({
			n: 1
		});
	});

	test('the move resets the previous owner’s failure history', () => {
		const { h: hh, ayse, mehmet } = ctx();
		const shared = endpointFor('family-tablet');
		upsertSubscription(hh.db, ayse.id, input(shared));
		hh.db
			.prepare('UPDATE push_subscriptions SET failure_count = 7, last_success_at = 1 WHERE endpoint = ?')
			.run(shared);

		upsertSubscription(hh.db, mehmet.id, input(shared));

		const row = hh.db
			.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?')
			.get(shared) as any;
		expect(row.failure_count).toBe(0);
		expect(row.last_success_at).toBeNull();
	});
});

describe('delete — idempotent, and never a probe', () => {
	test('deleting your own endpoint removes it', () => {
		const { h: hh, ayse } = ctx();
		const e = endpointFor();
		upsertSubscription(hh.db, ayse.id, input(e));
		expect(deleteSubscription(hh.db, ayse.id, e)).toBe(1);
		expect(countSubscriptions(hh.db, ayse.id)).toBe(0);
	});

	test('deleting it twice is idempotent', () => {
		const { h: hh, ayse } = ctx();
		const e = endpointFor();
		upsertSubscription(hh.db, ayse.id, input(e));
		deleteSubscription(hh.db, ayse.id, e);
		expect(deleteSubscription(hh.db, ayse.id, e)).toBe(0);
	});

	test('deleting SOMEBODY ELSE’s endpoint deletes nothing and stays theirs', () => {
		const { h: hh, ayse, mehmet } = ctx();
		const e = endpointFor();
		upsertSubscription(hh.db, ayse.id, input(e));

		// The route reports 200 either way; what must not happen is the row going.
		expect(deleteSubscription(hh.db, mehmet.id, e)).toBe(0);
		expect(countSubscriptions(hh.db, ayse.id)).toBe(1);
	});
});

describe('status', () => {
	test('subscribed and deviceCount are both scoped to the caller', () => {
		const { h: hh, ayse, mehmet } = ctx();
		const mine = endpointFor();
		const theirs = endpointFor();
		makeSubscription(hh.db, ayse.id, mine);
		makeSubscription(hh.db, ayse.id, endpointFor());
		makeSubscription(hh.db, mehmet.id, theirs);

		expect(subscriptionStatus(hh.db, ayse.id, mine)).toEqual({
			subscribed: true,
			deviceCount: 2
		});
		// Another member's endpoint is indistinguishable from one that never existed.
		expect(subscriptionStatus(hh.db, ayse.id, theirs)).toEqual({
			subscribed: false,
			deviceCount: 2
		});
		expect(subscriptionStatus(hh.db, ayse.id, 'https://push.example.com/never')).toEqual({
			subscribed: false,
			deviceCount: 2
		});
		expect(subscriptionStatus(hh.db, ayse.id, null)).toEqual({
			subscribed: false,
			deviceCount: 2
		});
		expect(hasSubscription(hh.db, mehmet.id, mine)).toBe(false);
	});
});
