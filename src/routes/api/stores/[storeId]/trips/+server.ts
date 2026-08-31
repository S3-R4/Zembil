/** `GET /api/stores/{storeId}/trips` — CONTRACT.md §3.6. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listClosedTrips } from '$lib/server/domain/trips';
import { actorOf, handle, ok } from '$lib/server/domain/responses';
import { validationFailed } from '$lib/server/domain/errors';

function numeric(raw: string | null, field: string): number | undefined {
	if (raw === null) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n)) throw validationFailed(`${field} must be a whole number.`);
	return n;
}

export const GET: RequestHandler = async ({ locals, params, url }) =>
	handle(() => {
		actorOf(locals);
		return ok(
			listClosedTrips(getDb(), params.storeId, {
				limit: numeric(url.searchParams.get('limit'), 'limit'),
				before: numeric(url.searchParams.get('before'), 'before')
			})
		);
	});
