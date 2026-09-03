/**
 * Who may change a store's visibility — CONTRACT.md §8.4a.
 *
 * §8.4 says who may SEE a store. This file is about the different, and until
 * now missing, question of who may decide who sees it. Every member who could
 * see a shop could privatise it, which took a shared family list away from
 * everyone else — permanently, since D-040 gives the losers no way back — in one
 * tap on a sheet that anybody could open.
 *
 * The rule: the member named by `stores.created_by`, or an admin. Nothing else,
 * and NOT "any member who can see it".
 *
 * Every refusal here is asserted twice: once on the response, and once by
 * reading the row back. PROJECT.md §11 records why — the M6 sweep removed the
 * visibility check from `updateStore` and no status code changed, because the
 * transaction committed and the closing `getStoreSummary` threw the same 404 on
 * the way out. A guard on a write is only observable through the write it did
 * not perform.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { bodyOf, harness, jsonRequest, localsFor, makeUser } from './_support';
import { setDb } from '$lib/server/db';
import { resetBus } from '$lib/server/realtime/bus';

import * as storesRoute from '../../src/routes/api/stores/+server';
import * as storeRoute from '../../src/routes/api/stores/[storeId]/+server';

afterEach(() => {
	setDb(null);
	resetBus();
});

const call = (fn: any, args: any) => fn(args) as Promise<Response>;
const url = (path = 'http://localhost/api/stores') => new URL(path);

async function world() {
	const h = harness();
	setDb(h.db);

	const creator = makeUser(h.db, 'ayse', 'Ayşe');
	const other = makeUser(h.db, 'baba', 'Baba');
	const admin = makeUser(h.db, 'root', 'Root');

	const creatorLocals = localsFor(creator);
	const otherLocals = localsFor(other, 'session-2');
	const adminLocals = localsFor(admin, 'session-3', { isAdmin: true });

	const created = await call(storesRoute.POST, {
		locals: creatorLocals,
		request: jsonRequest({ name: 'Migros' })
	});
	const store = (await bodyOf(created)).store;

	const row = () => h.db.prepare('SELECT * FROM stores WHERE id = ?').get(store.id) as any;

	return { h, creator, other, admin, creatorLocals, otherLocals, adminLocals, store, row };
}

const patch = (locals: any, storeId: string, body: unknown) =>
	call(storeRoute.PATCH, {
		locals,
		params: { storeId },
		request: jsonRequest(body, 'PATCH')
	});

describe('§8.4a — only the creator or an admin changes visibility', () => {
	test('the creator may, in both directions', async () => {
		const w = await world();
		try {
			const priv = await patch(w.creatorLocals, w.store.id, { visibility: 'private' });
			expect(priv.status).toBe(200);
			expect((await bodyOf(priv)).store.visibility).toBe('private');
			expect(w.row().private_to).toBe(w.creator.id);

			const pub = await patch(w.creatorLocals, w.store.id, { visibility: 'public' });
			expect(pub.status).toBe(200);
			expect((await bodyOf(pub)).store.visibility).toBe('public');
			expect(w.row().private_to).toBe(null);
		} finally {
			w.h.close();
		}
	});

	test('an admin may, on a store it can see', async () => {
		const w = await world();
		try {
			const res = await patch(w.adminLocals, w.store.id, { visibility: 'private' });
			expect(res.status).toBe(200);
			// 'private' has always meant "private to the CALLER" (§8.6). An admin
			// using it takes the store, it does not hold it on the creator's behalf
			// — there is no request field naming an owner, at any privilege level.
			expect(w.row().private_to).toBe(w.admin.id);
		} finally {
			w.h.close();
		}
	});

	test('a member who can see the store but did not create it is refused, and nothing is written', async () => {
		const w = await world();
		try {
			const before = w.row();
			const res = await patch(w.otherLocals, w.store.id, { visibility: 'private' });
			expect(res.status).toBe(403);
			expect((await bodyOf(res)).error.code).toBe('FORBIDDEN');

			const after = w.row();
			expect(after.private_to).toBe(null);
			// R-16: a refused PATCH is not a write, so the revalidation cursor must
			// not move either — a bumped rev would send every client refetching a
			// store that did not change.
			expect(after.rev).toBe(before.rev);
		} finally {
			w.h.close();
		}
	});

	test('the refusal takes the WHOLE patch with it, including the fields that were allowed', async () => {
		const w = await world();
		try {
			// Renaming is open to anybody who can see the store; changing who sees
			// it is not. A patch carrying both is one transaction, and it is the
			// refusal that has to win — a partial apply would let a bystander
			// rename a shop by attaching a visibility field it knew would fail.
			const res = await patch(w.otherLocals, w.store.id, {
				name: 'Not Migros',
				color: 'green',
				visibility: 'private'
			});
			expect(res.status).toBe(403);

			const after = w.row();
			expect(after.name).toBe('Migros');
			expect(after.color).toBe(w.store.color);
			expect(after.private_to).toBe(null);
			// Migration 003 scopes `name_key` by the owner, so a half-applied patch
			// is not just a stray rename — it is a store whose key disagrees with
			// its visibility.
			expect(after.name_key).toBe('migros');
		} finally {
			w.h.close();
		}
	});

	test('everything else on the endpoint is still open to any member who can see the store', async () => {
		const w = await world();
		try {
			const res = await patch(w.otherLocals, w.store.id, { name: 'Migros Sarıyer' });
			expect(res.status).toBe(200);
			expect(w.row().name).toBe('Migros Sarıyer');

			const archived = await patch(w.otherLocals, w.store.id, { archived: true });
			expect(archived.status).toBe(200);
			expect(w.row().archived_at).not.toBe(null);
		} finally {
			w.h.close();
		}
	});

	test('an invisible store still 404s rather than 403s, for the caller who could otherwise change it', async () => {
		const w = await world();
		try {
			// The creator privatises. The admin is now the caller §8.4a would allow
			// and §8.4 forbids, and §8.4 has to win: a 403 here would confirm that
			// a store with that id exists and belongs to somebody.
			expect((await patch(w.creatorLocals, w.store.id, { visibility: 'private' })).status).toBe(
				200
			);

			const res = await patch(w.adminLocals, w.store.id, { visibility: 'public' });
			expect(res.status).toBe(404);
			const body = await bodyOf(res);
			expect(body).toEqual({ error: { code: 'STORE_NOT_FOUND', message: 'Store not found.' } });
			expect(w.row().private_to).toBe(w.creator.id);
		} finally {
			w.h.close();
		}
	});

	test('a store whose creator was deleted is admin-only, not everybody`s', async () => {
		const w = await world();
		try {
			// `stores.created_by` is ON DELETE SET NULL. A null creator matches no
			// actor id, so the shop does not silently become open to the family.
			w.h.db.prepare('UPDATE stores SET created_by = NULL WHERE id = ?').run(w.store.id);

			expect((await patch(w.otherLocals, w.store.id, { visibility: 'private' })).status).toBe(403);
			expect((await patch(w.creatorLocals, w.store.id, { visibility: 'private' })).status).toBe(
				403
			);
			expect(w.row().private_to).toBe(null);

			expect((await patch(w.adminLocals, w.store.id, { visibility: 'private' })).status).toBe(200);
			expect(w.row().private_to).toBe(w.admin.id);
		} finally {
			w.h.close();
		}
	});
});

describe('§8.4a — `canChangeVisibility` tells the client the same thing the server enforces', () => {
	test('is true for the creator and for an admin, false for a bystander', async () => {
		const w = await world();
		try {
			const listFor = async (locals: any) =>
				(await bodyOf(await call(storesRoute.GET, { locals, url: url() }))).stores[0];

			expect((await listFor(w.creatorLocals)).canChangeVisibility).toBe(true);
			expect((await listFor(w.adminLocals)).canChangeVisibility).toBe(true);
			expect((await listFor(w.otherLocals)).canChangeVisibility).toBe(false);
		} finally {
			w.h.close();
		}
	});

	test('never carries the creator`s user id with it', async () => {
		const w = await world();
		try {
			const res = await call(storesRoute.GET, { locals: w.otherLocals, url: url() });
			const text = await res.text();
			// §3: no endpoint hands a user id to a non-admin. A `createdById` field
			// would make every shop a record of who created it.
			expect(text).not.toContain(w.creator.id);
			expect(text).not.toContain(w.other.id);
		} finally {
			w.h.close();
		}
	});
});
