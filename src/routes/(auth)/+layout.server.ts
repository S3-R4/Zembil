import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';

/** A signed-in member has no business on the sign-in screen. The exception is
 *  `/password`, which is exactly where a member with `must_change_password`
 *  belongs and which the (app) guard sends them to. */
export const load: LayoutServerLoad = ({ locals, url }) => {
	if (locals.user && url.pathname !== '/password') redirect(307, '/');
	if (!locals.user && url.pathname === '/password') redirect(307, '/login');
	return { user: locals.user };
};
