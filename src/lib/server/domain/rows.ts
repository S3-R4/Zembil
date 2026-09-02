/**
 * Row → domain-object mapping and the SELECT fragments shared across modules.
 *
 * §1.1a: rows come back as null-prototype objects, so nothing here spreads a row
 * into something expecting `Object.prototype`. Every value is read by name and
 * coerced explicitly.
 *
 * §8.6: `StoreSummary` and `Trip` both carry the four `Claim` fields, and
 * `claimedByMe` is NOT a column — it is computed per request from the session's
 * user id, which every mapper below therefore takes explicitly. It is passed as
 * an argument rather than held in module state on purpose: a request-scoped
 * value in a module-level variable is one `await` away from answering for the
 * wrong member.
 */
import type { Db } from '../db/index.js';
import type {
	Claim,
	Item,
	ItemState,
	StoreColor,
	StoreSummary,
	StoreVisibility,
	Trip,
	TripSummary,
	TripStatus
} from '$lib/types';

/** Raw `items` row joined with the two display names §7 requires. */
export interface ItemRow {
	id: string;
	trip_id: string;
	store_id: string;
	client_id: string | null;
	name: string;
	note: string | null;
	state: string;
	sort_order: number;
	ticked_at: number | null;
	ticked_by: string | null;
	carried_from_item_id: string | null;
	carried_to_item_id: string | null;
	origin_item_id: string;
	carry_count: number;
	version: number;
	created_at: number;
	created_by: string | null;
	updated_at: number;
	deleted_at: number | null;
	created_by_name?: string | null;
	ticked_by_name?: string | null;
}

export const ITEM_SELECT = `
  SELECT i.*, cu.display_name AS created_by_name, tu.display_name AS ticked_by_name
    FROM items i
    LEFT JOIN users cu ON cu.id = i.created_by
    LEFT JOIN users tu ON tu.id = i.ticked_by
`;

export function toItem(row: ItemRow): Item {
	return {
		id: row.id,
		tripId: row.trip_id,
		storeId: row.store_id,
		name: row.name,
		note: row.note ?? null,
		state: row.state as ItemState,
		sortOrder: Number(row.sort_order),
		tickedAt: row.ticked_at === null || row.ticked_at === undefined ? null : Number(row.ticked_at),
		tickedByName: row.ticked_by_name ?? null,
		carryCount: Number(row.carry_count),
		version: Number(row.version),
		createdAt: Number(row.created_at),
		createdByName: row.created_by_name ?? null
	};
}

/** The three claim columns plus the joined display name, as they come back. */
export interface ClaimRow {
	claimed_by?: string | null;
	claimed_at?: number | null;
	claim_note?: string | null;
	claimed_by_name?: string | null;
}

/**
 * I-16, the reader's half: **`claimed_by IS NULL` is unclaimed, whatever the
 * other two columns say.** `trips.claimed_by` is `ON DELETE SET NULL`, so a
 * deleted account leaves `claimed_at` and `claim_note` behind; reading them
 * without this guard would resurrect a claim owned by nobody, and the client
 * would render a release button that nobody can press.
 */
export function toClaim(row: ClaimRow, actorId: string): Claim {
	const claimedBy = row.claimed_by ?? null;
	if (claimedBy === null) {
		return { claimedByName: null, claimedByMe: false, claimedAt: null, claimNote: null };
	}
	return {
		claimedByName: row.claimed_by_name ?? null,
		claimedByMe: claimedBy === actorId,
		claimedAt:
			row.claimed_at === null || row.claimed_at === undefined ? null : Number(row.claimed_at),
		claimNote: row.claim_note ?? null
	};
}

export interface TripRow extends ClaimRow {
	id: string;
	store_id: string;
	seq: number;
	status: string;
	opened_at: number;
	closed_at: number | null;
	closed_by: string | null;
	closed_by_name?: string | null;
	bought_count?: number;
	carried_count?: number;
}

export const TRIP_SELECT = `
  SELECT t.*, u.display_name AS closed_by_name, cb.display_name AS claimed_by_name
    FROM trips t
    LEFT JOIN users u  ON u.id  = t.closed_by
    LEFT JOIN users cb ON cb.id = t.claimed_by
`;

export const TRIP_SUMMARY_SELECT = `
  SELECT t.*, u.display_name AS closed_by_name, cb.display_name AS claimed_by_name,
         (SELECT COUNT(*) FROM items i
           WHERE i.trip_id = t.id AND i.state = 'ticked' AND i.deleted_at IS NULL) AS bought_count,
         (SELECT COUNT(*) FROM items i
           WHERE i.trip_id = t.id AND i.state = 'carried' AND i.deleted_at IS NULL) AS carried_count
    FROM trips t
    LEFT JOIN users u  ON u.id  = t.closed_by
    LEFT JOIN users cb ON cb.id = t.claimed_by
`;

