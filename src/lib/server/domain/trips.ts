/**
 * Trips, close, rollover and claims — CONTRACT.md §3.5, §3.6, §8.4, §8.6,
 * R-6 … R-12, R-15, R-18 … R-20, §3.0/§8.9.
 *
 * Close is a single atomic transaction, always.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';
import { conflict, forbidden, notFound, validationFailed } from './errors.js';
import { emitStoreChanged, emitStoresChanged } from '../realtime/bus.js';
import { noteStoreActivity } from '../notify/index.js';
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
import {
	bumpRev,
	currentRev,
	getStoreSummary,
	openTripId,
	requireVisibleStore,
	requireVisibleStoreAs,
	requireWritableStore,
	type Actor
} from './stores.js';
import { beforeSeq, boundedInt, claimNote as validateClaimNote, boolean } from './validate.js';
import type { Item, StoreSummary, Trip, TripSummary } from '$lib/types';

const now = () => Date.now();

/**
 * §8.4: the 404 for a trip whose store is invisible is byte-identical to the 404
 * for a tripId that never existed. One factory, so they cannot drift.
 */
const tripNotFound = () => notFound('TRIP_NOT_FOUND', 'Trip not found.');

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
		// §8.4: visibility first — an invisible store 404s before it can 409, so
		// its archived state is not observable either. R-14: an archived store
		// rejects close with 409 STORE_ARCHIVED.
		requireWritableStore(db, storeId, actor.id);

		// 1. Re-read the trip inside the transaction.
		const trip = db.prepare('SELECT * FROM trips WHERE id = ?').get(tripId) as
			| TripRow
			| undefined;
		// R-6 step 1: a tripId that has NEVER existed is 404 TRIP_NOT_FOUND, not a
		// 409. Trips are never deleted, so it cannot be stale state — it is a
		// client bug or a guess, and a recoverable-looking 409 would hide it
		// behind a retry loop exactly as it would for a malformed body (§3.5).
		if (!trip) throw tripNotFound();
		// A trip that EXISTS but is closed, or belongs to another store, is the
		// genuinely stale case and still gets the 409 with openTripId.
		//
		// The M6 audit observed that this makes a real-but-foreign trip id
		// distinguishable from an invented one, and §8.4 is written as an
		// absolute. It stays as it is: **R-6 step 1 of the FROZEN §2 mandates
		// this 409 in exactly these words**, reaching it requires guessing a v4
		// UUID, and it discloses nothing but "some trip has this id". The
		// contract is not edited to match an implementation and an implementation
		// is not changed out from under a frozen rule on the strength of an
		// unreachable finding — §8.4's absolute is what was overstated, and it is
		// corrected there instead.
		if (trip.store_id !== storeId || trip.status !== 'open') {
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
			closedTrip: toTrip(closedTrip, actor.id),
			newTrip: toTrip(newTrip, actor.id),
			boughtCount: Number(boughtRow.n),
			carriedCount: pending.length,
			rev
		};
	});

	// 7. Emit AFTER commit, never inside it. §8.9: and notify in the same place,
	//    under the same condition.
	emitStoreChanged(storeId, result.rev);
	emitStoresChanged();
	noteStoreActivity(storeId);
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
	actorId: string,
	options: { limit?: unknown; before?: unknown } = {}
): TripHistoryPage {
	// §8.4: 404 STORE_NOT_FOUND, identical to a store id that never existed.
	requireVisibleStore(db, storeId, actorId);
	const limit = options.limit === undefined ? 20 : boundedInt(options.limit, 'limit', 1, 50);
	const before = options.before === undefined ? null : beforeSeq(options.before);

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
		trips: page.map((row) => toTripSummary(row, actorId)),
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
export function getTripDetail(db: Db, tripId: string, actorId: string): TripDetail {
	const row = db.prepare(`${TRIP_SUMMARY_SELECT} WHERE t.id = ?`).get(tripId) as
		| TripRow
		| undefined;
	if (!row) throw tripNotFound();
	// §8.4: a trip on a store the caller cannot see answers with the SAME 404 as
	// a tripId that never existed — same code, same message, same status.
	requireVisibleStoreAs(db, row.store_id, actorId, tripNotFound);

	const items = db
		.prepare(
			`${ITEM_SELECT}
			  WHERE i.trip_id = ? AND i.deleted_at IS NULL
			  ORDER BY CASE i.state WHEN 'ticked' THEN 0 WHEN 'carried' THEN 1 ELSE 2 END,
			           i.sort_order ASC, i.id ASC`
		)
		.all(tripId) as unknown as ItemRow[];

	return { trip: toTripSummary(row, actorId), items: items.map(toItem) };
}

// ---------------------------------------------------------------------------
// Claims — §8.6, R-18 … R-20.
// ---------------------------------------------------------------------------

export interface ClaimResult {
	store: StoreSummary;
	trip: Trip;
	/** false when nothing was written: the same holder re-claiming with the same
	 *  note (R-19), or releasing an already-unclaimed trip (R-20). §8.9 then
	 *  bumps nothing, emits nothing and notifies nothing. */
	changed: boolean;
	rev: number;
}

interface ClaimTripRow {
	id: string;
	store_id: string;
	status: string;
	claimed_by: string | null;
	claimed_at: number | null;
	claim_note: string | null;
}

/**
 * The same staleness guard `trips/close` uses (§3.5, §8.6): a missing or
 * non-string `tripId` is 400 — the client is broken, and a recoverable-looking
 * 409 would hide that behind a retry loop. A well-formed tripId that never
 * existed is 404; one that exists but is not this store's open trip is 409
 * TRIP_ALREADY_CLOSED with the openTripId sibling field.
 */
function requireOpenTrip(db: Db, storeId: string, tripId: string): ClaimTripRow {
	const trip = db
		.prepare('SELECT id, store_id, status, claimed_by, claimed_at, claim_note FROM trips WHERE id = ?')
		.get(tripId) as ClaimTripRow | undefined;
	if (!trip) throw tripNotFound();
	// Deliberately identical to `closeTrip`'s answer, including the foreign-store
	// case — §8.6 defines this guard as "the same staleness guard trips/close
	// uses", and two staleness guards that disagree is worse than either answer.
	if (trip.store_id !== storeId || trip.status !== 'open') {
		throw conflict('TRIP_ALREADY_CLOSED', 'That trip is already finished.', {
			openTripId: openTripId(db, storeId) ?? ''
		});
	}
	return trip;
}

function displayNameOf(db: Db, userId: string): string {
	const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId) as
		| { display_name: string }
		| undefined;
	// A claim held by an account that no longer exists cannot happen — claimed_by
	// is ON DELETE SET NULL and a NULL claimed_by reads as unclaimed (I-16) — but
	// the message must never be `undefined is already shopping.`
	return row ? row.display_name : 'Someone';
}

