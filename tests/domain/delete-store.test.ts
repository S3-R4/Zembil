/**
 * Deleting a store — CONTRACT.md §9.1, R-23, §3.0.
 *
 * Archiving (R-14) hides a shop and keeps every row. This is the other one, and
 * it is the only irreversible write in the API, so the tests here are about two
 * things rather than one:
 *
 *  1. **It removes exactly what it promises and nothing else.** The cascade is
 *     the schema's, so the assertion is on the schema's behaviour: trips, items
 *     and carried lineage go with the store, and a neighbouring store does not.
 *  2. **The refusal is observable as a refusal.** PROJECT.md §11 records the M6
 *     finding that removing the visibility check from `updateStore` changed no
 *     status code, because the write committed and the closing read threw the
 *     same 404 on the way out. A guard on a DELETE is worse: the row is gone and
 *     nothing reads it back. So every refusal here also asserts the store, its
 *     trips and its items are still in the database.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bodyOf, harness, jsonRequest, localsFor, makeUser, recorder } from './_support';
import { setDb } from '$lib/server/db';
import { resetBus } from '$lib/server/realtime/bus';
import {
	configureNotifier,
	pendingCount,
	resetNotifier,
	setNotificationSink
} from '$lib/server/notify/index';
import type { ZembilEvent } from '$lib/types';

import * as storesRoute from '../../src/routes/api/stores/+server';
import * as storeRoute from '../../src/routes/api/stores/[storeId]/+server';
import * as listRoute from '../../src/routes/api/stores/[storeId]/list/+server';
import * as itemsRoute from '../../src/routes/api/stores/[storeId]/items/+server';
import * as closeRoute from '../../src/routes/api/stores/[storeId]/trips/close/+server';

afterEach(() => {
	setDb(null);
	resetBus();
	resetNotifier();
});

const call = (fn: any, args: any) => fn(args) as Promise<Response>;
const url = (path = 'http://localhost/api/stores') => new URL(path);
const types = (events: ZembilEvent[]) => events.map((e) => e.type);

const countOf = (h: any, sql: string, id: string): number =>
	Number((h.db.prepare(sql).get(id) as any).n);

const storeRows = (h: any, id: string) => ({
	stores: countOf(h, 'SELECT COUNT(*) AS n FROM stores WHERE id = ?', id),
	trips: countOf(h, 'SELECT COUNT(*) AS n FROM trips WHERE store_id = ?', id),
	items: countOf(h, 'SELECT COUNT(*) AS n FROM items WHERE store_id = ?', id)
});

/** An owner, a bystander, an admin bystander, and one store with a closed trip
 *  behind it so the cascade has more than a single trip to remove. */
async function world() {
	const h = harness();
	setDb(h.db);

	const owner = makeUser(h.db, 'ayse', 'Ayşe');
	const other = makeUser(h.db, 'baba', 'Baba');
	const admin = makeUser(h.db, 'root', 'Root');

	const ownerLocals = localsFor(owner);
	const otherLocals = localsFor(other, 'session-2');
	const adminLocals = localsFor(admin, 'session-3', { isAdmin: true });

	const created = await call(storesRoute.POST, {
		locals: ownerLocals,
		request: jsonRequest({ name: 'Migros' })
	});
	const store = (await bodyOf(created)).store;

	const add = (name: string) =>
		call(itemsRoute.POST, {
			locals: ownerLocals,
			params: { storeId: store.id },
			request: jsonRequest({ name, clientId: randomUUID() })
		});

	await add('Milk');
	await add('Bread');
	// Close it: trip 1 keeps its rows, trip 2 opens, and the unticked items are
	// cloned onto it with `carried_from_item_id` pointing back — items that
	// reference other items are the cascade's sharpest corner.
	const openTripId = (
		h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(store.id) as any
	).id;
	const closed = await call(closeRoute.POST, {
		locals: ownerLocals,
		params: { storeId: store.id },
		request: jsonRequest({ tripId: openTripId })
	});
	expect(closed.status).toBe(200);

	return { h, owner, other, admin, ownerLocals, otherLocals, adminLocals, store };
}

const makePrivate = async (w: Awaited<ReturnType<typeof world>>) => {
	const res = await call(storeRoute.PATCH, {
		locals: w.ownerLocals,
		params: { storeId: w.store.id },
		request: jsonRequest({ visibility: 'private' }, 'PATCH')
	});
	expect(res.status).toBe(200);
};

