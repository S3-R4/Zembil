/**
 * The rollover state machine — CONTRACT.md §2, rules R-1 … R-17.
 * Every numbered rule has at least one assertion here or in the sibling
 * concurrency / statement-order / effects suites, which are named per rule.
 */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, makeUser, recorder, type Harness, type TestUser } from './_support';
import { checkAll } from './_invariants';
import { createStore, listStores, updateStore } from '$lib/server/domain/stores';
import {
	addItem,
	deleteItem,
	getOpenList,
	tickItem,
	untickItem,
	updateItem
} from '$lib/server/domain/items';
import { closeTrip, getTripDetail, listClosedTrips } from '$lib/server/domain/trips';
import { isDomainError } from '$lib/server/domain/errors';

function ctx() {
	const h = harness();
	const actor = makeUser(h.db, 'ayse', 'Ayse');
	const other = makeUser(h.db, 'mehmet', 'Mehmet');
	const store = createStore(h.db, { name: 'Migros' }, actor);
	return { h, actor, other, store };
}

const openTrip = (h: Harness, storeId: string): string =>
	(h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any).id;

const add = (h: Harness, storeId: string, actor: TestUser, name: string, clientId = randomUUID()) =>
	addItem(h.db, storeId, { name, clientId }, actor);

function expectDomainError(fn: () => unknown, code: string, status?: number) {
	try {
		fn();
	} catch (err) {
		if (!isDomainError(err)) throw err;
		expect(err.code).toBe(code);
		if (status !== undefined) expect(err.status).toBe(status);
		return err;
	}
	throw new Error(`expected a ${code} DomainError, got success`);
}

