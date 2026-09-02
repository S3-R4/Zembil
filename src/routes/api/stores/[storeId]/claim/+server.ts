/**
 * `POST|DELETE /api/stores/{storeId}/claim` — CONTRACT.md §8.6, R-18 … R-20.
 * Auth: session.
 *
 * "I'm going to this shop." The claim lives on the store's OPEN trip, so it
 * expires when the trip does; there is no timer and nothing to sweep.
 */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { claimTrip, releaseClaim } from '$lib/server/domain/trips';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const POST: RequestHandler = async ({ locals, params, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const result = claimTrip(
			getDb(),
			params.storeId,
			{
				tripId: body.tripId,
				// §8.6 makes `note` optional and says `null` or empty-after-trim
				// clears it; an ABSENT note is the same thing. It is forwarded
				// unconditionally so that is literally true, rather than the domain
				// treating `undefined` as "clear" while this route pretends it means
				// "leave alone" — the client always sends the field, so the only way
				// the two could disagree is a hand-written request, which is exactly
				// when a documented rule has to be the real one.
				note: body.note,
				takeover: body.takeover
			},
			actor
		);
		return ok({ store: result.store, trip: result.trip });
	});

export const DELETE: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		const actor = actorOf(locals);
		// R-20: no body. Only the current holder may release; releasing an
		// unclaimed trip is an idempotent 200 that writes nothing.
		const result = releaseClaim(getDb(), params.storeId, actor);
		return ok({ store: result.store, trip: result.trip });
	});
