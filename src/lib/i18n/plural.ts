/**
 * Plural selection — CONTRACT.md §8.5 gives us three languages and no library
 * to pick a form with.
 *
 * `Intl.PluralRules` is in the platform, knows every locale's categories, and
 * costs nothing to construct once. Writing `n === 1 ? a : b` per catalogue
 * would be right for English and German and quietly wrong for Turkish, where a
 * counted noun does not take the plural suffix at all: "3 ürün", never
 * "3 ürünler". So the Turkish catalogue supplies ONE form and this helper is
 * what makes supplying one form correct rather than lazy.
 */
import type { Locale } from '$lib/types';

/** The categories a catalogue may supply. `other` is mandatory: every locale
 *  has it, and it is the fallback for any category a catalogue omits. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };

const rules = new Map<Locale, Intl.PluralRules>();

function rulesFor(locale: Locale): Intl.PluralRules {
	let existing = rules.get(locale);
	if (!existing) {
		existing = new Intl.PluralRules(locale);
		rules.set(locale, existing);
	}
	return existing;
}

export function pluralCategory(locale: Locale, n: number): Intl.LDMLPluralRule {
	return rulesFor(locale).select(n);
}

/**
 * Picks the form for `n` in `locale`, falling back to `other`.
 *
 * The fallback is the whole design: a catalogue that gives only `other` is
 * declaring "this language does not inflect here", which is the truth in
 * Turkish, and a catalogue that gives `one` and `other` gets English and German
 * agreement for free.
 */
export function plural(locale: Locale, n: number, forms: PluralForms): string {
	return forms[pluralCategory(locale, n)] ?? forms.other;
}

/** Digits in the reader's locale. Latin digits for all three of ours today, but
 *  the number and the sentence around it should not disagree if that changes. */
export function num(locale: Locale, n: number): string {
	return new Intl.NumberFormat(locale).format(n);
}
