/**
 * The HTTP surface — CONTRACT.md §3.1, §3.4, §3.5, §3.6, §4.
 *
 * The route handlers are called directly with a minimal RequestEvent. Auth does
 * not exist in M1, so `locals.user` is populated the way hooks.server.ts will
 * populate it in M2 — the routes read the actor from there and nowhere else.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bodyOf, harness, jsonRequest, localsFor, makeUser, type Harness } from './_support';
import { setDb } from '$lib/server/db';
import { emitStoresChanged, resetBus, streamCount } from '$lib/server/realtime/bus';

import * as storesRoute from '../../src/routes/api/stores/+server';
import * as storeRoute from '../../src/routes/api/stores/[storeId]/+server';
import * as listRoute from '../../src/routes/api/stores/[storeId]/list/+server';
import * as itemsRoute from '../../src/routes/api/stores/[storeId]/items/+server';
import * as closeRoute from '../../src/routes/api/stores/[storeId]/trips/close/+server';
import * as tripsRoute from '../../src/routes/api/stores/[storeId]/trips/+server';
import * as itemRoute from '../../src/routes/api/items/[itemId]/+server';
import * as tickRoute from '../../src/routes/api/items/[itemId]/tick/+server';
import * as untickRoute from '../../src/routes/api/items/[itemId]/untick/+server';
import * as tripRoute from '../../src/routes/api/trips/[tripId]/+server';
import * as eventsRoute from '../../src/routes/api/events/+server';

afterEach(() => {
	setDb(null);
	resetBus();
});

function ctx() {
	const h = harness();
	setDb(h.db);
	const user = makeUser(h.db);
	const locals = localsFor(user);
	return { h, user, locals };
}

const url = (path = 'http://localhost/api/stores') => new URL(path);

const call = (fn: any, args: any) => fn(args) as Promise<Response>;

const openTripId = (h: Harness, storeId: string): string =>
	(h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any).id;

async function createStore(locals: any, name = 'Migros') {
	const res = await call(storesRoute.POST, { locals, request: jsonRequest({ name }) });
	expect(res.status).toBe(201);
	return (await bodyOf(res)).store;
}

describe('authentication seam', () => {
	test('every route reads the actor from locals.user and 401s without one', async () => {
		const { h } = ctx();
		try {
			const anon = localsFor(null);
			const responses = await Promise.all([
				call(storesRoute.GET, { locals: anon, url: url() }),
				call(storesRoute.POST, { locals: anon, request: jsonRequest({ name: 'X' }) }),
				call(storeRoute.PATCH, { locals: anon, params: { storeId: 'x' }, request: jsonRequest({}) }),
				call(storeRoute.DELETE, { locals: anon, params: { storeId: 'x' } }),
				call(listRoute.GET, { locals: anon, params: { storeId: 'x' } }),
				call(itemsRoute.POST, {
					locals: anon,
					params: { storeId: 'x' },
					request: jsonRequest({ name: 'A', clientId: randomUUID() })
				}),
				call(itemRoute.DELETE, { locals: anon, params: { itemId: 'x' } }),
				call(tickRoute.POST, { locals: anon, params: { itemId: 'x' } }),
				call(untickRoute.POST, { locals: anon, params: { itemId: 'x' } }),
				call(closeRoute.POST, {
					locals: anon,
					params: { storeId: 'x' },
					request: jsonRequest({ tripId: 'y' })
				}),
				call(tripsRoute.GET, { locals: anon, params: { storeId: 'x' }, url: url() }),
				call(tripRoute.GET, { locals: anon, params: { tripId: 'x' } }),
				call(eventsRoute.GET, { locals: anon })
			]);
			for (const res of responses) {
				expect(res.status).toBe(401);
				expect((await bodyOf(res)).error.code).toBe('UNAUTHENTICATED');
			}
		} finally {
			h.close();
		}
	});
});

describe('§3.4 — stores', () => {
	test('POST returns 201 with a StoreSummary; GET lists it', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			expect(Object.keys(store).sort()).toEqual(
				[
					'archivedAt',
					'color',
					'id',
					'lastClosedTripAt',
					'name',
					'openTripId',
					'pendingCount',
					'rev',
					'sortOrder',
					'tickedCount',
					// §8.6: StoreSummary gains visibility and the four Claim fields.
					'visibility',
					'claimedByName',
					'claimedByMe',
					'claimedAt',
					'claimNote'
				].sort()
			);

			const res = await call(storesRoute.GET, { locals, url: url() });
			expect((await bodyOf(res)).stores.map((s: any) => s.id)).toEqual([store.id]);
		} finally {
			h.close();
		}
	});

	test('?includeArchived=true is the only way back to an archived store', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			await call(storeRoute.PATCH, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ archived: true }, 'PATCH')
			});

			const hidden = await bodyOf(await call(storesRoute.GET, { locals, url: url() }));
			expect(hidden.stores).toEqual([]);

			const shown = await bodyOf(
				await call(storesRoute.GET, {
					locals,
					url: url('http://localhost/api/stores?includeArchived=true')
				})
			);
			expect(shown.stores.map((s: any) => s.id)).toEqual([store.id]);
			expect(shown.stores[0].archivedAt).toBeTypeOf('number');
		} finally {
			h.close();
		}
	});

	test('409 STORE_NAME_TAKEN carries the colliding storeId next to error, not inside it', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const res = await call(storesRoute.POST, { locals, request: jsonRequest({ name: 'MIGROS' }) });
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.error).toEqual({
				code: 'STORE_NAME_TAKEN',
				message: expect.any(String)
			});
			expect(body.storeId).toBe(store.id);
			expect(body.error.storeId).toBeUndefined();
		} finally {
			h.close();
		}
	});

	/**
	 * §3.4: STORE_NAME_TAKEN applies to PATCH too, not only POST. Every existing
	 * collision test renames via createStore; this is the one that renames an
	 * EXISTING store onto another existing store's name, and the one that
	 * proves the self-exclude works — PATCHing a store to its own current name
	 * must succeed, not collide with itself.
	 */
	test('PATCH rename: a cross-store collision is 409 STORE_NAME_TAKEN; renaming to its own name is not a self-collision', async () => {
		const { h, locals } = ctx();
		try {
			const migros = await createStore(locals, 'Migros');
			const bim = await createStore(locals, 'BIM');

			const collide = await call(storeRoute.PATCH, {
				locals,
				params: { storeId: bim.id },
				request: jsonRequest({ name: 'MIGROS' }, 'PATCH')
			});
			expect(collide.status).toBe(409);
			const collideBody = await bodyOf(collide);
			expect(collideBody.error.code).toBe('STORE_NAME_TAKEN');
			expect(collideBody.storeId).toBe(migros.id);
			// Nothing was renamed on the rejected side.
			expect(
				(await bodyOf(await call(storesRoute.GET, { locals, url: url() }))).stores.find(
					(s: any) => s.id === bim.id
				).name
			).toBe('BIM');

			const self = await call(storeRoute.PATCH, {
				locals,
				params: { storeId: migros.id },
				request: jsonRequest({ name: 'Migros' }, 'PATCH')
			});
			expect(self.status).toBe(200);
			expect((await bodyOf(self)).store.name).toBe('Migros');
		} finally {
			h.close();
		}
	});

	test('an unrecognised colour is 400 VALIDATION_FAILED', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(storesRoute.POST, {
				locals,
				request: jsonRequest({ name: 'BIM', color: 'chartreuse' })
			});
			expect(res.status).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
		} finally {
			h.close();
		}
	});

	/**
	 * §3.1b, as an attack rather than a unit test.
	 *
	 * `Number.isInteger(9007199254740993)` is `true`, and the value COMMITS as
	 * `9007199254740992`. With BigInt off (§1.1a) every later read of that row
	 * throws `RangeError [ERR_OUT_OF_RANGE]`, so one PATCH body from one ordinary
	 * family member turns `GET /api/stores`, `POST /api/stores` and that store's
	 * `GET /list` into permanent 500s for everyone, unrecoverable through the API.
	 *
	 * The 400 is half the test. The assertions AFTER it are the ones that matter:
	 * they prove the poisoning is impossible, not merely rejected on one path.
	 */
	test('a sortOrder the driver cannot round-trip is 400 and cannot poison the store list', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const before = (await bodyOf(await call(storesRoute.GET, { locals, url: url() }))).stores;

			for (const sortOrder of [
				9007199254740993, // isInteger true; commits as 2^53, then every read throws
				9007199254740992,
				1e300, // isInteger true; a REAL, which STRICT refuses to bind — a 500
				-1e300,
				2147483648, // outside the §3.1b range bound
				-2147483649,
				Number.MAX_SAFE_INTEGER,
				1.5,
				NaN,
				Infinity,
				'7',
				null
			]) {
				const res = await call(storeRoute.PATCH, {
					locals,
					params: { storeId: store.id },
					request: jsonRequest({ sortOrder }, 'PATCH')
				});
				expect(res.status, String(sortOrder)).toBe(400);
				expect((await bodyOf(res)).error.code, String(sortOrder)).toBe('VALIDATION_FAILED');
			}

			// The list still reads. This is the assertion the whole test exists for.
			const listed = await call(storesRoute.GET, { locals, url: url() });
			expect(listed.status).toBe(200);
			expect((await bodyOf(listed)).stores).toEqual(before);

			// And so do the other two endpoints a poisoned row would have taken down.
			const list = await call(listRoute.GET, { locals, params: { storeId: store.id } });
			expect(list.status).toBe(200);
			const created = await call(storesRoute.POST, {
				locals,
				request: jsonRequest({ name: 'BIM' })
			});
			expect(created.status).toBe(201);

			// The row itself is untouched — nothing was half-written.
			const raw = h.db.prepare('SELECT sort_order FROM stores WHERE id = ?').get(store.id) as any;
			expect(Number.isSafeInteger(raw.sort_order)).toBe(true);
			expect(raw.sort_order).toBe(1000);
		} finally {
			h.close();
		}
	});

	test('the boundaries of the §3.1b sortOrder range are accepted and stored verbatim', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			for (const sortOrder of [2147483647, -2147483648, 0]) {
				const res = await call(storeRoute.PATCH, {
					locals,
					params: { storeId: store.id },
					request: jsonRequest({ sortOrder }, 'PATCH')
				});
				expect(res.status, String(sortOrder)).toBe(200);
				expect((await bodyOf(res)).store.sortOrder).toBe(sortOrder);
				// R-15 writes the client integer directly, so a read-back must survive.
				expect(
					(await bodyOf(await call(storesRoute.GET, { locals, url: url() }))).stores[0].sortOrder
				).toBe(sortOrder);
			}
		} finally {
			h.close();
		}
	});
});

