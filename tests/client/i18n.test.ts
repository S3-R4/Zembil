/**
 * The message catalogues — CONTRACT.md §8.5.
 *
 * `Messages` is `typeof en`, so a missing key in `tr` or `de` is already a
 * compile error. This file exists because `npm run check` is not what runs in a
 * pre-commit hook here, and because the type system cannot say anything about
 * the CONTENT of a translation — that a Turkish plural did not silently keep an
 * English `one` form, or that a shop name was not glued to a case suffix.
 */
import { describe, expect, test } from 'vitest';
import { catalogues, isLocale, messagesFor, LANGUAGE_NAMES } from '$lib/i18n';
import { plural, num } from '$lib/i18n/plural';
import { LOCALES, DEFAULT_LOCALE, type Locale } from '$lib/types';

const keysOf = (o: Record<string, unknown>) => Object.keys(o).sort();

describe('parity', () => {
	test('every catalogue has exactly the same keys', () => {
		const en = keysOf(catalogues.en as unknown as Record<string, unknown>);
		for (const locale of LOCALES) {
			expect(keysOf(catalogues[locale] as unknown as Record<string, unknown>), locale).toEqual(en);
		}
	});

	test('every value has the same TYPE in every catalogue', () => {
		// A key that is a string in English and a function in Turkish compiles
		// (both are assignable through a widened type in some positions) and
		// throws at render time, in one language only.
		for (const key of keysOf(catalogues.en as unknown as Record<string, unknown>)) {
			const expected = typeof (catalogues.en as any)[key];
			for (const locale of LOCALES) {
				expect(typeof (catalogues[locale] as any)[key], `${locale}.${key}`).toBe(expected);
			}
		}
	});

	test('every function takes the same number of arguments in every catalogue', () => {
		for (const key of keysOf(catalogues.en as unknown as Record<string, unknown>)) {
			const source = (catalogues.en as any)[key];
			if (typeof source !== 'function') continue;
			for (const locale of LOCALES) {
				expect((catalogues[locale] as any)[key].length, `${locale}.${key}`).toBe(source.length);
			}
		}
	});

	test('no value is empty, and no string still reads as a placeholder', () => {
		for (const locale of LOCALES) {
			for (const [key, value] of Object.entries(catalogues[locale] as any)) {
				if (typeof value === 'string') {
					expect(value.trim().length, `${locale}.${key}`).toBeGreaterThan(0);
					expect(value, `${locale}.${key}`).not.toMatch(/TODO|FIXME|XXX/i);
				}
			}
		}
	});

	test('every catalogue is genuinely a translation, not a copy of English', () => {
		// A guard against the failure that looks like success: a `de.ts` that was
		// created by copying `en.ts` and never finished. Some overlap is real
		// ("Zembil", "Admin"), so this asserts a proportion rather than perfection.
		for (const locale of LOCALES.filter((l) => l !== 'en')) {
			const entries = Object.entries(catalogues[locale] as any).filter(
				([, v]) => typeof v === 'string'
			);
			const identical = entries.filter(
				([k, v]) => (catalogues.en as any)[k] === v
			);
			expect(identical.length / entries.length, `${locale} identical share`).toBeLessThan(0.1);
		}
	});
});

describe('Turkish does not inflect a counted noun, and must not pretend to', () => {
	test.each([1, 2, 5, 11, 100])('cardToBuy(%i) uses one form', (n) => {
		// "3 ürün", never "3 ürünler". `plural()` picking `other` for every n IS
		// the correct Turkish, which is why the catalogue supplies one form.
		expect(catalogues.tr.cardToBuy(n)).toContain('ürün');
		expect(catalogues.tr.cardToBuy(n)).not.toContain('ürünler');
	});

	test('German DOES inflect where English does', () => {
		expect(catalogues.de.finishBought(1)).not.toBe(catalogues.de.finishBought(2));
		expect(catalogues.de.finishBought(1)).toContain('Sache');
		expect(catalogues.de.finishBought(2)).toContain('Sachen');
	});

	test('English inflects too', () => {
		expect(catalogues.en.rowCarried(1)).toContain('1 time');
		expect(catalogues.en.rowCarried(3)).toContain('3 times');
	});
});

