/**
 * `ListState` — the client's copy of one store's open list.
 *
 * This had no test of any kind. It holds the only optimistic write in the app,
 * §4's revision cursor, and the guard that decides which of two overlapping
 * `/list` responses wins — and an audit found two reproduced defects in it that
 * 360 green tests could not see. Everything here is a case a bad connection
 * produces and a happy-path browser test does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ListState, forgetLists, shops } from '$lib/client/app.svelte';
import type { Item, StoreSummary, Trip } from '$lib/types';

const STORE_ID = 'store-1';

const store = (rev: number): StoreSummary => ({
	id: STORE_ID,
	name: 'Migros',
	color: 'terracotta',
	sortOrder: 1000,
	rev,
	openTripId: 'trip-1',
	pendingCount: 0,
	tickedCount: 0,
	lastClosedTripAt: null,
	archivedAt: null,
	visibility: 'public',
	canChangeVisibility: true,
	claimedByName: null,
	claimedByMe: false,
	claimedAt: null,
	claimNote: null
});

const trip: Trip = {
	id: 'trip-1',
	storeId: STORE_ID,
	seq: 1,
	status: 'open',
	openedAt: 1,
	closedAt: null,
	closedByName: null,
	claimedByName: null,
	claimedByMe: false,
	claimedAt: null,
	claimNote: null
};

const item = (over: Partial<Item> & { id: string }): Item => ({
	tripId: 'trip-1',
	storeId: STORE_ID,
	name: over.id,
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

const payload = (rev: number, items: Item[]) => ({ store: store(rev), trip, items });

/** A `fetch` that answers from a queue, so a test can control what each call
 *  returns and — crucially — the order in which they resolve. */
function stubFetch() {
	const pending: Array<{ resolve: (value: unknown) => void; url: string }> = [];
	const fn = vi.fn((input: string | URL) => {
		return new Promise<Response>((resolve) => {
			pending.push({
				url: String(input),
				resolve: (value) =>
					resolve(
						new Response(JSON.stringify(value), {
							status: 200,
							headers: { 'content-type': 'application/json' }
						})
					)
			});
		});
	});
	globalThis.fetch = fn as unknown as typeof globalThis.fetch;
	return {
		fn,
		pending,
		/** Resolves the nth outstanding request (0-based, in issue order). */
		settle(index: number, value: unknown) {
			pending[index].resolve(value);
		}
	};
}

const realFetch = globalThis.fetch;
let net: ReturnType<typeof stubFetch>;

beforeEach(() => {
	net = stubFetch();
});

afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

