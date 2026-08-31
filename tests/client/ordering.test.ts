/**
 * R-13, client-side. The optimistic tick reorders the list locally, so this
 * comparator has to produce the same total order the server's ORDER BY does —
 * if it does not, a row jumps the moment the real list arrives, which looks
 * exactly like the app having lost the tap.
 */
import { describe, expect, it } from 'vitest';
import { sortItems } from '$lib/client/app.svelte';
import type { Item } from '$lib/types';

const item = (over: Partial<Item>): Item => ({
	id: 'a',
	tripId: 't',
	storeId: 's',
	name: 'x',
	note: null,
	state: 'pending',
	sortOrder: 1000,
	tickedAt: null,
	tickedByName: null,
	carryCount: 0,
	version: 1,
	createdAt: 1,
	createdByName: null,
	...over
});

const ids = (items: Item[]) => sortItems(items).map((i) => i.id);

describe('sortItems', () => {
	it('puts pending before ticked, whatever their sortOrder', () => {
		expect(
			ids([
				item({ id: 'ticked', state: 'ticked', tickedAt: 5, sortOrder: 0 }),
				item({ id: 'pending', sortOrder: 9000 })
			])
		).toEqual(['pending', 'ticked']);
	});

	it('orders pending by sortOrder, then createdAt, then id', () => {
		// The ids run BACKWARDS against createdAt on purpose. With them in
		// agreement the id tiebreak alone produces the same answer, and the
		// createdAt comparison could be deleted without a single test noticing.
		expect(
			ids([
				item({ id: 'c', sortOrder: 2000 }),
				item({ id: 'a', sortOrder: 1000, createdAt: 20 }),
				item({ id: 'z', sortOrder: 1000, createdAt: 10 })
			])
		).toEqual(['z', 'a', 'c']);
	});

	it('breaks a full tie by id, so nothing reshuffles between refetches', () => {
		const tied = [
			item({ id: 'z', sortOrder: 1000, createdAt: 1 }),
			item({ id: 'a', sortOrder: 1000, createdAt: 1 }),
			item({ id: 'm', sortOrder: 1000, createdAt: 1 })
		];
		expect(ids(tied)).toEqual(['a', 'm', 'z']);
		// The same input arriving in a different order must give the same output.
		expect(ids([...tied].reverse())).toEqual(['a', 'm', 'z']);
	});

	it('puts the most recently ticked at the TOP of the ticked group', () => {
		// Undo has to stay reachable near the divider — that is why this half of
		// the order is DESC while the other half is ASC.
		expect(
			ids([
				item({ id: 'old', state: 'ticked', tickedAt: 10 }),
				item({ id: 'new', state: 'ticked', tickedAt: 30 }),
				item({ id: 'mid', state: 'ticked', tickedAt: 20 })
			])
		).toEqual(['new', 'mid', 'old']);
	});

	it('breaks a same-millisecond tick tie by id', () => {
		const tied = [
			item({ id: 'z', state: 'ticked', tickedAt: 10 }),
			item({ id: 'a', state: 'ticked', tickedAt: 10 })
		];
		expect(ids(tied)).toEqual(['a', 'z']);
		expect(ids([...tied].reverse())).toEqual(['a', 'z']);
	});

	it('does not mutate its input', () => {
		const items = [item({ id: 'b', sortOrder: 2000 }), item({ id: 'a', sortOrder: 1000 })];
		sortItems(items);
		expect(items.map((i) => i.id)).toEqual(['b', 'a']);
	});
});
