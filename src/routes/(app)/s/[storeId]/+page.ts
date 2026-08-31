import { api } from '$lib/client/api';
import type { Item, StoreSummary, Trip } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) =>
	api<{ store: StoreSummary; trip: Trip; items: Item[] }>(`/api/stores/${params.storeId}/list`, {
		fetch
	});
