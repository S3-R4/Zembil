/** `POST /api/stores/{storeId}/trips/close` — CONTRACT.md §3.5, R-6, R-11. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { closeTrip } from '$lib/server/domain/trips';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const POST: RequestHandler = async ({ locals, params, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const result = closeTrip(getDb(), params.storeId, { tripId: body.tripId }, actor);
		return ok({
			closedTrip: result.closedTrip,
			newTrip: result.newTrip,
			boughtCount: result.boughtCount,
			carriedCount: result.carriedCount
		});
	});