describe('§3.5 — list and items', () => {
	test('GET /list returns store, trip and ordered items', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
			});
			const body = await bodyOf(await call(listRoute.GET, { locals, params: { storeId: store.id } }));
			expect(body.store.id).toBe(store.id);
			expect(body.trip.id).toBe(store.openTripId);
			expect(body.items.map((i: any) => i.name)).toEqual(['Milk']);
			// §7: display names, never user ids.
			expect(body.items[0].createdByName).toBe('Ayse');
			expect(body.items[0].createdBy).toBeUndefined();
			expect(body.items[0].clientId).toBeUndefined();
		} finally {
			h.close();
		}
	});

	test('every item-mutating response carries { item, rev }', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const added = await bodyOf(
				await call(itemsRoute.POST, {
					locals,
					params: { storeId: store.id },
					request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
				})
			);
			expect(Object.keys(added).sort()).toEqual(['item', 'rev']);
			expect(added.rev).toBe(1);

			const ticked = await bodyOf(
				await call(tickRoute.POST, { locals, params: { itemId: added.item.id } })
			);
			expect(ticked.rev).toBe(2);
			const unticked = await bodyOf(
				await call(untickRoute.POST, { locals, params: { itemId: added.item.id } })
			);
			expect(unticked.rev).toBe(3);
			const patched = await bodyOf(
				await call(itemRoute.PATCH, {
					locals,
					params: { itemId: added.item.id },
					request: jsonRequest({ name: 'Milk 2L', version: unticked.item.version }, 'PATCH')
				})
			);
			expect(patched.rev).toBe(4);
			const deleted = await bodyOf(
				await call(itemRoute.DELETE, { locals, params: { itemId: added.item.id } })
			);
			expect(deleted.rev).toBe(5);
			expect(deleted.item.id).toBe(added.item.id);
		} finally {
			h.close();
		}
	});

	test('R-17 — a retry whose original was carried over returns 200 with the CLONE on the successor trip', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const clientId = randomUUID();
			const first = await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'Milk', clientId })
			});
			expect(first.status).toBe(201);
			const original = (await bodyOf(first)).item;

			const staleTrip = openTripId(h, store.id);
			await call(closeRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ tripId: staleTrip })
			});
			const successor = openTripId(h, store.id);

			const retry = await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'Milk', clientId })
			});
			expect(retry.status).toBe(200);
			const clone = (await bodyOf(retry)).item;
			expect(clone.id).not.toBe(original.id);
			expect(clone.tripId).toBe(successor);
			expect(clone.carryCount).toBe(1);

			const live = h.db
				.prepare(
					`SELECT COUNT(*) AS n FROM items WHERE store_id=? AND client_id=? AND state<>'carried' AND deleted_at IS NULL`
				)
				.get(store.id, clientId) as any;
			expect(Number(live.n)).toBe(1);
		} finally {
			h.close();
		}
	});

	test('409 VERSION_CONFLICT carries the current item next to error', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const added = await bodyOf(
				await call(itemsRoute.POST, {
					locals,
					params: { storeId: store.id },
					request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
				})
			);
			const res = await call(itemRoute.PATCH, {
				locals,
				params: { itemId: added.item.id },
				request: jsonRequest({ name: 'Milk 2L', version: 99 }, 'PATCH')
			});
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.error.code).toBe('VERSION_CONFLICT');
			expect(body.item.id).toBe(added.item.id);
			expect(body.item.version).toBe(1);
		} finally {
			h.close();
		}
	});

	test('404 ITEM_NOT_FOUND for an unknown or soft-deleted item on tick; DELETE differs only for the already-deleted case (R-10)', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const added = await bodyOf(
				await call(itemsRoute.POST, {
					locals,
					params: { storeId: store.id },
					request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
				})
			);
			await call(itemRoute.DELETE, { locals, params: { itemId: added.item.id } });

			for (const itemId of [randomUUID(), added.item.id]) {
				const res = await call(tickRoute.POST, { locals, params: { itemId } });
				expect(res.status).toBe(404);
				expect((await bodyOf(res)).error.code).toBe('ITEM_NOT_FOUND');
			}

			// DELETE itself: an id that never existed still 404s, exactly like its
			// siblings above.
			const neverExisted = await call(itemRoute.DELETE, {
				locals,
				params: { itemId: randomUUID() }
			});
			expect(neverExisted.status).toBe(404);
			expect((await bodyOf(neverExisted)).error.code).toBe('ITEM_NOT_FOUND');

			// But R-10 makes a REPEAT delete of the already-soft-deleted item above
			// idempotent success, not 404 — the one place DELETE's "unknown or
			// soft-deleted" case parts ways with tick/untick/patch.
			const again = await call(itemRoute.DELETE, { locals, params: { itemId: added.item.id } });
			expect(again.status).toBe(200);
			expect((await bodyOf(again)).item.id).toBe(added.item.id);
		} finally {
			h.close();
		}
	});

	test('close returns closedTrip, newTrip and the two counts; the loser gets openTripId', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const added = await bodyOf(
				await call(itemsRoute.POST, {
					locals,
					params: { storeId: store.id },
					request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
				})
			);
			await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'Bread', clientId: randomUUID() })
			});
			await call(tickRoute.POST, { locals, params: { itemId: added.item.id } });

			const tripId = openTripId(h, store.id);
			const res = await call(closeRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ tripId })
			});
			expect(res.status).toBe(200);
			const body = await bodyOf(res);
			expect(Object.keys(body).sort()).toEqual([
				'boughtCount',
				'carriedCount',
				'closedTrip',
				'newTrip'
			]);
			expect(body.boughtCount).toBe(1);
			expect(body.carriedCount).toBe(1);
			expect(body.closedTrip.status).toBe('closed');
			expect(body.newTrip.status).toBe('open');

			const again = await call(closeRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ tripId })
			});
			expect(again.status).toBe(409);
			const conflict = await bodyOf(again);
			expect(conflict.error.code).toBe('TRIP_ALREADY_CLOSED');
			expect(conflict.openTripId).toBe(body.newTrip.id);
		} finally {
			h.close();
		}
	});

	test('close with a missing or non-string tripId is 400 VALIDATION_FAILED with a bare envelope', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			for (const request of [jsonRequest({}), jsonRequest({ tripId: 7 })]) {
				const res = await call(closeRoute.POST, {
					locals,
					params: { storeId: store.id },
					request
				});
				expect(res.status).toBe(400);
				const body = await bodyOf(res);
				expect(body.error.code).toBe('VALIDATION_FAILED');
				// §3.1: only the three named conflicts carry a sibling field. A
				// malformed body must not look recoverable — no openTripId here.
				expect(Object.keys(body)).toEqual(['error']);
			}
			// The trip really was not closed.
			expect(openTripId(h, store.id)).toBe(store.openTripId);
		} finally {
			h.close();
		}
	});
});

