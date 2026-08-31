/**
 * Executable versions of the CONTRACT.md §1.2 table invariants.
 *
 * §1.2 is explicit that some invariants are bound by the schema and some only by
 * tests, and that "an invariant nobody enforces is a comment". These functions
 * are the enforcement for the test-bound half. Each returns a list of violations,
 * so every invariant gets both a positive test (clean database, no violations)
 * and a negative test (deliberately corrupted row, violation reported) — the M1
 * exit criterion is a test that FAILS when the invariant is violated, not merely
 * one that passes today.
 */
import type { Db } from '$lib/server/db';

type Row = Record<string, any>;
const all = (db: Db, sql: string, ...params: any[]) => db.prepare(sql).all(...params) as Row[];

/** I-1 — every non-archived store has exactly one trip with status='open'. */
export function checkI1(db: Db): string[] {
	return all(
		db,
		`SELECT s.id, (SELECT COUNT(*) FROM trips t WHERE t.store_id = s.id AND t.status='open') AS n
		   FROM stores s WHERE s.archived_at IS NULL`
	)
		.filter((r) => Number(r.n) !== 1)
		.map((r) => `I-1: store ${r.id} has ${r.n} open trips`);
}

/** I-2 — trips.seq is contiguous from 1 per store. A gap means a bug in close. */
export function checkI2(db: Db): string[] {
	const violations: string[] = [];
	for (const store of all(db, 'SELECT id FROM stores')) {
		const seqs = all(db, 'SELECT seq FROM trips WHERE store_id = ? ORDER BY seq ASC', store.id).map(
			(r) => Number(r.seq)
		);
		for (let i = 0; i < seqs.length; i += 1) {
			if (seqs[i] !== i + 1) {
				violations.push(`I-2: store ${store.id} seq ${seqs[i]} at position ${i + 1}`);
				break;
			}
		}
	}
	return violations;
}

/** I-3 — items.store_id always equals trips.store_id for the item's trip_id. */
export function checkI3(db: Db): string[] {
	return all(
		db,
		`SELECT i.id, i.store_id, t.store_id AS trip_store
		   FROM items i JOIN trips t ON t.id = i.trip_id
		  WHERE i.store_id <> t.store_id`
	).map((r) => `I-3: item ${r.id} store ${r.store_id} but trip store ${r.trip_store}`);
}

/** I-4 — a ticked item has both ticked_at and ticked_by set. */
export function checkI4(db: Db): string[] {
	return all(
		db,
		`SELECT id FROM items
		  WHERE (state = 'ticked') <> (ticked_at IS NOT NULL AND ticked_by IS NOT NULL)`
	).map((r) => `I-4: item ${r.id}`);
}

/** I-5 — a carried item has carried_to_item_id set, ticked_at NULL, and a CLOSED trip. */
export function checkI5(db: Db): string[] {
	return all(
		db,
		`SELECT i.id, i.carried_to_item_id, i.ticked_at, t.status
		   FROM items i JOIN trips t ON t.id = i.trip_id
		  WHERE i.state = 'carried'
		    AND (i.carried_to_item_id IS NULL OR i.ticked_at IS NOT NULL OR t.status <> 'closed')`
	).map((r) => `I-5: item ${r.id} (to=${r.carried_to_item_id} ticked=${r.ticked_at} trip=${r.status})`);
}

/** I-6 — origin_item_id is never NULL; it is own id at the root, else the chain root. */
export function checkI6(db: Db): string[] {
	const violations: string[] = [];
	for (const r of all(db, 'SELECT id, carried_from_item_id, origin_item_id FROM items')) {
		if (r.origin_item_id === null || r.origin_item_id === undefined) {
			violations.push(`I-6: item ${r.id} has NULL origin`);
			continue;
		}
		if (r.carried_from_item_id === null) {
			if (r.origin_item_id !== r.id) violations.push(`I-6: root item ${r.id} origin ${r.origin_item_id}`);
			continue;
		}
		// Walk the chain to its root and compare.
		let cursor = r.carried_from_item_id as string;
		const seen = new Set<string>();
		let root = cursor;
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			const parent = db
				.prepare('SELECT id, carried_from_item_id FROM items WHERE id = ?')
				.get(cursor) as Row | undefined;
			if (!parent) break;
			root = parent.id;
			cursor = parent.carried_from_item_id;
		}
		if (r.origin_item_id !== root) {
			violations.push(`I-6: item ${r.id} origin ${r.origin_item_id} but chain root ${root}`);
		}
	}
	return violations;
}

