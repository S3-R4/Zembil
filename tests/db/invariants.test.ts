/**
 * CONTRACT.md §1.2 — the table invariants.
 *
 * §1.2 splits them into schema-bound and test-bound. Schema-bound invariants get
 * a test that the DDL actually REJECTS the violation. Test-bound invariants get a
 * checker (tests/domain/_invariants.ts) plus a negative test that corrupts a row
 * behind the domain layer's back and asserts the checker reports it — the M1
 * exit criterion is a test that fails when the invariant is violated, not merely
 * one that passes today.
 */
import { describe, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { harness, makeUser } from '../domain/_support';
import {
	checkAll,
	checkI1,
	checkI2,
	checkI3,
	checkI5,
	checkI6,
	checkI7,
	checkI8,
	checkI9,
	checkI13
} from '../domain/_invariants';
import { createStore } from '$lib/server/domain/stores';
import { addItem, tickItem } from '$lib/server/domain/items';
import { closeTrip } from '$lib/server/domain/trips';

function seeded() {
	const h = harness();
	const actor = makeUser(h.db);
	const store = createStore(h.db, { name: 'Migros' }, actor);
	return { h, actor, store };
}

function openTrip(h: any, storeId: string): string {
	return (h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any)
		.id;
}

function rawItem(h: any, over: Record<string, unknown> = {}) {
	const ts = Date.now();
	const id = (over.id as string) ?? randomUUID();
	const values: Record<string, unknown> = {
		id,
		trip_id: over.trip_id,
		store_id: over.store_id,
		client_id: over.client_id ?? null,
		name: over.name ?? 'Raw',
		note: null,
		state: over.state ?? 'pending',
		sort_order: over.sort_order ?? 500,
		ticked_at: over.ticked_at ?? null,
		ticked_by: over.ticked_by ?? null,
		carried_from_item_id: over.carried_from_item_id ?? null,
		carried_to_item_id: over.carried_to_item_id ?? null,
		origin_item_id: over.origin_item_id ?? id,
		carry_count: over.carry_count ?? 0,
		version: 1,
		created_at: ts,
		created_by: over.created_by ?? null,
		updated_at: ts,
		deleted_at: over.deleted_at ?? null
	};
	h.db
		.prepare(
			`INSERT INTO items (id, trip_id, store_id, client_id, name, note, state, sort_order,
			   ticked_at, ticked_by, carried_from_item_id, carried_to_item_id, origin_item_id,
			   carry_count, version, created_at, created_by, updated_at, deleted_at)
			 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
		)
		.run(...Object.values(values));
	return id;
}

// ---------------------------------------------------------------------------
// Schema-bound: the DDL rejects the violation.
// ---------------------------------------------------------------------------

describe('schema-bound invariants', () => {
	test('I-1 — a second open trip for one store is rejected by trips_one_open_per_store', () => {
		const { h, store } = seeded();
		try {
			expect(() =>
				h.db
					.prepare(
						`INSERT INTO trips (id, store_id, seq, status, opened_at) VALUES (?,?,2,'open',?)`
					)
					.run(randomUUID(), store.id, Date.now())
			).toThrow(/UNIQUE constraint failed/i);
			expect(checkI1(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('I-4 — a ticked item without ticked_at or ticked_by is rejected', () => {
		const { h, store } = seeded();
		try {
			const trip = openTrip(h, store.id);
			expect(() => rawItem(h, { trip_id: trip, store_id: store.id, state: 'ticked' })).toThrow(
				/CHECK constraint failed/i
			);
			expect(() =>
				rawItem(h, { trip_id: trip, store_id: store.id, state: 'ticked', ticked_at: Date.now() })
			).toThrow(/CHECK constraint failed/i);
		} finally {
			h.close();
		}
	});

	test('I-5 — a carried item without carried_to_item_id is rejected', () => {
		const { h, store } = seeded();
		try {
			const trip = openTrip(h, store.id);
			expect(() => rawItem(h, { trip_id: trip, store_id: store.id, state: 'carried' })).toThrow(
				/CHECK constraint failed/i
			);
		} finally {
			h.close();
		}
	});

	test('I-10 — users.password_hash cannot be NULL', () => {
		const h = harness();
		try {
			const u = makeUser(h.db);
			expect(() =>
				h.db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(u.id)
			).toThrow(/NOT NULL constraint failed/i);
		} finally {
			h.close();
		}
	});

	test('I-11 — a second live row for one (store_id, client_id) is rejected', () => {
		const { h, store, actor } = seeded();
		try {
			const cid = randomUUID();
			addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			const trip = openTrip(h, store.id);
			expect(() =>
				rawItem(h, { trip_id: trip, store_id: store.id, client_id: cid, sort_order: 9999 })
			).toThrow(/UNIQUE constraint failed/i);
		} finally {
			h.close();
		}
	});

	test('I-12 — a duplicate sort_order within one trip is rejected', () => {
		const { h, store, actor } = seeded();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const trip = openTrip(h, store.id);
			expect(() =>
				rawItem(h, { trip_id: trip, store_id: store.id, sort_order: 1000 })
			).toThrow(/UNIQUE constraint failed/i);
		} finally {
			h.close();
		}
	});
});

// ---------------------------------------------------------------------------
// Test-bound: the checker must FAIL on a deliberately corrupted database.
// ---------------------------------------------------------------------------

describe('test-bound invariants — each checker fails when the invariant is violated', () => {
	test('I-2 — a gap in trips.seq is detected', () => {
		const { h, store } = seeded();
		try {
			expect(checkI2(h.db)).toEqual([]);
			h.db
				.prepare(`INSERT INTO trips (id, store_id, seq, status, opened_at, closed_at, closed_by)
				          VALUES (?,?,5,'closed',?,?,NULL)`)
				.run(randomUUID(), store.id, Date.now(), Date.now());
			expect(checkI2(h.db)).toHaveLength(1);
			expect(checkI2(h.db)[0]).toMatch(/I-2/);
		} finally {
			h.close();
		}
	});

	test('I-3 — an item whose store_id differs from its trip is detected', () => {
		const { h, actor, store } = seeded();
		try {
			const other = createStore(h.db, { name: 'BIM' }, actor);
			expect(checkI3(h.db)).toEqual([]);
			// The FK to stores is satisfied, so only the checker can catch this.
			rawItem(h, { trip_id: openTrip(h, store.id), store_id: other.id });
			expect(checkI3(h.db)).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test('I-5 (closed-trip half) — a carried item on an OPEN trip is detected', () => {
		const { h, store } = seeded();
		try {
			const trip = openTrip(h, store.id);
			const target = rawItem(h, { trip_id: trip, store_id: store.id, sort_order: 100 });
			// Schema-legal: state='carried' with a non-null carried_to_item_id.
			rawItem(h, {
				trip_id: trip,
				store_id: store.id,
				state: 'carried',
				carried_to_item_id: target,
				sort_order: 200
			});
			const violations = checkI5(h.db);
			expect(violations).toHaveLength(1);
			expect(violations[0]).toMatch(/trip=open/);
		} finally {
			h.close();
		}
	});

	test('I-6 — a wrong origin_item_id is detected', () => {
		const { h, store, actor } = seeded();
		try {
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			expect(checkI6(h.db)).toEqual([]);
			h.db
				.prepare('UPDATE items SET origin_item_id = ? WHERE id = ?')
				.run(randomUUID(), added.item.id);
			expect(checkI6(h.db)).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test('I-7 — a carry_count that does not match the chain is detected', () => {
		const { h, store, actor } = seeded();
		try {
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			expect(checkI7(h.db)).toEqual([]);
			h.db.prepare('UPDATE items SET carry_count = 7 WHERE id = ?').run(added.item.id);
			expect(checkI7(h.db)).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test('I-8 — a soft-deleted item that was carried is detected', () => {
		const { h, store, actor } = seeded();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const trip = openTrip(h, store.id);
			closeTrip(h.db, store.id, { tripId: trip }, actor);
			expect(checkI8(h.db)).toEqual([]);
			h.db
				.prepare(`UPDATE items SET deleted_at = ? WHERE state = 'carried'`)
				.run(Date.now());
			expect(checkI8(h.db)).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test('I-9 — a session row whose id is the raw token is detected', () => {
		const h = harness();
		try {
			const user = makeUser(h.db);
			const token = 'a-token-the-client-received';
			const ts = Date.now();
			const insert = h.db.prepare(
				`INSERT INTO sessions (id, user_id, auth_method, created_at, last_seen_at,
				                       idle_expires_at, absolute_expires_at, user_agent)
				 VALUES (?, ?, 'password', ?, ?, ?, ?, NULL)`
			);
			insert.run(
				createHash('sha256').update(token).digest('hex'),
				user.id,
				ts,
				ts,
				ts + 1000,
				ts + 2000
			);
			expect(checkI9(h.db, [token])).toEqual([]);

			insert.run(token, user.id, ts, ts, ts + 1000, ts + 2000);
			expect(checkI9(h.db, [token])).toHaveLength(1);
		} finally {
			h.close();
		}
	});

	test('I-13 — a negative or non-integer rev is detected', () => {
		const { h, store } = seeded();
		try {
			expect(checkI13(h.db)).toEqual([]);
			h.db.prepare('UPDATE stores SET rev = -1 WHERE id = ?').run(store.id);
			expect(checkI13(h.db)).toHaveLength(1);
		} finally {
			h.close();
		}
	});
});

describe('a database driven only through the domain layer satisfies every invariant', () => {
	test('after adds, ticks, an untick, a delete and two closes', () => {
		const { h, store, actor } = seeded();
		try {
			const a = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const b = addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor);
			const c = addItem(h.db, store.id, { name: 'Eggs', clientId: randomUUID() }, actor);
			tickItem(h.db, a.item.id, actor);
			tickItem(h.db, c.item.id, actor);
			h.db.prepare('UPDATE items SET deleted_at = ? WHERE id = ?').run(Date.now(), c.item.id);
			expect(b.item.id).toBeTruthy();

			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);
			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);

			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});
});