describe('§3.6 — history routes', () => {
	test('GET /stores/{id}/trips paginates and GET /trips/{id} returns the detail', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
			});
			const firstTrip = openTripId(h, store.id);
			await call(closeRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ tripId: firstTrip })
			});

			const page = await bodyOf(
				await call(tripsRoute.GET, {
					locals,
					params: { storeId: store.id },
					url: url('http://localhost/api/stores/x/trips?limit=10')
				})
			);
			expect(page.trips).toHaveLength(1);
			expect(page.trips[0].carriedCount).toBe(1);
			expect(page.nextBefore).toBe(null);

			const detail = await bodyOf(await call(tripRoute.GET, { locals, params: { tripId: firstTrip } }));
			expect(detail.trip.id).toBe(firstTrip);
			expect(detail.items.map((i: any) => i.state)).toEqual(['carried']);
		} finally {
			h.close();
		}
	});

	test('GET /trips/{tripId} 404s TRIP_NOT_FOUND for a well-formed id that never existed', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(tripRoute.GET, { locals, params: { tripId: randomUUID() } });
			expect(res.status).toBe(404);
			expect((await bodyOf(res)).error.code).toBe('TRIP_NOT_FOUND');
		} finally {
			h.close();
		}
	});

	test('an out-of-range limit is 400 rather than a silent clamp', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const res = await call(tripsRoute.GET, {
				locals,
				params: { storeId: store.id },
				url: url('http://localhost/api/stores/x/trips?limit=500')
			});
			expect(res.status).toBe(400);
		} finally {
			h.close();
		}
	});

	/**
	 * §3.1b at the query-string layer.
	 *
	 * This route used to pre-check its parameters with `!Number.isInteger(n)`,
	 * a second and weaker copy of rules the domain already enforces — the exact
	 * pattern §3.1b names as dangerous, since it admits `1e300` and
	 * `9007199254740993`. It now only converts the string and lets
	 * `listClosedTrips` be the single validator. These cases go through the real
	 * route with real query strings, so they cover whichever layer rejects them.
	 */
	test('every unparseable or out-of-range trips query parameter is 400 at the route', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			for (const qs of [
				'limit=0',
				'limit=-1',
				'limit=51',
				'limit=1.5',
				'limit=abc',
				'limit=',
				'limit=9007199254740993',
				'before=0',
				'before=-1',
				'before=1.5',
				'before=abc',
				'before=',
				'before=1e300',
				'before=9007199254740993', // isInteger true, isSafeInteger false
				'before=Infinity'
			]) {
				const res = await call(tripsRoute.GET, {
					locals,
					params: { storeId: store.id },
					url: url(`http://localhost/api/stores/x/trips?${qs}`)
				});
				expect(res.status, qs).toBe(400);
				expect((await bodyOf(res)).error.code, qs).toBe('VALIDATION_FAILED');
			}

			// Omitting both is still the documented default page, not a 400.
			const res = await call(tripsRoute.GET, {
				locals,
				params: { storeId: store.id },
				url: url('http://localhost/api/stores/x/trips')
			});
			expect(res.status).toBe(200);
		} finally {
			h.close();
		}
	});
});

