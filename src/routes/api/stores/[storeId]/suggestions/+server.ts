/** GET /api/stores/{storeId}/suggestions — CONTRACT.md §12.1. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { recentItemSuggestions } from '$lib/server/domain/items';
import { actorOf, handle, ok } from '$lib/server/domain/responses';

const numeric = (raw: string | null): number | undefined =>
	raw === null ? undefined : Number(raw);

export const GET: RequestHandler = async ({ locals, params, url }) =>
	handle(() => {
		const actor = actorOf(locals);
		return ok({
			suggestions: recentItemSuggestions(
				getDb(),
				params.storeId,
				actor,
				numeric(url.searchParams.get('limit'))
			)
		});
	});
