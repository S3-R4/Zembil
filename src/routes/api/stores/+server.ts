/** `GET|POST /api/stores` — CONTRACT.md §3.4. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createStore, listStores } from '$lib/server/domain/stores';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const GET: RequestHandler = async ({ locals, url }) =>
	handle(() => {
		// §8.4: the actor comes from the session and nowhere else. A store private
		// to somebody else is absent from the array.
		const actor = actorOf(locals);
		const includeArchived = url.searchParams.get('includeArchived') === 'true';
		return ok({ stores: listStores(getDb(), actor, includeArchived) });
	});

export const POST: RequestHandler = async ({ locals, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const store = createStore(getDb(), { name: body.name, color: body.color }, actor);
		return ok({ store }, 201);
	});
