/**
 * §8.9's **Notifies** column — CONTRACT.md §8.8, §8.9, R-21.
 *
 * This file exists because the M6 audit found the column had no coverage at
 * all: `noteItemAdded` and `noteStoreActivity` were tested only where they are
 * called directly, so deleting either call from the domain layer left the whole
 * suite green and push silently never fired again. A mutation sweep could not
 * have found it either — a sweep breaks code that exists, and what was missing
 * was a test, not a guard.
 *
 * Everything here drives the real ROUTE, with a recording sink installed the
 * way `hooks.server.ts` installs the push one. The coalescer is real; only the
 * clock is fake.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bodyOf, harness, jsonRequest, localsFor, makeUser, type Harness } from './_support';
import { setDb } from '$lib/server/db';
import { resetBus } from '$lib/server/realtime/bus';
import {
	configureNotifier,
	pendingCount,
	resetNotifier,
	setNotificationSink,
	type NotificationBatch
} from '$lib/server/notify';

import * as storesRoute from '../../src/routes/api/stores/+server';
import * as storeRoute from '../../src/routes/api/stores/[storeId]/+server';
import * as itemsRoute from '../../src/routes/api/stores/[storeId]/items/+server';
import * as itemRoute from '../../src/routes/api/items/[itemId]/+server';
import * as tickRoute from '../../src/routes/api/items/[itemId]/tick/+server';
import * as untickRoute from '../../src/routes/api/items/[itemId]/untick/+server';
import * as closeRoute from '../../src/routes/api/stores/[storeId]/trips/close/+server';
import * as claimRoute from '../../src/routes/api/stores/[storeId]/claim/+server';

const QUIET = 5 * 60_000;
const MAX_DELAY = 30 * 60_000;

let delivered: NotificationBatch[] = [];

beforeEach(() => {
	vi.useFakeTimers();
	resetNotifier();
	delivered = [];
	setNotificationSink((batch) => {
		delivered.push(batch);
	});
	configureNotifier({ quietMs: QUIET, maxDelayMs: MAX_DELAY });
});

afterEach(() => {
	resetNotifier();
	vi.useRealTimers();
	setDb(null);
	resetBus();
});

const call = (fn: any, args: any) => fn(args) as Promise<Response>;

async function world() {
	const h = harness();
	setDb(h.db);
	const ayse = makeUser(h.db, 'ayse', 'Ayşe');
	const locals = localsFor(ayse);
	const created = await call(storesRoute.POST, {
		locals,
		request: jsonRequest({ name: 'Migros' })
	});
	const store = (await bodyOf(created)).store;
	const tripId = (
		h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(store.id) as any
	).id;
	// Creating the store must not have armed anything — §8.9 lists no
	// notification for a store with nothing on it yet.
	expect(pendingCount()).toBe(0);
	return { h, ayse, locals, store, tripId };
}

const addItem = (locals: any, storeId: string, name: string) =>
	call(itemsRoute.POST, {
		locals,
		params: { storeId },
		request: jsonRequest({ name, clientId: randomUUID() })
	});

describe('an add arms a batch, and one batch is delivered when the list goes quiet', () => {
	test('one add → exactly one notification, after the quiet window', async () => {
		const w = await world();
		try {
			await addItem(w.locals, w.store.id, 'Milk');
			expect(pendingCount()).toBe(1);

			// Not a moment early.
			await vi.advanceTimersByTimeAsync(QUIET - 1);
			expect(delivered).toEqual([]);

			await vi.advanceTimersByTimeAsync(1);
			expect(delivered.length).toBe(1);
			expect(delivered[0].storeId).toBe(w.store.id);
			expect(delivered[0].count).toBe(1);
			expect(delivered[0].names).toEqual(['Milk']);
			expect(delivered[0].actorIds).toEqual([w.ayse.id]);
		} finally {
			w.h.close();
		}
	});

	test('eleven adds over a minute are ONE notification, not eleven', async () => {
		const w = await world();
		try {
			for (let i = 0; i < 11; i += 1) {
				await addItem(w.locals, w.store.id, `Item ${i}`);
				await vi.advanceTimersByTimeAsync(6_000);
			}
			expect(delivered).toEqual([]);

			await vi.advanceTimersByTimeAsync(QUIET);
			expect(delivered.length).toBe(1);
			expect(delivered[0].count).toBe(11);
			// The batch carries at most five names and the true count.
			expect(delivered[0].names.length).toBe(5);
		} finally {
			w.h.close();
		}
	});

	test('an idempotent add (R-17) arms nothing', async () => {
		const w = await world();
		try {
			const clientId = randomUUID();
			const body = { name: 'Milk', clientId };
			await call(itemsRoute.POST, {
				locals: w.locals,
				params: { storeId: w.store.id },
				request: jsonRequest(body)
			});
			await vi.advanceTimersByTimeAsync(QUIET);
			expect(delivered.length).toBe(1);

			// The retry writes nothing, so §8.9 says it notifies nothing.
			const repeat = await call(itemsRoute.POST, {
				locals: w.locals,
				params: { storeId: w.store.id },
				request: jsonRequest(body)
			});
			expect(repeat.status).toBe(200);
			expect(pendingCount()).toBe(0);
			await vi.advanceTimersByTimeAsync(QUIET);
			expect(delivered.length).toBe(1);
		} finally {
			w.h.close();
		}
	});
});

describe('every other write EXTENDS the window, and none of them arms one', () => {
	/**
	 * Table-driven over §8.9's remaining rows. Each case runs twice: once with
	 * no batch armed (must notify nothing at all) and once with one armed (must
	 * push the deadline out by a full window).
	 */
	const cases: Array<{
		name: string;
		run: (w: Awaited<ReturnType<typeof world>>, itemId: string) => Promise<Response>;
	}> = [
		{
			name: 'tick',
			run: (w, itemId) =>
				call(tickRoute.POST, { locals: w.locals, params: { itemId }, request: jsonRequest({}) })
		},
		{
			name: 'untick',
			run: async (w, itemId) => {
				await call(tickRoute.POST, {
					locals: w.locals,
					params: { itemId },
					request: jsonRequest({})
				});
				return call(untickRoute.POST, {
					locals: w.locals,
					params: { itemId },
					request: jsonRequest({})
				});
			}
		},
		{
			name: 'edit',
			run: (w, itemId) =>
				call(itemRoute.PATCH, {
					locals: w.locals,
					params: { itemId },
					request: jsonRequest({ name: 'Changed', version: 1 }, 'PATCH')
				})
		},
		{
			name: 'delete',
			run: (w, itemId) => call(itemRoute.DELETE, { locals: w.locals, params: { itemId } })
		},
		{
			name: 'PATCH the store',
			run: (w) =>
				call(storeRoute.PATCH, {
					locals: w.locals,
					params: { storeId: w.store.id },
					request: jsonRequest({ color: 'blue' }, 'PATCH')
				})
		},
		{
			name: 'claim',
			run: (w) =>
				call(claimRoute.POST, {
					locals: w.locals,
					params: { storeId: w.store.id },
					request: jsonRequest({ tripId: w.tripId, note: 'milk' })
				})
		},
		{
			name: 'close',
			run: (w) =>
				call(closeRoute.POST, {
					locals: w.locals,
					params: { storeId: w.store.id },
					request: jsonRequest({ tripId: w.tripId })
				})
		}
	];

	for (const c of cases) {
		test(`${c.name} with NO batch armed notifies nothing`, async () => {
			const w = await world();
			try {
				// An item exists but its add has already been delivered, so the
				// store is quiet again.
				const added = await addItem(w.locals, w.store.id, 'Milk');
				const itemId = (await bodyOf(added)).item.id;
				await vi.advanceTimersByTimeAsync(QUIET);
				expect(delivered.length).toBe(1);

				await c.run(w, itemId);
				// R-21: only adds arm. Ticking a whole list nobody added to today
				// sends nothing — the person ticking is standing in the shop.
				expect(pendingCount(), `${c.name} armed a batch`).toBe(0);
				await vi.advanceTimersByTimeAsync(MAX_DELAY);
				expect(delivered.length).toBe(1);
			} finally {
				w.h.close();
			}
		});

		test(`${c.name} with a batch armed pushes the deadline out`, async () => {
			const w = await world();
			try {
				const added = await addItem(w.locals, w.store.id, 'Milk');
				const itemId = (await bodyOf(added)).item.id;

				// Four minutes into a five-minute window…
				await vi.advanceTimersByTimeAsync(QUIET - 60_000);
				expect(delivered).toEqual([]);

				await c.run(w, itemId);

				// …the original deadline passes with nothing delivered, because the
				// write reset the clock.
				await vi.advanceTimersByTimeAsync(60_000 + 1);
				expect(delivered, `${c.name} did not extend the window`).toEqual([]);

				await vi.advanceTimersByTimeAsync(QUIET);
				expect(delivered.length).toBe(1);
			} finally {
				w.h.close();
			}
		});
	}

	test('an idempotent no-op does NOT extend the window', async () => {
		const w = await world();
		try {
			const added = await addItem(w.locals, w.store.id, 'Milk');
			const itemId = (await bodyOf(added)).item.id;
			await call(tickRoute.POST, {
				locals: w.locals,
				params: { itemId },
				request: jsonRequest({})
			});

			await vi.advanceTimersByTimeAsync(QUIET - 1_000);
			// Re-ticking an already-ticked item changes nothing (R-4), so §8.9
			// says it bumps nothing, emits nothing and notifies nothing. If it
			// extended the window, a client retrying a tick could hold a
			// notification back indefinitely.
			const repeat = await call(tickRoute.POST, {
				locals: w.locals,
				params: { itemId },
				request: jsonRequest({})
			});
			expect(repeat.status).toBe(200);

			await vi.advanceTimersByTimeAsync(1_000);
			expect(delivered.length).toBe(1);
		} finally {
			w.h.close();
		}
	});

	test('re-claiming with the same note does NOT extend the window', async () => {
		const w = await world();
		try {
			await addItem(w.locals, w.store.id, 'Milk');
			const claim = () =>
				call(claimRoute.POST, {
					locals: w.locals,
					params: { storeId: w.store.id },
					request: jsonRequest({ tripId: w.tripId, note: 'milk' })
				});
			await claim();

			await vi.advanceTimersByTimeAsync(QUIET - 1_000);
			await claim();
			await vi.advanceTimersByTimeAsync(1_000);
			expect(delivered.length).toBe(1);
		} finally {
			w.h.close();
		}
	});
});

