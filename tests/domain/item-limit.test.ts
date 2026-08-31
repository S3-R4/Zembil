/**
 * §3.5 — "At most 2000 non-deleted items per trip. Beyond that, 409
 * TRIP_ITEM_LIMIT." Implemented as `MAX_ITEMS_PER_TRIP` in items.ts but, until
 * this suite, never asserted: the boundary itself, that an R-17 idempotent
 * retry still succeeds AT the limit because it writes nothing, that the
 * rejected add bumps no `rev` and emits nothing (§3.0), and that the cap's own
 * `deleted_at IS NULL` predicate really does exclude soft-deleted rows from the
 * count.
 *
 * Note on "carried" rows: I-5 makes it structurally impossible for a `carried`
 * item to exist on an OPEN trip — carrying only happens at close, and the
 * carried original stays on the CLOSED trip it belonged to (R-7). The cap's
 * query is scoped by `trip_id = ?`, so a successor trip's count starts at zero
 * regardless of how many items the ancestor trip carried; there is no code
 * path where a `carried` row could be double-counted against the open trip's
 * cap. There is therefore nothing to assert about `carried` rows here beyond
 * what the soft-deleted case below already covers for `deleted_at IS NULL`.
 */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, makeUser, recorder, type Harness, type TestUser } from './_support';
import { createStore } from '$lib/server/domain/stores';
import { addItem, MAX_ITEMS_PER_TRIP } from '$lib/server/domain/items';
import { isDomainError } from '$lib/server/domain/errors';

function ctx() {
	const h = harness();
	const actor = makeUser(h.db);
	const store = createStore(h.db, { name: 'Migros' }, actor);
	const tripId = (
		h.db.prepare(`SELECT id FROM trips WHERE store_id = ? AND status = 'open'`).get(store.id) as any
	).id as string;
	return { h, actor, store, tripId };
}

/**
 * Bulk-seeds `count` pending items directly, in one transaction, bypassing
 * `addItem`'s per-row `MAX(sort_order)` scan so a 2000-row fixture builds in
 * milliseconds rather than looping the real endpoint 2000 times. Each row's
 * shape mirrors `addItem`'s own INSERT (items.ts) exactly, so it is otherwise
 * indistinguishable from a row `addItem` would have produced.
 */
function seedItems(
	h: Harness,
	tripId: string,
	storeId: string,
	actor: TestUser,
	count: number,
	options: { deletedCount?: number; startSortOrder?: number } = {}
): void {
	const deletedCount = options.deletedCount ?? 0;
	const startSortOrder = options.startSortOrder ?? 1000;
	const ts = Date.now();
	const stmt = h.db.prepare(
		`INSERT INTO items (
		   id, trip_id, store_id, client_id, name, note, state, sort_order,
		   ticked_at, ticked_by, carried_from_item_id, carried_to_item_id,
		   origin_item_id, carry_count, version, created_at, created_by, updated_at, deleted_at)
		 VALUES (?, ?, ?, NULL, ?, NULL, 'pending', ?, NULL, NULL, NULL, NULL, ?, 0, 1, ?, ?, ?, ?)`
	);
	h.db.exec('BEGIN');
	try {
		for (let i = 0; i < count; i += 1) {
			const id = randomUUID();
			const deletedAt = i < deletedCount ? ts : null;
			stmt.run(id, tripId, storeId, `Seed ${i}`, startSortOrder + i * 1000, id, ts, actor.id, ts, deletedAt);
		}
		h.db.exec('COMMIT');
	} catch (err) {
		h.db.exec('ROLLBACK');
		throw err;
	}
}

const nonDeletedCount = (h: Harness, tripId: string): number =>
	Number(
		(h.db.prepare('SELECT COUNT(*) AS n FROM items WHERE trip_id = ? AND deleted_at IS NULL').get(
			tripId
		) as any).n
	);

const revOf = (h: Harness, storeId: string): number =>
	Number((h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(storeId) as any).rev);

