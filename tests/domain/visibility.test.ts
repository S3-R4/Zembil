/**
 * Store visibility — CONTRACT.md §8.4, R-22, I-18.
 *
 * This is an authorization boundary added to a system that did not have one,
 * and PROJECT.md §7 records what happened the last time this project shipped
 * one: the M2 audit found a bypass under a fully green 371-test suite. So this
 * file is deliberately exhaustive rather than representative — it walks **every
 * row** of §8.4's table, from a non-owner and from an ADMIN non-owner, because
 * "admins are not exempt" is the clause a future reader is most likely to
 * assume away.
 *
 * The central assertion is not that a private store is refused. It is that the
 * refusal is **indistinguishable from a store that never existed**: same status,
 * same code, same message, no extra fields. A `403` — or a `404` whose message
 * differs — would confirm that a store with that id exists and belongs to
 * somebody, which is the one fact the feature exists to hide.
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
import * as claimRoute from '../../src/routes/api/stores/[storeId]/claim/+server';
import * as itemRoute from '../../src/routes/api/items/[itemId]/+server';
import * as tickRoute from '../../src/routes/api/items/[itemId]/tick/+server';
import * as untickRoute from '../../src/routes/api/items/[itemId]/untick/+server';
import * as tripRoute from '../../src/routes/api/trips/[tripId]/+server';

afterEach(() => {
	setDb(null);
	resetBus();
});

const call = (fn: any, args: any) => fn(args) as Promise<Response>;
const url = (path = 'http://localhost/api/stores') => new URL(path);

/** A world with an owner, a bystander, an admin bystander, and one store the
 *  owner is about to make private. */
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

	// One item on it, so the item-scoped endpoints have something real to aim at
	// — a 404 for an item that does not exist would prove nothing.
	const added = await call(itemsRoute.POST, {
		locals: ownerLocals,
		params: { storeId: store.id },
		request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
	});
	const item = (await bodyOf(added)).item;
	const tripId = (
		h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(store.id) as any
	).id;

	return { h, owner, other, admin, ownerLocals, otherLocals, adminLocals, store, item, tripId };
}

async function makePrivate(w: Awaited<ReturnType<typeof world>>) {
	const res = await call(storeRoute.PATCH, {
		locals: w.ownerLocals,
		params: { storeId: w.store.id },
		request: jsonRequest({ visibility: 'private' }, 'PATCH')
	});
	expect(res.status).toBe(200);
	expect((await bodyOf(res)).store.visibility).toBe('private');
}