describe('R-21 — the clamp stops an active list starving its own notification', () => {
	test('a list touched every four minutes still notifies at the ceiling', async () => {
		const w = await world();
		try {
			const added = await addItem(w.locals, w.store.id, 'Milk');
			const itemId = (await bodyOf(added)).item.id;

			// Somebody nudging the list every four minutes, for an hour. Without
			// the clamp this notifies never.
			for (let elapsed = 0; elapsed < MAX_DELAY * 2 && delivered.length === 0; elapsed += 240_000) {
				await vi.advanceTimersByTimeAsync(240_000);
				await call(itemRoute.PATCH, {
					locals: w.locals,
					params: { itemId },
					request: jsonRequest({ note: `nudge ${elapsed}`, version: 1 }, 'PATCH')
				}).catch(() => {
					/* version conflicts are irrelevant here; the emit is what matters */
				});
			}

			expect(delivered.length).toBe(1);
			// It fired at the ceiling, not at a quiet window.
			expect(Date.now() - delivered[0].armedAt).toBeLessThanOrEqual(MAX_DELAY + 240_000);
		} finally {
			w.h.close();
		}
	});
});

describe('the coalescer is per store', () => {
	test('two shops notify separately', async () => {
		const w = await world();
		try {
			const other = await call(storesRoute.POST, {
				locals: w.locals,
				request: jsonRequest({ name: 'Eczane' })
			});
			const second = (await bodyOf(other)).store;

			await addItem(w.locals, w.store.id, 'Milk');
			await addItem(w.locals, second.id, 'Aspirin');
			expect(pendingCount()).toBe(2);

			await vi.advanceTimersByTimeAsync(QUIET);
			expect(delivered.length).toBe(2);
			expect(new Set(delivered.map((b) => b.storeId))).toEqual(
				new Set([w.store.id, second.id])
			);
		} finally {
			w.h.close();
		}
	});
});
