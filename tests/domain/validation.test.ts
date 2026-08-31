/**
 * CONTRACT.md §3.1a — string input validation happens BEFORE the write.
 *
 * A CHECK constraint reaching the user is a 500, and a 500 on a 250-character
 * paste into the add sheet is a defect. Each case below asserts a
 * 400 VALIDATION_FAILED, and the last block asserts the DDL's checks are set at
 * the same numbers so they remain a backstop rather than the validator.
 */
import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, makeUser, type Harness } from './_support';
import { createStore, updateStore } from '$lib/server/domain/stores';
import { addItem, updateItem } from '$lib/server/domain/items';
import { closeTrip, listClosedTrips } from '$lib/server/domain/trips';
import { isDomainError } from '$lib/server/domain/errors';

function ctx() {
	const h = harness();
	const actor = makeUser(h.db);
	const store = createStore(h.db, { name: 'Migros' }, actor);
	return { h, actor, store };
}

function expectValidationFailure(fn: () => unknown) {
	try {
		fn();
	} catch (err) {
		expect(isDomainError(err)).toBe(true);
		expect((err as any).code).toBe('VALIDATION_FAILED');
		expect((err as any).status).toBe(400);
		return;
	}
	throw new Error('expected VALIDATION_FAILED');
}

describe('item name — trim, 1–200 after trimming', () => {
	test('empty, whitespace-only, over-length and non-string are all rejected', () => {
		const { h, actor, store } = ctx();
		try {
			for (const name of ['', '   ', ' \t\n', 'x'.repeat(201), 42, null, undefined]) {
				expectValidationFailure(() =>
					addItem(h.db, store.id, { name, clientId: randomUUID() } as any, actor)
				);
			}
			// The boundary is inclusive and no CHECK is ever reached.
			const ok = addItem(
				h.db,
				store.id,
				{ name: `  ${'x'.repeat(200)}  `, clientId: randomUUID() },
				actor
			);
			expect(ok.item.name).toHaveLength(200);
		} finally {
			h.close();
		}
	});

	test('the trimmed value is what is stored', () => {
		const { h, actor, store } = ctx();
		try {
			const added = addItem(h.db, store.id, { name: '  Milk \n', clientId: randomUUID() }, actor);
			expect(added.item.name).toBe('Milk');
		} finally {
			h.close();
		}
	});
});

describe('item note — null or empty-after-trim stores NULL, max 500', () => {
	test('note handling', () => {
		const { h, actor, store } = ctx();
		try {
			expect(
				addItem(h.db, store.id, { name: 'A', note: '   ', clientId: randomUUID() }, actor).item.note
			).toBe(null);
			expect(
				addItem(h.db, store.id, { name: 'B', note: null, clientId: randomUUID() }, actor).item.note
			).toBe(null);
			expect(
				addItem(h.db, store.id, { name: 'C', note: ' 2 litre ', clientId: randomUUID() }, actor).item
					.note
			).toBe('2 litre');
			expectValidationFailure(() =>
				addItem(h.db, store.id, { name: 'D', note: 'x'.repeat(501), clientId: randomUUID() }, actor)
			);
		} finally {
			h.close();
		}
	});
});

describe('store name — trim, 1–60', () => {
	test('rejects empty and over-length on create and patch', () => {
		const { h, actor, store } = ctx();
		try {
			expectValidationFailure(() => createStore(h.db, { name: '  ' }, actor));
			expectValidationFailure(() => createStore(h.db, { name: 'x'.repeat(61) }, actor));
			expectValidationFailure(() => updateStore(h.db, store.id, { name: 'x'.repeat(61) }));
		} finally {
			h.close();
		}
	});
});

describe('clientId — must parse as a UUID', () => {
	test('non-UUIDs are rejected before any write', () => {
		const { h, actor, store } = ctx();
		try {
			for (const cid of ['', 'not-a-uuid', '12345', randomUUID().toUpperCase(), 7, null]) {
				expectValidationFailure(() =>
					addItem(h.db, store.id, { name: 'Milk', clientId: cid } as any, actor)
				);
			}
			const count = h.db.prepare('SELECT COUNT(*) AS n FROM items').get() as any;
			expect(Number(count.n)).toBe(0);
		} finally {
			h.close();
		}
	});
});

describe('store color — validated against the enum, never interpolated', () => {
	test('an unrecognised colour is 400, not a CSS class', () => {
		const { h, actor, store } = ctx();
		try {
			expectValidationFailure(() => createStore(h.db, { name: 'BIM', color: 'chartreuse' }, actor));
			expectValidationFailure(() =>
				updateStore(h.db, store.id, { color: "red'; DROP TABLE items;--" })
			);
			expect(h.db.prepare(`SELECT COUNT(*) AS n FROM items`).get()).toBeTruthy();
		} finally {
			h.close();
		}
	});

	test('the default colour cycles rather than running out at store nine', () => {
		const h = harness();
		const actor = makeUser(h.db);
		try {
			const colors: string[] = [];
			for (let i = 0; i < 9; i += 1) {
				colors.push(createStore(h.db, { name: `Store ${i}` }, actor).color);
			}
			expect(new Set(colors.slice(0, 8)).size).toBe(8);
			expect(colors[8]).toBe('terracotta'); // 8 % 8
		} finally {
			h.close();
		}
	});
});

