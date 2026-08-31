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

export function shortDate(ms: number | null): string {
	if (ms === null) return '';
	return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
