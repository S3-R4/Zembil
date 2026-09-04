import type { Locale } from '$lib/types';

/** Public install/offline metadata. Safe to embed before authentication. */
export const PWA_DESCRIPTIONS: Readonly<Record<Locale, string>> = Object.freeze({
	en: 'The family shopping list.',
	tr: 'Ailenin alışveriş listesi.',
	de: 'Die Einkaufsliste für die Familie.'
});
