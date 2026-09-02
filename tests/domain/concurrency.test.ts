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
import type { Db } from '$lib/server/db';

const openTrip = (h: Harness, storeId: string): string =>
	(h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any).id;

/**
 * Intercepts the FIRST call to the exact SQL text R-6 step 1 uses to re-read
 * the trip, and runs `onRead` synchronously in the gap BEFORE the real
 * statement executes — i.e. after this transaction's read but before its
 * write. This is how the race is constructed deterministically in a
 * single-threaded, synchronous `node:sqlite` process: there is no other way
 * to land a second connection's full transaction inside one statement's gap
 * without controlling exactly which statement triggers it.
 *
 * `db.prepare(...)` and every returned `Statement` method is invoked with the
 * REAL connection as `this`, never the proxy — `node:sqlite`'s native classes
 * brand-check their receiver, and calling a native method through a Proxy
 * throws "Illegal invocation" otherwise.
 */
function raceOnTripRead(realDb: Db, onRead: () => void): Db {
	let fired = false;
	const TARGET_SQL = 'SELECT * FROM trips WHERE id = ?'; // trips.ts, R-6 step 1
	return new Proxy(realDb, {
		get(target, prop) {
			if (prop === 'prepare') {
				return (sql: string, ...rest: unknown[]) => {
					const stmt = (target as any).prepare(sql, ...rest);
					if (!fired && sql === TARGET_SQL) {
						return {
							get(...args: unknown[]) {
								if (!fired) {
									fired = true;
									onRead();
								}
								return stmt.get(...args);
							},
							run: stmt.run.bind(stmt),
							all: stmt.all.bind(stmt)
						};
					}
					return stmt;
				};
			}
			const value = (target as any)[prop];
			return typeof value === 'function' ? value.bind(target) : value;
		}
	}) as Db;
}

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
			expect(getOpenList(h.db, store.id, actor.id).items).toHaveLength(2);
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	/**
	 * `tx()` uses `BEGIN IMMEDIATE`, which takes the write lock BEFORE the first
	 * statement inside the transaction ever runs — including R-6 step 1's re-read
	 * of the trip. This test lands a rival's FULL close (its own real `closeTrip`
	 * call, on a second connection) exactly in the gap between our step-1 read
	 * and our step-3 write, using `raceOnTripRead` above.
	 *
	 * Under `BEGIN IMMEDIATE` the rival cannot get in at all: the write lock is
	 * already ours before the read runs, so the rival's own `BEGIN IMMEDIATE`
	 * blocks and times out (`ERR_SQLITE_ERROR`, errcode 5, SQLITE_BUSY) — and our
	 * own close completes normally.
	 *
	 * Downgrading `tx()` to a plain deferred `BEGIN` was verified to turn this
	 * red: the rival's `BEGIN IMMEDIATE` no longer contends with anything (our
	 * transaction has taken no lock yet), so the rival's close lands cleanly and
	 * commits. Our transaction's snapshot was fixed at its earlier read, so when
	 * it then reaches step 3's `UPDATE trips SET status='closed' ...` — a write
	 * against a row the rival already moved — SQLite refuses with
	 * `ERR_SQLITE_ERROR`, errcode 517 (SQLITE_BUSY_SNAPSHOT), which `busy_timeout`
	 * does not retry. That raw error reaches the caller instead of the clean
	 * `409 TRIP_ALREADY_CLOSED` R-11 mandates.
	 */
	test('BEGIN IMMEDIATE closes the gap a deferred BEGIN would leave between the status re-read and the close write', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const tripId = openTrip(h, store.id);
			const rival = h.second({ busyTimeout: 80 });

			let rivalError: any = null;
			let rivalResult: any = null;
			const spyDb = raceOnTripRead(h.db, () => {
				try {
					rivalResult = closeTrip(rival, store.id, { tripId }, actor);
				} catch (err) {
					rivalError = err;
				}
			});

			let caught: any = null;
			let result: any = null;
			try {
				result = closeTrip(spyDb, store.id, { tripId }, actor);
			} catch (err) {
				caught = err;
			}

			// The rival could not land in the gap: it never even committed.
			expect(rivalResult).toBeNull();
			expect(rivalError).toBeDefined();
			expect(rivalError.code).toBe('ERR_SQLITE_ERROR');
			expect(rivalError.errcode).toBe(5); // SQLITE_BUSY, not a snapshot conflict

			// Our own close, whose read the rival tried to race, completed
			// normally — no raw SQLite error ever reached this caller.
			expect(caught).toBeNull();
			expect(result.closedTrip.status).toBe('closed');
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
			const list = getOpenList(h.db, store.id, actor.id);
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
			expect(getOpenList(h.db, store.id, actor.id).items.map((i) => i.name)).toEqual(['Bread', 'Milk']);
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