describe('§4 — GET /api/events', () => {
	test('serves text/event-stream with the mandated headers', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(eventsRoute.GET, { locals });
			expect(res.status).toBe(200);
			expect(res.headers.get('content-type')).toBe('text/event-stream');
			expect(res.headers.get('cache-control')).toBe('no-store');
			expect(res.headers.get('x-accel-buffering')).toBe('no');
			await res.body?.cancel();
		} finally {
			h.close();
		}
	});

	test('the wire format is unnamed events with single-line JSON data and no id', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(eventsRoute.GET, { locals });
			const reader = res.body!.getReader();
			const decoder = new TextDecoder();

			const first = await reader.read();
			expect(decoder.decode(first.value)).toBe(': connected\n\n');

			// createStore emits stores.changed; the add emits store.changed.
			const store = await createStore(locals);
			const storesFrame = decoder.decode((await reader.read()).value);

			await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
			});
			const storeFrame = decoder.decode((await reader.read()).value);

			expect(storesFrame).toBe('data: {"v":1,"type":"stores.changed"}\n\n');
			expect(storeFrame).toBe(
				`data: {"v":1,"type":"store.changed","storeId":"${store.id}","rev":1}\n\n`
			);

			const wire = storesFrame + storeFrame;
			expect(wire).not.toContain('event:');
			expect(wire).not.toContain('id:');
			for (const frame of wire.split('\n\n').filter(Boolean)) {
				expect(frame.split('\n')).toHaveLength(1);
				const payload = JSON.parse(frame.replace(/^data: /, ''));
				expect(payload.v).toBe(1);
			}
			await reader.cancel();
		} finally {
			h.close();
		}
	});

	/**
	 * `MAX_BUFFERED_CHUNKS` (events/+server.ts): a consumer that stops reading
	 * must be torn down rather than have `controller.enqueue` buffer every ping
	 * and every hint in process memory forever (D-028). Never read a byte from
	 * `res.body` here — that is the point: this reproduces the in-process side
	 * of a stalled consumer directly, which is the part unit-testable without a
	 * real socket and megabytes of traffic.
	 */
	test('a consumer that stops reading is torn down instead of buffered without bound', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(eventsRoute.GET, { locals });
			expect(res.status).toBe(200);
			expect(streamCount(locals.sessionId!)).toBe(1);

			// Never read res.body: every one of these is an unread chunk piling up
			// behind the ': connected\n\n' already enqueued at stream start.
			for (let i = 0; i < 100; i += 1) emitStoresChanged();

			// The stream must have torn itself down well before 100 unread events —
			// removed from the bus, exactly like any other closed stream.
			expect(streamCount(locals.sessionId!)).toBe(0);

			await res.body?.cancel();
		} finally {
			h.close();
		}
	});
});