describe('other scalar inputs', () => {
	test('PATCH /items requires a numeric version and at least one field', () => {
		const { h, actor, store } = ctx();
		try {
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			expectValidationFailure(() => updateItem(h.db, added.item.id, { version: '1' } as any));
			expectValidationFailure(() => updateItem(h.db, added.item.id, { version: 1 } as any));
		} finally {
			h.close();
		}
	});

	/**
	 * §3.1b, and a lesson about where a test aims.
	 *
	 * The case above passes `{ version: '1' }` with no `name` and no `note`, so
	 * `updateItem`'s "nothing to update" guard fires FIRST and `itemVersion` is
	 * never reached. The whole validator could be replaced by `Number(value)`
	 * and the suite would stay green — an audit proved exactly that. Every case
	 * here carries a `name`, so validation is what rejects it.
	 */
	test('PATCH /items rejects a version that is not a safe integer >= 1, reaching the validator', () => {
		const { h, actor, store } = ctx();
		try {
			const added = addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			for (const version of [
				0, // versions start at 1
				-1,
				1.5,
				9007199254740993, // isInteger true, isSafeInteger false — the §3.1b case
				1e300,
				NaN,
				Infinity,
				'1',
				null,
				undefined
			]) {
				expectValidationFailure(() =>
					updateItem(h.db, added.item.id, { name: 'Bread', version } as any)
				);
			}
			// The item is untouched: no name change slipped through on a rejected version.
			const row = h.db.prepare('SELECT name, version FROM items WHERE id = ?').get(added.item.id) as any;
			expect(row.name).toBe('Milk');
			expect(row.version).toBe(added.item.version);
		} finally {
			h.close();
		}
	});

	/**
	 * §3.1b — the trip-history cursor. `before` reaches a `WHERE t.seq < ?` bind,
	 * and had no test of any kind: gutting `beforeSeq` left all 146 tests green.
	 */
	test('GET /trips rejects a before cursor that is not a safe integer >= 1', () => {
		const { h, store } = ctx();
		try {
			for (const before of [0, -1, 1.5, 9007199254740993, 1e300, NaN, Infinity, '1', null]) {
				expectValidationFailure(() => listClosedTrips(h.db, store.id, { before }));
			}
			// And the same for `limit`, whose §3.1b range is 1–50.
			for (const limit of [0, -1, 51, 1.5, 9007199254740993, NaN, '10', null]) {
				expectValidationFailure(() => listClosedTrips(h.db, store.id, { limit }));
			}
			// A valid cursor still works, so the bound is not simply rejecting everything.
			expect(listClosedTrips(h.db, store.id, { before: 1, limit: 50 }).trips).toEqual([]);
		} finally {
			h.close();
		}
	});

	// §3.1a/`boolean()`'s only caller: PATCH /stores' `archived` field. No other
	// endpoint takes a boolean input.
	test('PATCH /stores rejects a non-boolean archived value', () => {
		const { h, store } = ctx();
		try {
			for (const archived of ['true', 'false', 1, 0, null, [], {}, 'yes']) {
				expectValidationFailure(() => updateStore(h.db, store.id, { archived } as any));
			}
			// A real boolean still works, so the bound is not rejecting everything.
			expect(updateStore(h.db, store.id, { archived: true }).archivedAt).not.toBeNull();
		} finally {
			h.close();
		}
	});

	test('PATCH /stores with an empty body is 400, not a silent rev bump', () => {
		const { h, store } = ctx();
		try {
			const before = (h.db.prepare('SELECT rev FROM stores WHERE id=?').get(store.id) as any).rev;
			expectValidationFailure(() => updateStore(h.db, store.id, {}));
			expect((h.db.prepare('SELECT rev FROM stores WHERE id=?').get(store.id) as any).rev).toBe(
				before
			);
		} finally {
			h.close();
		}
	});

	test('trip history limit is bounded to 1–50', () => {
		const { h, store } = ctx();
		try {
			expectValidationFailure(() => listClosedTrips(h.db, store.id, { limit: 0 }));
			expectValidationFailure(() => listClosedTrips(h.db, store.id, { limit: 51 }));
			expectValidationFailure(() => listClosedTrips(h.db, store.id, { limit: 1.5 }));
			expect(listClosedTrips(h.db, store.id, { limit: 50 }).trips).toEqual([]);
		} finally {
			h.close();
		}
	});

	// §3.5: a missing or non-string tripId is 400 VALIDATION_FAILED, NOT a 409.
	// The 409 means "your view is stale, here is the current trip"; answering a
	// malformed body with a recoverable-looking 409 hides a client bug behind a
	// retry loop that appears to work.
	test('close with a missing or non-string tripId is 400 VALIDATION_FAILED, never a 409 or a 500', () => {
		const { h, actor, store } = ctx();
		try {
			for (const tripId of [undefined, null, 42, {}, [], true, '']) {
				try {
					closeTrip(h.db, store.id, { tripId }, actor);
					throw new Error(`expected a rejection for ${String(tripId)}`);
				} catch (err: any) {
					expect(isDomainError(err)).toBe(true);
					expect(err.code).toBe('VALIDATION_FAILED');
					expect(err.status).toBe(400);
					expect(err.extra).toBeUndefined();
				}
			}
			// The store is untouched: no close happened, the open trip is the same one.
			const stillOpen = h.db
				.prepare(`SELECT id FROM trips WHERE store_id = ? AND status = 'open'`)
				.get(store.id) as any;
			expect(stillOpen.id).toBe(store.openTripId);
		} finally {
			h.close();
		}
	});

	// R-6 step 1: a tripId that has NEVER existed is 404 TRIP_NOT_FOUND, not a
	// 409. Trips are never deleted, so it cannot be stale state — it is a client
	// bug, and a recoverable-looking 409 would hide it behind a retry loop that
	// appears to work, the same reasoning as the malformed-body ruling above.
	test('close with a well-formed tripId that never existed is 404 TRIP_NOT_FOUND, with no openTripId', () => {
		const { h, actor, store } = ctx();
		try {
			const neverExisted = randomUUID();
			try {
				closeTrip(h.db, store.id, { tripId: neverExisted }, actor);
				throw new Error('expected a rejection');
			} catch (err: any) {
				expect(isDomainError(err)).toBe(true);
				expect(err.code).toBe('TRIP_NOT_FOUND');
				expect(err.status).toBe(404);
				// §3.1: only the three named siblings exist, and this is not one.
				expect(err.extra).toBeUndefined();
			}
			// The store is untouched: the open trip is still the same one.
			const stillOpen = h.db
				.prepare(`SELECT id FROM trips WHERE store_id = ? AND status = 'open'`)
				.get(store.id) as any;
			expect(stillOpen.id).toBe(store.openTripId);
		} finally {
			h.close();
		}
	});

	// The other half of the ruling: a trip that EXISTS but is closed, or belongs
	// to another store, is genuinely stale state and still gets the recoverable
	// 409 carrying openTripId.
	test('close of a trip that exists but is closed, or belongs to another store, is 409 TRIP_ALREADY_CLOSED with openTripId', () => {
		const { h, actor, store } = ctx();
		try {
			addItem(h.db, store.id, { name: 'Milk', clientId: randomUUID() }, actor);
			const closedId = store.openTripId;
			const successor = closeTrip(h.db, store.id, { tripId: closedId }, actor).newTrip.id;

			for (const tripId of [closedId, createStore(h.db, { name: 'BIM' }, actor).openTripId]) {
				try {
					closeTrip(h.db, store.id, { tripId }, actor);
					throw new Error('expected a rejection');
				} catch (err: any) {
					expect(isDomainError(err)).toBe(true);
					expect(err.code).toBe('TRIP_ALREADY_CLOSED');
					expect(err.status).toBe(409);
					expect(err.extra.openTripId).toBe(successor);
				}
			}
		} finally {
			h.close();
		}
	});
});