describe('R-1 — store creation also creates its first trip', () => {
	test('the store and its seq=1 open trip exist together', () => {
		const { h, actor, store } = ctx();
		try {
			const trips = h.db.prepare('SELECT * FROM trips WHERE store_id = ?').all(store.id) as any[];
			expect(trips).toHaveLength(1);
			expect(Number(trips[0].seq)).toBe(1);
			expect(trips[0].status).toBe('open');
			expect(store.openTripId).toBe(trips[0].id);
			expect(store.rev).toBe(0);
		} finally {
			h.close();
		}
	});

	test('a failed creation leaves neither a store nor a trip behind', () => {
		const { h, actor } = ctx();
		try {
			const before = h.db.prepare('SELECT COUNT(*) AS n FROM stores').get() as any;
			expectDomainError(() => createStore(h.db, { name: ' migros ' }, actor), 'STORE_NAME_TAKEN', 409);
			const after = h.db.prepare('SELECT COUNT(*) AS n FROM stores').get() as any;
			expect(Number(after.n)).toBe(Number(before.n));
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});
});

describe('R-2 — add targets the store, and the server resolves the open trip', () => {
	test('an add composed before a close lands on the NEW trip, not the closed one', () => {
		const { h, actor, store } = ctx();
		try {
			const staleTripId = openTrip(h, store.id);
			add(h, store.id, actor, 'Milk');
			closeTrip(h.db, store.id, { tripId: staleTripId }, actor);

			const newTripId = openTrip(h, store.id);
			expect(newTripId).not.toBe(staleTripId);

			// The client only ever names the store.
			const late = add(h, store.id, actor, 'Late arrival');
			expect(late.item.tripId).toBe(newTripId);
			expect(late.created).toBe(true);
		} finally {
			h.close();
		}
	});
});

describe('R-3 / R-4 — tick', () => {
	test('tick sets state, ticked_at, ticked_by and bumps version, staying in its trip', () => {
		const { h, actor, store } = ctx();
		try {
			const added = add(h, store.id, actor, 'Milk');
			const ticked = tickItem(h.db, added.item.id, actor);
			expect(ticked.item.state).toBe('ticked');
			expect(ticked.item.tickedAt).toBeTypeOf('number');
			expect(ticked.item.tickedByName).toBe('Ayse');
			expect(ticked.item.version).toBe(added.item.version + 1);
			expect(ticked.item.tripId).toBe(added.item.tripId);
			expect(ticked.changed).toBe(true);
		} finally {
			h.close();
		}
	});

	test('R-4 — a second tick succeeds and records the FIRST writer, not the second', () => {
		const { h, actor, other, store } = ctx();
		try {
			const added = add(h, store.id, actor, 'Milk');
			const first = tickItem(h.db, added.item.id, actor);
			const second = tickItem(h.db, added.item.id, other);
			expect(second.changed).toBe(false);
			expect(second.item.tickedByName).toBe('Ayse');
			expect(second.item.tickedAt).toBe(first.item.tickedAt);
			expect(second.item.version).toBe(first.item.version);
		} finally {
			h.close();
		}
	});
});

describe('R-5 — untick', () => {
	test('untick clears ticked_at and ticked_by and bumps version', () => {
		const { h, actor, store } = ctx();
		try {
			const added = add(h, store.id, actor, 'Milk');
			const ticked = tickItem(h.db, added.item.id, actor);
			const unticked = untickItem(h.db, added.item.id, actor);
			expect(unticked.item.state).toBe('pending');
			expect(unticked.item.tickedAt).toBe(null);
			expect(unticked.item.tickedByName).toBe(null);
			expect(unticked.item.version).toBe(ticked.item.version + 1);
			expect(unticked.changed).toBe(true);
		} finally {
			h.close();
		}
	});

	test('unticking an already-pending item is a success that changes nothing', () => {
		const { h, actor, store } = ctx();
		try {
			const added = add(h, store.id, actor, 'Milk');
			const again = untickItem(h.db, added.item.id, actor);
			expect(again.changed).toBe(false);
			expect(again.item.version).toBe(added.item.version);
		} finally {
			h.close();
		}
	});
});

describe('R-6 — close is one atomic transaction', () => {
	test('closes the trip, opens seq+1, and clones every pending item forward', () => {
		const { h, actor, other, store } = ctx();
		try {
			const cidMilk = randomUUID();
			const milk = addItem(h.db, store.id, { name: 'Milk', note: '2L', clientId: cidMilk }, other);
			const bread = add(h, store.id, actor, 'Bread');
			tickItem(h.db, bread.item.id, actor);

			const closedId = openTrip(h, store.id);
			const result = closeTrip(h.db, store.id, { tripId: closedId }, actor);

			expect(result.closedTrip.status).toBe('closed');
			expect(result.closedTrip.closedAt).toBeTypeOf('number');
			expect(result.closedTrip.closedByName).toBe('Ayse');
			expect(result.newTrip.seq).toBe(result.closedTrip.seq + 1);
			expect(result.newTrip.status).toBe('open');
			expect(result.boughtCount).toBe(1);
			expect(result.carriedCount).toBe(1);

			const original = h.db.prepare('SELECT * FROM items WHERE id = ?').get(milk.item.id) as any;
			expect(original.state).toBe('carried');
			expect(original.carried_to_item_id).toBeTruthy();
			expect(original.client_id).toBe(cidMilk);

			const clone = h.db
				.prepare('SELECT * FROM items WHERE id = ?')
				.get(original.carried_to_item_id) as any;
			expect(clone.trip_id).toBe(result.newTrip.id);
			expect(clone.name).toBe('Milk');
			expect(clone.note).toBe('2L');
			expect(clone.state).toBe('pending');
			expect(clone.client_id).toBe(cidMilk);
			expect(clone.carried_from_item_id).toBe(milk.item.id);
			expect(clone.origin_item_id).toBe(milk.item.id);
			expect(Number(clone.carry_count)).toBe(1);
			expect(Number(clone.version)).toBe(1);
			// The original author is preserved — carry-over is not authorship.
			expect(clone.created_by).toBe(other.id);
			// R-15: a clone inherits the original's sort_order verbatim.
			expect(Number(clone.sort_order)).toBe(Number(original.sort_order));

			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('closing an empty trip is refused with 409 TRIP_EMPTY and changes nothing', () => {
		const { h, actor, store } = ctx();
		try {
			const tripId = openTrip(h, store.id);
			expectDomainError(() => closeTrip(h.db, store.id, { tripId }, actor), 'TRIP_EMPTY', 409);
			const trip = h.db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as any;
			expect(trip.status).toBe('open');
			expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM trips').get() as any).n)).toBe(1);
		} finally {
			h.close();
		}
	});

	test('a trip whose only items are soft-deleted counts as empty', () => {
		const { h, actor, store } = ctx();
		try {
			const added = add(h, store.id, actor, 'Milk');
			deleteItem(h.db, added.item.id, actor);
			expectDomainError(
				() => closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor),
				'TRIP_EMPTY'
			);
		} finally {
			h.close();
		}
	});

	test('closing a trip that is already closed returns 409 TRIP_ALREADY_CLOSED with the open trip id', () => {
		const { h, actor, store } = ctx();
		try {
			add(h, store.id, actor, 'Milk');
			const firstId = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: firstId }, actor);
			const successor = openTrip(h, store.id);

			const err = expectDomainError(
				() => closeTrip(h.db, store.id, { tripId: firstId }, actor),
				'TRIP_ALREADY_CLOSED',
				409
			);
			expect(err.extra).toEqual({ openTripId: successor });
		} finally {
			h.close();
		}
	});

	test('a tripId belonging to another store is refused the same way', () => {
		const { h, actor, store } = ctx();
		try {
			const other = createStore(h.db, { name: 'BIM' }, actor);
			add(h, store.id, actor, 'Milk');
			const err = expectDomainError(
				() => closeTrip(h.db, store.id, { tripId: openTrip(h, other.id) }, actor),
				'TRIP_ALREADY_CLOSED'
			);
			expect(err.extra).toEqual({ openTripId: openTrip(h, store.id) });
		} finally {
			h.close();
		}
	});

	test('carry lineage survives repeated closes: origin is stable and carry_count grows', () => {
		const { h, actor, store } = ctx();
		try {
			const first = add(h, store.id, actor, 'Milk');
			for (let i = 0; i < 3; i += 1) {
				closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);
			}
			const live = h.db
				.prepare(`SELECT * FROM items WHERE state='pending' AND deleted_at IS NULL`)
				.get() as any;
			expect(live.origin_item_id).toBe(first.item.id);
			expect(Number(live.carry_count)).toBe(3);
			expect(Number((h.db.prepare('SELECT COUNT(*) AS n FROM trips').get() as any).n)).toBe(4);
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});
});

describe('R-7 — ticked items never carry', () => {
	test('a ticked item stays exactly where it is, in the closed trip, forever', () => {
		const { h, actor, store } = ctx();
		try {
			const bought = add(h, store.id, actor, 'Bread');
			add(h, store.id, actor, 'Milk');
			const ticked = tickItem(h.db, bought.item.id, actor);
			const closedId = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: closedId }, actor);

			const after = h.db.prepare('SELECT * FROM items WHERE id = ?').get(bought.item.id) as any;
			expect(after.state).toBe('ticked');
			expect(after.trip_id).toBe(closedId);
			expect(after.carried_to_item_id).toBe(null);
			expect(Number(after.ticked_at)).toBe(ticked.item.tickedAt);

			const cloneCount = h.db
				.prepare('SELECT COUNT(*) AS n FROM items WHERE carried_from_item_id = ?')
				.get(bought.item.id) as any;
			expect(Number(cloneCount.n)).toBe(0);
		} finally {
			h.close();
		}
	});
});

