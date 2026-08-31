/**
 * Items — CONTRACT.md §3.5, R-2 … R-5, R-8, R-10, R-13, R-15, R-17, §3.0.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';
import { conflict, notFound, validationFailed } from './errors.js';
import { emitStoreChanged } from '../realtime/bus.js';
import { ITEM_SELECT, readItem, toItem, type ItemRow } from './rows.js';
import {
	bumpRev,
	currentRev,
	getStoreSummary,
	requireStore,
	requireWritableStore,
	type Actor
} from './stores.js';
import { clientId as validateClientId, itemVersion, itemName, itemNote } from './validate.js';
import type { Item, ItemMutation, StoreSummary, Trip } from '$lib/types';
import { toTrip, TRIP_SELECT, type TripRow } from './rows.js';

const now = () => Date.now();

/** §3.5: at most 2000 non-deleted items per trip; beyond it, 409 TRIP_ITEM_LIMIT. */
export const MAX_ITEMS_PER_TRIP = 2000;

/**
 * I-3's enforcement point. `items.store_id` is denormalized from `trips.store_id`,
 * and §1.2 makes that test-bound rather than trigger-bound precisely because a
 * single helper that returns both ids together makes the violation unwritable.
 * Nothing else in this codebase may compose an item's `(trip_id, store_id)` pair.
 */
export function resolveOpenTrip(db: Db, storeId: string): { tripId: string; storeId: string } {
	const row = db
		.prepare(`SELECT id, store_id FROM trips WHERE store_id = ? AND status = 'open'`)
		.get(storeId) as { id: string; store_id: string } | undefined;
	if (!row) {
		// R-1 makes this unreachable: a store never exists without an open trip.
		throw notFound('TRIP_NOT_FOUND', 'This store has no open list.');
	}
	return { tripId: row.id, storeId: row.store_id };
}

interface ItemContextRow extends ItemRow {
	trip_status: string;
	store_archived_at: number | null;
}

function loadItemContext(db: Db, itemId: string): ItemContextRow | undefined {
	return db
		.prepare(
			`SELECT i.*, cu.display_name AS created_by_name, tu.display_name AS ticked_by_name,
			        t.status AS trip_status, s.archived_at AS store_archived_at
			   FROM items i
			   JOIN trips  t ON t.id = i.trip_id
			   JOIN stores s ON s.id = i.store_id
			   LEFT JOIN users cu ON cu.id = i.created_by
			   LEFT JOIN users tu ON tu.id = i.ticked_by
			  WHERE i.id = ?`
		)
		.get(itemId) as unknown as ItemContextRow | undefined;
}

/** R-8: the only writes a closed trip ever receives are those in R-6 step 5. */
function assertWritable(row: ItemContextRow): void {
	if (row.trip_status !== 'open') {
		throw conflict('TRIP_CLOSED', 'That trip has been finished.');
	}
	if (row.store_archived_at !== null && row.store_archived_at !== undefined) {
		throw conflict('STORE_ARCHIVED', 'This store is archived.');
	}
}

/**
 * R-13. Pending items sort by `sort_order ASC, created_at ASC, id ASC`; ticked
 * items sort BELOW all pending items by `ticked_at DESC, id ASC`. The `id`
 * tiebreaks are mandatory — without a total order the list visibly reshuffles
 * between refetches. `carried` items never appear in an open list.
 *
 * Two statements rather than one CASE-laden ORDER BY: the two groups sort by
 * different columns in different directions, and the two-query form is the one
 * a reader can check against R-13 line by line.
 */
export function listOpenItems(db: Db, tripId: string): Item[] {
	const pending = db
		.prepare(
			`${ITEM_SELECT}
			  WHERE i.trip_id = ? AND i.deleted_at IS NULL AND i.state = 'pending'
			  ORDER BY i.sort_order ASC, i.created_at ASC, i.id ASC`
		)
		.all(tripId) as unknown as ItemRow[];
	const ticked = db
		.prepare(
			`${ITEM_SELECT}
			  WHERE i.trip_id = ? AND i.deleted_at IS NULL AND i.state = 'ticked'
			  ORDER BY i.ticked_at DESC, i.id ASC`
		)
		.all(tripId) as unknown as ItemRow[];
	return [...pending, ...ticked].map(toItem);
}

export interface ListResponse {
	store: StoreSummary;
	trip: Trip;
	items: Item[];
}

