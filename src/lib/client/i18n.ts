/**
 * Reading the current language inside a component — CONTRACT.md §8.5.
 *
 * There is deliberately **no module-level `$state` singleton** here, which is
 * the obvious way to write this and is wrong on the server. SvelteKit renders
 * every request in one process, so a module-scoped reactive value is shared
 * between concurrent requests: two members loading a page at the same moment
 * would race, and the loser would be served the other one's language. The bug
 * is invisible in development, where there is one user.
 *
 * So the locale travels in `page.data`, which is per-render by construction —
 * the root `+layout.server.ts` puts it there — and a component reads it with
 *
 *     const m = $derived(messages());
 *
 * `$derived` plus `$app/state`'s reactive `page` gives re-render on a language
 * change for free, without anything to subscribe to or tear down.
 */
import { page } from '$app/state';
import { messagesFor, type Messages } from '$lib/i18n';
import { DEFAULT_LOCALE, type Locale } from '$lib/types';
import { isLocale } from '$lib/i18n';

/** The active locale, from layout data. Falls back only for a render with no
 *  layout data at all, which is the error page before `load` has run. */
export function locale(): Locale {
	const value = (page.data as { locale?: unknown } | undefined)?.locale;
	return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** The catalogue for the active locale. Call inside `$derived`. */
export function messages(): Messages {
	return messagesFor(locale());
}