describe('§8.4 — a private store is invisible, one endpoint at a time', () => {
	// Each case is (name, how to call it, the code §8.4 mandates). Driving them
	// from a table is what makes "every row" checkable against the contract by
	// reading, rather than by trusting that nobody forgot one.
	const cases: Array<{
		name: string;
		code: string;
		run: (w: Awaited<ReturnType<typeof world>>, locals: any, storeId: string, itemId: string, tripId: string) => Promise<Response>;
	}> = [
		{
			name: 'PATCH /api/stores/{id}',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId) =>
				call(storeRoute.PATCH, {
					locals,
					params: { storeId },
					request: jsonRequest({ name: 'Renamed' }, 'PATCH')
				})
		},
		{
			name: 'GET /api/stores/{id}/list',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId) => call(listRoute.GET, { locals, params: { storeId } })
		},
		{
			name: 'POST /api/stores/{id}/items',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId) =>
				call(itemsRoute.POST, {
					locals,
					params: { storeId },
					request: jsonRequest({ name: 'Bread', clientId: randomUUID() })
				})
		},
		{
			name: 'POST /api/stores/{id}/trips/close',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId, _itemId, tripId) =>
				call(closeRoute.POST, {
					locals,
					params: { storeId },
					request: jsonRequest({ tripId })
				})
		},
		{
			name: 'GET /api/stores/{id}/trips',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId) =>
				call(tripsRoute.GET, { locals, params: { storeId }, url: url() })
		},
		{
			name: 'POST /api/stores/{id}/claim',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId, _itemId, tripId) =>
				call(claimRoute.POST, {
					locals,
					params: { storeId },
					request: jsonRequest({ tripId })
				})
		},
		{
			name: 'DELETE /api/stores/{id}/claim',
			code: 'STORE_NOT_FOUND',
			run: (_w, locals, storeId) => call(claimRoute.DELETE, { locals, params: { storeId } })
		},
		{
			name: 'PATCH /api/items/{id}',
			code: 'ITEM_NOT_FOUND',
			run: (_w, locals, _storeId, itemId) =>
				call(itemRoute.PATCH, {
					locals,
					params: { itemId },
					request: jsonRequest({ name: 'Changed', version: 1 }, 'PATCH')
				})
		},
		{
			name: 'DELETE /api/items/{id}',
			code: 'ITEM_NOT_FOUND',
			run: (_w, locals, _storeId, itemId) =>
				call(itemRoute.DELETE, { locals, params: { itemId } })
		},
		{
			name: 'POST /api/items/{id}/tick',
			code: 'ITEM_NOT_FOUND',
			run: (_w, locals, _storeId, itemId) =>
				call(tickRoute.POST, { locals, params: { itemId }, request: jsonRequest({}) })
		},
		{
			name: 'POST /api/items/{id}/untick',
			code: 'ITEM_NOT_FOUND',
			run: (_w, locals, _storeId, itemId) =>
				call(untickRoute.POST, { locals, params: { itemId }, request: jsonRequest({}) })
		},
		{
			name: 'GET /api/trips/{id}',
			code: 'TRIP_NOT_FOUND',
			run: (_w, locals, _storeId, _itemId, tripId) =>
				call(tripRoute.GET, { locals, params: { tripId } })
		}
	];

	for (const kind of ['a member', 'an ADMIN'] as const) {
		for (const c of cases) {
			test(`${c.name} is ${c.code} for ${kind} who does not own it`, async () => {
				const w = await world();
				try {
					await makePrivate(w);
					const locals = kind === 'an ADMIN' ? w.adminLocals : w.otherLocals;
					const res = await c.run(w, locals, w.store.id, w.item.id, w.tripId);
					expect(res.status).toBe(404);
					expect((await bodyOf(res)).error.code).toBe(c.code);
				} finally {
					w.h.close();
				}
			});
		}
	}

	test('the owner still reaches every one of them', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			for (const c of cases) {
				// Fresh state per case: some of these mutate. The point is only that
				// none of them 404s for the owner.
				const inner = await world();
				try {
					await makePrivate(inner);
					const res = await c.run(
						inner,
						inner.ownerLocals,
						inner.store.id,
						inner.item.id,
						inner.tripId
					);
					expect(res.status, `${c.name} for the owner`).toBeLessThan(400);
				} finally {
					inner.h.close();
				}
			}
		} finally {
			w.h.close();
		}
	});
});

describe('§8.4 — the 404 is indistinguishable from a store that never existed', () => {
	test('same status, same code, same message, same body keys', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const invisible = await call(listRoute.GET, {
				locals: w.otherLocals,
				params: { storeId: w.store.id }
			});
			const fabricated = await call(listRoute.GET, {
				locals: w.otherLocals,
				params: { storeId: randomUUID() }
			});

			expect(invisible.status).toBe(fabricated.status);
			const a = await bodyOf(invisible);
			const b = await bodyOf(fabricated);
			// Deep equality, not just the code: a message that named the store, or a
			// stray sibling field, is exactly the leak this rule forbids.
			expect(a).toEqual(b);
			expect(Object.keys(a)).toEqual(['error']);
		} finally {
			w.h.close();
		}
	});

	test('an item on a private store 404s the same way as a fabricated item id', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const invisible = await call(tickRoute.POST, {
				locals: w.otherLocals,
				params: { itemId: w.item.id },
				request: jsonRequest({})
			});
			const fabricated = await call(tickRoute.POST, {
				locals: w.otherLocals,
				params: { itemId: randomUUID() },
				request: jsonRequest({})
			});
			expect(invisible.status).toBe(404);
			expect(await bodyOf(invisible)).toEqual(await bodyOf(fabricated));
		} finally {
			w.h.close();
		}
	});
});

describe('§8.4 — listing', () => {
	test('a private store is absent from GET /api/stores for everyone else, admin included', async () => {
		const w = await world();
		try {
			await makePrivate(w);

			for (const locals of [w.otherLocals, w.adminLocals]) {
				const res = await call(storesRoute.GET, { locals, url: url() });
				const ids = (await bodyOf(res)).stores.map((s: any) => s.id);
				expect(ids).not.toContain(w.store.id);
			}

			const mine = await call(storesRoute.GET, { locals: w.ownerLocals, url: url() });
			const ids = (await bodyOf(mine)).stores.map((s: any) => s.id);
			expect(ids).toContain(w.store.id);
		} finally {
			w.h.close();
		}
	});

	test('?includeArchived=true does not become a way around it', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(storesRoute.GET, {
				locals: w.otherLocals,
				url: url('http://localhost/api/stores?includeArchived=true')
			});
			const ids = (await bodyOf(res)).stores.map((s: any) => s.id);
			expect(ids).not.toContain(w.store.id);
		} finally {
			w.h.close();
		}
	});
});

