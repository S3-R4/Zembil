/**
 * Client state — CONTRACT.md §3.4, §3.5, §4.
 *
 * Two reactive singletons: `shops` (the home screen) and a per-store `ListState`
 * cache. Both are refetch-driven, because §4's realtime events are hints and
 * never carry data. The only thing that is ever applied locally before the
 * server agrees is a tick or an untick — see `tick()` below for why that one
 * is worth the complexity and the others are not.
 */
import type { Item, ItemMutation, StoreSummary, Trip } from '$lib/types';
import { ApiError, OfflineError, api } from './api';

/** R-13, applied client-side so an optimistic tick lands in the right place
 *  without waiting for a refetch. Must match the server's ORDER BY exactly, or
 *  a row jumps when the real list arrives. */
export function sortItems(items: Item[]): Item[] {
	return [...items].sort((a, b) => {
		const aTicked = a.state === 'ticked';
		const bTicked = b.state === 'ticked';
		// Ticked items sort below ALL pending items.
		if (aTicked !== bTicked) return aTicked ? 1 : -1;
		if (aTicked) {
			// Most recently ticked at the top of the ticked group, so undo is always
			// reachable near the divider.
			const byTicked = (b.tickedAt ?? 0) - (a.tickedAt ?? 0);
			if (byTicked !== 0) return byTicked;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		}
		if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
		if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
		// The id tiebreak is mandatory: without a total order two rows sharing a
		// key render in whatever order they arrive, and the list visibly
		// reshuffles between refetches.
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

export function messageOf(err: unknown): string {
	if (err instanceof ApiError) return err.message;
	if (err instanceof OfflineError) return 'No signal.';
	return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------

export class Shops {
	stores = $state<StoreSummary[]>([]);
	loading = $state(false);
	error = $state<string | null>(null);
	loaded = $state(false);
	/** §9.1: the receipt for the last store this session deleted, so the screen
	 *  the member lands on afterwards can say what went. Read once and cleared
	 *  by whoever shows it. */
	lastDeleted = $state<StoreDeletion | null>(null);

	seed(stores: StoreSummary[]): void {
		this.stores = stores;
		this.loaded = true;
		this.error = null;
	}

	async load(): Promise<void> {
		this.loading = true;
		try {
			const body = await api<{ stores: StoreSummary[] }>('/api/stores');
			this.stores = body.stores;
			this.loaded = true;
			this.error = null;
		} catch (err) {
			this.error = messageOf(err);
		} finally {
			this.loading = false;
		}
	}

	/** §4: skip the refetch when this store's rev is one we already have. */
	revOf(storeId: string): number {
		return this.stores.find((s) => s.id === storeId)?.rev ?? -1;
	}

	async create(name: string, color?: string): Promise<StoreSummary> {
		const body = await api<{ store: StoreSummary }>('/api/stores', {
			method: 'POST',
			body: color ? { name, color } : { name }
		});
		await this.load();
		return body.store;
	}

	/**
	 * §8.4 / R-14: the archived listing. Not folded into `stores`, because the
	 * home screen must not show archived shops and this is the ONLY way an
	 * archived store's id is reachable — R-14's un-archive promise depends on it.
	 */
	async loadArchived(): Promise<StoreSummary[]> {
		const body = await api<{ stores: StoreSummary[] }>('/api/stores?includeArchived=true');
		return body.stores.filter((s) => s.archivedAt !== null);
	}

	/** `PATCH /api/stores/{id}` — name, colour, sortOrder, archived, visibility. */
	async patch(storeId: string, patch: StorePatch): Promise<StoreSummary> {
		const body = await api<{ store: StoreSummary }>(
			`/api/stores/${encodeURIComponent(storeId)}`,
			{ method: 'PATCH', body: patch }
		);
		await this.load();
		return body.store;
	}

	/**
	 * `DELETE /api/stores/{id}` — §9.1 / R-23. Permanent: the store, its trips
	 * and every item on them. Returns what went, so the screen can say it.
	 */
	async remove(storeId: string): Promise<StoreDeletion> {
		const body = await api<{ deleted: StoreDeletion }>(
			`/api/stores/${encodeURIComponent(storeId)}`,
			{ method: 'DELETE' }
		);
		this.lastDeleted = body.deleted;
		await this.load();
		return body.deleted;
	}
}

/** §9.1: what `DELETE /api/stores/{id}` reports it destroyed. */
export interface StoreDeletion {
	storeId: string;
	name: string;
	trips: number;
	items: number;
}

/** The five fields §8.6 makes patchable. `visibility` is the M6 addition. */
export interface StorePatch {
	name?: string;
	color?: string;
	sortOrder?: number;
	archived?: boolean;
	visibility?: 'public' | 'private';
}

export const shops = new Shops();

// ---------------------------------------------------------------------------

export class ListState {
	readonly storeId: string;
	store = $state<StoreSummary | null>(null);
	trip = $state<Trip | null>(null);
	items = $state<Item[]>([]);
	error = $state<string | null>(null);
	loading = $state(false);
	loaded = $state(false);
	/** §4's cursor. The rev we last saw, so an echo of our own write does not
	 *  cost a second full fetch. */
	rev = $state(-1);
	/** Item ids with a write in flight, so a row can show it and a second tap
	 *  cannot start a competing request. */
	busy = $state<Set<string>>(new Set());
	/**
	 * Increments on every fetch. A response whose generation is no longer the
	 * current one is discarded — two `/list` requests can overtake each other on
	 * a flaky link, and without this the OLDER answer wins simply by arriving
	 * last: it overwrites the items AND drags `rev` backwards, so a tick the
	 * server accepted is silently un-ticked on screen and its own echo has
	 * already been spent.
	 */
	private generation = 0;

	constructor(storeId: string) {
		this.storeId = storeId;
	}

	get pending(): Item[] {
		return this.items.filter((i) => i.state === 'pending');
	}

	get ticked(): Item[] {
		return this.items.filter((i) => i.state === 'ticked');
	}

	/**
	 * Adopts a `/list` payload. Refuses one that is older than what we already
	 * have, which is what lets both the page load and a realtime refetch call it
	 * unconditionally: whichever is newer wins, and neither has to know about the
	 * other.
	 */
	seed(data: { store: StoreSummary; trip: Trip; items: Item[] }): boolean {
		if (this.loaded && data.store.rev < this.rev) return false;

		// A row with a write in flight keeps its optimistic state. The server's
		// answer for that row is on its way and will replace it; letting a refetch
		// that landed first revert the checkbox would show a flicker nobody asked
		// for, on the one action a member performs several times a minute.
		const inFlight = new Map(
			this.items.filter((i) => this.busy.has(i.id)).map((i) => [i.id, i])
		);

		this.store = data.store;
		this.trip = data.trip;
		this.items = sortItems(data.items.map((i) => inFlight.get(i.id) ?? i));
		this.rev = data.store.rev;
		this.loaded = true;
		this.error = null;
		return true;
	}

	async load(): Promise<void> {
		const mine = ++this.generation;
		this.loading = true;
		try {
			const body = await api<{ store: StoreSummary; trip: Trip; items: Item[] }>(
				`/api/stores/${encodeURIComponent(this.storeId)}/list`
			);
			// Superseded while we were waiting. Dropping it is the whole point.
			if (mine !== this.generation) return;
			this.seed(body);
		} catch (err) {
			if (mine !== this.generation) return;
			this.error = messageOf(err);
		} finally {
			if (mine === this.generation) this.loading = false;
		}
	}

	/** §4: a hint whose rev we already have is not worth a fetch. */
	async onStoreChanged(rev: number): Promise<void> {
		if (rev <= this.rev) return;
		await this.load();
	}

	private setBusy(id: string, value: boolean): void {
		const next = new Set(this.busy);
		if (value) next.add(id);
		else next.delete(id);
		this.busy = next;
	}

	private applyMutation(result: ItemMutation): void {
		// §3.5's `rev` proves our own write landed; it does NOT prove we have seen
		// everything before it. If it is more than one ahead of our cursor,
		// somebody else committed in between and their `store.changed` — which
		// carries the lower rev — would now be suppressed by the §4 cursor as if
		// it were our own echo. Refetch instead of dropping their item.
		const skipped = this.loaded && result.rev > this.rev + 1;

		this.rev = Math.max(this.rev, result.rev);
		const index = this.items.findIndex((i) => i.id === result.item.id);
		const next = [...this.items];
		if (index === -1) next.push(result.item);
		else next[index] = result.item;
		this.items = sortItems(next.filter((i) => i.state !== 'carried'));
		if (this.store) this.store = { ...this.store, rev: this.rev };

		if (skipped) void this.load();
	}

	/**
	 * The one optimistic write. Ticking is the action a member performs standing
	 * in an aisle on a bad connection, several times a minute, and a 300ms wait
	 * per tap is the difference between the app feeling like a list and feeling
	 * like a form. Adding is not optimistic: an added row that later vanishes is
	 * far more alarming than a checkbox that flicks back, and the add sheet stays
	 * open anyway so the latency is hidden.
	 *
	 * The server's response replaces the guess wholesale, including `version` —
	 * §7 warns that a client keeping its pre-tick version gets a spurious
	 * VERSION_CONFLICT the next time it opens the edit sheet.
	 */
	async tick(item: Item): Promise<void> {
		await this.toggle(item, 'tick');
	}

	async untick(item: Item): Promise<void> {
		await this.toggle(item, 'untick');
	}

	private async toggle(item: Item, action: 'tick' | 'untick'): Promise<void> {
		if (this.busy.has(item.id)) return;
		const optimistic: Item = {
			...item,
			state: action === 'tick' ? 'ticked' : 'pending',
			tickedAt: action === 'tick' ? Date.now() : null,
			tickedByName: action === 'tick' ? item.tickedByName : null
		};
		this.items = sortItems(this.items.map((i) => (i.id === item.id ? optimistic : i)));
		this.setBusy(item.id, true);
		this.error = null;
		try {
			this.applyMutation(
				await api<ItemMutation>(`/api/items/${item.id}/${action}`, { method: 'POST', body: {} })
			);
		} catch (err) {
			// Put THIS row back as it was, rebased onto whatever the list looks like
			// now. Restoring a whole snapshot taken before the request would also
			// roll back any refetch that landed while we waited — a failed tick on a
			// bad connection would delete another member's freshly-arrived row.
			this.items = sortItems(this.items.map((i) => (i.id === item.id ? item : i)));
			this.error = messageOf(err);
			if (err instanceof ApiError && (err.code === 'TRIP_CLOSED' || err.code === 'ITEM_NOT_FOUND')) {
				await this.load();
			}
		} finally {
			this.setBusy(item.id, false);
		}
	}

	/** §3.5: `clientId` is required and is reused across every retry of one
	 *  compose, so a timeout on cellular cannot produce a duplicate. */
	async add(name: string, note: string | null, clientId: string): Promise<Item> {
		const body = await api<{ item: Item }>(`/api/stores/${encodeURIComponent(this.storeId)}/items`, {
			method: 'POST',
			body: note ? { name, note, clientId } : { name, clientId }
		});
		await this.load();
		return body.item;
	}

	async edit(item: Item, name: string, note: string | null): Promise<void> {
		this.applyMutation(
			await api<ItemMutation>(`/api/items/${item.id}`, {
				method: 'PATCH',
				body: { name, note, version: item.version }
			})
		);
	}

	async remove(item: Item): Promise<void> {
		const result = await api<ItemMutation>(`/api/items/${item.id}`, { method: 'DELETE' });
		this.rev = result.rev;
		this.items = this.items.filter((i) => i.id !== item.id);
		if (this.store) this.store = { ...this.store, rev: result.rev };
	}

	/**
	 * Adopts a `{ store, trip }` payload from a claim write.
	 *
	 * Deliberately NOT `seed()`: those responses carry no items, and seed's
	 * rev-based staleness check is about item state. A claim changes the header,
	 * so the store and trip are replaced and the item list is left exactly as it
	 * is — including any row with a tick in flight.
	 */
	private applyClaim(payload: { store: StoreSummary; trip: Trip }): void {
		this.store = payload.store;
		this.trip = payload.trip;
		this.rev = Math.max(this.rev, payload.store.rev);
	}

	/**
	 * §8.6 / R-19. `takeover` is the second attempt after a `409 TRIP_CLAIMED`:
	 * the first call deliberately fails so the member is told who is already
	 * going, rather than silently displacing them.
	 */
	async claim(note: string | null, takeover = false): Promise<void> {
		const tripId = this.trip?.id;
		if (!tripId) throw new Error('No open trip.');
		this.applyClaim(
			await api<{ store: StoreSummary; trip: Trip }>(
				`/api/stores/${encodeURIComponent(this.storeId)}/claim`,
				{ method: 'POST', body: { tripId, note, takeover } }
			)
		);
		await shops.load();
	}

	/** R-20. Idempotent server-side; only the holder may call it. */
	async releaseClaim(): Promise<void> {
		this.applyClaim(
			await api<{ store: StoreSummary; trip: Trip }>(
				`/api/stores/${encodeURIComponent(this.storeId)}/claim`,
				{ method: 'DELETE' }
			)
		);
		await shops.load();
	}

	async close(): Promise<{ boughtCount: number; carriedCount: number }> {
		const tripId = this.trip?.id;
		if (!tripId) throw new Error('No open trip.');
		const result = await api<{ boughtCount: number; carriedCount: number }>(
			`/api/stores/${encodeURIComponent(this.storeId)}/trips/close`,
			{ method: 'POST', body: { tripId } }
		);
		await this.load();
		await shops.load();
		return result;
	}
}

const lists = new Map<string, ListState>();

/** One ListState per store, kept across navigations so returning to a list does
 *  not flash empty while it refetches. */
export function listFor(storeId: string): ListState {
	let state = lists.get(storeId);
	if (!state) {
		state = new ListState(storeId);
		lists.set(storeId, state);
	}
	return state;
}

/**
 * Drops every cached list AND the home screen. Called on sign-out and on
 * `session.revoked`: the next person to sign in on this device must not see a
 * frame of the previous one's shopping while the first fetch is in flight.
 */
export function forgetLists(): void {
	lists.clear();
	shops.stores = [];
	shops.loaded = false;
	shops.error = null;
}

/**
 * §4's `revalidate`: the EventSource `open` event, `visibilitychange`, `focus`
 * and `online`. Reloads the home screen AND every list already on screen.
 *
 * Reloading only the home screen is not enough, and the failure is invisible:
 * §4 sends no `id:` and no `Last-Event-ID` replay, so an event emitted while
 * the stream was down is simply gone. A tablet whose idle stream was dropped by
 * the proxy would show a store card saying "2 to buy" above a list holding one
 * row, indefinitely.
 */
export function revalidateAll(): void {
	void shops.load();
	for (const list of lists.values()) {
		if (list.loaded) void list.load();
	}
}