/**
 * `POST /api/stores/{storeId}/claim` — R-18, R-19.
 *
 * All three claim columns are written by ONE UPDATE (I-16). The claim lands on
 * the store's OPEN trip, so R-6 retires it by opening a fresh one: nothing has
 * to remember to clear anything, and the claim stays on the closed trip as the
 * record of who did that shopping.
 */
export function claimTrip(
	db: Db,
	storeId: string,
	input: { tripId: unknown; note?: unknown; takeover?: unknown },
	actor: Actor
): ClaimResult {
	if (typeof input.tripId !== 'string' || input.tripId.length === 0) {
		throw validationFailed('tripId is required.');
	}
	const tripId = input.tripId;
	// §3.1a: validated BEFORE the write. The migration-002 CHECK on claim_note is
	// the backstop that catches a route which forgot, in tests, not in production.
	const note = validateClaimNote(input.note);
	const takeover =
		input.takeover === undefined || input.takeover === null
			? false
			: boolean(input.takeover, 'takeover');

	const result = tx(db, () => {
		// §8.4: visibility first, before the trip is even looked up. R-14 does not
		// list claiming among the writes an archived store rejects, so it is not
		// rejected here either.
		requireVisibleStore(db, storeId, actor.id);
		const trip = requireOpenTrip(db, storeId, tripId);

		const holder = trip.claimed_by ?? null;
		const mine = holder !== null && holder === actor.id;
		if (holder !== null && !mine && !takeover) {
			// R-19: the message names the holder — a display name, never an id — so
			// the client can offer "take over anyway" without a second round trip.
			// §8.10: TRIP_CLAIMED carries no sibling field.
			throw conflict('TRIP_CLAIMED', `${displayNameOf(db, holder)} is already shopping this trip.`);
		}

		// R-19: the same member re-claiming their own trip is not a conflict, it
		// updates the note — and if the note is unchanged too, nothing happened.
		if (mine && (trip.claim_note ?? null) === note) {
			return { changed: false, rev: currentRev(db, storeId), tripId };
		}

		// R-19: the same holder editing their note keeps the ORIGINAL claimed_at.
		// "Ayşe has been shopping since 18:04" is the useful fact, and rewriting
		// the timestamp on a note edit silently changes it to 18:31. A takeover
		// and a fresh claim both start the clock; only an edit preserves it.
		// I-16 holds either way — all three columns are still written by this one
		// statement.
		const claimedAt = mine ? (trip.claimed_at ?? now()) : now();
		db.prepare(
			'UPDATE trips SET claimed_by = ?, claimed_at = ?, claim_note = ? WHERE id = ?'
		).run(actor.id, claimedAt, note, tripId);

		return { changed: true, rev: bumpRev(db, storeId), tripId };
	});

	return finishClaim(db, storeId, result, actor);
}

