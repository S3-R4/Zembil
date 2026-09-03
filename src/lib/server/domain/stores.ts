/**
 * Stores — CONTRACT.md §3.4, §8.4, §8.6, R-1, R-14, R-15, R-16, R-22, §3.0/§8.9.
 *
 * Every statement is prepared with bound parameters. No value is ever
 * interpolated into SQL, integers included.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';
import { conflict, notFound, validationFailed, type DomainError } from './errors.js';
import { emitStoreChanged, emitStoresChanged } from '../realtime/bus.js';
import { discardStoreNotifications, noteStoreActivity } from '../notify/index.js';
import {
	STORE_SUMMARY_SELECT,
	readStoreSummary,
	toStoreSummary,
	type StoreSummaryRow
} from './rows.js';
import {
	STORE_COLORS,
	storeColor,
	storeName,
	scopedNameKey,
	storeVisibility,
	boolean,
	sortOrder as validateSortOrder
} from './validate.js';
import type { StoreColor, StoreSummary } from '$lib/types';

export interface Actor {
	id: string;
}

const now = () => Date.now();

/**
 * §8.4: the 404 an invisible store produces is BYTE-IDENTICAL to the 404 a
 * fabricated id produces. One factory, used by every store-scoped path, is what
 * makes that true by construction rather than by two string literals that agree
 * today.
 */
const storeNotFound = () => notFound('STORE_NOT_FOUND', 'Store not found.');

/**
 * §8.4, stated once and enforced in exactly one place:
 *
 *   A store is visible to a member when `private_to IS NULL` or
 *   `private_to = <the session's user id>`. Nothing else grants visibility.
 *   BEING AN ADMIN DOES NOT.
 *
 * Nothing outside this function reads `stores.private_to` to make a decision.
 * The actor id comes from `locals.user.id` by way of the route — never from a
 * body or a query parameter, either of which would let the caller name their own
 * authorization subject.
 */
export interface VisibleStore {
	id: string;
	rev: number;
	archivedAt: number | null;
	privateTo: string | null;
}

/** THE predicate. Both readers of `private_to` — this module and the item
 *  context join in `items.ts` — decide with this one function. */
export function isVisibleTo(privateTo: string | null | undefined, actorId: string): boolean {
	const owner = privateTo ?? null;
	return owner === null || owner === actorId;
}

/** The one place `stores.private_to` is READ for a decision. Returns null for
 *  "no such store" and for "not yours" alike; the callers below turn that into
 *  whichever 404 code their endpoint owes (§8.4's table). */
function loadVisibleStore(db: Db, storeId: string, actorId: string): VisibleStore | null {
	const row = db
		.prepare('SELECT id, rev, archived_at, private_to FROM stores WHERE id = ?')
		.get(storeId) as
		| { id: string; rev: number; archived_at: number | null; private_to: string | null }
		| undefined;
	if (!row) return null;
	if (!isVisibleTo(row.private_to, actorId)) return null;
	return {
		id: row.id,
		rev: Number(row.rev),
		archivedAt: row.archived_at ?? null,
		privateTo: row.private_to ?? null
	};
}

export function requireVisibleStore(db: Db, storeId: string, actorId: string): VisibleStore {
	// A store that does not exist and a store that is not this member's are the
	// same answer, produced by the same throw. A 403 here would tell the caller
	// that a store with that id exists and belongs to somebody, which is the one
	// fact the feature exists to hide.
	const store = loadVisibleStore(db, storeId, actorId);
	if (!store) throw storeNotFound();
	return store;
}

/**
 * The same rule, reported with a different code. §8.4's table says the item
 * endpoints answer `ITEM_NOT_FOUND` and the trip-detail endpoint answers
 * `TRIP_NOT_FOUND`, each byte-identical to that endpoint's own "never existed"
 * 404, so the caller cannot tell the two apart.
 */
export function requireVisibleStoreAs(
	db: Db,
	storeId: string,
	actorId: string,
	whenInvisible: () => DomainError
): VisibleStore {
	const store = loadVisibleStore(db, storeId, actorId);
	if (!store) throw whenInvisible();
	return store;
}

/** R-14: an archived store rejects writes with `409 STORE_ARCHIVED`.
 *  Visibility is resolved FIRST (§8.4), so a private store's archived state is
 *  not observable either — an invisible store 404s before it can 409. */
export function requireWritableStore(db: Db, storeId: string, actorId: string): VisibleStore {
	const store = requireVisibleStore(db, storeId, actorId);
	if (store.archivedAt !== null) {
		throw conflict('STORE_ARCHIVED', 'This store is archived.');
	}
	return store;
}

