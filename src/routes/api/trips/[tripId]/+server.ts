/** `GET /api/trips/{tripId}` — CONTRACT.md §3.6. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getTripDetail } from '$lib/server/domain/trips';
import { actorOf, handle, ok } from '$lib/server/domain/responses';

export const GET: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		actorOf(locals);
		return ok(getTripDetail(getDb(), params.tripId));
	});