describe('no shop or person name is glued to a case suffix', () => {
	// Turkish vowel harmony needs "Migros'a" but "BİM'e", and nothing in this
	// codebase can know which. Every phrase built around a name must therefore
	// route the suffix onto a fixed word instead.
	const names = ['Migros', 'BİM', 'A101', 'Şok'];

	test.each(names)('addSheetTitle(%s) leaves the name untouched', (name) => {
		const rendered = catalogues.tr.addSheetTitle(name);
		expect(rendered).toContain(name);
		// The character immediately after the name must be a space, never an
		// apostrophe or a letter — either would be an invented suffix.
		const after = rendered[rendered.indexOf(name) + name.length];
		expect(after, rendered).toBe(' ');
	});

	test.each(names)('itemInStore(%s) leaves the name untouched', (name) => {
		const rendered = catalogues.tr.itemInStore(name);
		const after = rendered[rendered.indexOf(name) + name.length];
		expect(after, rendered).toBe(' ');
	});

	test('claimByOther puts no suffix on a person name', () => {
		for (const name of ['Ayşe', 'Baba', 'Ahmet']) {
			const rendered = catalogues.tr.claimByOther(name);
			const after = rendered[rendered.indexOf(name) + name.length];
			expect(after, rendered).toBe(' ');
		}
	});
});

describe('interpolation actually interpolates', () => {
	test('every single-string function includes its argument', () => {
		const marker = '⟪MARK⟫';
		for (const locale of LOCALES) {
			for (const [key, value] of Object.entries(catalogues[locale] as any)) {
				if (typeof value !== 'function' || value.length !== 1) continue;
				// Number-taking functions are covered by the plural tests; this pass
				// is for the ones that take a name.
				const rendered = (value as (s: string) => string)(marker);
				if (typeof rendered !== 'string') continue;
				if (rendered.includes(marker)) continue;
				// A function that ignores its argument entirely is a translation
				// that dropped the variable — the sentence still reads, and the
				// shop name is gone.
				expect.fail(`${locale}.${key} ignored its argument: ${rendered}`);
			}
		}
	});
});

describe('messagesFor', () => {
	test('returns the right catalogue for each locale', () => {
		for (const locale of LOCALES) {
			expect(messagesFor(locale)).toBe(catalogues[locale]);
		}
	});

	test('falls back to the default for anything it does not recognise', () => {
		// The ONE fallback in the system, and it is for values arriving from
		// outside the type system — a stored column, a URL, a header.
		for (const bad of [undefined, null, '', 'fr', 'EN', 42, {}, []]) {
			expect(messagesFor(bad)).toBe(catalogues[DEFAULT_LOCALE]);
		}
	});

	test('isLocale accepts exactly the three, with no case folding', () => {
		for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
		for (const bad of ['EN', 'tr-TR', 'de_DE', 'fr', '', null, 7]) {
			expect(isLocale(bad)).toBe(false);
		}
	});
});

describe('the language picker', () => {
	test('each language names itself in itself', () => {
		// Somebody who has landed in a language they cannot read has to be able to
		// find their way out, so the picker never localises its own labels.
		expect(LANGUAGE_NAMES.tr).toBe('Türkçe');
		expect(LANGUAGE_NAMES.de).toBe('Deutsch');
		expect(LANGUAGE_NAMES.en).toBe('English');
		expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual([...LOCALES].sort());
	});
});

describe('plural()', () => {
	test('falls back to `other` when a category is not supplied', () => {
		expect(plural('en', 1, { other: 'x' })).toBe('x');
		expect(plural('tr', 5, { other: 'x' })).toBe('x');
	});

	test('picks `one` for English and German at n=1 only', () => {
		for (const locale of ['en', 'de'] as Locale[]) {
			expect(plural(locale, 1, { one: 'ONE', other: 'OTHER' })).toBe('ONE');
			expect(plural(locale, 0, { one: 'ONE', other: 'OTHER' })).toBe('OTHER');
			expect(plural(locale, 2, { one: 'ONE', other: 'OTHER' })).toBe('OTHER');
		}
	});

	test('num formats in the reader locale', () => {
		expect(num('en', 1234)).toBe('1,234');
		expect(num('de', 1234)).toBe('1.234');
	});
});
