import type { LayoutServerLoad } from './$types';
import { negotiateAcceptLanguage } from '$lib/server/auth/locale';
import { DEFAULT_THEME } from '$lib/types';

/**
 * `locals.user` is set by hooks.server.ts from the session cookie and from
 * nothing else (§5). Exposing it here means every page renders signed-in on the
 * server, so there is no authenticated flash of a logged-out shell.
 *
 * `locale` rides along for the same reason, and it matters more (§8.5): the
 * strings are chosen during SSR, so delivering the language any later than this
 * means the first paint is in English and then changes. PROJECT.md §13 records
 * the theme-flash bug of exactly that shape; a flash of the wrong *language* is
 * a flash of an app the reader cannot read.
 *
 * Signed in, it is the member's column — the single source, per §8.5. Signed
 * out there is no member, so the sign-in screen is the one place a header is
 * consulted at request time, which is not a violation of §8.5's rule: that rule
 * is about a member's language never depending on which device they used, and
 * here there is no member yet.
 */
export const load: LayoutServerLoad = ({ locals, request }) => ({
	user: locals.user,
	locale: locals.user
		? locals.user.locale
		: negotiateAcceptLanguage(request.headers.get('accept-language')),
	// The theme rides along for the same reason and with the same shape. The
	// SSR'd document already carries it on `<html>` (hooks.server.ts); this copy
	// is what lets the root layout re-apply it after an in-app change, which is
	// a client-side navigation and does not re-render `<html>`. Signed out there
	// is no member and no column, so it is `auto` and the device decides.
	theme: locals.user ? locals.user.theme : DEFAULT_THEME
});