describe('R-8 — closed trips are immutable', () => {
	test('tick, untick, edit and delete against an item on a closed trip all return 409 TRIP_CLOSED', () => {
		const { h, actor, store } = ctx();
		try {
			const bought = add(h, store.id, actor, 'Bread');
			tickItem(h.db, bought.item.id, actor);
			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			expectDomainError(() => tickItem(h.db, bought.item.id, actor), 'TRIP_CLOSED', 409);
			expectDomainError(() => untickItem(h.db, bought.item.id, actor), 'TRIP_CLOSED', 409);
			expectDomainError(
				() => updateItem(h.db, bought.item.id, { name: 'Bread ekmek', version: 2 }, actor),
				'TRIP_CLOSED',
				409
			);
			expectDomainError(() => deleteItem(h.db, bought.item.id, actor), 'TRIP_CLOSED', 409);
		} finally {
			h.close();
		}
	});
});

describe('R-9 — undo is scoped to the open trip', () => {
	test('an item ticked before the close cannot be un-ticked afterwards, but is visible in history', () => {
		const { h, actor, store } = ctx();
		try {
			const bought = add(h, store.id, actor, 'Bread');
			tickItem(h.db, bought.item.id, actor);
			const closedId = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: closedId }, actor);

			expectDomainError(() => untickItem(h.db, bought.item.id, actor), 'TRIP_CLOSED');

			const history = getTripDetail(h.db, closedId, actor.id);
			expect(history.items.map((i) => i.id)).toContain(bought.item.id);
			expect(history.trip.boughtCount).toBe(1);
		} finally {
			h.close();
		}
	});
});

