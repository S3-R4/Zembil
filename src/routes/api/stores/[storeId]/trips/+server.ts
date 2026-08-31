/** `GET /api/stores/{storeId}/trips` — CONTRACT.md §3.6. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listClosedTrips } from '$lib/server/domain/trips';
import { actorOf, handle, ok } from '$lib/server/domain/responses';

/**
 * Query parameters arrive as strings, so something has to turn them into
 * numbers. That is ALL this does.
 *
 * It deliberately does not check the result. An earlier version rejected
 * `!Number.isInteger(n)` here, which is the exact pattern §3.1b names as
 * dangerous — it admits `1e300` and `9007199254740993` — and it put a second,
 * weaker copy of the rules in front of the real ones in `listClosedTrips`.
 * Two validators for one field is how they drift apart. `Number()` maps
 * anything unparseable to `NaN` and an empty parameter to `0`, both of which
 * the domain's `boundedInt` rejects with the 400 §3.1b requires.
 */
function numeric(raw: string | null): number | undefined {
	return raw === null ? undefined : Number(raw);
}

export const GET: RequestHandler = async ({ locals, params, url }) =>
	handle(() => {
		actorOf(locals);
		return ok(
			listClosedTrips(getDb(), params.storeId, {
				limit: numeric(url.searchParams.get('limit')),
				before: numeric(url.searchParams.get('before'))
			})
		);
	});
