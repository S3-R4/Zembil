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
import { resetBus } from '$lib/server/realtime/bus';

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
					'tickedCount'
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

	test('404 ITEM_NOT_FOUND for an unknown or soft-deleted item on tick', async () => {
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

	test('every error body has exactly the code/message pair and no nested recovery data', async () => {
		const { h, locals } = ctx();
		try {
			const res = await call(listRoute.GET, { locals, params: { storeId: randomUUID() } });
			expect(res.status).toBe(404);
			const body = await bodyOf(res);
			expect(Object.keys(body)).toEqual(['error']);
			expect(Object.keys(body.error).sort()).toEqual(['code', 'message']);
			expect(res.headers.get('content-type')).toContain('application/json');
		} finally {
			h.close();
		}
	});
});