/** §3.4 / §8.4: `?includeArchived=true` additionally returns archived stores;
 *  a store private to somebody else is absent from the array either way. */
export function listStores(db: Db, actorId: string, includeArchived = false): StoreSummary[] {
	const visible = '(s.private_to IS NULL OR s.private_to = ?)';
	const sql = includeArchived
		? `${STORE_SUMMARY_SELECT} WHERE ${visible} ORDER BY s.sort_order ASC, s.name ASC, s.id ASC`
		: `${STORE_SUMMARY_SELECT} WHERE ${visible} AND s.archived_at IS NULL ORDER BY s.sort_order ASC, s.name ASC, s.id ASC`;
	const rows = db.prepare(sql).all(actorId) as unknown as StoreSummaryRow[];
	return rows.map((row) => toStoreSummary(row, actorId));
}

export function getStoreSummary(db: Db, storeId: string, actorId: string): StoreSummary {
	requireVisibleStore(db, storeId, actorId);
	const store = readStoreSummary(db, storeId, actorId);
	if (!store) throw storeNotFound();
	return store;
}

/**
 * §3.4: default colour is the first palette key not already used by an active
 * store VISIBLE TO THIS MEMBER; once all eight are in use, the key at index
 * `(visible active count) % 8`, so store nine gets a colour rather than a NOT
 * NULL violation and a 500.
 *
 * The visibility filter is not decoration, and an earlier version of this
 * function did not have it — the M6 audit found the omission. Unfiltered, this
 * is an existence oracle for private stores, and a good one: create a store with
 * no colour, and the key you are given tells you which keys are taken by stores
 * you cannot see. Past eight it leaks the COUNT of them directly. The cost of
 * filtering — two members' palettes drifting apart — is not a cost at all for a
 * feature whose entire purpose is that the two members see different worlds.
 */
function defaultColor(db: Db, actorId: string): StoreColor {
	const rows = db
		.prepare(
			'SELECT color FROM stores WHERE archived_at IS NULL AND (private_to IS NULL OR private_to = ?)'
		)
		.all(actorId) as Array<{ color: string }>;
	const used = new Set(rows.map((r) => r.color));
	const free = STORE_COLORS.find((c) => !used.has(c));
	if (free) return free;
	return STORE_COLORS[rows.length % STORE_COLORS.length];
}

/**
 * R-22, as corrected by the M6 audit: uniqueness is scoped to visibility, so a
 * collision can only ever be against a store the caller CAN see.
 *
 * `nameKey` here is the SCOPED key (migration 003) — a public name for a public
 * store, `<ownerId> U+001F <name>` for a private one. A member's private shop
 * therefore occupies a key space nobody else's lookup can reach, which is what
 * removes the oracle: before this, typing "Eczane" and reading the 409 told you
 * somebody had a private shop called Eczane, which is a worse disclosure than
 * the store id R-22 was careful to withhold.
 *
 * The consequence is that `storeId` is now ALWAYS safe to return: the row it
 * names is visible to the caller by construction. The invisible-collision case
 * does not exist any more rather than being handled.
 */
function throwNameTaken(db: Db, nameKey: string, actorId: string, excludeStoreId?: string): void {
	const row = db.prepare('SELECT id, private_to FROM stores WHERE name_key = ?').get(nameKey) as
		| { id: string; private_to: string | null }
		| undefined;
	if (!row) return;
	if (excludeStoreId !== undefined && row.id === excludeStoreId) return;
	// Asserted rather than assumed: if a future change to the key scheme ever
	// let a lookup reach a store the caller cannot see, this must not quietly
	// hand out its id. `isVisibleTo` is THE predicate — never a second copy of it.
	if (!isVisibleTo(row.private_to, actorId)) {
		throw conflict('STORE_NAME_TAKEN', 'A store with that name already exists.');
	}
	throw conflict('STORE_NAME_TAKEN', 'A store with that name already exists.', {
		storeId: row.id
	});
}

/**
 * R-1: the store row and its `seq=1`, `status='open'` trip are created in the
 * SAME transaction. A store never exists without an open trip.
 * §3.0: emits `stores.changed`. There is no prior `rev` to bump, and §8.9 lists
 * no notification for a store that has nothing on it yet.
 */
