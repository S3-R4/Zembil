/**
 * Stores — CONTRACT.md §3.4, R-1, R-14, R-15, R-16, §3.0.
 *
 * Every statement is prepared with bound parameters. No value is ever
 * interpolated into SQL, integers included.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { tx } from '../db/index.js';
import { conflict, notFound, validationFailed } from './errors.js';
import { emitStoreChanged, emitStoresChanged } from '../realtime/bus.js';
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
	storeNameKey,
	boolean,
	sortOrder as validateSortOrder
} from './validate.js';
import type { StoreColor, StoreSummary } from '$lib/types';

export interface Actor {
	id: string;
}

const now = () => Date.now();

/** §3.4: `?includeArchived=true` additionally returns archived stores. */
export function listStores(db: Db, includeArchived = false): StoreSummary[] {
	const sql = includeArchived
		? `${STORE_SUMMARY_SELECT} ORDER BY s.sort_order ASC, s.name ASC, s.id ASC`
		: `${STORE_SUMMARY_SELECT} WHERE s.archived_at IS NULL ORDER BY s.sort_order ASC, s.name ASC, s.id ASC`;
	const rows = db.prepare(sql).all() as unknown as StoreSummaryRow[];
	return rows.map(toStoreSummary);
}

export function getStoreSummary(db: Db, storeId: string): StoreSummary {
	const store = readStoreSummary(db, storeId);
	if (!store) throw notFound('STORE_NOT_FOUND', 'Store not found.');
	return store;
}

/**
 * §3.4: default colour is the first palette key not already used by an active
 * store; once all eight are in use, the key at index `(active count) % 8`, so
 * store nine gets a colour rather than a NOT NULL violation and a 500.
 */
function defaultColor(db: Db): StoreColor {
	const rows = db
		.prepare('SELECT color FROM stores WHERE archived_at IS NULL')
		.all() as Array<{ color: string }>;
	const used = new Set(rows.map((r) => r.color));
	const free = STORE_COLORS.find((c) => !used.has(c));
	if (free) return free;
	return STORE_COLORS[rows.length % STORE_COLORS.length];
}

function nameCollision(db: Db, nameKey: string, excludeStoreId?: string): string | null {
	const row = db.prepare('SELECT id FROM stores WHERE name_key = ?').get(nameKey) as
		| { id: string }
		| undefined;
	if (!row) return null;
	if (excludeStoreId !== undefined && row.id === excludeStoreId) return null;
	return row.id;
}

/**
 * R-1: the store row and its `seq=1`, `status='open'` trip are created in the
 * SAME transaction. A store never exists without an open trip.
 * §3.0: emits `stores.changed`. There is no prior `rev` to bump.
 */
export function createStore(
	db: Db,
	input: { name: unknown; color?: unknown },
	actor: Actor
): StoreSummary {
	const name = storeName(input.name);
	const nameKey = storeNameKey(name);
	const explicitColor = input.color === undefined ? null : storeColor(input.color);

	const storeId = tx(db, () => {
		const clash = nameCollision(db, nameKey);
		if (clash) {
			throw conflict('STORE_NAME_TAKEN', 'A store with that name already exists.', {
				storeId: clash
			});
		}

		const ts = now();
		const id = randomUUID();
		const color = explicitColor ?? defaultColor(db);

		// R-15: MAX+1000 over all stores, archived included.
		const maxRow = db
			.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM stores')
			.get() as { m: number };
		const sortOrder = Number(maxRow.m) + 1000;

		db.prepare(
			`INSERT INTO stores (id, name, name_key, color, sort_order, rev, created_at, created_by, archived_at)
			 VALUES (?, ?, ?, ?, ?, 0, ?, ?, NULL)`
		).run(id, name, nameKey, color, sortOrder, ts, actor.id);

		db.prepare(
			`INSERT INTO trips (id, store_id, seq, status, opened_at, closed_at, closed_by)
			 VALUES (?, ?, 1, 'open', ?, NULL, NULL)`
		).run(randomUUID(), id, ts);

		return id;
	});

	emitStoresChanged();
	return getStoreSummary(db, storeId);
}

export interface StorePatch {
	name?: unknown;
	color?: unknown;
	sortOrder?: unknown;
	archived?: unknown;
}

/**
 * §3.4 PATCH. R-14: archiving sets `archived_at` and leaves the open trip alone;
 * un-archiving restores it intact. §3.0: bumps `rev`, emits BOTH `stores.changed`
 * and `store.changed`.
 */
