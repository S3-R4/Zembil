/**
 * Push delivery — CONTRACT.md §8.7, and the half of R-21 that decides WHO hears.
 *
 * Nothing is mocked except the outbound HTTPS call. The database, the recipient
 * query, the payload composition and the failure handling are all real, per
 * PROJECT.md §11 — a test that mocked those would be testing the mock. The seam
 * is `setPushTransport`, and it exists only because a unit test cannot dial
 * Apple's push service.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	bodyOf,
	call,
	endpointFor,
	harness,
	localsFor,
	makeStore,
	makeSubscription,
	makeUser,
	type Harness
} from './_support';
import { setDb } from '$lib/server/db';
import { deliverBatch, recipientsFor, resetVapidKeyCache, setPushTransport } from '$lib/server/push';
import type { NotificationBatch } from '$lib/server/notify';

const CONFIG = { pushEnabled: true, vapidSubject: 'mailto:zembil@example.com' };

interface Sent {
	endpoint: string;
	payload: any;
	subject: string;
}

let sent: Sent[] = [];
/** Endpoints the fake push service should reject, and with what status. */
let failures = new Map<string, number>();

beforeEach(() => {
	sent = [];
	failures = new Map();
	resetVapidKeyCache();
	setPushTransport(async (subscription, payload, options) => {
		const status = failures.get(subscription.endpoint);
		if (status !== undefined) {
			// The shape `web-push` rejects with: a `WebPushError` carrying
			// `statusCode`. Anything without one must NOT be read as "gone".
			const err = new Error(`push service said ${status}`) as Error & { statusCode: number };
			err.statusCode = status;
			throw err;
		}
		sent.push({
			endpoint: subscription.endpoint,
			payload: JSON.parse(payload),
			subject: options.vapidDetails.subject
		});
		return { statusCode: 201 };
	});
});

afterEach(() => {
	setPushTransport(null);
	setDb(null);
	resetVapidKeyCache();
});

const batch = (storeId: string, over: Partial<NotificationBatch> = {}): NotificationBatch => ({
	storeId,
	armedAt: Date.now(),
	count: 1,
	names: ['Milk'],
	actorIds: [],
	...over
});

describe('§8.7 — who is notified', () => {
	test('everyone with a subscription, except the people who did the adding', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const ayse = makeUser(h.db, { displayName: 'Ayşe' });
			const baba = makeUser(h.db, { displayName: 'Baba' });
			const dede = makeUser(h.db, { displayName: 'Dede' });
			const store = makeStore(h.db);
			makeSubscription(h.db, ayse.id);
			makeSubscription(h.db, baba.id);
			makeSubscription(h.db, dede.id);

			const report = await deliverBatch(h.db, CONFIG, batch(store.id, { actorIds: [ayse.id] }));

			expect(report.recipients).toBe(2);
			expect(report.delivered).toBe(2);
			// The person who typed it does not get told about it.
			expect(sent.some((s) => s.endpoint.includes('never'))).toBe(false);
			expect(report.skipped).toBe(null);
		} finally {
			h.close();
		}
	});

	test('a deactivated member is not notified', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const gone = makeUser(h.db, { isActive: false });
			const here = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, gone.id);
			makeSubscription(h.db, here.id);

			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.recipients).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a member with no subscription is not a recipient', async () => {
		const h = harness();
		try {
			setDb(h.db);
			makeUser(h.db);
			const subscribed = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, subscribed.id);

			expect(recipientsFor(h.db, store.id, []).length).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a PRIVATE store notifies nobody', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const owner = makeUser(h.db);
			const other = makeUser(h.db);
			const store = makeStore(h.db, 'Eczane', owner.id);
			makeSubscription(h.db, owner.id);
			makeSubscription(h.db, other.id);

			// §8.4 applied to the recipient query. The only person who can see the
			// store is the person adding to it, so the set is empty by construction
			// — this looks like a bug when you meet it and is the whole point.
			const report = await deliverBatch(h.db, CONFIG, batch(store.id, { actorIds: [owner.id] }));
			expect(report.recipients).toBe(0);
			expect(report.skipped).toBe('no-recipients');
			expect(sent).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('a private store does not notify the OTHER members even if the owner is not a contributor', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const owner = makeUser(h.db);
			const other = makeUser(h.db);
			const store = makeStore(h.db, 'Eczane', owner.id);
			makeSubscription(h.db, other.id);

			// An empty `actorIds` is the harshest case: nothing excludes anyone, so
			// only visibility can keep `other` out.
			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.recipients).toBe(0);
		} finally {
			h.close();
		}
	});

	test('a store that vanished during the quiet window notifies nobody', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			makeSubscription(h.db, user.id);
			const report = await deliverBatch(h.db, CONFIG, batch('no-such-store'));
			expect(report.skipped).toBe('store-gone');
		} finally {
			h.close();
		}
	});
});