describe('R-10 — delete', () => {
	test('delete is soft, idempotent, and a deleted pending item is not carried', () => {
		const { h, actor, store } = ctx();
		try {
			const gone = add(h, store.id, actor, 'Yoghurt');
			const kept = add(h, store.id, actor, 'Milk');

			const first = deleteItem(h.db, gone.item.id, actor);
			expect(first.changed).toBe(true);
			const again = deleteItem(h.db, gone.item.id, actor);
			expect(again.changed).toBe(false);
			expect(again.rev).toBe(first.rev);

			// Still present as a row — soft, not hard.
			expect(h.db.prepare('SELECT * FROM items WHERE id = ?').get(gone.item.id)).toBeTruthy();

			const list = getOpenList(h.db, store.id, actor.id);
			expect(list.items.map((i) => i.id)).toEqual([kept.item.id]);

			const result = closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);
			expect(result.carriedCount).toBe(1);
			const deletedAfter = h.db.prepare('SELECT * FROM items WHERE id = ?').get(gone.item.id) as any;
			expect(deletedAfter.state).toBe('pending');
			expect(deletedAfter.carried_to_item_id).toBe(null);
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});
});

/**
 * Where R-10 meets R-8 and R-14, idempotency wins: deleting an ALREADY-deleted
 * item returns 200 even after its trip has since closed or its store has since
 * been archived — where a FIRST delete in either situation is 409 (asserted
 * above, in R-8's and R-14's own suites). Nothing is written on the repeat, so
 * §3.0 says it bumps no rev and emits nothing.
 */
describe('R-10 meets R-8 and R-14 — idempotency wins the conflict', () => {
	test('re-deleting an already-deleted item is 200, not 409 TRIP_CLOSED, once its trip has closed', () => {
		const { h, actor, store } = ctx();
		try {
			const gone = add(h, store.id, actor, 'Yoghurt');
			add(h, store.id, actor, 'Milk'); // keeps the trip non-empty so the close below can succeed
			const first = deleteItem(h.db, gone.item.id, actor);
			expect(first.changed).toBe(true);

			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			const rec = recorder();
			const before = Number((h.db.prepare('SELECT rev FROM stores WHERE id=?').get(store.id) as any).rev);
			try {
				// A FIRST delete here would be 409 TRIP_CLOSED (see R-8's suite above).
				// This item is already gone, and R-10's idempotency wins: 200, not 409.
				const again = deleteItem(h.db, gone.item.id, actor);
				expect(again.changed).toBe(false);
				expect(again.item.id).toBe(gone.item.id);
				expect(again.rev).toBe(before);
				// Nothing was written: rev is untouched and nothing was emitted.
				expect(Number((h.db.prepare('SELECT rev FROM stores WHERE id=?').get(store.id) as any).rev)).toBe(
					before
				);
				expect(rec.take()).toEqual([]);
			} finally {
				rec.stop();
			}
		} finally {
			h.close();
		}
	});

	test('re-deleting an already-deleted item is 200, not 409 STORE_ARCHIVED, once its store has been archived', () => {
		const { h, actor, store } = ctx();
		try {
			const gone = add(h, store.id, actor, 'Yoghurt');
			const first = deleteItem(h.db, gone.item.id, actor);
			expect(first.changed).toBe(true);

			updateStore(h.db, store.id, { archived: true }, actor);

			const rec = recorder();
			const before = Number((h.db.prepare('SELECT rev FROM stores WHERE id=?').get(store.id) as any).rev);
			try {
				// A FIRST delete here would be 409 STORE_ARCHIVED (see R-14's suite
				// below). This item is already gone, and R-10's idempotency wins.
				const again = deleteItem(h.db, gone.item.id, actor);
				expect(again.changed).toBe(false);
				expect(again.item.id).toBe(gone.item.id);
				expect(again.rev).toBe(before);
				expect(Number((h.db.prepare('SELECT rev FROM stores WHERE id=?').get(store.id) as any).rev)).toBe(
					before
				);
				expect(rec.take()).toEqual([]);
			} finally {
				rec.stop();
			}
		} finally {
			h.close();
		}
	});
});

