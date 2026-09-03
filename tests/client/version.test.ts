/**
 * Versioning — CONTRACT.md §11.1, `src/lib/version.ts`.
 *
 * A version string exists to be trusted, so the things that could make it a lie
 * are what this file asserts: that `package.json` and the module agree, that
 * the release date is a real date and not a plausible-looking typo, and that the
 * label the screen renders is derived rather than typed a second time.
 *
 * `docs/VERSIONS.md` is read too. A release log whose top entry is not the
 * version the app reports is the one shape of drift nobody notices, because
 * both halves look right on their own.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { RELEASED_ON, VERSION, displayVersion, releasedAt } from '$lib/version';
import { longDate } from '$lib/client/time';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const versions = readFileSync(new URL('../../docs/VERSIONS.md', import.meta.url), 'utf8');

describe('the version is written once', () => {
	it('package.json agrees with $lib/version', () => {
		// The module is the source; package.json cannot be, because importing it
		// into a client-bundled module would ship the whole manifest to every
		// browser — the fingerprint §3.8 refuses to serve.
		expect(pkg.version).toBe(VERSION);
	});

	it('is `0.<milestone>.<patch>`, all three numeric', () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
		const [major] = VERSION.split('.').map(Number);
		// Still 0.x deliberately: the frozen contract is the compatibility
		// promise, not the number. A 1.0 needs a D-entry saying what it means.
		expect(major).toBe(0);
	});

	it('is the version docs/VERSIONS.md has at the top', () => {
		const first = versions.match(/^## (v\d+\.\d+(?:\.\d+)?)/m);
		expect(first, 'docs/VERSIONS.md has no `## vX.Y` heading').not.toBeNull();
		expect(first?.[1]).toBe(displayVersion());
	});
});

describe('the release date is a date', () => {
	it('is `YYYY-MM-DD` and parses to that exact day in UTC', () => {
		expect(RELEASED_ON).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		const ms = releasedAt();
		expect(Number.isNaN(ms)).toBe(false);
		// Round-trips: catches 2026-02-30 and 2026-13-01, which `Date.parse`
		// either shifts silently or rejects depending on the form.
		expect(new Date(ms).toISOString().slice(0, 10)).toBe(RELEASED_ON);
	});

	it('is not in the future', () => {
		// A release date ahead of the clock means somebody edited the constant
		// while planning rather than while shipping.
		expect(releasedAt()).toBeLessThanOrEqual(Date.now());
	});

	it('is parsed as UTC, so the rendered day does not shift west of Greenwich', () => {
		// `Date.parse('2026-09-03')` is UTC midnight; `new Date('2026/09/03')` is
		// local midnight. Getting this wrong shows the 2nd to a reader in Chicago.
		expect(releasedAt('2026-09-03')).toBe(Date.UTC(2026, 8, 3));
	});
});

describe('displayVersion', () => {
	it('drops a zero patch and keeps a real one', () => {
		expect(displayVersion('0.8.0')).toBe('v0.8');
		expect(displayVersion('0.8.1')).toBe('v0.8.1');
		expect(displayVersion('0.9.0')).toBe('v0.9');
		expect(displayVersion('1.0.0')).toBe('v1.0');
		expect(displayVersion('0.8.10')).toBe('v0.8.10');
	});

	it('renders the current version as the shape the brief asked for', () => {
		expect(displayVersion()).toMatch(/^v\d+\.\d+(\.\d+)?$/);
	});
});

describe('longDate', () => {
	it('is day-first in every language the app speaks', () => {
		// `users.locale` holds a LANGUAGE, and `Intl` reads a bare `en` as en-US —
		// "September 3, 2026". Every written date in this app is day-first
		// (DESIGN.md §4 spells one as "4 Aug"), so English is pinned to en-GB.
		// This asserts the house style, not `Intl`'s tables: the day has to come
		// before the month for all three.
		const ms = Date.UTC(2026, 8, 3);
		for (const locale of ['en', 'tr', 'de']) {
			const text = longDate(ms, locale);
			expect(text, locale).toContain('3');
			expect(text, locale).toContain('2026');
			expect(text.indexOf('3'), `${locale}: the day must precede the month`).toBeLessThan(
				text.search(/\p{L}/u)
			);
		}
	});

	it('renders the release date without shifting the day', () => {
		expect(longDate(releasedAt(), 'en')).toBe('3 September 2026');
	});

	it('actually uses the locale it was handed', () => {
		// The sweep found this gap: every assertion above holds for a function
		// that ignores its argument and formats everything as en-GB, because all
		// three languages are day-first and German spells September the English
		// way. Turkish does not, which is what makes the argument observable.
		const ms = Date.UTC(2026, 8, 3);
		expect(longDate(ms, 'tr')).toContain('Eylül');
		expect(longDate(ms, 'tr')).not.toBe(longDate(ms, 'en'));
	});
});
