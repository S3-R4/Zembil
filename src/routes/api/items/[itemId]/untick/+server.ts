/** `POST /api/items/{itemId}/untick` — CONTRACT.md §3.5, R-5, R-9. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { untickItem } from '$lib/server/domain/items';
import { actorOf, handle, ok } from '$lib/server/domain/responses';

export const POST: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		const actor = actorOf(locals);
		const result = untickItem(getDb(), params.itemId, actor);
		return ok({ item: result.item, rev: result.rev });
	});