describe('PATCH /items — name and note semantics (§3.5, §3.1a)', () => {
	test('note can be cleared to null, and name alone leaves the note intact', () => {
		const { h, actor, store } = ctx();
		try {
			const added = addItem(
				h.db,
				store.id,
				{ name: 'Milk', note: '2L', clientId: randomUUID() },
				actor
			);
			const renamed = updateItem(h.db, added.item.id, { name: 'Milk 2L', version: 1 }, actor);
			expect(renamed.item.name).toBe('Milk 2L');
			expect(renamed.item.note).toBe('2L');

			const cleared = updateItem(h.db, added.item.id, { note: null, version: 2 }, actor);
			expect(cleared.item.note).toBe(null);
			expect(cleared.item.name).toBe('Milk 2L');

			const noted = updateItem(h.db, added.item.id, { note: '  yarim  ', version: 3 }, actor);
			expect(noted.item.note).toBe('yarim');
		} finally {
			h.close();
		}
	});
});

describe('reading an archived store', () => {
	test('GET /list still works, so the un-archive action is reachable from the list screen', () => {
		const { h, actor, store } = ctx();
		try {
			add(h, store.id, actor, 'Milk');
			updateStore(h.db, store.id, { archived: true }, actor);
			const list = getOpenList(h.db, store.id, actor.id);
			expect(list.items).toHaveLength(1);
			expect(list.store.archivedAt).toBeTypeOf('number');
		} finally {
			h.close();
		}
	});
});

