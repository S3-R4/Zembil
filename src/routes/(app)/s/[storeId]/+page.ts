import { loadApi } from '$lib/client/load';
import type { Item, StoreSummary, Trip } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) =>
	loadApi<{ store: StoreSummary; trip: Trip; items: Item[] }>(
		// Encoded, even though every endpoint is authorized server-side: a path
		// parameter interpolated raw is the wrong default, and it is how a bad id
		// turns into a confusing failure rather than a clean 404.
		`/api/stores/${encodeURIComponent(params.storeId)}/list`,
		{ fetch }
	);