export function toTrip(row: TripRow, actorId: string): Trip {
	return {
		id: row.id,
		storeId: row.store_id,
		seq: Number(row.seq),
		status: row.status as TripStatus,
		openedAt: Number(row.opened_at),
		closedAt: row.closed_at === null || row.closed_at === undefined ? null : Number(row.closed_at),
		closedByName: row.closed_by_name ?? null,
		...toClaim(row, actorId)
	};
}

export function toTripSummary(row: TripRow, actorId: string): TripSummary {
	return {
		...toTrip(row, actorId),
		boughtCount: Number(row.bought_count ?? 0),
		carriedCount: Number(row.carried_count ?? 0)
	};
}

export interface StoreSummaryRow extends ClaimRow {
	id: string;
	name: string;
	color: string;
	sort_order: number;
	rev: number;
	archived_at: number | null;
	private_to: string | null;
	open_trip_id: string | null;
	pending_count: number;
	ticked_count: number;
	last_closed_trip_at: number | null;
}

/**
 * One statement for the whole home screen. The open-trip subquery is repeated
 * rather than joined so the counts stay NULL-safe for the (schema-impossible,
 * but cheap to survive) case of a store with no open trip.
 *
 * The claim comes from the OPEN trip (R-18): a claim belongs to a trip, so the
 * home screen shows the claim on the run that is happening now and nothing from
 * the ones already in history.
 */
export const STORE_SUMMARY_SELECT = `
  SELECT s.id, s.name, s.color, s.sort_order, s.rev, s.archived_at, s.private_to,
         ot.id AS open_trip_id,
         ot.claimed_by AS claimed_by, ot.claimed_at AS claimed_at, ot.claim_note AS claim_note,
         cb.display_name AS claimed_by_name,
         (SELECT COUNT(*) FROM items i
           WHERE i.trip_id = ot.id AND i.state = 'pending' AND i.deleted_at IS NULL) AS pending_count,
         (SELECT COUNT(*) FROM items i
           WHERE i.trip_id = ot.id AND i.state = 'ticked' AND i.deleted_at IS NULL) AS ticked_count,
         (SELECT MAX(t.closed_at) FROM trips t
           WHERE t.store_id = s.id AND t.status = 'closed') AS last_closed_trip_at
    FROM stores s
    LEFT JOIN trips ot ON ot.store_id = s.id AND ot.status = 'open'
    LEFT JOIN users cb ON cb.id = ot.claimed_by
`;

export function toStoreSummary(row: StoreSummaryRow, actorId: string): StoreSummary {
	const privateTo = row.private_to ?? null;
	const visibility: StoreVisibility = privateTo === null ? 'public' : 'private';
	return {
		id: row.id,
		name: row.name,
		color: row.color as StoreColor,
		sortOrder: Number(row.sort_order),
		rev: Number(row.rev),
		openTripId: row.open_trip_id ?? '',
		pendingCount: Number(row.pending_count ?? 0),
		tickedCount: Number(row.ticked_count ?? 0),
		lastClosedTripAt:
			row.last_closed_trip_at === null || row.last_closed_trip_at === undefined
				? null
				: Number(row.last_closed_trip_at),
		archivedAt:
			row.archived_at === null || row.archived_at === undefined ? null : Number(row.archived_at),
		visibility,
		...toClaim(row, actorId)
	};
}

/**
 * Reads one store's summary WITHOUT a visibility check — every caller must have
 * gone through `requireVisibleStore` first (§8.4). It is not exported beyond the
 * domain layer for that reason.
 */
export function readStoreSummary(db: Db, storeId: string, actorId: string): StoreSummary | null {
	const row = db.prepare(`${STORE_SUMMARY_SELECT} WHERE s.id = ?`).get(storeId) as
		| StoreSummaryRow
		| undefined;
	return row ? toStoreSummary(row, actorId) : null;
}

export function readItem(db: Db, itemId: string): Item | null {
	const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(itemId) as unknown as ItemRow | undefined;
	return row ? toItem(row) : null;
}

export function readTrip(db: Db, tripId: string, actorId: string): Trip | null {
	const row = db.prepare(`${TRIP_SELECT} WHERE t.id = ?`).get(tripId) as unknown as TripRow | undefined;
	return row ? toTrip(row, actorId) : null;
}