describe('§3.5 — at most 2000 non-deleted items per trip', () => {
	test('the constant really is 2000, so the boundary tests below match the contract', () => {
		expect(MAX_ITEMS_PER_TRIP).toBe(2000);
	});

	test('the item BELOW the limit (1999 existing) is accepted, reaching exactly 2000', () => {
		const { h, actor, store, tripId } = ctx();
		try {
			seedItems(h, tripId, store.id, actor, MAX_ITEMS_PER_TRIP - 1);
			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP - 1);

			const added = addItem(h.db, store.id, { name: 'The 2000th', clientId: randomUUID() }, actor);
			expect(added.created).toBe(true);
			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP);
		} finally {
			h.close();
		}
	});

	test('the item AT the limit (2000 existing) is rejected with 409 TRIP_ITEM_LIMIT', () => {
		const { h, actor, store, tripId } = ctx();
		try {
			seedItems(h, tripId, store.id, actor, MAX_ITEMS_PER_TRIP);
			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP);

			let caught: any;
			try {
				addItem(h.db, store.id, { name: 'One too many', clientId: randomUUID() }, actor);
			} catch (err) {
				caught = err;
			}
			expect(isDomainError(caught)).toBe(true);
			expect(caught.code).toBe('TRIP_ITEM_LIMIT');
			expect(caught.status).toBe(409);

			// Nothing was written: the count is exactly what it was before the call.
			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP);
		} finally {
			h.close();
		}
	});

	test('a rejected add at the limit bumps no rev and emits nothing (§3.0)', () => {
		const { h, actor, store, tripId } = ctx();
		try {
			seedItems(h, tripId, store.id, actor, MAX_ITEMS_PER_TRIP);
			const rec = recorder();
			const before = revOf(h, store.id);
			try {
				expect(() =>
					addItem(h.db, store.id, { name: 'One too many', clientId: randomUUID() }, actor)
				).toThrow();
				expect(revOf(h, store.id)).toBe(before);
				expect(rec.take()).toEqual([]);
			} finally {
				rec.stop();
			}
		} finally {
			h.close();
		}
	});

	test('R-17 — an idempotent retry of a clientId that already resolves succeeds AT the limit, because it writes nothing', () => {
		const { h, actor, store, tripId } = ctx();
		try {
			// One of the 2000 rows carries a client_id an earlier compose already
			// used, exactly like a row addItem itself would have produced.
			const clientId = randomUUID();
			seedItems(h, tripId, store.id, actor, MAX_ITEMS_PER_TRIP - 1);
			h.db
				.prepare(
					`INSERT INTO items (
					   id, trip_id, store_id, client_id, name, note, state, sort_order,
					   ticked_at, ticked_by, carried_from_item_id, carried_to_item_id,
					   origin_item_id, carry_count, version, created_at, created_by, updated_at, deleted_at)
					 VALUES (?, ?, ?, ?, 'Already there', NULL, 'pending', ?, NULL, NULL, NULL, NULL, ?, 0, 1, ?, ?, ?, NULL)`
				)
				.run(
					randomUUID(),
					tripId,
					store.id,
					clientId,
					9999000,
					randomUUID(), // origin_item_id (own root)
					Date.now(),
					actor.id,
					Date.now()
				);
			// Fix origin_item_id to equal the row's own id (I-6), since the insert
			// above generated a fresh id for origin rather than reusing the row id.
			const seeded = h.db
				.prepare(`SELECT id FROM items WHERE trip_id = ? AND client_id = ?`)
				.get(tripId, clientId) as any;
			h.db.prepare('UPDATE items SET origin_item_id = ? WHERE id = ?').run(seeded.id, seeded.id);

			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP);

			const rec = recorder();
			const before = revOf(h, store.id);
			try {
				// The retry resolves against the existing row BEFORE the cap is ever
				// checked (items.ts: the R-17 lookup runs first), so it succeeds even
				// though the trip is exactly full.
				const retry = addItem(h.db, store.id, { name: 'Already there', clientId }, actor);
				expect(retry.created).toBe(false);
				expect(retry.item.id).toBe(seeded.id);
				expect(retry.rev).toBe(before);

				// Nothing was written: count, rev and the bus are all unchanged.
				expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP);
				expect(revOf(h, store.id)).toBe(before);
				expect(rec.take()).toEqual([]);
			} finally {
				rec.stop();
			}
		} finally {
			h.close();
		}
	});

	test('soft-deleted rows do not count toward the cap, even when the trip holds 2000+ rows total', () => {
		const { h, actor, store, tripId } = ctx();
		try {
			// 2000 rows total, but 50 of them are already soft-deleted, so only
			// 1950 are live. The cap counts `deleted_at IS NULL` rows only.
			seedItems(h, tripId, store.id, actor, MAX_ITEMS_PER_TRIP, { deletedCount: 50 });
			const totalRows = Number(
				(h.db.prepare('SELECT COUNT(*) AS n FROM items WHERE trip_id = ?').get(tripId) as any).n
			);
			expect(totalRows).toBe(MAX_ITEMS_PER_TRIP);
			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP - 50);

			// There is room per the cap, so this add must succeed rather than 409.
			const added = addItem(h.db, store.id, { name: 'Room after all', clientId: randomUUID() }, actor);
			expect(added.created).toBe(true);
			expect(nonDeletedCount(h, tripId)).toBe(MAX_ITEMS_PER_TRIP - 49);
		} finally {
			h.close();
		}
	});
});