describe('R-13 — ordering within a list', () => {
	test('pending items sort by sort_order, created_at, id; ticked items sort below them by ticked_at DESC', () => {
		const { h, actor, store } = ctx();
		try {
			const a = add(h, store.id, actor, 'A');
			const b = add(h, store.id, actor, 'B');
			const c = add(h, store.id, actor, 'C');
			const d = add(h, store.id, actor, 'D');

			tickItem(h.db, b.item.id, actor);
			tickItem(h.db, d.item.id, actor);
			// Force distinct ticked_at values so the DESC ordering is observable.
			h.db.prepare('UPDATE items SET ticked_at = ? WHERE id = ?').run(1000, b.item.id);
			h.db.prepare('UPDATE items SET ticked_at = ? WHERE id = ?').run(2000, d.item.id);

			const list = getOpenList(h.db, store.id, actor.id);
			expect(list.items.map((i) => i.name)).toEqual(['A', 'C', 'D', 'B']);
			expect(list.items.map((i) => i.state)).toEqual(['pending', 'pending', 'ticked', 'ticked']);
			expect(a.item.sortOrder).toBeLessThan(c.item.sortOrder);
		} finally {
			h.close();
		}
	});

	test('the id tiebreak makes the order total for items sharing a key', () => {
		const { h, actor, store } = ctx();
		try {
			const one = add(h, store.id, actor, 'One');
			const two = add(h, store.id, actor, 'Two');
			tickItem(h.db, one.item.id, actor);
			tickItem(h.db, two.item.id, actor);
			// Same millisecond: only the id tiebreak can order these.
			h.db.prepare('UPDATE items SET ticked_at = 5000').run();

			const ids = getOpenList(h.db, store.id, actor.id).items.map((i) => i.id);
			expect(ids).toEqual([...ids].sort());
			expect(getOpenList(h.db, store.id, actor.id).items.map((i) => i.id)).toEqual(ids);
		} finally {
			h.close();
		}
	});

	test('carried and soft-deleted items never appear in an open list', () => {
		const { h, actor, store } = ctx();
		try {
			const carried = add(h, store.id, actor, 'Milk');
			const deleted = add(h, store.id, actor, 'Yoghurt');
			deleteItem(h.db, deleted.item.id, actor);
			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			const list = getOpenList(h.db, store.id, actor.id);
			expect(list.items.map((i) => i.state)).toEqual(['pending']);
			expect(list.items.map((i) => i.id)).not.toContain(carried.item.id);
			expect(list.items.map((i) => i.id)).not.toContain(deleted.item.id);
		} finally {
			h.close();
		}
	});

	test('GET /trips/{id} includes carried items and excludes deleted ones', () => {
		const { h, actor, store } = ctx();
		try {
			const carried = add(h, store.id, actor, 'Milk');
			const bought = add(h, store.id, actor, 'Bread');
			const deleted = add(h, store.id, actor, 'Yoghurt');
			tickItem(h.db, bought.item.id, actor);
			deleteItem(h.db, deleted.item.id, actor);

			const closedId = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: closedId }, actor);

			const detail = getTripDetail(h.db, closedId, actor.id);
			const ids = detail.items.map((i) => i.id);
			expect(ids).toContain(carried.item.id);
			expect(ids).toContain(bought.item.id);
			expect(ids).not.toContain(deleted.item.id);
			// §3.6: BOUGHT FIRST, THEN LEFT BEHIND. A plain `state ASC` would sort
			// alphabetically and put 'carried' above 'ticked' — backwards.
			expect(detail.items.map((i) => i.state)).toEqual(['ticked', 'carried']);
			expect(detail.trip.boughtCount).toBe(1);
			expect(detail.trip.carriedCount).toBe(1);
		} finally {
			h.close();
		}
	});

	test('GET /trips/{id} orders bought first, then left behind, each by sort_order then id', () => {
		const { h, actor, store } = ctx();
		try {
			// Interleave the two groups in insertion (and therefore sort_order)
			// order, so a query that ignored state entirely would also fail here.
			const a = add(h, store.id, actor, 'Milk'); // carried, sort_order 1000
			const b = add(h, store.id, actor, 'Bread'); // ticked,  sort_order 2000
			const c = add(h, store.id, actor, 'Eggs'); // carried, sort_order 3000
			const d = add(h, store.id, actor, 'Tea'); // ticked,  sort_order 4000

			// Tick the LATER one first, so a stray `ticked_at DESC` (R-13's open-list
			// rule) would produce d before b and fail this assertion.
			tickItem(h.db, d.item.id, actor);
			tickItem(h.db, b.item.id, actor);

			const closedId = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: closedId }, actor);

			const detail = getTripDetail(h.db, closedId, actor.id);
			expect(detail.items.map((i) => i.state)).toEqual([
				'ticked',
				'ticked',
				'carried',
				'carried'
			]);
			expect(detail.items.map((i) => i.id)).toEqual([
				b.item.id,
				d.item.id,
				a.item.id,
				c.item.id
			]);

			// The open successor trip is ordered by R-13 instead: everything there is
			// pending, so the CASE arm for 'pending' is exercised on a real trip too.
			const successorId = openTrip(h, store.id);
			const successor = getTripDetail(h.db, successorId, actor.id);
			expect(successor.items.map((i) => i.state)).toEqual(['pending', 'pending']);
			expect(successor.items.map((i) => i.name)).toEqual(['Milk', 'Eggs']);
		} finally {
			h.close();
		}
	});
});

