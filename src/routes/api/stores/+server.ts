/** `GET|POST /api/stores` — CONTRACT.md §3.4. Auth: session. */
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { createStore, listStores } from '$lib/server/domain/stores';
import { actorOf, handle, ok, readJson } from '$lib/server/domain/responses';

export const GET: RequestHandler = async ({ locals, url }) =>
	handle(() => {
		actorOf(locals);
		const includeArchived = url.searchParams.get('includeArchived') === 'true';
		return ok({ stores: listStores(getDb(), includeArchived) });
	});

export const POST: RequestHandler = async ({ locals, request }) =>
	handle(async () => {
		const actor = actorOf(locals);
		const body = await readJson(request);
		const store = createStore(getDb(), { name: body.name, color: body.color }, actor);
		return ok({ store }, 201);
	});
