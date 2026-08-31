/**
 * Trips, close and rollover — CONTRACT.md §3.5, §3.6, R-6 … R-12, R-15, §3.0.
 *
 * Close is a single atomic transaction, always.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';
import { conflict, notFound, validationFailed } from './errors.js';
import { emitStoreChanged, emitStoresChanged } from '../realtime/bus.js';
import {
	ITEM_SELECT,
	TRIP_SELECT,
	TRIP_SUMMARY_SELECT,
	toItem,
	toTrip,
	toTripSummary,
	type ItemRow,
	type TripRow
} from './rows.js';
import { bumpRev, openTripId, requireStore, type Actor } from './stores.js';
import { boundedInt, integer } from './validate.js';
import type { Item, Trip, TripSummary } from '$lib/types';

const now = () => Date.now();

export interface CloseResult {
	closedTrip: Trip;
	newTrip: Trip;
	boughtCount: number;
	carriedCount: number;
	rev: number;
}

/**
 * R-6 step 5, the one place in this codebase where statement order is
 * load-bearing (D-024). Three statements, not two:
 *
 *   1. insert the clone with `client_id = NULL`
 *   2. mark the original `carried`, pointing at the clone
 *   3. set the clone's `client_id` to the original's
 *
 * `carried_to_item_id` is a self-referencing foreign key and SQLite checks
 * foreign keys immediately, so marking the original first points at a row that
 * does not exist. `client_id` is carried rather than nulled (I-11, R-17), so
 * inserting the clone first puts two rows inside `items_client_id`'s partial
 * predicate at once. Neither two-statement order commits; tests assert both
 * raise SQLITE_CONSTRAINT so this cannot regress into a scheme that only works
 * because a constraint was dropped.
 */
function carryForward(db: Db, original: ItemRow, newTripId: string, ts: number): string {
	// Generate the clone's id in application code first.
	const cloneId = randomUUID();

	db.prepare(
		`INSERT INTO items (
		   id, trip_id, store_id, client_id, name, note, state, sort_order,
		   ticked_at, ticked_by, carried_from_item_id, carried_to_item_id,
		   origin_item_id, carry_count, version, created_at, created_by, updated_at, deleted_at)
		 VALUES (?, ?, ?, NULL, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, ?, ?, 1, ?, ?, ?, NULL)`
	).run(
		cloneId,
		newTripId,
		original.store_id,
		original.name,
		original.note,
		// R-15: a clone INHERITS the original's sort_order verbatim.
		original.sort_order,
		original.id,
		original.origin_item_id,
		Number(original.carry_count) + 1,
		ts,
		// The original author is preserved — carry-over is not authorship.
		original.created_by,
		ts
	);

	db.prepare(
		`UPDATE items SET state = 'carried', carried_to_item_id = ?, version = version + 1,
		        updated_at = ? WHERE id = ?`
	).run(cloneId, ts, original.id);

	db.prepare('UPDATE items SET client_id = ? WHERE id = ?').run(original.client_id, cloneId);

	return cloneId;
}

/**
 * `POST /api/stores/{storeId}/trips/close` — R-6, R-7, R-11.
 * §3.0: bumps `rev` and emits BOTH `store.changed` and `stores.changed`.
 */
