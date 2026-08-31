/**
 * R-6 step 5 / D-024 — the carry-over statement order is load-bearing.
 *
 * The contract's table says both two-statement orders abort. This suite executes
 * all three sequences against the real §1.1 DDL with foreign_keys=ON, so the
 * three-statement form cannot quietly "start working" the day someone drops a
 * constraint for an unrelated reason.
 */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, makeUser } from './_support';
import { createStore } from '$lib/server/domain/stores';
import { addItem } from '$lib/server/domain/items';
import { checkAll } from './_invariants';

/**
 * `node:sqlite` reports `code = 'ERR_SQLITE_ERROR'` and puts SQLite's EXTENDED
 * result code in `errcode`. The low byte of an extended code is the primary
 * code, and SQLITE_CONSTRAINT is 19 — so SQLITE_CONSTRAINT_FOREIGNKEY (787) and
 * SQLITE_CONSTRAINT_UNIQUE (2067) both satisfy this. Asserting on the message
 * alone would pass for any error whose text happens to contain "constraint".
 */
const SQLITE_CONSTRAINT = 19;
function expectSqliteConstraint(err: any): void {
	expect(err).toBeDefined();
	expect(err.code).toBe('ERR_SQLITE_ERROR');
	expect(typeof err.errcode).toBe('number');
	expect(err.errcode & 0xff).toBe(SQLITE_CONSTRAINT);
}

/** A store whose trip 1 is closed, with one pending item and a live successor trip. */
function midClose() {
	const h = harness();
	const actor = makeUser(h.db);
	const store = createStore(h.db, { name: 'Migros' }, actor);
	const clientId = randomUUID();
	const original = addItem(h.db, store.id, { name: 'Milk', clientId }, actor).item;

	const ts = Date.now();
	const closedTripId = original.tripId;
	const newTripId = randomUUID();
	h.db
		.prepare(`UPDATE trips SET status='closed', closed_at=?, closed_by=? WHERE id=?`)
		.run(ts, actor.id, closedTripId);
	h.db
		.prepare(
			`INSERT INTO trips (id, store_id, seq, status, opened_at) VALUES (?, ?, 2, 'open', ?)`
		)
		.run(newTripId, store.id, ts);

	const row = h.db.prepare('SELECT * FROM items WHERE id = ?').get(original.id) as any;
	return { h, actor, store, row, newTripId, clientId, ts };
}

function insertClone(h: any, row: any, cloneId: string, newTripId: string, ts: number, cid: string | null) {
	h.db
		.prepare(
			`INSERT INTO items (id, trip_id, store_id, client_id, name, note, state, sort_order,
			   ticked_at, ticked_by, carried_from_item_id, carried_to_item_id, origin_item_id,
			   carry_count, version, created_at, created_by, updated_at, deleted_at)
			 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?, NULL, ?, ?, 1, ?, ?, ?, NULL)`
		)
		.run(
			cloneId,
			newTripId,
			row.store_id,
			cid,
			row.name,
			row.note,
			row.sort_order,
			row.id,
			row.origin_item_id,
			Number(row.carry_count) + 1,
			ts,
			row.created_by,
			ts
		);
}

function markCarried(h: any, row: any, cloneId: string, ts: number) {
	h.db
		.prepare(
			`UPDATE items SET state='carried', carried_to_item_id=?, version=version+1, updated_at=? WHERE id=?`
		)
		.run(cloneId, ts, row.id);
}

describe('R-6 step 5 — only the three-statement order commits', () => {
	test('update original to carried FIRST, then insert the clone → FOREIGN KEY constraint failed', () => {
		const { h, row, newTripId, ts, clientId } = midClose();
		try {
			const cloneId = randomUUID();
			h.db.exec('BEGIN IMMEDIATE');
			let caught: any;
			try {
				markCarried(h, row, cloneId, ts);
				insertClone(h, row, cloneId, newTripId, ts, clientId);
			} catch (err) {
				caught = err;
			}
			try {
				h.db.exec('ROLLBACK');
			} catch {
				/* already unwound */
			}
			expectSqliteConstraint(caught);
			expect(String(caught.message)).toMatch(/FOREIGN KEY constraint failed/i);
			expect(caught.errcode).toBe(787); // SQLITE_CONSTRAINT_FOREIGNKEY
		} finally {
			h.close();
		}
	});

	test('insert the clone WITH client_id first, then update the original → items_client_id UNIQUE', () => {
		const { h, row, newTripId, ts, clientId } = midClose();
		try {
			const cloneId = randomUUID();
			h.db.exec('BEGIN IMMEDIATE');
			let caught: any;
			try {
				insertClone(h, row, cloneId, newTripId, ts, clientId);
				markCarried(h, row, cloneId, ts);
			} catch (err) {
				caught = err;
			}
			try {
				h.db.exec('ROLLBACK');
			} catch {
				/* already unwound */
			}
			expectSqliteConstraint(caught);
			expect(String(caught.message)).toMatch(
				/UNIQUE constraint failed: items\.store_id, items\.client_id/i
			);
			expect(caught.errcode).toBe(2067); // SQLITE_CONSTRAINT_UNIQUE
		} finally {
			h.close();
		}
	});

	test('insert with client_id=NULL, update the original, then set the clone client_id → commits', () => {
		const { h, row, newTripId, ts, clientId, store } = midClose();
		try {
			const cloneId = randomUUID();
			h.db.exec('BEGIN IMMEDIATE');
			insertClone(h, row, cloneId, newTripId, ts, null);
			markCarried(h, row, cloneId, ts);
			h.db.prepare('UPDATE items SET client_id = ? WHERE id = ?').run(clientId, cloneId);
			h.db.exec('COMMIT');

			const clone = h.db.prepare('SELECT * FROM items WHERE id = ?').get(cloneId) as any;
			expect(clone.client_id).toBe(clientId);
			expect(clone.trip_id).toBe(newTripId);
			const original = h.db.prepare('SELECT * FROM items WHERE id = ?').get(row.id) as any;
			expect(original.state).toBe('carried');
			expect(original.client_id).toBe(clientId);
			expect(store.id).toBeTruthy();
			expect(checkAll(h.db)).toEqual([]);
		} finally {
			h.close();
		}
	});

	test('the FK is immediate, not deferred — D-024 rejects DEFERRABLE INITIALLY DEFERRED', () => {
		const { h } = midClose();
		try {
			const sql = (
				h.db.prepare(`SELECT sql FROM sqlite_schema WHERE name = 'items'`).get() as any
			).sql as string;
			expect(sql).not.toMatch(/DEFERRABLE/i);
		} finally {
			h.close();
		}
	});
});
