import { api } from '$lib/client/api';
import type { StoreSummary } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) =>
	api<{ stores: StoreSummary[] }>('/api/stores', { fetch });
