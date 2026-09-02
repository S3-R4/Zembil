/**
 * Interface language — CONTRACT.md §8.5, I-14.
 *
 * Two jobs, and they are deliberately separate:
 *
 *  1. `validateLocale` guards `PATCH /api/me`. It is the only way a locale is
 *     ever chosen after an account exists.
 *  2. `negotiateAcceptLanguage` picks the INITIAL value at account creation,
 *     from the creating request's `Accept-Language`. §8.5 is explicit that this
 *     is the one and only moment a header is consulted: a per-request header
 *     would make the same account render differently on two devices and would
 *     make server-composed push text depend on whichever device made the last
 *     request.
 *
 * The header is attacker-controlled, so the parser is bounded on every axis it
 * has — total bytes, number of entries, and the length of a single tag — before
 * any regular expression touches it.
 */
import { DEFAULT_LOCALE, LOCALES, type Locale } from '$lib/types';
import { DomainError } from '../domain/errors.js';

/**
 * How much of `Accept-Language` is parsed at all. A browser sends well under
 * 100 bytes; anything past this is either broken or hostile, and the tail of a
 * language header carries the least-preferred entries, so discarding it cannot
 * change the answer for a real client.
 */
export const ACCEPT_LANGUAGE_MAX_LENGTH = 512;

/** How many comma-separated entries are considered, after the byte cap. */
const MAX_ENTRIES = 32;

/** RFC 5646 caps a subtag at 8 characters; this bounds one whole tag. */
const MAX_TAG_LENGTH = 35;

/** Applied only to an already length-bounded tag, so it cannot backtrack far. */
const TAG_RE = /^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/;

function isLocale(value: string): value is Locale {
	return (LOCALES as readonly string[]).includes(value);
}

/**
 * §8.5: the request body's `locale`. Anything that is not one of the three
 * exact strings is `400 VALIDATION_FAILED` — no trimming, no case folding, no
 * "closest match". The column has the same `CHECK` (I-14); this exists so a bad
 * value is a 400 rather than a 500 from SQLite.
 */
export function validateLocale(value: unknown): Locale {
	if (typeof value !== 'string' || !isLocale(value)) {
		throw new DomainError(
			'VALIDATION_FAILED',
			400,
			`Language must be one of ${LOCALES.join(', ')}.`
		);
	}
	return value;
}

/**
 * Negotiates `Accept-Language` against the three supported locales, returning
 * `DEFAULT_LOCALE` when nothing matches. Pure: no database, no config, no
 * clock.
 *
 * - q-values are honoured; `q=0` means "not acceptable" and is dropped.
 * - Matching is on the primary subtag, so `tr-TR` → `tr` and `de-CH` → `de`.
 * - Ties are broken by position, which is what a client that omits q expects.
 * - `*` is ignored rather than expanded: expanding it can only ever produce the
 *   default, which is what we return anyway when nothing matched.
 */
export function negotiateAcceptLanguage(header: string | null | undefined): Locale {
	if (typeof header !== 'string' || header.length === 0) return DEFAULT_LOCALE;

	const truncated = header.length > ACCEPT_LANGUAGE_MAX_LENGTH;
	const bounded = truncated ? header.slice(0, ACCEPT_LANGUAGE_MAX_LENGTH) : header;

	const parts = bounded.split(',');
	// A truncated header's final entry was cut mid-token; it might have been
	// `de-facto-something` and now reads `de`, which would be a match we
	// invented. Drop it.
	if (truncated) parts.pop();

	let best: Locale | null = null;
	let bestQ = 0;

	for (const part of parts.slice(0, MAX_ENTRIES)) {
		const [rawTag, ...params] = part.split(';');
		const tag = rawTag.trim().toLowerCase();
		if (tag.length === 0 || tag.length > MAX_TAG_LENGTH || !TAG_RE.test(tag)) continue;

		const primary = tag.split('-')[0];
		if (!isLocale(primary)) continue;

		const q = qualityOf(params);
		// The `q <= 0` half is redundant with `bestQ` starting at 0 — a q=0 entry
		// can never beat it — and a mutation sweep confirms removing it changes no
		// observable behaviour. It stays because it states the RFC rule ("q=0 means
		// not acceptable") at the point the rule applies, and because a later
		// change to `bestQ`'s initial value would otherwise silently make q=0
		// rankable. Kept for the same reason as `requireSessionId` in guards.ts.
		if (q === null || q <= 0) continue;

		// Strictly greater, so an earlier entry wins a tie.
		if (q > bestQ) {
			best = primary;
			bestQ = q;
		}
	}

	return best ?? DEFAULT_LOCALE;
}

/** `null` means the parameters were malformed and the entry must be ignored. */
function qualityOf(params: string[]): number | null {
	let q = 1;
	for (const param of params) {
		const eq = param.indexOf('=');
		if (eq < 0) continue;
		const name = param.slice(0, eq).trim().toLowerCase();
		if (name !== 'q') continue; // other parameters (e.g. RFC 9110 extensions) do not affect rank
		const raw = param.slice(eq + 1).trim();
		if (!/^(?:0(?:\.\d{1,3})?|1(?:\.0{1,3})?)$/.test(raw)) return null;
		q = Number(raw);
	}
	return q;
}