describe('the DDL length checks are the backstop, set at the same numbers', () => {
	test('items and stores CHECK at 200 / 500 / 60', () => {
		const h = harness();
		try {
			const items = (h.db.prepare(`SELECT sql FROM sqlite_schema WHERE name='items'`).get() as any)
				.sql as string;
			expect(items).toMatch(/length\(name\) <= 200/);
			expect(items).toMatch(/length\(note\) <= 500/);
			const stores = (h.db.prepare(`SELECT sql FROM sqlite_schema WHERE name='stores'`).get() as any)
				.sql as string;
			expect(stores).toMatch(/length\(name\) <= 60/);
		} finally {
			h.close();
		}
	});
});

describe('not found', () => {
	test('unknown ids produce 404s with stable codes', () => {
		const { h, actor } = ctx();
		try {
			for (const [fn, code] of [
				[() => addItem(h.db, randomUUID(), { name: 'A', clientId: randomUUID() }, actor), 'STORE_NOT_FOUND'],
				[() => updateStore(h.db, randomUUID(), { name: 'A' }), 'STORE_NOT_FOUND'],
				[() => updateItem(h.db, randomUUID(), { name: 'A', version: 1 }), 'ITEM_NOT_FOUND']
			] as Array<[() => unknown, string]>) {
				try {
					fn();
					throw new Error('expected a rejection');
				} catch (err: any) {
					expect(isDomainError(err)).toBe(true);
					expect(err.code).toBe(code);
					expect(err.status).toBe(404);
				}
			}
		} finally {
			h.close();
		}
	});
});