/**
 * `DELETE /api/stores/{storeId}/claim` — R-20. Clears the three columns in one
 * UPDATE. Only the current holder may release; anyone else gets 403 FORBIDDEN.
 * Releasing an unclaimed trip is an idempotent success that writes nothing.
 */
export function releaseClaim(db: Db, storeId: string, actor: Actor): ClaimResult {
	const result = tx(db, () => {
		requireVisibleStore(db, storeId, actor.id);
		const tripId = openTripId(db, storeId);
		// R-1 makes this unreachable: a store never exists without an open trip.
		if (tripId === null) throw tripNotFound();
		const trip = db.prepare('SELECT claimed_by FROM trips WHERE id = ?').get(tripId) as
			| { claimed_by: string | null }
			| undefined;

		const holder = trip?.claimed_by ?? null;
		// I-16: claimed_by IS NULL is unclaimed whatever the other two columns say.
		if (holder === null) return { changed: false, rev: currentRev(db, storeId), tripId };
		if (holder !== actor.id) {
			// A 403, not a 404: the caller can see this store, so the existence of
			// the claim is not a secret from them — only the right to end it is.
			throw forbidden('Only the person shopping can release this.');
		}

		db.prepare(
			'UPDATE trips SET claimed_by = NULL, claimed_at = NULL, claim_note = NULL WHERE id = ?'
		).run(tripId);

		return { changed: true, rev: bumpRev(db, storeId), tripId };
	});

	return finishClaim(db, storeId, result, actor);
}

/**
 * §8.9: a claim that changed something bumps `rev` and emits BOTH store events —
 * the home screen card shows the claim and so does the list header — and
 * notifies. One that changed nothing does none of the three. Everything here
 * happens AFTER the transaction commits.
 */
function finishClaim(
	db: Db,
	storeId: string,
	result: { changed: boolean; rev: number; tripId: string },
	actor: Actor
): ClaimResult {
	if (result.changed) {
		emitStoresChanged();
		emitStoreChanged(storeId, result.rev);
		noteStoreActivity(storeId);
	}
	const trip = db.prepare(`${TRIP_SELECT} WHERE t.id = ?`).get(result.tripId) as unknown as TripRow;
	return {
		store: getStoreSummary(db, storeId, actor),
		trip: toTrip(trip, actor.id),
		changed: result.changed,
		rev: result.rev
	};
}