export function closeTrip(
	db: Db,
	storeId: string,
	input: { tripId: unknown },
	actor: Actor
): CloseResult {
	// §3.5: a MISSING or NON-STRING tripId is 400 VALIDATION_FAILED, never a 409.
	// The 409 means "your view of the world is stale and here is the current
	// trip"; a malformed body means the client is broken, and answering it with a
	// recoverable-looking 409 hides that bug behind a retry loop that appears to
	// work. A stale but well-formed tripId still gets the 409 with openTripId.
	if (typeof input.tripId !== 'string' || input.tripId.length === 0) {
		throw validationFailed('tripId is required.');
	}
	const tripId = input.tripId;

	const result = tx(db, () => {
		const store = requireStore(db, storeId);
		if (store.archivedAt !== null) throw conflict('STORE_ARCHIVED', 'This store is archived.');

		// 1. Re-read the trip inside the transaction.
		const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as
			| TripRow
			| undefined;
		if (!trip || trip.store_id !== storeId || trip.status !== 'open') {
			throw conflict('TRIP_ALREADY_CLOSED', 'That trip is already finished.', {
				openTripId: openTripId(db, storeId) ?? ''
			});
		}

		// 2. An empty trip would write a meaningless entry into history.
		const countRow = db
			.prepare('SELECT COUNT(*) AS n FROM items WHERE trip_id = ? AND deleted_at IS NULL')
			.get(tripId) as { n: number };
		if (Number(countRow.n) === 0) {
			throw conflict('TRIP_EMPTY', 'There is nothing on this list to finish.');
		}

		const ts = now();

		// 3. Close it. This must happen BEFORE step 4 or trips_one_open_per_store
		//    rejects the successor insert.
		db.prepare(`UPDATE trips SET status = 'closed', closed_at = ?, closed_by = ? WHERE id = ?`).run(
			ts,
			actor.id,
			tripId
		);

		// 4. Insert the successor trip.
		const newTripId = randomUUID();
		db.prepare(
			`INSERT INTO trips (id, store_id, seq, status, opened_at, closed_at, closed_by)
			 VALUES (?, ?, ?, 'open', ?, NULL, NULL)`
		).run(newTripId, storeId, Number(trip.seq) + 1, ts);

		// 5. Carry every non-deleted pending item forward. R-7: ticked items are
		//    not touched — they stay in the closed trip forever as the history.
		const pending = db
			.prepare(
				`SELECT * FROM items
				  WHERE trip_id = ? AND deleted_at IS NULL AND state = 'pending'
				  ORDER BY sort_order ASC, created_at ASC, id ASC`
			)
			.all(tripId) as unknown as ItemRow[];
		for (const original of pending) carryForward(db, original, newTripId, ts);

		const boughtRow = db
			.prepare(
				`SELECT COUNT(*) AS n FROM items
				  WHERE trip_id = ? AND state = 'ticked' AND deleted_at IS NULL`
			)
			.get(tripId) as { n: number };

		// 6. Bump the store's rev, inside this same transaction.
		const rev = bumpRev(db, storeId);

		const closedTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = ?`).get(tripId) as unknown as TripRow;
		const newTrip = db.prepare(`${TRIP_SELECT} WHERE t.id = ?`).get(newTripId) as unknown as TripRow;

		return {
			closedTrip: toTrip(closedTrip),
			newTrip: toTrip(newTrip),
			boughtCount: Number(boughtRow.n),
			carriedCount: pending.length,
			rev
		};
	});

	// 7. Emit AFTER commit, never inside it.
	emitStoreChanged(storeId, result.rev);
	emitStoresChanged();
	return result;
}

export interface TripHistoryPage {
	trips: TripSummary[];
	nextBefore: number | null;
}

/** `GET /api/stores/{storeId}/trips?limit=20&before={seq}` — §3.6. Closed trips, newest first. */
export function listClosedTrips(
	db: Db,
	storeId: string,
	options: { limit?: unknown; before?: unknown } = {}
): TripHistoryPage {
	requireStore(db, storeId);
	const limit = options.limit === undefined ? 20 : boundedInt(options.limit, 'limit', 1, 50);
	const before = options.before === undefined ? null : integer(options.before, 'before');

	const rows = (
		before === null
			? db
					.prepare(
						`${TRIP_SUMMARY_SELECT}
						  WHERE t.store_id = ? AND t.status = 'closed'
						  ORDER BY t.seq DESC LIMIT ?`
					)
					.all(storeId, limit + 1)
			: db
					.prepare(
						`${TRIP_SUMMARY_SELECT}
						  WHERE t.store_id = ? AND t.status = 'closed' AND t.seq < ?
						  ORDER BY t.seq DESC LIMIT ?`
					)
					.all(storeId, before, limit + 1)
	) as unknown as TripRow[];

	const page = rows.slice(0, limit);
	const hasMore = rows.length > limit;
	return {
		trips: page.map(toTripSummary),
		nextBefore: hasMore && page.length > 0 ? Number(page[page.length - 1].seq) : null
	};
}

export interface TripDetail {
	trip: TripSummary;
	items: Item[];
}

/**
 * `GET /api/trips/{tripId}` — §3.6. Items are ordered BOUGHT FIRST, THEN LEFT
 * BEHIND:
 *
 *   CASE state WHEN 'ticked' THEN 0 WHEN 'carried' THEN 1 ELSE 2 END,
 *   sort_order ASC, id ASC
 *
 * The explicit CASE is load-bearing: a plain `state ASC` sorts alphabetically,
 * which puts `carried` above `ticked` and renders the history screen with what
 * you failed to buy at the top and what you actually bought below it. That is
 * backwards. `carried` items are INCLUDED — the history screen's "left on the
 * list" count is meaningless without them, and R-13's exclusion of `carried`
 * applies to the open list only. Soft-deleted items are excluded per I-8. Works
 * for open and closed trips alike.
 */
export function getTripDetail(db: Db, tripId: string): TripDetail {
	const row = db.prepare(`${TRIP_SUMMARY_SELECT} WHERE t.id = ?`).get(tripId) as
		| TripRow
		| undefined;
	if (!row) throw notFound('TRIP_NOT_FOUND', 'Trip not found.');

	const items = db
		.prepare(
			`${ITEM_SELECT}
			  WHERE i.trip_id = ? AND i.deleted_at IS NULL
			  ORDER BY CASE i.state WHEN 'ticked' THEN 0 WHEN 'carried' THEN 1 ELSE 2 END,
			           i.sort_order ASC, i.id ASC`
		)
		.all(tripId) as unknown as ItemRow[];

	return { trip: toTripSummary(row), items: items.map(toItem) };
}