describe('R-14 — archiving a store', () => {
	test('archiving hides it, leaves the open trip untouched, and rejects writes', () => {
		const { h, actor, store } = ctx();
		try {
			const item = add(h, store.id, actor, 'Milk');
			const tripBefore = openTrip(h, store.id);

			updateStore(h.db, store.id, { archived: true }, actor);

			expect(listStores(h.db, actor.id).map((s) => s.id)).not.toContain(store.id);
			const withArchived = listStores(h.db, actor.id, true).find((s) => s.id === store.id);
			expect(withArchived?.archivedAt).toBeTypeOf('number');

			const trip = h.db.prepare('SELECT * FROM trips WHERE id = ?').get(tripBefore) as any;
			expect(trip.status).toBe('open');

			// R-14 enumerates the rejected writes EXHAUSTIVELY. All six, and nothing
			// else, are 409 STORE_ARCHIVED.
			expectDomainError(
				() => addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor),
				'STORE_ARCHIVED',
				409
			);
			expectDomainError(
				() => updateItem(h.db, item.item.id, { name: 'Milk 2', version: item.item.version }, actor),
				'STORE_ARCHIVED',
				409
			);
			expectDomainError(() => deleteItem(h.db, item.item.id, actor), 'STORE_ARCHIVED', 409);
			expectDomainError(() => tickItem(h.db, item.item.id, actor), 'STORE_ARCHIVED', 409);
			expectDomainError(() => untickItem(h.db, item.item.id, actor), 'STORE_ARCHIVED', 409);
			expectDomainError(
				() => closeTrip(h.db, store.id, { tripId: tripBefore }, actor),
				'STORE_ARCHIVED',
				409
			);

			// Reads are explicitly NOT rejected — rejecting them would make
			// "un-archiving restores it intact" unreachable from the store's screen.
			expect(getOpenList(h.db, store.id, actor.id).items).toHaveLength(1);
			expect(listClosedTrips(h.db, store.id, actor.id).trips).toEqual([]);
			expect(getTripDetail(h.db, tripBefore, actor.id).items).toHaveLength(1);

			// PATCH /stores/{id} is never rejected: it is the endpoint that un-archives.
			expect(() => updateStore(h.db, store.id, { name: 'Migros Bostanci' }, actor)).not.toThrow();
			expect(() => updateStore(h.db, store.id, { archived: false }, actor)).not.toThrow();
		} finally {
			h.close();
		}
	});

	test('un-archiving restores it intact', () => {
		const { h, actor, store } = ctx();
		try {
			const item = add(h, store.id, actor, 'Milk');
			updateStore(h.db, store.id, { archived: true }, actor);
			updateStore(h.db, store.id, { archived: false }, actor);

			const restored = listStores(h.db, actor.id).find((s) => s.id === store.id);
			expect(restored).toBeDefined();
			expect(restored?.archivedAt).toBe(null);
			expect(restored?.pendingCount).toBe(1);
			expect(tickItem(h.db, item.item.id, actor).changed).toBe(true);
		} finally {
			h.close();
		}
	});

	test('a name clash against an archived store returns its id so un-archiving is reachable', () => {
		const { h, actor, store } = ctx();
		try {
			updateStore(h.db, store.id, { archived: true }, actor);
			const err = expectDomainError(
				() => createStore(h.db, { name: 'MIGROS' }, actor),
				'STORE_NAME_TAKEN',
				409
			);
			expect(err.extra).toEqual({ storeId: store.id });
		} finally {
			h.close();
		}
	});
});

describe('R-15 — sort_order allocation', () => {
	test('a new item is MAX+1000 over ALL rows of the trip, deleted included', () => {
		const { h, actor, store } = ctx();
		try {
			const a = add(h, store.id, actor, 'A');
			const b = add(h, store.id, actor, 'B');
			expect(a.item.sortOrder).toBe(1000);
			expect(b.item.sortOrder).toBe(2000);

			deleteItem(h.db, b.item.id, actor);
			const c = add(h, store.id, actor, 'C');
			// The deleted row still counts, so no key is reused.
			expect(c.item.sortOrder).toBe(3000);
		} finally {
			h.close();
		}
	});

	test('adds after a close continue from MAX+1000 and land below every carried item', () => {
		const { h, actor, store } = ctx();
		try {
			add(h, store.id, actor, 'A');
			add(h, store.id, actor, 'B');
			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			const fresh = add(h, store.id, actor, 'C');
			expect(fresh.item.sortOrder).toBe(3000);
			expect(getOpenList(h.db, store.id, actor.id).items.map((i) => i.name)).toEqual(['A', 'B', 'C']);
		} finally {
			h.close();
		}
	});

	test('a new store is MAX+1000 over all stores, archived included', () => {
		const { h, actor, store } = ctx();
		try {
			expect(store.sortOrder).toBe(1000);
			updateStore(h.db, store.id, { archived: true }, actor);
			const second = createStore(h.db, { name: 'BIM' }, actor);
			expect(second.sortOrder).toBe(2000);
		} finally {
			h.close();
		}
	});

	test('PATCH /stores writes the client-supplied sortOrder directly', () => {
		const { h, actor, store } = ctx();
		try {
			const patched = updateStore(h.db, store.id, { sortOrder: 42 }, actor);
			expect(patched.sortOrder).toBe(42);
		} finally {
			h.close();
		}
	});
});

