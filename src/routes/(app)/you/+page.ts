import { api } from '$lib/client/api';
import type { Passkey, User } from '$lib/types';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) =>
	api<{ user: User; passkeys: Passkey[] }>('/api/me', { fetch });