export function updateStore(db: Db, storeId: string, patch: StorePatch): StoreSummary {
	const has = (k: keyof StorePatch) => Object.hasOwn(patch, k) && patch[k] !== undefined;
	if (!has('name') && !has('color') && !has('sortOrder') && !has('archived')) {
		throw validationFailed('Nothing to update.');
	}

	// §3.1a: validate before the write, never let a CHECK reach the user.
	const name = has('name') ? storeName(patch.name) : null;
	const nameKey = name === null ? null : storeNameKey(name);
	const color = has('color') ? storeColor(patch.color) : null;
	// §3.1b: `sortOrder` is the one client-supplied integer written directly
	// (R-15), so it is bounded as well as safe-integer checked.
	const sortOrder = has('sortOrder') ? validateSortOrder(patch.sortOrder) : null;
	const archived = has('archived') ? boolean(patch.archived, 'archived') : null;

	const rev = tx(db, () => {
		const store = db
			.prepare('SELECT id, rev, archived_at FROM stores WHERE id = ?')
			.get(storeId) as { id: string; rev: number; archived_at: number | null } | undefined;
		if (!store) throw notFound('STORE_NOT_FOUND', 'Store not found.');

		if (nameKey !== null) {
			const clash = nameCollision(db, nameKey, storeId);
			if (clash) {
				throw conflict('STORE_NAME_TAKEN', 'A store with that name already exists.', {
					storeId: clash
				});
			}
			db.prepare('UPDATE stores SET name = ?, name_key = ? WHERE id = ?').run(
				name,
				nameKey,
				storeId
			);
		}
		if (color !== null) db.prepare('UPDATE stores SET color = ? WHERE id = ?').run(color, storeId);
		if (sortOrder !== null) {
			db.prepare('UPDATE stores SET sort_order = ? WHERE id = ?').run(sortOrder, storeId);
		}
		if (archived !== null) {
			const archivedAt = archived ? (store.archived_at ?? now()) : null;
			db.prepare('UPDATE stores SET archived_at = ? WHERE id = ?').run(archivedAt, storeId);
		}

		const next = Number(store.rev) + 1;
		db.prepare('UPDATE stores SET rev = ? WHERE id = ?').run(next, storeId);
		return next;
	});

	emitStoresChanged();
	emitStoreChanged(storeId, rev);
	return getStoreSummary(db, storeId);
}

/** Internal helper used by the item and trip modules. */
export function requireStore(
	db: Db,
	storeId: string
): { id: string; rev: number; archivedAt: number | null } {
	const row = db.prepare('SELECT id, rev, archived_at FROM stores WHERE id = ?').get(storeId) as
		| { id: string; rev: number; archived_at: number | null }
		| undefined;
	if (!row) throw notFound('STORE_NOT_FOUND', 'Store not found.');
	return { id: row.id, rev: Number(row.rev), archivedAt: row.archived_at ?? null };
}

/** R-14: an archived store rejects writes with `409 STORE_ARCHIVED`. */
export function requireWritableStore(db: Db, storeId: string) {
	const store = requireStore(db, storeId);
	if (store.archivedAt !== null) {
		throw conflict('STORE_ARCHIVED', 'This store is archived.');
	}
	return store;
}

/** R-16: bumped INSIDE the write transaction; the event is emitted after commit. */
export function bumpRev(db: Db, storeId: string): number {
	const row = db
		.prepare('UPDATE stores SET rev = rev + 1 WHERE id = ? RETURNING rev')
		.get(storeId) as { rev: number } | undefined;
	if (!row) throw notFound('STORE_NOT_FOUND', 'Store not found.');
	return Number(row.rev);
}

export function currentRev(db: Db, storeId: string): number {
	const row = db.prepare('SELECT rev FROM stores WHERE id = ?').get(storeId) as
		| { rev: number }
		| undefined;
	if (!row) throw notFound('STORE_NOT_FOUND', 'Store not found.');
	return Number(row.rev);
}

/** The store's currently-open trip. R-2 resolves this inside the write transaction. */
export function openTripId(db: Db, storeId: string): string | null {
	const row = db
		.prepare(`SELECT id FROM trips WHERE store_id = ? AND status = 'open'`)
		.get(storeId) as { id: string } | undefined;
	return row ? row.id : null;
}