describe('R-22 — a private store\'s NAME is not discoverable either', () => {
	/**
	 * The M6 audit's sharpest finding. Before migration 003, `name_key` was
	 * UNIQUE table-wide, so a member could type "Eczane", read
	 * `409 STORE_NAME_TAKEN`, see no such shop in their own list, and conclude
	 * that somebody had a private shop called Eczane. That is a WORSE disclosure
	 * than the store id R-22 was careful to withhold, and it made I-18 false as
	 * written.
	 *
	 * Uniqueness is now scoped to visibility, so there is no collision to read.
	 */
	test('a private store does not reserve its name against anybody else', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Migros' })
			});
			// Not a 409 with a careful omission — no conflict at all.
			expect(res.status).toBe(201);
			const created = (await bodyOf(res)).store;
			expect(created.name).toBe('Migros');
			expect(created.id).not.toBe(w.store.id);
		} finally {
			w.h.close();
		}
	});

	test('two members can each hold a private shop of the same name', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const theirs = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Migros' })
			});
			await call(storeRoute.PATCH, {
				locals: w.otherLocals,
				params: { storeId: (await bodyOf(theirs)).store.id },
				request: jsonRequest({ visibility: 'private' }, 'PATCH')
			});

			// Each member's private names are unique to that member; the two key
			// spaces never meet.
			for (const [locals, expected] of [
				[w.ownerLocals, 1],
				[w.otherLocals, 1]
			] as const) {
				const list = await call(storesRoute.GET, { locals, url: url() });
				const named = (await bodyOf(list)).stores.filter((s: any) => s.name === 'Migros');
				expect(named.length).toBe(expected);
			}
		} finally {
			w.h.close();
		}
	});

	test('a member cannot hold two private shops of the SAME name', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const second = await call(storesRoute.POST, {
				locals: w.ownerLocals,
				request: jsonRequest({ name: 'Migros' })
			});
			// Public at this point, so no clash with their own private one…
			expect(second.status).toBe(201);
			const res = await call(storeRoute.PATCH, {
				locals: w.ownerLocals,
				params: { storeId: (await bodyOf(second)).store.id },
				request: jsonRequest({ visibility: 'private' }, 'PATCH')
			});
			// …until it tries to join that namespace, where the name is taken —
			// by a store this caller CAN see, so the id is safe to hand back.
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.error.code).toBe('STORE_NAME_TAKEN');
			expect(body.storeId).toBe(w.store.id);
		} finally {
			w.h.close();
		}
	});

	test('going public collides with an existing PUBLIC shop of that name', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const theirs = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Migros' })
			});
			expect(theirs.status).toBe(201);

			// The private "Migros" now tries to rejoin the public namespace, where
			// the name has been taken in the meantime.
			const res = await call(storeRoute.PATCH, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ visibility: 'public' }, 'PATCH')
			});
			expect(res.status).toBe(409);
			expect((await bodyOf(res)).error.code).toBe('STORE_NAME_TAKEN');

			// And it is still private, and still theirs — a refused transition
			// leaves the row exactly as it was.
			const still = w.h.db
				.prepare('SELECT private_to FROM stores WHERE id = ?')
				.get(w.store.id) as any;
			expect(still.private_to).toBe(w.owner.id);
		} finally {
			w.h.close();
		}
	});

	test('a control character cannot be used to forge a key namespace', async () => {
		const w = await world();
		try {
			// U+001F is the delimiter between owner and name in a private key. A
			// name carrying one could otherwise be crafted to land in another
			// member's key space.
			const res = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: `${w.owner.id}\u001fMigros` })
			});
			expect(res.status).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
		} finally {
			w.h.close();
		}
	});

	test('…and still carries storeId when the collision is visible', async () => {
		const w = await world();
		try {
			const res = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Migros' })
			});
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.storeId).toBe(w.store.id);
		} finally {
			w.h.close();
		}
	});
});

