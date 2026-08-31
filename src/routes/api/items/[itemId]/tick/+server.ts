/** `POST /api/items/{itemId}/tick` — CONTRACT.md §3.5, R-3, R-4. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { tickItem } from '$lib/server/domain/items';
import { actorOf, handle, ok } from '$lib/server/domain/responses';

export const POST: RequestHandler = async ({ locals, params }) =>
	handle(() => {
		const actor = actorOf(locals);
		const result = tickItem(getDb(), params.itemId, actor);
		return ok({ item: result.item, rev: result.rev });
	});