describe('§3.1 — the error envelope', () => {
	test('a malformed JSON body is 400 VALIDATION_FAILED, never a 500', async () => {
		const { h, locals } = ctx();
		try {
			const bad = new Request('http://localhost/api/stores', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{"name": '
			});
			const res = await call(storesRoute.POST, { locals, request: bad });
			expect(res.status).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
		} finally {
			h.close();
		}
	});

	test('a 250-character paste into the add sheet is a 400, not a CHECK constraint 500', async () => {
		const { h, locals } = ctx();
		try {
			const store = await createStore(locals);
			const res = await call(itemsRoute.POST, {
				locals,
				params: { storeId: store.id },
				request: jsonRequest({ name: 'x'.repeat(250), clientId: randomUUID() })
			});
			expect(res.status).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
		} finally {
			h.close();
		}
	});

	/**
	 * `readJson`'s body-shape guard. A malformed-JSON body (above) never reaches
	 * this check — `JSON.parse` already threw. These four ARE valid JSON, so
	 * without the `parsed === null || typeof parsed !== 'object' ||
	 * Array.isArray(parsed)` guard they sail past the `try/catch` and into
	 * `body.name` — which throws for `null` and is merely `undefined` for the
	 * others, but none of them is the JSON *object* §3.1 requires. The
	 * deliberately-empty body (`''`, parsed as `{}`) is NOT here: that is the
	 * one non-object-shaped input the guard must let through.
	 */
	test('a non-object JSON body (null, array, string, number) is 400 VALIDATION_FAILED, never a 500', async () => {
		const { h, locals } = ctx();
		try {
			for (const raw of [null, [], 'x', 42]) {
				const res = await call(storesRoute.POST, { locals, request: jsonRequest(raw) });
				expect(res.status, JSON.stringify(raw)).toBe(400);
				const body = await bodyOf(res);
				expect(body.error.code, JSON.stringify(raw)).toBe('VALIDATION_FAILED');
				// The message is asserted, not just the code, and §3.1 pins it for
				// exactly this reason: only `null` reaches a field access and 500s
				// without the guard. An array, string or number just makes every
				// field `undefined`, so `storeName` produces its OWN 400 and the
				// code alone cannot tell whether the body-shape guard ran at all.
				expect(body.error.message, JSON.stringify(raw)).toBe('Request body must be a JSON object.');
			}
			// An empty body is NOT a non-object: §3.1 reads it as `{}`, and the
			// guard must let it through to the field validators.
			const empty = await call(storesRoute.POST, {
				locals,
				request: new Request('http://localhost/api/stores', { method: 'POST', body: '' })
			});
			expect((await bodyOf(empty)).error.message).not.toBe('Request body must be a JSON object.');
		} finally {
			h.close();
		}
	});

	/**
	 * `handle()`'s "nothing else leaks" promise. A DomainError's own message is
	 * always safe to show (§3.1) — the promise this test is for is about
	 * everything ELSE: a plain `Error` thrown by a real dependency (here, the
	 * database handle itself) must never reach the client as its own message.
	 * The db is swapped for a stub via the `setDb` test seam (owned by this
	 * agent, not a hook added to responses.ts) so a real route's real call to
	 * `getDb()` fails with a plain `Error` carrying a detail that must never be
	 * echoed back.
	 */
	test('a non-DomainError never leaks its message; the client gets the generic string', async () => {
		const { h, locals } = ctx();
		try {
			const secret = 'ECONNRESET at zembil.db line 42 during checkpoint';
			const originalError = console.error;
			console.error = () => {};
			try {
				setDb({
					prepare() {
						throw new Error(secret);
					}
				} as any);
				const res = await call(storesRoute.GET, { locals, url: url() });
				expect(res.status).toBe(500);
				const body = await bodyOf(res);
				expect(body.error.code).toBe('INTERNAL');
				expect(body.error.message).toBe('Something went wrong. Please try again.');
				const wire = JSON.stringify(body);
				expect(wire).not.toContain(secret);
				expect(wire).not.toContain('ECONNRESET');
				expect(wire).not.toContain('checkpoint');
			} finally {
				console.error = originalError;
			}
		} finally {
			h.close();
		}
	});

	test('every error body has exactly the code/message pair and no nested recovery data', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(listRoute.GET, { locals, params: { storeId: randomUUID() } });
			expect(res.status).toBe(404);
			const body = await bodyOf(res);
			// getOpenList has two 404 guards in sequence — getStoreSummary's
			// STORE_NOT_FOUND, then a TRIP_NOT_FOUND fallback if a store somehow had
			// no open trip. A random, never-existed storeId must fail on the FIRST
			// one; asserting only the status leaves that indistinguishable.
			expect(body.error.code).toBe('STORE_NOT_FOUND');
			expect(Object.keys(body)).toEqual(['error']);
			expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
			expect(res.headers.get('content-type')).toContain('application/json');
		} finally {
			h.close();
		}
	});
});