describe('§8.6 — visibility is a property of the store, not a one-way door', () => {
	test('making it public again restores it to everyone, with its items intact', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			await call(storeRoute.PATCH, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ visibility: 'public' }, 'PATCH')
			});

			const res = await call(listRoute.GET, {
				locals: w.otherLocals,
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(200);
			const body = await bodyOf(res);
			expect(body.store.visibility).toBe('public');
			expect(body.items.map((i: any) => i.name)).toEqual(['Milk']);
		} finally {
			w.h.close();
		}
	});

	test('privatising is scoped to the caller: a second member cannot claim it by patching', async () => {
		const w = await world();
		try {
			// `other` privatises the shared store, which §8.6 permits — any member
			// may privatise any store they can see.
			await call(storeRoute.PATCH, {
				locals: w.otherLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ visibility: 'private' }, 'PATCH')
			});
			// It now belongs to `other`, so the ORIGINAL creator loses it too.
			// That is the documented cost of D-040, and it is asserted rather than
			// assumed so nobody "fixes" it into a creator exemption by accident.
			const res = await call(listRoute.GET, {
				locals: w.ownerLocals,
				params: { storeId: w.store.id }
			});
			expect(res.status).toBe(404);

			const theirs = await call(listRoute.GET, {
				locals: w.otherLocals,
				params: { storeId: w.store.id }
			});
			expect(theirs.status).toBe(200);
		} finally {
			w.h.close();
		}
	});
});

describe('§8.4 — the refusal must be a refusal, not a 404 printed over a completed write', () => {
	/**
	 * The mutation sweep found this gap, and it is worth recording why the
	 * obvious test missed it.
	 *
	 * Removing the visibility check from the top of `updateStore` did NOT change
	 * any status code: the transaction committed the rename, and then the
	 * function's closing `getStoreSummary` — which resolves visibility for its
	 * OWN reasons — threw the same `404 STORE_NOT_FOUND` on the way out. Every
	 * assertion about the response still passed while a member who cannot see a
	 * store was silently renaming it.
	 *
	 * So the assertions below read the DATABASE, not the response. A guard on a
	 * write is only observable through the write it did not perform.
	 */
	const nameOf = (h: Harness, id: string) =>
		(h.db.prepare('SELECT name FROM stores WHERE id = ?').get(id) as any).name;
	const revOf = (h: Harness, id: string) =>
		Number((h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(id) as any).rev);
	const privateToOf = (h: Harness, id: string) =>
		(h.db.prepare('SELECT private_to FROM stores WHERE id = ?').get(id) as any).private_to;

	test('PATCH does not rename a store the caller cannot see', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const before = { name: nameOf(w.h, w.store.id), rev: revOf(w.h, w.store.id) };

			for (const locals of [w.otherLocals, w.adminLocals]) {
				const res = await call(storeRoute.PATCH, {
					locals,
					params: { storeId: w.store.id },
					request: jsonRequest({ name: 'Stolen' }, 'PATCH')
				});
				expect(res.status).toBe(404);
			}

			expect(nameOf(w.h, w.store.id)).toBe(before.name);
			// `rev` is the revalidation cursor every client trusts (R-16). A bump
			// with no visible change would make every phone refetch for nothing —
			// and proves a transaction ran that should not have.
			expect(revOf(w.h, w.store.id)).toBe(before.rev);
		} finally {
			w.h.close();
		}
	});

	test('PATCH cannot take ownership of a store the caller cannot see', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			// The nastiest shape of this: if the guard were missing, `visibility:
			// 'private'` would rewrite `private_to` to the CALLER and hand them
			// somebody else's private store.
			const res = await call(storeRoute.PATCH, {
				locals: w.otherLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ visibility: 'private' }, 'PATCH')
			});
			expect(res.status).toBe(404);
			expect(privateToOf(w.h, w.store.id)).toBe(w.owner.id);
		} finally {
			w.h.close();
		}
	});

	test('POST /items does not add to a store the caller cannot see', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(itemsRoute.POST, {
				locals: w.adminLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ name: 'Smuggled', clientId: randomUUID() })
			});
			expect(res.status).toBe(404);
			const n = Number(
				(w.h.db.prepare('SELECT COUNT(*) AS n FROM items WHERE store_id = ?').get(w.store.id) as any)
					.n
			);
			expect(n).toBe(1);
		} finally {
			w.h.close();
		}
	});

	test('tick does not change an item on a store the caller cannot see', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(tickRoute.POST, {
				locals: w.adminLocals,
				params: { itemId: w.item.id },
				request: jsonRequest({})
			});
			expect(res.status).toBe(404);
			const row = w.h.db.prepare('SELECT state, version FROM items WHERE id = ?').get(w.item.id) as any;
			expect(row.state).toBe('pending');
			expect(Number(row.version)).toBe(1);
		} finally {
			w.h.close();
		}
	});

	test('claim does not write to a trip on a store the caller cannot see', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(claimRoute.POST, {
				locals: w.adminLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ tripId: w.tripId, note: 'mine now' })
			});
			expect(res.status).toBe(404);
			const row = w.h.db
				.prepare('SELECT claimed_by, claimed_at, claim_note FROM trips WHERE id = ?')
				.get(w.tripId) as any;
			expect(row.claimed_by).toBe(null);
			expect(row.claimed_at).toBe(null);
			expect(row.claim_note).toBe(null);
		} finally {
			w.h.close();
		}
	});

	test('close does not finish a trip on a store the caller cannot see', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(closeRoute.POST, {
				locals: w.adminLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ tripId: w.tripId })
			});
			expect(res.status).toBe(404);
			const row = w.h.db.prepare('SELECT status FROM trips WHERE id = ?').get(w.tripId) as any;
			expect(row.status).toBe('open');
		} finally {
			w.h.close();
		}
	});
});

