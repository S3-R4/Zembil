import type { LayoutServerLoad } from './$types';

/** `locals.user` is set by hooks.server.ts from the session cookie and from
 *  nothing else (§5). Exposing it here means every page renders signed-in on
 *  the server, so there is no authenticated flash of a logged-out shell. */
export const load: LayoutServerLoad = ({ locals }) => ({ user: locals.user });
