/** Recent-item suggestions — CONTRACT.md §12.1. */
import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { harness, localsFor, makeUser, bodyOf, type Harness } from './_support';
import { setDb } from '$lib/server/db';
import { addItem, deleteItem, recentItemSuggestions, tickItem } from '$lib/server/domain/items';
import { createStore, updateStore, type Actor } from '$lib/server/domain/stores';
import { closeTrip } from '$lib/server/domain/trips';
import * as suggestionsRoute from '../../src/routes/api/stores/[storeId]/suggestions/+server';

afterEach(() => setDb(null));

function world() {
	const h = harness();
	setDb(h.db);
	const user = makeUser(h.db, 'ayse', 'Ayşe');
	const actor: Actor = { id: user.id };
	const store = createStore(h.db, { name: 'Migros' }, actor);
	return { h, user, actor, store };
}

const add = (h: Harness, storeId: string, actor: Actor, name: string) =>
	addItem(h.db, storeId, { name, clientId: randomUUID() }, actor).item;

function close(h: Harness, storeId: string, actor: Actor) {
	const tripId = (
		h.db.prepare("SELECT id FROM trips WHERE store_id = ? AND status = 'open'").get(storeId) as {
			id: string;
		}
	).id;
	closeTrip(h.db, storeId, { tripId }, actor);
}

describe('recentItemSuggestions', () => {
	test('returns distinct bought names, newest first', () => {
		const w = world();
		try {
			const milk = add(w.h, w.store.id, w.actor, 'Milk');
			tickItem(w.h.db, milk.id, w.actor);
			w.h.db.prepare('UPDATE items SET ticked_at = 10 WHERE id = ?').run(milk.id);
			close(w.h, w.store.id, w.actor);

			const bread = add(w.h, w.store.id, w.actor, 'Bread');
			tickItem(w.h.db, bread.id, w.actor);
			w.h.db.prepare('UPDATE items SET ticked_at = 20 WHERE id = ?').run(bread.id);
			close(w.h, w.store.id, w.actor);

			expect(recentItemSuggestions(w.h.db, w.store.id, w.actor, 8)).toEqual(['Bread', 'Milk']);
		} finally {
			w.h.close();
		}
	});

	test('Unicode-folds duplicates and lets the newest spelling win', () => {
		const w = world();
		try {
			const old = add(w.h, w.store.id, w.actor, '  TAM  SÜT  ');
			tickItem(w.h.db, old.id, w.actor);
			w.h.db.prepare('UPDATE items SET ticked_at = 10 WHERE id = ?').run(old.id);
			close(w.h, w.store.id, w.actor);
			const recent = add(w.h, w.store.id, w.actor, 'Tam süt');
			tickItem(w.h.db, recent.id, w.actor);
			w.h.db.prepare('UPDATE items SET ticked_at = 20 WHERE id = ?').run(recent.id);
			close(w.h, w.store.id, w.actor);

			expect(recentItemSuggestions(w.h.db, w.store.id, w.actor)).toEqual(['Tam süt']);
		} finally {
			w.h.close();
		}
	});

	test('excludes names already active, unticked history, and deleted items', () => {
		const w = world();
		try {
			const milk = add(w.h, w.store.id, w.actor, 'Milk');
			tickItem(w.h.db, milk.id, w.actor);
			close(w.h, w.store.id, w.actor);
			add(w.h, w.store.id, w.actor, '  milk '); // active duplicate excludes history

			const deleted = add(w.h, w.store.id, w.actor, 'Bread');
			tickItem(w.h.db, deleted.id, w.actor);
			deleteItem(w.h.db, deleted.id, w.actor);
			add(w.h, w.store.id, w.actor, 'Never bought');
			close(w.h, w.store.id, w.actor);
			const carriedClone = w.h.db
				.prepare(
					`SELECT id
					   FROM items
					  WHERE store_id = ? AND name = 'Never bought' AND state = 'pending'`
				)
				.get(w.store.id) as { id: string };
			deleteItem(w.h.db, carriedClone.id, w.actor); // carried history alone is not a purchase

			expect(recentItemSuggestions(w.h.db, w.store.id, w.actor)).toEqual([]);
		} finally {
			w.h.close();
		}
	});

	test('validates the limit instead of silently clamping it', () => {
		const w = world();
		try {
			for (const bad of [0, 21, 1.5, NaN, '8']) {
				expect(() => recentItemSuggestions(w.h.db, w.store.id, w.actor, bad)).toThrow();
			}
		} finally {
			w.h.close();
		}
	});

	test('the route resolves private-store visibility before returning history', async () => {
		const w = world();
		try {
			const other = makeUser(w.h.db, 'baba', 'Baba');
			updateStore(w.h.db, w.store.id, { visibility: 'private' }, w.actor);
			const response = await suggestionsRoute.GET({
				locals: localsFor(other),
				params: { storeId: w.store.id },
				url: new URL('http://localhost/api/stores/x/suggestions')
			} as any);
			expect(response.status).toBe(404);
			expect((await bodyOf(response)).error).toEqual({
				code: 'STORE_NOT_FOUND',
				message: 'Store not found.'
			});
		} finally {
			w.h.close();
		}
	});

	test('the route requires a session', async () => {
		const w = world();
		try {
			const response = await suggestionsRoute.GET({
				locals: localsFor(null),
				params: { storeId: w.store.id },
				url: new URL('http://localhost/api/stores/x/suggestions')
			} as any);
			expect(response.status).toBe(401);
		} finally {
			w.h.close();
		}
	});
});
