/**
 * Trip claims — CONTRACT.md §8.6, R-18 … R-20, I-16, §8.9.
 *
 * The rule that carries the design is R-18: the claim lives on the TRIP, so it
 * expires when the trip does and nothing has to clear it. The test that matters
 * most here is therefore the one nobody would think to write — that closing a
 * trip leaves the claim behind as history and opens an unclaimed one.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bodyOf, harness, jsonRequest, localsFor, makeUser, recorder, type Harness } from './_support';
import { setDb } from '$lib/server/db';
import { resetBus } from '$lib/server/realtime/bus';

import * as storesRoute from '../../src/routes/api/stores/+server';
import * as itemsRoute from '../../src/routes/api/stores/[storeId]/items/+server';
import * as claimRoute from '../../src/routes/api/stores/[storeId]/claim/+server';
import * as closeRoute from '../../src/routes/api/stores/[storeId]/trips/close/+server';
import * as tripRoute from '../../src/routes/api/trips/[tripId]/+server';
import * as listRoute from '../../src/routes/api/stores/[storeId]/list/+server';

afterEach(() => {
	setDb(null);
	resetBus();
});

const call = (fn: any, args: any) => fn(args) as Promise<Response>;

async function world() {
	const h = harness();
	setDb(h.db);
	const ayse = makeUser(h.db, 'ayse', 'Ayşe');
	const baba = makeUser(h.db, 'baba', 'Baba');
	const aLocals = localsFor(ayse);
	const bLocals = localsFor(baba, 'session-2');

	const created = await call(storesRoute.POST, {
		locals: aLocals,
		request: jsonRequest({ name: 'Migros' })
	});
	const store = (await bodyOf(created)).store;
	const tripId = openTrip(h, store.id);
	return { h, ayse, baba, aLocals, bLocals, store, tripId };
}

const openTrip = (h: Harness, storeId: string): string =>
	(h.db.prepare(`SELECT id FROM trips WHERE store_id=? AND status='open'`).get(storeId) as any).id;

const claim = (locals: any, storeId: string, body: unknown) =>
	call(claimRoute.POST, { locals, params: { storeId }, request: jsonRequest(body) });

const release = (locals: any, storeId: string) =>
	call(claimRoute.DELETE, { locals, params: { storeId } });

const claimRow = (h: Harness, tripId: string) =>
	h.db.prepare('SELECT claimed_by, claimed_at, claim_note FROM trips WHERE id = ?').get(tripId) as any;

describe('R-18 — claiming, and what the response says', () => {
	test('a claim names the holder by DISPLAY name and marks it as mine', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'only the milk' });
			expect(res.status).toBe(200);
			const body = await bodyOf(res);

			expect(body.store.claimedByName).toBe('Ayşe');
			expect(body.store.claimedByMe).toBe(true);
			expect(body.store.claimNote).toBe('only the milk');
			expect(typeof body.store.claimedAt).toBe('number');
			expect(body.trip.claimedByName).toBe('Ayşe');

			// §3: responses carry display names, never user ids. `claimedByMe` is
			// the whole reason that rule can hold here — two members can share a
			// display name, so the client cannot compare strings to decide whose
			// release button it is.
			expect(JSON.stringify(body)).not.toContain(w.ayse.id);
		} finally {
			w.h.close();
		}
	});

	test('the same claim reads as SOMEONE ELSE to another member', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'only the milk' });
			const res = await call(listRoute.GET, {
				locals: w.bLocals,
				params: { storeId: w.store.id }
			});
			const body = await bodyOf(res);
			expect(body.store.claimedByName).toBe('Ayşe');
			expect(body.store.claimedByMe).toBe(false);
		} finally {
			w.h.close();
		}
	});

	test('all three columns are written together (I-16)', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'bread' });
			const row = claimRow(w.h, w.tripId);
			expect(row.claimed_by).toBe(w.ayse.id);
			expect(typeof row.claimed_at).toBe('number');
			expect(row.claim_note).toBe('bread');
		} finally {
			w.h.close();
		}
	});

	test('a claim with no note is a claim with a null note, not a rejected request', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId });
			expect(res.status).toBe(200);
			expect(claimRow(w.h, w.tripId).claim_note).toBe(null);
		} finally {
			w.h.close();
		}
	});
});

describe('R-18 — the claim dies with the trip, and nothing has to clear it', () => {
	test('closing leaves the claim on the CLOSED trip and opens an unclaimed one', async () => {
		const w = await world();
		try {
			await call(itemsRoute.POST, {
				locals: w.aLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
			});
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'only the milk' });

			const closed = await call(closeRoute.POST, {
				locals: w.aLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ tripId: w.tripId })
			});
			expect(closed.status).toBe(200);

			// History keeps it: this is how `GET /api/trips/{id}` can say who did
			// the shopping, without the audit table BACKLOG.md rejects.
			const old = claimRow(w.h, w.tripId);
			expect(old.claimed_by).toBe(w.ayse.id);
			expect(old.claim_note).toBe('only the milk');

			const detail = await bodyOf(
				await call(tripRoute.GET, { locals: w.aLocals, params: { tripId: w.tripId } })
			);
			expect(detail.trip.claimedByName).toBe('Ayşe');
			expect(detail.trip.claimNote).toBe('only the milk');

			// And the successor starts clean — with no timer, no sweep and no code
			// that had to remember.
			const next = openTrip(w.h, w.store.id);
			expect(next).not.toBe(w.tripId);
			const fresh = claimRow(w.h, next);
			expect(fresh.claimed_by).toBe(null);
			expect(fresh.claimed_at).toBe(null);
			expect(fresh.claim_note).toBe(null);
		} finally {
			w.h.close();
		}
	});
});

describe('R-19 — re-claiming, conflict and takeover', () => {
	test('the holder re-claiming with a new note is an update, never a conflict', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk and bread' });
			expect(res.status).toBe(200);
			expect(claimRow(w.h, w.tripId).claim_note).toBe('milk and bread');
		} finally {
			w.h.close();
		}
	});

	test('editing the note keeps the ORIGINAL claimed_at', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const first = Number(claimRow(w.h, w.tripId).claimed_at);

			await new Promise((resolve) => setTimeout(resolve, 5));
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk and bread' });

			// "Ayşe has been shopping since 18:04" is the useful fact. Rewriting
			// the timestamp on a note edit silently moves it to 18:31.
			expect(Number(claimRow(w.h, w.tripId).claimed_at)).toBe(first);
		} finally {
			w.h.close();
		}
	});

	test('a TAKEOVER does restart the clock — it is a different person shopping', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const first = Number(claimRow(w.h, w.tripId).claimed_at);

			await new Promise((resolve) => setTimeout(resolve, 5));
			await claim(w.bLocals, w.store.id, { tripId: w.tripId, takeover: true });

			expect(Number(claimRow(w.h, w.tripId).claimed_at)).toBeGreaterThan(first);
		} finally {
			w.h.close();
		}
	});

	test('someone else claiming is 409 TRIP_CLAIMED and NAMES the holder', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const res = await claim(w.bLocals, w.store.id, { tripId: w.tripId });
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.error.code).toBe('TRIP_CLAIMED');
			// The name is what lets the client offer "take over anyway" without a
			// second round trip.
			expect(body.error.message).toContain('Ayşe');
			// §3.1/§8.10: exactly three responses carry a sibling field, and this
			// is not one of them.
			expect(Object.keys(body)).toEqual(['error']);
			// Nothing was written.
			expect(claimRow(w.h, w.tripId).claimed_by).toBe(w.ayse.id);
		} finally {
			w.h.close();
		}
	});

	test('takeover:true overwrites the claim and replaces the note', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const res = await claim(w.bLocals, w.store.id, {
				tripId: w.tripId,
				takeover: true,
				note: 'I am nearer'
			});
			expect(res.status).toBe(200);
			const row = claimRow(w.h, w.tripId);
			expect(row.claimed_by).toBe(w.baba.id);
			expect(row.claim_note).toBe('I am nearer');
		} finally {
			w.h.close();
		}
	});

	test('takeover:true on an UNCLAIMED trip is an ordinary claim', async () => {
		const w = await world();
		try {
			const res = await claim(w.bLocals, w.store.id, { tripId: w.tripId, takeover: true });
			expect(res.status).toBe(200);
			expect(claimRow(w.h, w.tripId).claimed_by).toBe(w.baba.id);
		} finally {
			w.h.close();
		}
	});
});

describe('R-20 — releasing', () => {
	test('the holder releases, and all three columns clear together', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const res = await release(w.aLocals, w.store.id);
			expect(res.status).toBe(200);
			const row = claimRow(w.h, w.tripId);
			expect(row.claimed_by).toBe(null);
			expect(row.claimed_at).toBe(null);
			expect(row.claim_note).toBe(null);
		} finally {
			w.h.close();
		}
	});

	test('a non-holder gets 403 FORBIDDEN and changes nothing', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const res = await release(w.bLocals, w.store.id);
			// 403, not 404: the caller can SEE this store, so the claim's existence
			// is not a secret from them — only the right to end it is.
			expect(res.status).toBe(403);
			expect((await bodyOf(res)).error.code).toBe('FORBIDDEN');
			expect(claimRow(w.h, w.tripId).claimed_by).toBe(w.ayse.id);
		} finally {
			w.h.close();
		}
	});

	test('releasing an unclaimed trip is an idempotent 200', async () => {
		const w = await world();
		try {
			const res = await release(w.bLocals, w.store.id);
			expect(res.status).toBe(200);
			expect(claimRow(w.h, w.tripId).claimed_by).toBe(null);
		} finally {
			w.h.close();
		}
	});
});

describe('§8.6 — the tripId staleness guard', () => {
	test('a missing tripId is 400, never a recoverable-looking 409', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, {});
			expect(res.status).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
		} finally {
			w.h.close();
		}
	});

	test('a non-string tripId is 400', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, { tripId: 42 });
			expect(res.status).toBe(400);
		} finally {
			w.h.close();
		}
	});

	test('a tripId that never existed is 404 TRIP_NOT_FOUND', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, { tripId: randomUUID() });
			expect(res.status).toBe(404);
			expect((await bodyOf(res)).error.code).toBe('TRIP_NOT_FOUND');
		} finally {
			w.h.close();
		}
	});

	test('a STALE but real tripId is 409 TRIP_ALREADY_CLOSED with the open trip id', async () => {
		const w = await world();
		try {
			await call(itemsRoute.POST, {
				locals: w.aLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ name: 'Milk', clientId: randomUUID() })
			});
			await call(closeRoute.POST, {
				locals: w.aLocals,
				params: { storeId: w.store.id },
				request: jsonRequest({ tripId: w.tripId })
			});

			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId });
			expect(res.status).toBe(409);
			const body = await bodyOf(res);
			expect(body.error.code).toBe('TRIP_ALREADY_CLOSED');
			expect(body.openTripId).toBe(openTrip(w.h, w.store.id));
		} finally {
			w.h.close();
		}
	});
});

describe('§3.1a — the note', () => {
	test('141 characters is 400, and nothing is written', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, {
				tripId: w.tripId,
				note: 'x'.repeat(141)
			});
			// A CHECK constraint reaching the user would be a 500; §3.1a promises a
			// 400, and migration 002's CHECK is the backstop, not the control.
			expect(res.status).toBe(400);
			expect(claimRow(w.h, w.tripId).claimed_by).toBe(null);
		} finally {
			w.h.close();
		}
	});

	test('140 characters is accepted', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'x'.repeat(140) });
			expect(res.status).toBe(200);
		} finally {
			w.h.close();
		}
	});

	test('whitespace-only and null both clear the note', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: '   ' });
			expect(claimRow(w.h, w.tripId).claim_note).toBe(null);

			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: null });
			expect(claimRow(w.h, w.tripId).claim_note).toBe(null);
		} finally {
			w.h.close();
		}
	});

	test('a non-string note is 400', async () => {
		const w = await world();
		try {
			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: { evil: true } });
			expect(res.status).toBe(400);
		} finally {
			w.h.close();
		}
	});
});

describe('§8.9 — what a claim bumps and emits', () => {
	test('a claim that changes something bumps rev and emits BOTH store events', async () => {
		const w = await world();
		const rec = recorder();
		try {
			const before = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const after = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			expect(after).toBe(before + 1);

			const types = rec.take().map((e) => e.type);
			// Both, for the same reason a close emits both: the home card shows the
			// claim and so does the list header.
			expect(types).toContain('stores.changed');
			expect(types).toContain('store.changed');
		} finally {
			rec.stop();
			w.h.close();
		}
	});

	test('re-claiming with the SAME note bumps nothing and emits nothing', async () => {
		const w = await world();
		try {
			await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			const rec = recorder();
			const before = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			const res = await claim(w.aLocals, w.store.id, { tripId: w.tripId, note: 'milk' });
			expect(res.status).toBe(200);
			const after = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			expect(after).toBe(before);
			expect(rec.take()).toEqual([]);
			rec.stop();
		} finally {
			w.h.close();
		}
	});

	test('releasing an already-unclaimed trip bumps nothing and emits nothing', async () => {
		const w = await world();
		const rec = recorder();
		try {
			const before = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			await release(w.aLocals, w.store.id);
			const after = Number(
				(w.h.db.prepare('SELECT rev FROM stores WHERE id = ?').get(w.store.id) as any).rev
			);
			expect(after).toBe(before);
			expect(rec.take()).toEqual([]);
		} finally {
			rec.stop();
			w.h.close();
		}
	});
});