describe('R-16 — stores.rev is the revalidation cursor', () => {
	test('rev starts at 0 and increases by exactly one per changing write', () => {
		const { h, actor, store } = ctx();
		try {
			expect(store.rev).toBe(0);
			const added = add(h, store.id, actor, 'Milk');
			expect(added.rev).toBe(1);
			expect(tickItem(h.db, added.item.id, actor).rev).toBe(2);
			expect(untickItem(h.db, added.item.id, actor).rev).toBe(3);
			expect(updateItem(h.db, added.item.id, { name: 'Milk 2L', version: 3 }, actor).rev).toBe(4);
			expect(deleteItem(h.db, added.item.id, actor).rev).toBe(5);
			expect(updateStore(h.db, store.id, { name: 'Migros Sanayi' }, actor).rev).toBe(6);
		} finally {
			h.close();
		}
	});
});

describe('R-17 — idempotent add survives a rollover', () => {
	test('a retry whose original was carried over resolves to the CLONE, not a second item', () => {
		const { h, actor, store } = ctx();
		try {
			const cid = randomUUID();
			const first = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			const staleTrip = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: staleTrip }, actor);
			const successor = openTrip(h, store.id);

			const retry = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			expect(retry.created).toBe(false);
			expect(retry.item.id).not.toBe(first.item.id);
			expect(retry.item.tripId).toBe(successor);
			expect(retry.item.carryCount).toBe(1);

			const rows = h.db
				.prepare(`SELECT COUNT(*) AS n FROM items WHERE store_id = ? AND client_id = ?`)
				.get(store.id, cid) as any;
			expect(Number(rows.n)).toBe(2); // the carried original plus its one clone
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('a plain retry on the same trip returns the same row', () => {
		const { h, actor, store } = ctx();
		try {
			const cid = randomUUID();
			const first = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			const retry = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			expect(retry.created).toBe(false);
			expect(retry.item.id).toBe(first.item.id);
			expect(retry.rev).toBe(first.rev);
		} finally {
			h.close();
		}
	});

	test('a retry after the item was deleted creates a fresh item — the documented double fault', () => {
		const { h, actor, store } = ctx();
		try {
			const cid = randomUUID();
			const first = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			deleteItem(h.db, first.item.id, actor);
			const retry = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			expect(retry.created).toBe(true);
			expect(retry.item.id).not.toBe(first.item.id);
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('the same clientId at a different store is a different item — scope is the store', () => {
		const { h, actor, store } = ctx();
		try {
			const other = createStore(h.db, { name: 'BIM' }, actor);
			const cid = randomUUID();
			const a = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			const b = addItem(h.db, other.id, { name: 'Milk', clientId: cid }, actor);
			expect(b.created).toBe(true);
			expect(b.item.id).not.toBe(a.item.id);
		} finally {
			h.close();
		}
	});
});

describe('trip history — §3.6', () => {
	test('closed trips come back newest first with counts and a cursor', () => {
		const { h, actor, store } = ctx();
		try {
			for (let i = 0; i < 3; i += 1) {
				const item = add(h, store.id, actor, `Item ${i}`);
				tickItem(h.db, item.item.id, actor);
				closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);
			}
			const page = listClosedTrips(h.db, store.id, actor.id, { limit: 2 });
			expect(page.trips.map((t) => t.seq)).toEqual([3, 2]);
			expect(page.nextBefore).toBe(2);
			expect(page.trips[0].boughtCount).toBe(1);

			const next = listClosedTrips(h.db, store.id, actor.id, { limit: 2, before: page.nextBefore! });
			expect(next.trips.map((t) => t.seq)).toEqual([1]);
			expect(next.nextBefore).toBe(null);
		} finally {
			h.close();
		}
	});
});
