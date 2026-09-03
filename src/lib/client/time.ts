/** "Used 2 minutes ago" — docs/DESIGN.md §4 (Account screen). */
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	['year', 365 * 24 * 3600_000],
	['month', 30 * 24 * 3600_000],
	['day', 24 * 3600_000],
	['hour', 3600_000],
	['minute', 60_000]
];

export function relative(ms: number | null): string {
	if (ms === null) return 'never used';
	const delta = ms - Date.now();
	for (const [unit, size] of UNITS) {
		if (Math.abs(delta) >= size) return rtf.format(Math.round(delta / size), unit);
	}
	return 'just now';
}

/**
 * `users.locale` holds a LANGUAGE (`en`), and `Intl` reads a bare language tag
 * as its most populous region — so `en` formats a date as "September 3, 2026".
 *
 * Every written date in this app is day-first: DESIGN.md §4 spells the admin
 * screen's as "Disabled 4 Aug", and Turkish and German are day-first anyway. So
 * English is pinned to `en-GB`, which is the region that agrees with the rest of
 * the interface rather than the one with the most speakers. This is a formatting
 * decision, not a language one — the strings still come from the `en` catalogue.
 */
const DATE_TAGS: Record<string, string> = { en: 'en-GB' };

/**
 * "3 September 2026" — a release date, written out.
 *
 * The locale is passed explicitly rather than left to `undefined` (which means
 * "whatever the browser is set to"). `users.locale` is the source of every other
 * string on the screen, and a date beside them in a different language reads as
 * a bug. `relative` and `shortDate` above still use the browser default; they
 * predate the locale column and are a separate change.
 */
export function longDate(ms: number, locale: string): string {
	return new Date(ms).toLocaleDateString(DATE_TAGS[locale] ?? locale, {
		day: 'numeric',
		month: 'long',
		year: 'numeric'
	});
}

export function shortDate(ms: number | null): string {
	if (ms === null) return '';
	return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
