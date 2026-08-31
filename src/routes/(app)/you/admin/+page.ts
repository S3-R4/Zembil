import { api } from '$lib/client/api';
import type { AdminUser } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) =>
	api<{ users: AdminUser[] }>('/api/admin/users', { fetch });