describe('§8.4 — the default-colour palette must not leak either', () => {
	/**
	 * Found by the M6 audit. `defaultColor` picks the first palette key not in
	 * use by an active store, and originally read every store in the table. That
	 * is a good oracle: create a store with no colour, and the key you are given
	 * tells you which keys are taken by stores you cannot see. Past the eighth it
	 * leaks the COUNT of them outright.
	 *
	 * The stated cost of filtering — two members' palettes drifting apart — is
	 * not a cost for a feature whose whole purpose is that they see different
	 * worlds.
	 */
	test("a private store does not consume a colour from anybody else's palette", async () => {
		const w = await world();
		try {
			// The owner's only store takes 'terracotta' (the first key), then goes
			// private.
			expect(w.store.color).toBe('terracotta');
			await makePrivate(w);

			// From the other member's side the palette is untouched, so their first
			// store gets the FIRST key — not the second.
			const res = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Their shop' })
			});
			expect(res.status).toBe(201);
			expect((await bodyOf(res)).store.color).toBe('terracotta');
		} finally {
			w.h.close();
		}
	});

	test('and an admin gets the same untouched palette', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			const res = await call(storesRoute.POST, {
				locals: w.adminLocals,
				request: jsonRequest({ name: 'Admin shop' })
			});
			expect((await bodyOf(res)).store.color).toBe('terracotta');
		} finally {
			w.h.close();
		}
	});

	test('a visible store DOES consume one, so the filter is not just "always first"', async () => {
		const w = await world();
		try {
			// Public this time: the other member can see it, so it takes a key out
			// of their palette and they get the second.
			const res = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Their shop' })
			});
			expect((await bodyOf(res)).store.color).not.toBe('terracotta');
		} finally {
			w.h.close();
		}
	});
});

describe('R-22 — the defence behind the namespace', () => {
	/**
	 * §8.4a makes an invisible name collision **unreachable**: a private store's
	 * key lives under its owner's namespace, so no other member's lookup can
	 * land on it. `throwNameTaken` still refuses to hand back the id when the
	 * row it found is invisible, and this test is the only way to reach that
	 * branch — by writing a row the application itself cannot produce.
	 *
	 * The codebase's precedent for an unreachable guard is `requireSessionId`
	 * (guards.ts), which is kept with a comment explaining that a test would
	 * only assert an impossible input. This one is different in a way that
	 * earns the test: the impossible input is one statement away, and what the
	 * guard prevents if the key scheme ever regresses is a private store's id in
	 * a response. A comment cannot fail; this can.
	 */
	test('a hand-forged unscoped key on a private store still does not leak its id', async () => {
		const w = await world();
		try {
			await makePrivate(w);
			// The regression this stands in for: `scopedNameKey` losing its
			// namespace, so a private store sits in the public key space again.
			w.h.db.prepare('UPDATE stores SET name_key = ? WHERE id = ?').run('migros', w.store.id);

			const res = await call(storesRoute.POST, {
				locals: w.otherLocals,
				request: jsonRequest({ name: 'Migros' })
			});
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.error.code).toBe('STORE_NAME_TAKEN');
			// The sibling field is the leak: a usable id for a store this caller
			// must not know exists.
			expect(Object.hasOwn(body, 'storeId')).toBe(false);
		} finally {
			w.h.close();
		}
	});
});