/** I-7 — carry_count equals the length of the carried_from_item_id chain. */
export function checkI7(db: Db): string[] {
	const violations: string[] = [];
	for (const r of all(db, 'SELECT id, carried_from_item_id, carry_count FROM items')) {
		let depth = 0;
		let cursor = r.carried_from_item_id as string | null;
		const seen = new Set<string>();
		while (cursor && !seen.has(cursor)) {
			seen.add(cursor);
			depth += 1;
			const parent = db
				.prepare('SELECT carried_from_item_id FROM items WHERE id = ?')
				.get(cursor) as Row | undefined;
			cursor = parent ? parent.carried_from_item_id : null;
		}
		if (Number(r.carry_count) !== depth) {
			violations.push(`I-7: item ${r.id} carry_count ${r.carry_count} but chain depth ${depth}`);
		}
	}
	return violations;
}

/** I-8 — a soft-deleted item is never carried. */
export function checkI8(db: Db): string[] {
	return all(
		db,
		`SELECT id FROM items
		  WHERE deleted_at IS NOT NULL AND (state = 'carried' OR carried_to_item_id IS NOT NULL)`
	).map((r) => `I-8: deleted item ${r.id} was carried`);
}

/**
 * I-9 — sessions.id is never equal to any value that was ever sent to a client.
 * The caller supplies the tokens it issued; the id must be the sha256 of one,
 * never the token itself.
 */
export function checkI9(db: Db, issuedTokens: Iterable<string>): string[] {
	const issued = new Set(issuedTokens);
	return all(db, 'SELECT id FROM sessions')
		.filter((r) => issued.has(r.id))
		.map((r) => `I-9: session id ${r.id} was sent to a client`);
}

/** I-10 — users.password_hash is never NULL. */
export function checkI10(db: Db): string[] {
	return all(db, 'SELECT id FROM users WHERE password_hash IS NULL').map(
		(r) => `I-10: user ${r.id} has no password hash`
	);
}

/** I-11 — at most one live row per (store_id, client_id). */
export function checkI11(db: Db): string[] {
	return all(
		db,
		`SELECT store_id, client_id, COUNT(*) AS n FROM items
		  WHERE client_id IS NOT NULL AND state <> 'carried' AND deleted_at IS NULL
		  GROUP BY store_id, client_id HAVING n > 1`
	).map((r) => `I-11: ${r.n} live rows for (${r.store_id}, ${r.client_id})`);
}

/** I-12 — within one trip, sort_order is unique across non-deleted items. */
export function checkI12(db: Db): string[] {
	return all(
		db,
		`SELECT trip_id, sort_order, COUNT(*) AS n FROM items
		  WHERE deleted_at IS NULL GROUP BY trip_id, sort_order HAVING n > 1`
	).map((r) => `I-12: trip ${r.trip_id} sort_order ${r.sort_order} used ${r.n} times`);
}

/** I-13 — stores.rev is a non-negative integer; strict increase is asserted by the effects suite. */
export function checkI13(db: Db): string[] {
	return all(db, 'SELECT id, rev FROM stores WHERE rev < 0 OR CAST(rev AS INTEGER) <> rev').map(
		(r) => `I-13: store ${r.id} rev ${r.rev}`
	);
}

/** Every invariant that can be checked without extra context. */
export function checkAll(db: Db): string[] {
	return [
		...checkI1(db),
		...checkI2(db),
		...checkI3(db),
		...checkI4(db),
		...checkI5(db),
		...checkI6(db),
		...checkI7(db),
		...checkI8(db),
		...checkI10(db),
		...checkI11(db),
		...checkI12(db),
		...checkI13(db)
	];
}
