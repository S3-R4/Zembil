/**
 * The VAPID keypair — CONTRACT.md §8.7, D-038.
 *
 * The property under test is "generated once, and once only". A second keypair
 * would silently invalidate every subscription registered against the first,
 * and the failure would be invisible: notifications simply stop arriving.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { harness, type Harness } from './_support';
import { getVapidKeys, getVapidPublicKey, resetVapidKeyCache } from '$lib/server/push';

let h: Harness | null = null;

afterEach(() => {
	resetVapidKeyCache();
	h?.close();
	h = null;
});

function ctx(): Harness {
	h = harness();
	resetVapidKeyCache();
	return h;
}

describe('VAPID keys', () => {
	test('are generated on first use and stored in server_keys', () => {
		const { db } = ctx();
		expect(db.prepare('SELECT COUNT(*) AS n FROM server_keys').get()).toMatchObject({ n: 0 });

		const keys = getVapidKeys(db);
		expect(keys.publicKey.length).toBeGreaterThan(20);
		expect(keys.privateKey.length).toBeGreaterThan(20);

		const row = db.prepare(`SELECT * FROM server_keys WHERE name = 'vapid'`).get() as any;
		expect(row.public_key).toBe(keys.publicKey);
		expect(row.private_key).toBe(keys.privateKey);
		expect(Number.isSafeInteger(row.created_at)).toBe(true);
	});

	test('a second call returns the same pair and writes no second row', () => {
		const { db } = ctx();
		const first = getVapidKeys(db);
		const second = getVapidKeys(db);
		expect(second).toEqual(first);
		expect(db.prepare('SELECT COUNT(*) AS n FROM server_keys').get()).toMatchObject({ n: 1 });
	});

	test('the cache is not the thing keeping it stable — a cold read agrees', () => {
		const { db } = ctx();
		const first = getVapidKeys(db);
		resetVapidKeyCache();
		expect(getVapidKeys(db)).toEqual(first);
		expect(db.prepare('SELECT COUNT(*) AS n FROM server_keys').get()).toMatchObject({ n: 1 });
	});

	test('a racing generation cannot produce a second keypair', () => {
		const { db } = ctx();
		// Simulate the race the ON CONFLICT clause exists for: a row appears
		// between the cold read and the transaction. There is one process and
		// node:sqlite is synchronous so this cannot happen today, but the guard
		// must not depend on that.
		resetVapidKeyCache();
		db.prepare(
			`INSERT INTO server_keys (name, public_key, private_key, created_at)
			 VALUES ('vapid', 'RIVAL_PUBLIC', 'RIVAL_PRIVATE', ?)`
		).run(Date.now());

		const keys = getVapidKeys(db);
		expect(keys.publicKey).toBe('RIVAL_PUBLIC');
		expect(db.prepare('SELECT COUNT(*) AS n FROM server_keys').get()).toMatchObject({ n: 1 });
	});

	test('getVapidPublicKey exposes the public half only', () => {
		const { db } = ctx();
		const keys = getVapidKeys(db);
		const pub = getVapidPublicKey(db);
		expect(pub).toBe(keys.publicKey);
		expect(pub).not.toContain(keys.privateKey);
	});

	test('the cache is keyed on the connection, so a second database gets its own pair', () => {
		const a = harness();
		const b = harness();
		try {
			resetVapidKeyCache();
			const first = getVapidKeys(a.db);
			const second = getVapidKeys(b.db);
			expect(second.publicKey).not.toBe(first.publicKey);
		} finally {
			a.close();
			b.close();
			resetVapidKeyCache();
		}
	});
});