/** `GET /api/stores/{storeId}/list` — §3.5. Never includes deleted or carried items. */
export function getOpenList(db: Db, storeId: string): ListResponse {
	const store = getStoreSummary(db, storeId);
	const tripRow = db
		.prepare(`${TRIP_SELECT} WHERE t.store_id = ? AND t.status = 'open'`)
		.get(storeId) as unknown as TripRow | undefined;
	if (!tripRow) throw notFound('TRIP_NOT_FOUND', 'This store has no open list.');
	return { store, trip: toTrip(tripRow), items: listOpenItems(db, tripRow.id) };
}

export interface AddItemResult extends ItemMutation {
	/** false when R-17's idempotent lookup hit an existing row. */
	created: boolean;
}

/**
 * R-2 (store-scoped add), R-15 (server-assigned `sort_order`), R-17 (idempotency
 * that survives a rollover). §3.0: a new row bumps `rev` and emits
 * `store.changed`; an idempotent hit bumps nothing and emits nothing.
 */
export function addItem(
	db: Db,
	storeId: string,
	input: { name: unknown; note?: unknown; clientId: unknown },
	actor: Actor
): AddItemResult {
	const name = itemName(input.name);
	const note = itemNote(input.note);
	const cid = validateClientId(input.clientId);

	const result = tx(db, () => {
		requireWritableStore(db, storeId);

		// R-17: store-scoped and rollover-safe. A retry whose original committed
		// before a close resolves to the CLONE on the successor trip.
		const existing = db
			.prepare(
				`${ITEM_SELECT}
				  WHERE i.store_id = ? AND i.client_id = ? AND i.state <> 'carried' AND i.deleted_at IS NULL`
			)
			.get(storeId, cid) as unknown as ItemRow | undefined;
		if (existing) {
			return { item: toItem(existing), rev: currentRev(db, storeId), created: false };
		}

		const target = resolveOpenTrip(db, storeId);

		// §3.5: at most 2000 non-deleted items per trip. GET /list and
		// GET /trips/{id} return every item unpaginated, and one account holder —
		// every account here belongs to a person who could be careless or
		// compromised, which is the stated threat model — must not be able to make
		// a response, or the database, unbounded by looping this endpoint. The cap
		// is checked only on the create path: an R-17 idempotent retry above still
		// succeeds at the limit, because it writes nothing.
		const countRow = db
			.prepare('SELECT COUNT(*) AS n FROM items WHERE trip_id = ? AND deleted_at IS NULL')
			.get(target.tripId) as { n: number };
		if (Number(countRow.n) >= MAX_ITEMS_PER_TRIP) {
			throw conflict('TRIP_ITEM_LIMIT', 'This list is full. Finish the trip to start a new one.');
		}

		const ts = now();
		const id = randomUUID();

		// R-15: COALESCE(MAX(sort_order), 0) + 1000 over ALL rows of the target
		// trip, deleted included, computed inside this same transaction.
		const maxRow = db
			.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM items WHERE trip_id = ?')
			.get(target.tripId) as { m: number };
		const sortOrder = Number(maxRow.m) + 1000;

		db.prepare(
			`INSERT INTO items (
			   id, trip_id, store_id, client_id, name, note, state, sort_order,
			   ticked_at, ticked_by, carried_from_item_id, carried_to_item_id,
			   origin_item_id, carry_count, version, created_at, created_by, updated_at, deleted_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, 0, 1, ?, ?, ?, NULL)`
		).run(id, target.tripId, target.storeId, cid, name, note, sortOrder, id, ts, actor.id, ts);

		const rev = bumpRev(db, storeId);
		const item = readItem(db, id);
		if (!item) throw new Error('Item vanished immediately after insert');
		return { item, rev, created: true };
	});

	if (result.created) emitStoreChanged(storeId, result.rev);
	return result;
}

/**
 * `PATCH /api/items/{itemId}` — §3.5. `409 VERSION_CONFLICT` carries the current
 * item so the client can reconcile without a second round trip.
 */