export function createStore(
	db: Db,
	input: { name: unknown; color?: unknown },
	actor: Actor
): StoreSummary {
	const name = storeName(input.name);
	// A new store is always public (§8.6: PATCH is the only way to privatise
	// one), so its key is the unscoped form.
	const nameKey = scopedNameKey(name, null);
	const explicitColor = input.color === undefined ? null : storeColor(input.color);

	const storeId = tx(db, () => {
		throwNameTaken(db, nameKey, actor.id);

		const ts = now();
		const id = randomUUID();
		const color = explicitColor ?? defaultColor(db, actor.id);

		// R-15: MAX+1000 over all stores, archived included.
		const maxRow = db
			.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM stores')
			.get() as { m: number };
		const sortOrder = Number(maxRow.m) + 1000;

		// A new store is public; §8.6's PATCH is the only way to privatise one.
		db.prepare(
			`INSERT INTO stores (id, name, name_key, color, sort_order, rev, created_at, created_by, archived_at, private_to)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL)`
		).run(id, name, nameKey, color, sortOrder, ts, actor.id);

		db.prepare(
			`INSERT INTO trips (id, store_id, seq, status, opened_at, closed_at, closed_by)
			 VALUES (?, ?, 1, 'open', ?, NULL, NULL)`
		).run(randomUUID(), id, ts);

		return id;
	});

	emitStoresChanged();
	return getStoreSummary(db, storeId, actor.id);
}

export interface StorePatch {
	name?: unknown;
	color?: unknown;
	sortOrder?: unknown;
	archived?: unknown;
	visibility?: unknown;
}

/**
 * §3.4 PATCH. R-14: archiving sets `archived_at` and leaves the open trip alone;
 * un-archiving restores it intact. §8.6: `visibility` sets `private_to` to the
 * CALLER's id or to NULL — the owner is never named by the request. §3.0/§8.9:
 * bumps `rev`, emits BOTH `stores.changed` and `store.changed`, and notifies.
 */
export function updateStore(
	db: Db,
	storeId: string,
	patch: StorePatch,
	actor: Actor
): StoreSummary {
	const has = (k: keyof StorePatch) => Object.hasOwn(patch, k) && patch[k] !== undefined;
	if (!has('name') && !has('color') && !has('sortOrder') && !has('archived') && !has('visibility')) {
		throw validationFailed('Nothing to update.');
	}

	// §3.1a: validate before the write, never let a CHECK reach the user.
	const name = has('name') ? storeName(patch.name) : null;
	const color = has('color') ? storeColor(patch.color) : null;
	// §3.1b: `sortOrder` is the one client-supplied integer written directly
	// (R-15), so it is bounded as well as safe-integer checked.
	const sortOrder = has('sortOrder') ? validateSortOrder(patch.sortOrder) : null;
	const archived = has('archived') ? boolean(patch.archived, 'archived') : null;
	const visibility = has('visibility') ? storeVisibility(patch.visibility) : null;

	const rev = tx(db, () => {
		// §8.4: visibility first, before anything else. R-14: PATCH is never
		// rejected for an archived store — it is the endpoint that un-archives.
		const store = requireVisibleStore(db, storeId, actor.id);

		// Migration 003 couples the name and the visibility: `name_key` is scoped
		// by the owner for a private store, so changing EITHER changes the key.
		// They are resolved together, once, against the values the row will hold
		// after this patch — computing them separately is how a store ends up
		// public with a private key, or private under somebody else's namespace.
		const currentName = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId) as {
			name: string;
		};
		const nextName = name ?? currentName.name;
		const nextPrivateTo =
			visibility === null
				? store.privateTo
				: visibility === 'private'
					? actor.id
					: null;

		if (name !== null || visibility !== null) {
			const nextKey = scopedNameKey(nextName, nextPrivateTo);
			// The collision check runs on the key the row is about to have, which
			// is what makes "going public collides with an existing public shop of
			// the same name" a clean 409 rather than a CHECK reaching the user.
			throwNameTaken(db, nextKey, actor.id, storeId);
			db.prepare('UPDATE stores SET name = ?, name_key = ? WHERE id = ?').run(
				nextName,
				nextKey,
				storeId
			);
		}
		if (color !== null) db.prepare('UPDATE stores SET color = ? WHERE id = ?').run(color, storeId);
		if (sortOrder !== null) {
			db.prepare('UPDATE stores SET sort_order = ? WHERE id = ?').run(sortOrder, storeId);
		}
		if (archived !== null) {
			const archivedAt = archived ? (store.archivedAt ?? now()) : null;
			db.prepare('UPDATE stores SET archived_at = ? WHERE id = ?').run(archivedAt, storeId);
		}
		if (visibility !== null) {
			// 'private' means private to the CALLER. There is no request field
			// naming an owner, at any privilege level, so no member can hand a
			// store to somebody else or take one from them.
			db.prepare('UPDATE stores SET private_to = ? WHERE id = ?').run(nextPrivateTo, storeId);
		}

		const next = store.rev + 1;
		db.prepare('UPDATE stores SET rev = ? WHERE id = ?').run(next, storeId);
		return next;
	});

	emitStoresChanged();
	emitStoreChanged(storeId, rev);
	noteStoreActivity(storeId);
	return getStoreSummary(db, storeId, actor.id);
}