/** Lets every already-resolved promise settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('seed', () => {
	it('refuses a payload older than what it already holds', () => {
		const list = new ListState(STORE_ID);
		expect(list.seed(payload(5, [item({ id: 'a' })]))).toBe(true);
		expect(list.rev).toBe(5);

		// The page load handing back a stale snapshot must not undo a newer one.
		expect(list.seed(payload(4, [item({ id: 'b' })]))).toBe(false);
		expect(list.items.map((i) => i.id)).toEqual(['a']);
		expect(list.rev).toBe(5);

		expect(list.seed(payload(6, [item({ id: 'c' })]))).toBe(true);
		expect(list.items.map((i) => i.id)).toEqual(['c']);
	});

	it('accepts the first payload whatever its rev', () => {
		const list = new ListState(STORE_ID);
		expect(list.seed(payload(0, [item({ id: 'a' })]))).toBe(true);
	});

	it('keeps a row whose write is still in flight', async () => {
		const list = new ListState(STORE_ID);
		list.seed(payload(1, [item({ id: 'a' })]));

		void list.tick(list.items[0]);
		await flush();
		expect(list.busy.has('a')).toBe(true);
		expect(list.items[0].state).toBe('ticked');

		// A refetch landing mid-tick must not revert the checkbox: the server's
		// answer for that row is already on its way.
		list.seed(payload(2, [item({ id: 'a' })]));
		expect(list.items[0].state).toBe('ticked');
	});
});

describe('load — overlapping responses', () => {
	it('discards an older response that arrives last', async () => {
		const list = new ListState(STORE_ID);
		list.seed(payload(1, [item({ id: 'a' })]));

		void list.load(); // request #0
		void list.load(); // request #1, the newer one
		await flush();
		expect(net.pending).toHaveLength(2);

		// The newer request answers first, then the older one arrives late — the
		// exact ordering that used to un-tick an item the server had accepted.
		net.settle(1, payload(9, [item({ id: 'new' })]));
		await flush();
		net.settle(0, payload(3, [item({ id: 'stale' })]));
		await flush();

		expect(list.items.map((i) => i.id)).toEqual(['new']);
		// And the cursor did not go backwards, which is what would have made the
		// next real event look like our own echo.
		expect(list.rev).toBe(9);
	});
});

describe('the §4 cursor', () => {
	it('skips a refetch for a rev it already has, and takes one for a newer', async () => {
		const list = new ListState(STORE_ID);
		list.seed(payload(7, []));

		await list.onStoreChanged(7);
		await list.onStoreChanged(6);
		expect(net.fn).not.toHaveBeenCalled();

		void list.onStoreChanged(8);
		await flush();
		expect(net.fn).toHaveBeenCalledTimes(1);
	});

	it('refetches when its own write jumped the cursor past somebody else', async () => {
		// §3.5's `rev` proves OUR write landed; it does not prove we have seen
		// everything before it. Adopting a rev two ahead would make the other
		// member's `store.changed` — carrying the lower rev — look like our echo.
		const list = new ListState(STORE_ID);
		list.seed(payload(5, [item({ id: 'a' })]));

		void list.tick(list.items[0]);
		await flush();
		net.settle(0, { item: item({ id: 'a', state: 'ticked', tickedAt: 2 }), rev: 7 });
		await flush();

		expect(list.rev).toBe(7);
		// One extra /list fetch, rather than silently dropping rev 6.
		const listFetches = net.fn.mock.calls.filter((c) => String(c[0]).endsWith('/list'));
		expect(listFetches).toHaveLength(1);
	});

	it('does not refetch when the write moved the cursor by exactly one', async () => {
		const list = new ListState(STORE_ID);
		list.seed(payload(5, [item({ id: 'a' })]));

		void list.tick(list.items[0]);
		await flush();
		net.settle(0, { item: item({ id: 'a', state: 'ticked', tickedAt: 2 }), rev: 6 });
		await flush();

		expect(list.rev).toBe(6);
		expect(net.fn.mock.calls.filter((c) => String(c[0]).endsWith('/list'))).toHaveLength(0);
	});
});

describe('optimistic tick', () => {
	it('applies immediately and adopts the server item wholesale', async () => {
		const list = new ListState(STORE_ID);
		list.seed(payload(1, [item({ id: 'a', version: 1 })]));

		void list.tick(list.items[0]);
		await flush();
		expect(list.items[0].state).toBe('ticked');

		net.settle(0, { item: item({ id: 'a', state: 'ticked', tickedAt: 9, version: 2 }), rev: 2 });
		await flush();
		// §7: the client must adopt the returned version, or the next edit gets a
		// spurious VERSION_CONFLICT.
		expect(list.items[0].version).toBe(2);
		expect(list.busy.size).toBe(0);
	});

	it('ignores a second tap while the first is in flight', async () => {
		const list = new ListState(STORE_ID);
		list.seed(payload(1, [item({ id: 'a' })]));

		void list.tick(list.items[0]);
		await flush();
		void list.tick(list.items[0]);
		await flush();

		expect(net.fn).toHaveBeenCalledTimes(1);
	});

	it('reverts only its own row, rebased onto whatever arrived meanwhile', async () => {
		// Restoring a snapshot taken before the request would also roll back any
		// refetch that landed while we waited — a failed tick on a bad connection
		// eating another member's freshly-arrived row.
		let rejectTick: (reason: unknown) => void = () => {};
		globalThis.fetch = vi.fn(
			() => new Promise<Response>((_, reject) => (rejectTick = reject))
		) as unknown as typeof globalThis.fetch;

		const list = new ListState(STORE_ID);
		list.seed(payload(1, [item({ id: 'a', sortOrder: 1000 })]));

		void list.tick(list.items[0]);
		await flush();
		expect(list.busy.has('a')).toBe(true);

		// Another member's row arrives while the tick is still in flight.
		list.seed(payload(2, [item({ id: 'a', sortOrder: 1000 }), item({ id: 'b', sortOrder: 2000 })]));
		expect(list.items.map((i) => i.id).sort()).toEqual(['a', 'b']);
		// 'a' keeps its optimistic tick, so it sits below 'b' for now.
		expect(list.items.find((i) => i.id === 'a')?.state).toBe('ticked');

		rejectTick(new TypeError('offline'));
		await flush();
		await flush();

		// 'a' is back to pending and above 'b'; 'b' survived the failure.
		expect(list.items.map((i) => i.id)).toEqual(['a', 'b']);
		expect(list.items[0].state).toBe('pending');
		expect(list.error).toBeTruthy();
		expect(list.busy.size).toBe(0);
	});
});

describe('forgetLists', () => {
	it('clears the home screen too, not only the cached lists', () => {
		shops.seed([store(1)]);
		expect(shops.loaded).toBe(true);

		forgetLists();

		// The next person to sign in on this device must not see a frame of the
		// previous one's shopping.
		expect(shops.stores).toEqual([]);
		expect(shops.loaded).toBe(false);
	});
});
