import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/**
 * The client-side half of the auth gate. It is a redirect for the member's
 * benefit, not a control: every endpoint under `/api/` is checked server-side
 * on every request (§3), and rendering a page is not an authorization check.
 */
export const load: LayoutServerLoad = ({ locals, url }) => {
	if (!locals.user) {
		redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	}
	// §3.2: while the flag is set the API answers 403 PASSWORD_CHANGE_REQUIRED to
	// everything else, so any screen rendered here would be a wall of errors.
	if (locals.user.mustChangePassword) redirect(307, '/password');
	return { user: locals.user };
};
