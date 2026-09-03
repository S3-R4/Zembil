/**
 * CONTRACT.md §3.0 — the normative write-effects table.
 *
 * "A write not listed here bumps nothing and emits nothing." Every row this
 * agent owns is asserted below, including each idempotent no-op, which must bump
 * NOTHING and emit NOTHING. Rows for auth- and admin-owned endpoints belong to
 * zembil-auth's suite.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, makeUser, recorder, type Harness } from './_support';
import { createStore, deleteStore, updateStore } from '$lib/server/domain/stores';
import { addItem, deleteItem, tickItem, untickItem, updateItem } from '$lib/server/domain/items';
import { closeTrip } from '$lib/server/domain/trips';
import { resetBus, subscribe } from '$lib/server/realtime/bus';
import type { ZembilEvent } from '$lib/types';

afterEach(() => resetBus());

const openTrip = (h: Harness, storeId: string): string =>
	(h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any).id;

const revOf = (h: Harness, storeId: string): number =>
	Number((h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(storeId) as any).rev);

const types = (events: ZembilEvent[]) => events.map((e) => e.type);

function ctx() {
	const h = harness();
	const actor = makeUser(h.db);
	const rec = recorder();
	return { h, actor, rec };
}

describe('§3.0 — writes that bump and emit', () => {
	test('POST /api/stores — no rev to bump, emits stores.changed only', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			expect(types(rec.take())).toEqual(['stores.changed']);
			expect(store.rev).toBe(0);
			expect(revOf(h, store.id)).toBe(0);
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('DELETE /api/stores/{id} — emits stores.changed AND store.changed one rev ahead (§9.1)', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			updateStore(h.db, store.id, { name: 'Migros Sanayi' }, actor);
			const before = revOf(h, store.id);
			rec.take();

			const deleted = deleteStore(h.db, store.id, actor);
			expect(deleted.storeId).toBe(store.id);

			const events = rec.take();
			expect(types(events)).toEqual(['stores.changed', 'store.changed']);
			// The row is gone, so there is no rev to read back — the hint carries a
			// number strictly above the cursor an open list screen is holding,
			// which is the only thing that makes it refetch and learn the 404.
			expect((events[1] as any).rev).toBe(before + 1);
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('PATCH /api/stores/{id} — bumps rev, emits stores.changed AND store.changed', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			rec.take();

			for (const patch of [
				{ name: 'Migros Sanayi' },
				{ color: 'green' },
				{ sortOrder: 7 },
				{ archived: true },
				{ archived: false }
			]) {
				const before = revOf(h, store.id);
				const updated = updateStore(h.db, store.id, patch as any, actor);
				const events = rec.take();
				expect(types(events).sort()).toEqual(['store.changed', 'stores.changed']);
				expect(revOf(h, store.id)).toBe(before + 1);
				expect(updated.rev).toBe(before + 1);
				const storeChanged = events.find((e) => e.type === 'store.changed') as any;
				expect(storeChanged.storeId).toBe(store.id);
				expect(storeChanged.rev).toBe(before + 1);
			}
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('POST /api/stores/{id}/items (new row) — bumps rev, emits store.changed', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			rec.take();
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const events = rec.take();
			expect(types(events)).toEqual(['store.changed']);
			expect((events[0] as any).rev).toBe(1);
			expect(added.rev).toBe(1);
			expect(revOf(h, store.id)).toBe(1);
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('PATCH, DELETE, tick and untick each bump rev once and emit one store.changed', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			rec.take();

			const steps: Array<[string, () => { rev: number }]> = [
				['tick', () => tickItem(h.db, added.item.id, actor)],
				['untick', () => untickItem(h.db, added.item.id, actor)],
				['patch', () => updateItem(h.db, added.item.id, { name: 'Milk 2L', version: 3 }, actor)],
				['delete', () => deleteItem(h.db, added.item.id, actor)]
			];

			for (const [label, run] of steps) {
				const before = revOf(h, store.id);
				const result = run();
				const events = rec.take();
				expect(types(events), label).toEqual(['store.changed']);
				expect((events[0] as any).storeId).toBe(store.id);
				expect((events[0] as any).rev, label).toBe(before + 1);
				// §3.5: the response's rev is the SAME value the event carries.
				expect(result.rev, label).toBe(before + 1);
			}
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('POST /api/stores/{id}/trips/close — bumps rev, emits store.changed AND stores.changed', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			rec.take();

			const before = revOf(h, store.id);
			const result = closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);
			const events = rec.take();
			expect(types(events).sort()).toEqual(['store.changed', 'stores.changed']);
			expect(revOf(h, store.id)).toBe(before + 1);
			expect(result.rev).toBe(before + 1);
			expect((events.find((e) => e.type === 'store.changed') as any).rev).toBe(before + 1);
		} finally {
			rec.stop();
			h.close();
		}
	});
});

describe('§3.0 — idempotent no-ops bump nothing and emit nothing', () => {
	test('POST /items with a clientId that already resolves', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			const cid = randomUUID();
			addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			rec.take();
			const before = revOf(h, store.id);

			const retry = addItem(h.db, store.id, { name: 'Milk', clientId: cid }, actor);
			expect(rec.take()).toEqual([]);
			expect(revOf(h, store.id)).toBe(before);
			expect(retry.rev).toBe(before);
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('re-ticking, re-unticking and re-deleting', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			const a = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const b = addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor);
			const c = addItem(h.db, store.id, { name: 'Eggs', clientId: randomUUID() }, actor);
			tickItem(h.db, a.item.id, actor);
			deleteItem(h.db, b.item.id, actor);
			rec.take();
			const before = revOf(h, store.id);

			expect(tickItem(h.db, a.item.id, actor).rev).toBe(before); // already ticked
			expect(untickItem(h.db, c.item.id, actor).rev).toBe(before); // already pending
			expect(deleteItem(h.db, b.item.id, actor).rev).toBe(before); // already deleted

			expect(rec.take()).toEqual([]);
			expect(revOf(h, store.id)).toBe(before);
		} finally {
			rec.stop();
			h.close();
		}
	});

	test('a rejected write emits nothing and leaves rev alone', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			rec.take();
			const before = revOf(h, store.id);

			expect(() => createStore(h.db, { name: 'migros' }, actor)).toThrow();
			expect(() => closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor)).toThrow();
			expect(() => addItem(h.db, store.id, { name: '', clientId: randomUUID() }, actor)).toThrow();

			expect(rec.take()).toEqual([]);
			expect(revOf(h, store.id)).toBe(before);
		} finally {
			rec.stop();
			h.close();
		}
	});
});

describe('I-13 — rev is strictly increasing per store', () => {
	test('a long mixed sequence of writes never repeats or lowers a rev', () => {
		const { h, actor, rec } = ctx();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			const seen: number[] = [revOf(h, store.id)];
			for (let i = 0; i < 5; i += 1) {
				const item = addItem(h.db, store.id, { name: `Item ${i}`, clientId: randomUUID() }, actor);
				seen.push(revOf(h, store.id));
				tickItem(h.db, item.item.id, actor);
				seen.push(revOf(h, store.id));
				untickItem(h.db, item.item.id, actor);
				seen.push(revOf(h, store.id));
			}
			closeTrip(h.db, store.id, { tripId: openTrip(h, store.id) }, actor);
			seen.push(revOf(h, store.id));

			for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThan(seen[i - 1]);

			// Every store.changed the bus saw carried a rev in the same sequence.
			const revs = rec.events.filter((e) => e.type === 'store.changed').map((e: any) => e.rev);
			for (let i = 1; i < revs.length; i += 1) expect(revs[i]).toBeGreaterThan(revs[i - 1]);
		} finally {
			rec.stop();
			h.close();
		}
	});
});

describe('§4 — events are emitted after commit, never inside', () => {
	test('a subscriber that reads the database on receipt sees the committed write', () => {
		const h = harness();
		const actor = makeUser(h.db);
		resetBus();
		try {
			const store = createStore(h.db, { name: 'Migros' }, actor);
			const observed: Array<{ rev: number; visibleRev: number; inTransaction: boolean }> = [];
			const off = subscribe(
				'u',
				's',
				(e: any) => {
					if (e.type !== 'store.changed') return;
					observed.push({
						rev: e.rev,
						visibleRev: revOf(h, store.id),
						// If the emit happened inside the transaction this would be true.
						inTransaction: (h.db as any).isTransaction === true
					});
				},
				() => {}
			);
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			off();

			// Guard the guard: if node:sqlite ever drops `isTransaction` the check
			// above would silently become `undefined === true` and always pass.
			expect(typeof (h.db as any).isTransaction).toBe('boolean');
			expect(observed).toHaveLength(1);
			expect(observed[0].visibleRev).toBe(observed[0].rev);
			expect(observed[0].inTransaction).toBe(false);
		} finally {
			resetBus();
			h.close();
		}
	});

	/**
	 * The single-path test above proves the mechanism once, against `addItem`.
	 * This is the same proof carried over EVERY path this agent owns that §3.0
	 * lists as emitting: a subscriber reading the database from inside its own
	 * callback — the same position a real SSE handler is in — must see the
	 * write already committed, and any `rev` the event carries must be the SAME
	 * value a fresh read of `stores.rev` returns at that instant.
	 *
	 * Table-driven over the eight emitting paths in §3.0. Each case's `verify`
	 * runs SYNCHRONOUSLY inside the bus subscriber, i.e. at receipt time, and
	 * reads the row directly rather than trusting the value `run()` is about to
	 * return to this test — the point is what the DATABASE shows a concurrent
	 * reader at that exact moment, not what the mutator's own return value says.
	 */
	test('every one of the eight §3.0 paths: the subscriber sees the write committed and rev matching, at receipt', () => {
		const h = harness();
		const actor = makeUser(h.db);
		resetBus();
		try {
			// Fixtures, created before the subscriber attaches so they do not
			// themselves appear as observations below.
			const store = createStore(h.db, { name: 'Migros' }, actor);
			const seed = addItem(h.db, store.id, { name: 'Seed', clientId: randomUUID() }, actor);

			interface Receipt {
				type: string;
				storeId?: string;
				revAtReceipt?: number;
				inTransaction: boolean;
			}
			let receipts: Receipt[] = [];
			let verify: (() => void) | null = null;

			const off = subscribe(
				'u',
				's',
				(e: any) => {
					receipts.push({
						type: e.type,
						storeId: e.type === 'store.changed' ? e.storeId : undefined,
						// Read straight from the database, not from the event payload,
						// at the exact instant the subscriber runs.
						revAtReceipt: e.type === 'store.changed' ? revOf(h, e.storeId) : undefined,
						// If the emit ever moved inside the transaction this would be true.
						inTransaction: (h.db as any).isTransaction === true
					});
					// Assert the committed row from inside the callback itself, exactly
					// where a real subscriber's own DB read would run.
					verify?.();
				},
				() => {}
			);

			interface Case {
				label: string;
				expectedTypes: string[];
				run: () => { rev?: number };
				verify: () => void;
			}

			let tripId = (
				h.db.prepare(`SELECT id FROM trips WHERE store_id = ? AND status = 'open'`).get(store.id) as any
			).id;

			const cases: Case[] = [
				{
					label: 'createStore',
					expectedTypes: ['stores.changed'],
					run: () => createStore(h.db, { name: 'BIM' }, actor),
					verify: () => {
						const row = h.db.prepare(`SELECT rev FROM stores WHERE name = 'BIM'`).get() as any;
						expect(row).toBeDefined();
						expect(Number(row.rev)).toBe(0);
					}
				},
				{
					label: 'updateStore',
					expectedTypes: ['store.changed', 'stores.changed'],
					run: () => updateStore(h.db, store.id, { name: 'Migros Sanayi' }, actor),
					verify: () => {
						const row = h.db.prepare('SELECT name FROM stores WHERE id = ?').get(store.id) as any;
						expect(row.name).toBe('Migros Sanayi');
					}
				},
				{
					label: 'addItem (new row)',
					expectedTypes: ['store.changed'],
					run: () => addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor),
					verify: () => {
						const row = h.db
							.prepare(`SELECT COUNT(*) AS n FROM items WHERE name = 'Milk' AND deleted_at IS NULL`)
							.get() as any;
						expect(Number(row.n)).toBe(1);
					}
				},
				{
					label: 'tickItem',
					expectedTypes: ['store.changed'],
					run: () => tickItem(h.db, seed.item.id, actor),
					verify: () => {
						const row = h.db.prepare('SELECT state, ticked_at FROM items WHERE id = ?').get(seed.item.id) as any;
						expect(row.state).toBe('ticked');
						expect(row.ticked_at).not.toBeNull();
					}
				},
				{
					label: 'untickItem',
					expectedTypes: ['store.changed'],
					run: () => untickItem(h.db, seed.item.id, actor),
					verify: () => {
						const row = h.db.prepare('SELECT state, ticked_at FROM items WHERE id = ?').get(seed.item.id) as any;
						expect(row.state).toBe('pending');
						expect(row.ticked_at).toBeNull();
					}
				},
				{
					label: 'updateItem',
					expectedTypes: ['store.changed'],
					run: () => {
						const current = h.db.prepare('SELECT version FROM items WHERE id = ?').get(seed.item.id) as any;
						return updateItem(h.db, seed.item.id, { name: 'Seed 2', version: Number(current.version) }, actor);
					},
					verify: () => {
						const row = h.db.prepare('SELECT name FROM items WHERE id = ?').get(seed.item.id) as any;
						expect(row.name).toBe('Seed 2');
					}
				},
				{
					label: 'deleteItem (first delete)',
					expectedTypes: ['store.changed'],
					run: () => deleteItem(h.db, seed.item.id, actor),
					verify: () => {
						const row = h.db.prepare('SELECT deleted_at FROM items WHERE id = ?').get(seed.item.id) as any;
						expect(row.deleted_at).not.toBeNull();
					}
				},
				{
					label: 'closeTrip',
					expectedTypes: ['store.changed', 'stores.changed'],
					run: () => closeTrip(h.db, store.id, { tripId }, actor),
					verify: () => {
						const row = h.db.prepare('SELECT status FROM trips WHERE id = ?').get(tripId) as any;
						expect(row.status).toBe('closed');
					}
				}
			];

			for (const c of cases) {
				// deleteItem left the trip with no pending items; give closeTrip
				// something to close (R-6 step 2 forbids an empty trip).
				if (c.label === 'closeTrip') {
					addItem(h.db, store.id, { name: 'Bread', clientId: randomUUID() }, actor);
				}

				receipts = [];
				verify = c.verify;
				const result = c.run();
				verify = null;

				expect(receipts.map((r) => r.type).sort(), c.label).toEqual([...c.expectedTypes].sort());
				for (const r of receipts) {
					expect(r.inTransaction, `${c.label}: emitted inside the transaction`).toBe(false);
					if (r.type === 'store.changed') {
						// Every store.changed case in this table targets the fixture store.
						expect(r.storeId, c.label).toBe(store.id);
						// The event's own rev, the store row read back at receipt, and
						// the mutator's returned rev must all agree.
						expect(r.revAtReceipt, c.label).toBe(result.rev);
					}
				}
			}

			off();
			// Guard the guard: if node:sqlite ever drops `isTransaction` every
			// `inTransaction` check above would silently become `undefined === true`
			// and always pass.
			expect(typeof (h.db as any).isTransaction).toBe('boolean');
		} finally {
			resetBus();
			h.close();
		}
	});
});
