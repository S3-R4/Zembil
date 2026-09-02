/**
 * The catalogue registry — CONTRACT.md §8.5.
 *
 * Three languages, one object each, no library and no build step. `Messages` is
 * `typeof en`, so `tr` and `de` are structurally forced to carry every key with
 * the same signature; there is deliberately **no runtime fallback to English**,
 * because a fallback hides the missing key it is covering for.
 *
 * This module is isomorphic on purpose. The client renders from it, and so does
 * anything on the server that needs a member-facing string. Push notification
 * text is the exception and lives in `$lib/server/push/messages.ts` — it is
 * composed for a recipient who is not the requester, it is written to a lock
 * screen rather than to this app's markup, and keeping it separate means the
 * server catalogue cannot pull the whole UI catalogue into the delivery path.
 */
import type { Locale } from '$lib/types';
import { DEFAULT_LOCALE, LOCALES } from '$lib/types';
import { en, type Messages } from './en';
import { tr } from './tr';
import { de } from './de';

export type { Messages };
export { plural, num, pluralCategory, type PluralForms } from './plural';

export const catalogues: Readonly<Record<Locale, Messages>> = Object.freeze({ en, tr, de });

export function isLocale(value: unknown): value is Locale {
	return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** The catalogue for a locale, or English for anything unrecognised. This is
 *  the ONLY fallback in the system, and it exists for values arriving from
 *  outside the type system — a stored column, a URL, a header. */
export function messagesFor(locale: unknown): Messages {
	return isLocale(locale) ? catalogues[locale] : catalogues[DEFAULT_LOCALE];
}

/** What the language picker on `/you` renders. Each language names itself in
 *  itself: somebody who has landed in the wrong language has to be able to find
 *  their way out, and "Türkçe" is legible to a Turkish speaker in a way that
 *  "Turkish" spelled out in German is not. */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = Object.freeze({
	en: 'English',
	tr: 'Türkçe',
	de: 'Deutsch'
});