describe('§8.7 — the payload', () => {
	test('is composed per recipient in that recipient own locale', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const tr = makeUser(h.db, { locale: 'tr' });
			const de = makeUser(h.db, { locale: 'de' });
			const en = makeUser(h.db, { locale: 'en' });
			const store = makeStore(h.db, 'Migros');
			makeSubscription(h.db, tr.id, endpointFor('tr'));
			makeSubscription(h.db, de.id, endpointFor('de'));
			makeSubscription(h.db, en.id, endpointFor('en'));

			await deliverBatch(h.db, CONFIG, batch(store.id, { count: 4, names: ['Süt', 'Ekmek'] }));

			const byLang = Object.fromEntries(
				sent.map((s) => [s.endpoint.split('/')[3], s.payload.body])
			);
			// Three different strings for one batch — which is why composition is
			// inside the recipient loop and not above it.
			expect(new Set(Object.values(byLang)).size).toBe(3);
			expect(byLang.tr).toContain('daha');
			expect(byLang.de).toMatch(/weitere|weiterer/);
			expect(byLang.en).toContain('more');
		} finally {
			h.close();
		}
	});

	test('carries the store name resolved at DELIVERY time', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db, 'Migros');
			makeSubscription(h.db, user.id);

			// Renamed after the batch was armed. The notification must say what the
			// shop is called now, not what it was called when somebody typed.
			h.db.prepare('UPDATE stores SET name = ? WHERE id = ?').run('BİM', store.id);
			await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(sent[0].payload.title).toBe('BİM');
		} finally {
			h.close();
		}
	});

	test('carries no ids, and points at the list', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const author = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, user.id);

			await deliverBatch(h.db, CONFIG, batch(store.id, { actorIds: [author.id] }));
			const raw = JSON.stringify(sent[0].payload);
			expect(raw).not.toContain(user.id);
			expect(raw).not.toContain(author.id);
			expect(sent[0].payload.data.url).toBe(`/s/${store.id}`);
		} finally {
			h.close();
		}
	});
});

describe('§8.7 — failures never reach the person who triggered them', () => {
	test('410 deletes the subscription row immediately', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			const endpoint = endpointFor('dead');
			makeSubscription(h.db, user.id, endpoint);
			failures.set(endpoint, 410);

			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.pruned).toBe(1);
			const n = Number(
				(h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n
			);
			expect(n).toBe(0);
		} finally {
			h.close();
		}
	});

	test('404 does the same', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			const endpoint = endpointFor('gone');
			makeSubscription(h.db, user.id, endpoint);
			failures.set(endpoint, 404);
			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.pruned).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a 500 increments failure_count and KEEPS the row', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			const endpoint = endpointFor('flaky');
			const id = makeSubscription(h.db, user.id, endpoint);
			failures.set(endpoint, 500);

			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.failed).toBe(1);
			expect(report.pruned).toBe(0);
			const row = h.db
				.prepare('SELECT failure_count FROM push_subscriptions WHERE id = ?')
				.get(id) as any;
			expect(Number(row.failure_count)).toBe(1);
		} finally {
			h.close();
		}
	});

	test('an error with NO status code is not treated as gone', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, user.id);
			// A DNS failure or a socket timeout. Deleting a live subscription
			// because the network blipped is the failure this distinction prevents.
			setPushTransport(async () => {
				throw new Error('getaddrinfo ENOTFOUND');
			});

			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.pruned).toBe(0);
			expect(report.failed).toBe(1);
			const n = Number(
				(h.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as any).n
			);
			expect(n).toBe(1);
		} finally {
			h.close();
		}
	});

	test('deliverBatch never rejects, whatever the transport does', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, user.id);
			setPushTransport(() => {
				throw new Error('synchronous explosion');
			});
			// R-21's promise: a push failure is never visible to the person whose
			// write triggered it, and "never" includes a bug in this module.
			await expect(deliverBatch(h.db, CONFIG, batch(store.id))).resolves.toBeDefined();
		} finally {
			h.close();
		}
	});

	test('one dead device does not stop the next one being delivered to', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			const dead = endpointFor('dead');
			const live = endpointFor('live');
			makeSubscription(h.db, user.id, dead);
			makeSubscription(h.db, user.id, live);
			failures.set(dead, 410);

			const report = await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(report.delivered).toBe(1);
			expect(report.pruned).toBe(1);
			expect(sent.map((s) => s.endpoint)).toEqual([live]);
		} finally {
			h.close();
		}
	});
});

describe('§8.7 — the operator switches', () => {
	test('pushEnabled:false sends nothing', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, user.id);
			const report = await deliverBatch(h.db, { ...CONFIG, pushEnabled: false }, batch(store.id));
			expect(report.skipped).toBe('disabled');
			expect(sent).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('a null VAPID subject sends nothing rather than composing an invalid JWT', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, user.id);
			// The local-development case: a plain-http origin yields no valid
			// contact URI, and RFC 8292 admits no other kind.
			const report = await deliverBatch(h.db, { ...CONFIG, vapidSubject: null }, batch(store.id));
			expect(report.skipped).toBe('no-vapid-subject');
			expect(sent).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('the configured subject is what reaches the transport', async () => {
		const h = harness();
		try {
			setDb(h.db);
			const user = makeUser(h.db);
			const store = makeStore(h.db);
			makeSubscription(h.db, user.id);
			await deliverBatch(h.db, CONFIG, batch(store.id));
			expect(sent[0].subject).toBe('mailto:zembil@example.com');
		} finally {
			h.close();
		}
	});
});
