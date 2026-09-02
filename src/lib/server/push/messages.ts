/**
 * Push notification text — CONTRACT.md §8.7, §8.5.
 *
 * A deliberately separate, tiny catalogue rather than an import from
 * `src/lib/i18n/**`. Two reasons, and the second is the load-bearing one:
 *
 * 1. This text is composed on the SERVER, per recipient, in that recipient's
 *    `users.locale` — a notification is read by somebody who is not the person
 *    who triggered it, so the client that displays it cannot translate it.
 * 2. The client catalogue is a client bundle. Reaching into it from
 *    `src/lib/server/` couples a server module to something that may be
 *    tree-shaken, lazily loaded or reorganised for reasons that have nothing to
 *    do with push. Nine strings are cheaper than that coupling.
 *
 * The three languages are not one template with the words swapped:
 *
 * - **Turkish does not pluralise a noun after a numeral.** "4 ürün", never
 *   "4 ürünler". Writing `${n} ${noun}${n === 1 ? '' : 'ler'}` is the English
 *   rule wearing Turkish words, and it is wrong in every case but n = 1.
 * - **Turkish puts "daha" ("more") after the noun phrase**, not before it:
 *   "ve 4 ürün daha", not "ve daha 4 ürün".
 * - **German inflects the adjective with the number**: "1 weiterer Artikel"
 *   (nominative singular masculine) vs "4 weitere Artikel". The noun itself is
 *   identical in both — the plural is carried by the adjective, which is the
 *   opposite of where English carries it.
 */
import type { Locale } from '$lib/types';

export interface PushPayload {
	title: string;
	body: string;
	/** §8.7: no user ids, no item ids, no note text. Just where to go. */
	data: { url: string };
	/**
	 * Collapses a re-notification for the same store onto the same slot on the
	 * device rather than stacking. The store id is already in `data.url`.
	 */
	tag: string;
}

export interface PayloadInput {
	storeId: string;
	storeName: string;
	/** Up to MAX_NAMES_PER_BATCH of them, in the order they were added. */
	names: string[];
	/** The TRUE number added, which may exceed `names.length`. */
	count: number;
}

/** "a", "a and b", "a, b and c" — the conjunction is the only per-language part. */
function joinList(names: string[], and: string): string {
	if (names.length === 0) return '';
	if (names.length === 1) return names[0];
	return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]}`;
}

interface Catalogue {
	/** The conjunction used between the last two names of a complete list. */
	and: string;
	/** "… and 4 more items" — appended after a comma-joined list. */
	more(n: number): string;
	/** Fallback when the batch carried no names at all (defensive; see below). */
	countOnly(n: number): string;
}

const CATALOGUES: Record<Locale, Catalogue> = {
	en: {
		and: 'and',
		more: (n) => (n === 1 ? 'and 1 more item' : `and ${n} more items`),
		countOnly: (n) => (n === 1 ? '1 new item' : `${n} new items`)
	},
	tr: {
		and: 've',
		// No plural suffix after a numeral: "4 ürün daha", not "4 ürünler daha".
		// "daha" trails the noun phrase.
		more: (n) => `ve ${n} ürün daha`,
		countOnly: (n) => `${n} yeni ürün`
	},
	de: {
		and: 'und',
		// The number is carried by the adjective ending, not by the noun:
		// "1 weiterer Artikel" / "4 weitere Artikel".
		more: (n) => (n === 1 ? 'und 1 weiterer Artikel' : `und ${n} weitere Artikel`),
		countOnly: (n) => (n === 1 ? '1 neuer Artikel' : `${n} neue Artikel`)
	}
};

/** Anything outside the I-14 set falls back to English rather than throwing —
 *  a locale nobody validated must not be able to silence a notification. */
export function catalogueFor(locale: string): Catalogue {
	return CATALOGUES[locale as Locale] ?? CATALOGUES.en;
}

/**
 * §8.7: title is the store name, resolved at DELIVERY time so a store renamed
 * during the quiet window notifies under its current name.
 */
export function composePayload(locale: string, input: PayloadInput): PushPayload {
	const c = catalogueFor(locale);
	const names = input.names.slice(0, input.count);
	const extra = Math.max(0, input.count - names.length);

	let body: string;
	if (names.length === 0) {
		// The coalescer always carries at least one name for a non-zero count, so
		// this is unreachable through `noteItemAdded`. It exists because the
		// alternative to a fallback is an empty notification body, and a member
		// receiving a blank buzz cannot tell it from a bug in their phone.
		body = c.countOnly(input.count);
	} else if (extra === 0) {
		body = joinList(names, c.and);
	} else {
		// With a "more" clause the list stays comma-joined throughout: "milk,
		// bread and eggs and 2 more items" reads as a mistake in all three
		// languages, so the conjunction is spent on the more-clause instead.
		body = `${names.join(', ')} ${c.more(extra)}`;
	}

	return {
		title: input.storeName,
		body,
		data: { url: `/s/${input.storeId}` },
		tag: `zembil-store-${input.storeId}`
	};
}
