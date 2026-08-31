/**
 * R-11 (concurrent close) and R-12 (add racing close).
 *
 * §1.1a mandates ONE connection in the application, so two closes cannot
 * interleave in-process and a purely sequential test would still pass with
 * `BEGIN IMMEDIATE` removed. These tests therefore open a SECOND `DatabaseSync`
 * handle on the same file so the serialization path is actually exercised.
 */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, makeUser, type Harness } from './_support';
import { checkAll } from './_invariants';
import { createStore } from '$lib/server/domain/stores';
import { addItem, getOpenList } from '$lib/server/domain/items';
import { closeTrip } from '$lib/server/domain/trips';
import { isDomainError } from '$lib/server/domain/errors';

const openTrip = (h: Harness, storeId: string): string =>
	(h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any).id;

function ctx() {
	// A short busy_timeout keeps the "the writer is genuinely locked out" tests
	// fast. Production is 5000 (asserted in tests/db/schema.test.ts).
	const h = harness({ busyTimeout: 80 });
	const actor = makeUser(h.db);
	const store = createStore(h.db, { name: 'Migros' }, actor);
	return { h, actor, store };
}

describe('R-11 — concurrent close', () => {
	test('a second handle holding BEGIN IMMEDIATE actually locks the close out', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const tripId = openTrip(h, store.id);

			const rival = h.second({ busyTimeout: 80 });
			rival.exec('BEGIN IMMEDIATE');
			try {
				let caught: any;
				try {
					closeTrip(h.db, store.id, { tripId }, actor);
				} catch (err) {
					caught = err;
				}
				// Correctness comes from the transaction, not from hoping: while the
				// rival holds the write lock, our close cannot start at all.
				expect(caught).toBeDefined();
				expect(caught.code).toBe('ERR_SQLITE_ERROR');
				expect(String(caught.message)).toMatch(/database is locked|busy/i);
			} finally {
				rival.exec('ROLLBACK');
			}

			// Nothing was half-written: the trip is still open and there is no successor.
			const trips = h.db.prepare('SELECT * FROM trips WHERE store_id = ?').all(store.id) as any[];
			expect(trips).toHaveLength(1);
			expect(trips[0].status).toBe('open');
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('the loser of two closes gets 409 TRIP_ALREADY_CLOSED with the right openTripId, and there is exactly one successor', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const tripId = openTrip(h, store.id);

			// The rival is a genuinely separate connection running the same close.
			const rival = h.second({ busyTimeout: 80 });
			const winner = closeTrip(rival, store.id, { tripId }, actor);

			let caught: any;
			try {
				closeTrip(h.db, store.id, { tripId }, actor);
			} catch (err) {
				caught = err;
			}
			expect(isDomainError(caught)).toBe(true);
			expect(caught.code).toBe('TRIP_ALREADY_CLOSED');
			expect(caught.status).toBe(409);
			expect(caught.extra).toEqual({ openTripId: winner.newTrip.id });

			const open = h.db
				.prepare(`SELECT COUNT(*) AS n FROM trips WHERE store_id=? AND status='open'`)
				.get(store.id) as any;
			expect(Number(open.n)).toBe(1);
			const all = h.db.prepare('SELECT COUNT(*) AS n FROM trips WHERE store_id=?').get(store.id) as any;
			expect(Number(all.n)).toBe(2); // never two successors
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('two closes racing on the same store produce exactly one clone per pending item', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor);
			const tripId = openTrip(h, store.id);

			const rival = h.second({ busyTimeout: 80 });
			closeTrip(rival, store.id, { tripId }, actor);
			try {
				closeTrip(h.db, store.id, { tripId }, actor);
			} catch {
				/* expected: TRIP_ALREADY_CLOSED */
			}

			const clones = h.db
				.prepare('SELECT COUNT(*) AS n FROM items WHERE carried_from_item_id IS NOT NULL')
				.get() as any;
			expect(Number(clones.n)).toBe(2);
			expect(getOpenList(h.db, store.id).items).toHaveLength(2);
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});
});

describe('R-12 — an add racing a close is never lost, in either ordering', () => {
	test('an add that commits BEFORE the close carries over', () => {
		const { h, actor, store } = ctx();
		try {
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const result = closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			expect(result.carriedCount).toBe(1);
			const original = h.db.prepare('SELECT * FROM items WHERE id = ?').get(added.item.id) as any;
			expect(original.state).toBe('carried');
			const list = getOpenList(h.db, store.id);
			expect(list.items.map((i) => i.name)).toEqual(['Milk']);
			expect(list.items[0].id).not.toBe(added.item.id);
			expect(list.trip.id).toBe(result.newTrip.id);
		} finally {
			h.close();
		}
	});

	test('an add that commits AFTER the close lands on the successor trip', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor);
			const result = closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			expect(added.item.tripId).toBe(result.newTrip.id);
			expect(getOpenList(h.db, store.id).items.map((i) => i.name)).toEqual(['Bread', 'Milk']);
		} finally {
			h.close();
		}
	});

	test('an add attempted while a rival close holds the write lock is serialized, and the retry lands exactly once', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor);
			const tripId = openTrip(h, store.id);
			const clientId = randomUUID();

			// The rival's close transaction is open and uncommitted.
			const rival = h.second({ busyTimeout: 80 });
			rival.exec('BEGIN IMMEDIATE');
			rival
				.prepare(`UPDATE trips SET status='closed', closed_at=?, closed_by=? WHERE id=?`)
				.run(Date.now(), actor.id, tripId);

			let addFailed = false;
			try {
				addItem(h.db, store.id, { name: 'Milk', clientId }, actor);
			} catch {
				addFailed = true;
			}
			expect(addFailed).toBe(true);

			// The close aborts; the phone retries the same compose.
			rival.exec('ROLLBACK');
			const retry = addItem(h.db, store.id, { name: 'Milk', clientId }, actor);
			expect(retry.created).toBe(true);

			// And once more, this time after a real close: R-17 means the retry
			// resolves to the clone rather than adding a duplicate.
			closeTrip(h.db, store.id, { tripId }, actor);
			const afterClose = addItem(h.db, store.id, { name: 'Milk', clientId }, actor);
			expect(afterClose.created).toBe(false);

			const live = h.db
				.prepare(
					`SELECT COUNT(*) AS n FROM items
					  WHERE store_id=? AND client_id=? AND state <> 'carried' AND deleted_at IS NULL`
				)
				.get(store.id, clientId) as any;
			expect(Number(live.n)).toBe(1);
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});
});