export function updateItem(
	db: Db,
	itemId: string,
	input: { name?: unknown; note?: unknown; version: unknown }
): ItemMutation {
	const hasName = Object.hasOwn(input, 'name') && input.name !== undefined;
	const hasNote = Object.hasOwn(input, 'note');
	if (!hasName && !hasNote) throw validationFailed('Nothing to update.');
	const name = hasName ? itemName(input.name) : null;
	const note = hasNote ? itemNote(input.note) : null;
	const version = itemVersion(input.version);

	const result = tx(db, () => {
		const row = loadItemContext(db, itemId);
		if (!row || row.deleted_at !== null) throw notFound('ITEM_NOT_FOUND', 'Item not found.');
		assertWritable(row);
		if (Number(row.version) !== version) {
			throw conflict('VERSION_CONFLICT', 'Someone else changed this item.', {
				item: toItem(row)
			});
		}

		const ts = now();
		db.prepare(
			`UPDATE items
			    SET name = COALESCE(?, name),
			        note = CASE WHEN ? = 1 THEN ? ELSE note END,
			        version = version + 1,
			        updated_at = ?
			  WHERE id = ?`
		).run(name, hasNote ? 1 : 0, note, ts, itemId);

		const rev = bumpRev(db, row.store_id);
		const item = readItem(db, itemId);
		if (!item) throw new Error('Item vanished during update');
		return { item, rev, storeId: row.store_id };
	});

	emitStoreChanged(result.storeId, result.rev);
	return { item: result.item, rev: result.rev };
}

export interface DeleteResult extends ItemMutation {
	/** false when the item was already soft-deleted (R-10 idempotent repeat). */
	changed: boolean;
}

/** R-10: soft delete, idempotent. A pending item deleted before close is not carried. */
export function deleteItem(db: Db, itemId: string): DeleteResult {
	const result = tx(db, () => {
		const row = loadItemContext(db, itemId);
		if (!row) throw notFound('ITEM_NOT_FOUND', 'Item not found.');

		if (row.deleted_at !== null && row.deleted_at !== undefined) {
			// §3.0: already deleted — bumps nothing, emits nothing.
			return { item: toItem(row), rev: currentRev(db, row.store_id), changed: false, storeId: row.store_id };
		}

		assertWritable(row);

		const ts = now();
		db.prepare('UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, itemId);
		const rev = bumpRev(db, row.store_id);
		const item = readItem(db, itemId);
		if (!item) throw new Error('Item vanished during delete');
		return { item, rev, changed: true, storeId: row.store_id };
	});

	if (result.changed) emitStoreChanged(result.storeId, result.rev);
	return { item: result.item, rev: result.rev, changed: result.changed };
}

export interface TickResult extends ItemMutation {
	/** false when the item was already in the requested state (R-4, R-5). */
	changed: boolean;
}

/**
 * R-3 and R-4. Ticking an already-ticked item is a success and does NOT
 * overwrite the original `ticked_at`/`ticked_by` — the first writer is recorded.
 */
export function tickItem(db: Db, itemId: string, actor: Actor): TickResult {
	return setTicked(db, itemId, true, actor);
}

/** R-5. Idempotent in the same way. Allowed only while the trip is open (R-9). */
export function untickItem(db: Db, itemId: string, actor: Actor): TickResult {
	return setTicked(db, itemId, false, actor);
}

function setTicked(db: Db, itemId: string, ticked: boolean, actor: Actor): TickResult {
	const result = tx(db, () => {
		const row = loadItemContext(db, itemId);
		// §3.5: 404 if the item does not exist OR is soft-deleted.
		if (!row || row.deleted_at !== null) throw notFound('ITEM_NOT_FOUND', 'Item not found.');
		assertWritable(row);

		const target = ticked ? 'ticked' : 'pending';
		if (row.state === target) {
			return { item: toItem(row), rev: currentRev(db, row.store_id), changed: false, storeId: row.store_id };
		}

		const ts = now();
		if (ticked) {
			db.prepare(
				`UPDATE items SET state = 'ticked', ticked_at = ?, ticked_by = ?,
				        version = version + 1, updated_at = ? WHERE id = ?`
			).run(ts, actor.id, ts, itemId);
		} else {
			db.prepare(
				`UPDATE items SET state = 'pending', ticked_at = NULL, ticked_by = NULL,
				        version = version + 1, updated_at = ? WHERE id = ?`
			).run(ts, itemId);
		}

		const rev = bumpRev(db, row.store_id);
		const item = readItem(db, itemId);
		if (!item) throw new Error('Item vanished during tick');
		return { item, rev, changed: true, storeId: row.store_id };
	});

	if (result.changed) emitStoreChanged(result.storeId, result.rev);
	return { item: result.item, rev: result.rev, changed: result.changed };
}

export { requireStore };