describe('§9.1 / R-23 — DELETE /api/stores/{id} removes the store and its rows', () => {
	test('the store, every trip and every item go, and the response says how many', async () => {
		const w = await world();
		try {
			const before = storeRows(w.h, w.store.id);
			expect(before.trips).toBe(2);
			expect(before.items).toBe(4); // 2 originals + 2 carried clones

			const res = await call(storeRoute.DELETE, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(200);

			const { deleted } = await bodyOf(res);
			expect(deleted).toEqual({
				storeId: w.store.id,
				name: 'Migros',
				trips: before.trips,
				items: before.items
			});

			expect(storeRows(w.h, w.store.id)).toEqual({ stores: 0, trips: 0, items: 0 });
		} finally {
			w.h.close();
		}
	});

	test('a neighbouring store keeps every one of its rows', async () => {
		const w = await world();
		try {
			const second = (
				await bodyOf(
					await call(storesRoute.POST, {
						locals: w.ownerLocals,
						request: jsonRequest({ name: 'Eczane' })
					})
				)
			).store;
			await call(itemsRoute.POST, {
				locals: w.ownerLocals,
				params: { storeId: second.id },
				request: jsonRequest({ name: 'Aspirin', clientId: randomUUID() })
			});

			await call(storeRoute.DELETE, { locals: w.ownerLocals, params: { storeId: w.store.id } });

			expect(storeRows(w.h, second.id)).toEqual({ stores: 1, trips: 1, items: 1 });
		} finally {
			w.h.close();
		}
	});

	test('it disappears from GET /api/stores and its list 404s afterwards', async () => {
		const w = await world();
		try {
			await call(storeRoute.DELETE, { locals: w.ownerLocals, params: { storeId: w.store.id } });

			const listed = await bodyOf(
				await call(storesRoute.GET, {
					locals: w.ownerLocals,
					url: url('http://localhost/api/stores?includeArchived=true')
				})
			);
			expect(listed.stores.map((s: any) => s.id)).not.toContain(w.store.id);

			const gone = await call(listRoute.GET, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id }
			});
			expect(gone.status).toBe(404);
		} finally {
			w.h.close();
		}
	});

	test('R-14 does not apply: an archived store is deletable', async () => {
		const w = await world();
		try {
			await call(storeRoute.PATCH, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ archived: true }, 'PATCH')
			});

			const res = await call(storeRoute.DELETE, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(200);
			expect(storeRows(w.h, w.store.id).stores).toBe(0);
		} finally {
			w.h.close();
		}
	});

	test('deleting twice: the second call is a 404, not a 500', async () => {
		const w = await world();
		try {
			await call(storeRoute.DELETE, { locals: w.ownerLocals, params: { storeId: w.store.id } });
			const again = await call(storeRoute.DELETE, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id }
			});
			expect(again.status).toBe(404);
			expect((await bodyOf(again)).error.code).toBe('STORE_NOT_FOUND');
		} finally {
			w.h.close();
		}
	});
});

describe('§8.4 — an invisible store cannot be deleted, and the refusal leaves it intact', () => {
	test('a bystander gets the byte-identical 404 and the rows survive', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const before = storeRows(w.h, w.store.id);

			const invisible = await call(storeRoute.DELETE, {
				locals: w.otherLocals,
				params: { storeId: w.store.id }
			});
			const fabricated = await call(storeRoute.DELETE, {
				locals: w.otherLocals,
				params: { storeId: randomUUID() }
			});

			expect(invisible.status).toBe(404);
			expect(invisible.status).toBe(fabricated.status);
			const a = await bodyOf(invisible);
			expect(a).toEqual(await bodyOf(fabricated));
			expect(Object.keys(a)).toEqual(['error']);

			// The assertion that kills the mutation. Every response-shaped check
			// above stays green if the guard is removed and the row is destroyed
			// on the way to a 404.
			expect(storeRows(w.h, w.store.id)).toEqual(before);
		} finally {
			w.h.close();
		}
	});

	test('an admin is not exempt, and the rows survive that too', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const before = storeRows(w.h, w.store.id);

			const res = await call(storeRoute.DELETE, {
				locals: w.adminLocals,
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(404);
			expect(storeRows(w.h, w.store.id)).toEqual(before);
		} finally {
			w.h.close();
		}
	});

	test('the owner can delete their own private store', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(storeRoute.DELETE, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(200);
			expect(storeRows(w.h, w.store.id)).toEqual({ stores: 0, trips: 0, items: 0 });
		} finally {
			w.h.close();
		}
	});

	test('an anonymous caller gets 401 and the rows survive', async () => {
		const w = await world();
		try {
			const before = storeRows(w.h, w.store.id);
			const res = await call(storeRoute.DELETE, {
				locals: localsFor(null),
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(401);
			expect(storeRows(w.h, w.store.id)).toEqual(before);
		} finally {
			w.h.close();
		}
	});
});

describe('§3.0 — what a delete emits', () => {
	test('stores.changed AND store.changed, the latter one rev ahead of the row that is gone', async () => {
		const w = await world();
		try {
			const rev = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			const rec = recorder();
			try {
				await call(storeRoute.DELETE, { locals: w.ownerLocals, params: { storeId: w.store.id } });
				const events = rec.take();
				expect(types(events)).toEqual(['stores.changed', 'store.changed']);
				const hint = events.find((e) => e.type === 'store.changed') as any;
				expect(hint.storeId).toBe(w.store.id);
				// Strictly higher than the cursor a member on /s/{id} is holding, or
				// they never refetch and never learn the shop is gone.
				expect(hint.rev).toBe(rev + 1);
				expect(hint.rev).toBeGreaterThan(rev);
			} finally {
				rec.stop();
			}
		} finally {
			w.h.close();
		}
	});

	test('a refused delete emits nothing', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const rec = recorder();
			try {
				await call(storeRoute.DELETE, { locals: w.otherLocals, params: { storeId: w.store.id } });
				expect(rec.take()).toEqual([]);
			} finally {
				rec.stop();
			}
		} finally {
			w.h.close();
		}
	});

	test('a pending notification batch for the store is dropped, not left armed', async () => {
		const w = await world();
		try {
			resetNotifier();
			setNotificationSink(() => {});
			configureNotifier({ quietMs: 60_000, maxDelayMs: 300_000 });

			await call(itemsRoute.POST, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ name: 'Yoğurt', clientId: randomUUID() })
			});
			expect(pendingCount()).toBe(1);

			await call(storeRoute.DELETE, { locals: w.ownerLocals, params: { storeId: w.store.id } });
			expect(pendingCount()).toBe(0);
		} finally {
			w.h.close();
		}
	});
});