/** What a delete removed, so the caller can say so and a test can assert it. */
export interface StoreDeletion {
	storeId: string;
	name: string;
	trips: number;
	items: number;
}

/**
 * §9.1 / R-23 `DELETE /api/stores/{storeId}` — the permanent one.
 *
 * Archiving (R-14) hides a shop and keeps every row; this destroys them. The two
 * are deliberately different actions with different words on them, because only
 * one of them is undoable and the difference has to be visible before the tap,
 * not after it.
 *
 * The cascade is the SCHEMA's, not this function's: `trips.store_id` and
 * `items.store_id` are both `REFERENCES stores(id) ON DELETE CASCADE`, and the
 * connection runs with `PRAGMA foreign_keys = ON` (db/index.ts). Deleting the
 * children here in application code would be a second, weaker copy of a rule the
 * database already enforces atomically — and the copy is what rots. The counts
 * are read *before* the delete, inside the same transaction, purely so the
 * response can report what went.
 *
 * §8.4: visibility is resolved FIRST and an invisible store gets the
 * byte-identical `404 STORE_NOT_FOUND`. R-14 does not apply — an archived store
 * is deletable, and is in fact the likeliest thing to be deleted.
 *
 * §3.0: emits `stores.changed` AND `store.changed`. The second one carries
 * `rev + 1` — a rev the row will never hold, because the row is gone. That is
 * the point: a member standing on `/s/{id}` when somebody else deletes the shop
 * holds a cursor at `rev`, and only a strictly higher hint makes them refetch
 * and discover the 404. Emitting nothing would leave them tapping a list that no
 * longer exists.
 */
export function deleteStore(db: Db, storeId: string, actor: Actor): StoreDeletion {
	const result = tx(db, () => {
		const store = requireVisibleStore(db, storeId, actor.id);

		const row = db.prepare('SELECT name FROM stores WHERE id = ?').get(storeId) as {
			name: string;
		};
		const trips = Number(
			(db.prepare('SELECT COUNT(*) AS n FROM trips WHERE store_id = ?').get(storeId) as { n: number })
				.n
		);
		const items = Number(
			(db.prepare('SELECT COUNT(*) AS n FROM items WHERE store_id = ?').get(storeId) as { n: number })
				.n
		);

		db.prepare('DELETE FROM stores WHERE id = ?').run(storeId);

		return {
			deletion: { storeId, name: row.name, trips, items } satisfies StoreDeletion,
			rev: store.rev + 1
		};
	});

	// A batch armed for a list that no longer exists notifies nobody about
	// nothing; drop it rather than let its timer run out (§9.1).
	discardStoreNotifications(storeId);
	emitStoresChanged();
	emitStoreChanged(storeId, result.rev);
	return result.deletion;
}

/** R-16: bumped INSIDE the write transaction; the event is emitted after commit.
 *  Visibility is the caller's responsibility and has already been resolved —
 *  every path that reaches here went through `requireVisibleStore` first. */
export function bumpRev(db: Db, storeId: string): number {
	const row = db
		.prepare('UPDATE stores SET rev = rev + 1 WHERE id = ? RETURNING rev')
		.get(storeId) as { rev: number } | undefined;
	if (!row) throw storeNotFound();
	return Number(row.rev);
}

export function currentRev(db: Db, storeId: string): number {
	const row = db.prepare('SELECT rev FROM stores WHERE id = ?').get(storeId) as
		| { rev: number }
		| undefined;
	if (!row) throw storeNotFound();
	return Number(row.rev);
}

/** The store's currently-open trip. R-2 resolves this inside the write transaction. */
export function openTripId(db: Db, storeId: string): string | null {
	const row = db
		.prepare(`SELECT id FROM trips WHERE store_id = ? AND status = 'open'`)
		.get(storeId) as { id: string } | undefined;
	return row ? row.id : null;
}
