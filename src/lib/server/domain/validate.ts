/**
 * String and scalar input validation — CONTRACT.md §3.1a.
 *
 * Normative and applied BEFORE any database write. A `CHECK` constraint that
 * reaches the user is a 500, and a 500 on a 250-character paste into the add
 * sheet is a defect. The DDL's length checks are the backstop that catches a
 * route which forgot to validate — in tests, not in production.
 */
import { validationFailed } from './errors.js';
import type { StoreColor, StoreVisibility } from '$lib/types';

export const STORE_COLORS: readonly StoreColor[] = Object.freeze([
	'terracotta',
	'green',
	'violet',
	'blue',
	'amber',
	'rose',
	'teal',
	'slate'
]);

/** §3.1a: "trim means Unicode whitespace, and the trimmed value is what is stored." */
export function trimUnicode(value: string): string {
	return value.trim();
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== 'string') throw validationFailed(`${field} must be text.`);
	return value;
}

export function requiredText(value: unknown, field: string, max: number): string {
	const trimmed = trimUnicode(requireString(value, field));
	if (trimmed.length < 1) throw validationFailed(`${field} cannot be empty.`);
	if (trimmed.length > max) throw validationFailed(`${field} is too long (max ${max}).`);
	return trimmed;
}

/** `null`, absent, or empty-after-trim all store as NULL. */
export function optionalText(value: unknown, field: string, max: number): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = trimUnicode(requireString(value, field));
	if (trimmed.length === 0) return null;
	if (trimmed.length > max) throw validationFailed(`${field} is too long (max ${max}).`);
	return trimmed;
}

export const itemName = (value: unknown) => requiredText(value, 'Name', 200);
export const itemNote = (value: unknown) => optionalText(value, 'Note', 500);
/**
 * §3.1a, tightened by the M6 audit: a store name carries no control characters.
 *
 * This is load-bearing, not hygiene. `stores.name_key` namespaces a private
 * store's key as `<ownerId> U+001F <normalized name>` (migration 003), so a
 * name containing U+001F could be crafted to land in another member's key space
 * and collide with — or shadow — their private shop. Rejecting the whole C0/C1
 * range costs nothing: no shop is called anything with a control character in
 * it, and `trim()` has already removed the whitespace ones a paste might carry.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/u;

export const storeName = (value: unknown) => {
	const name = requiredText(value, 'Name', 60);
	if (CONTROL_CHARS.test(name)) throw validationFailed('Name cannot contain control characters.');
	return name;
};

/**
 * §8.6: a claim note is 1–140 characters after §3.1c trimming; `null`, absent or
 * empty-after-trim clears it. Validated HERE and not by the migration-002
 * `CHECK`, for the §3.1a reason: a constraint that reaches the user is a 500,
 * and a 500 on a long note is a defect, not validation.
 */
export const claimNote = (value: unknown) => optionalText(value, 'Note', 140);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** §3.1a: `clientId` must parse as a UUID; rejected otherwise. */
export function clientId(value: unknown): string {
	const raw = requireString(value, 'clientId');
	if (!UUID_RE.test(raw)) throw validationFailed('clientId must be a UUID.');
	return raw;
}

export function storeColor(value: unknown): StoreColor {
	// Reaches a CSS class name, so it is validated against the enum server-side
	// and never interpolated. §3.4.
	if (typeof value !== 'string' || !STORE_COLORS.includes(value as StoreColor)) {
		throw validationFailed('Unknown colour.');
	}
	return value as StoreColor;
}

export const STORE_VISIBILITIES: readonly StoreVisibility[] = Object.freeze([
	'public',
	'private'
]);

/**
 * §8.6 / §8.4: a closed enum, validated exactly like `storeColor`. The value
 * decides whether a store is visible to the rest of the family, so anything
 * outside the enum is a 400 rather than a silently-ignored field — an ignored
 * `visibilty` typo would return 200 and leave a store the caller believes is
 * private fully public.
 */
export function storeVisibility(value: unknown): StoreVisibility {
	if (typeof value !== 'string' || !STORE_VISIBILITIES.includes(value as StoreVisibility)) {
		throw validationFailed('Unknown visibility.');
	}
	return value as StoreVisibility;
}

/**
 * §3.1b. `Number.isSafeInteger`, never `Number.isInteger`.
 *
 * `Number.isInteger` returns true for `1e300` and for `9007199254740993`, and
 * both reach the database. `1e300` is a REAL, which a STRICT table rejects on
 * bind — a 500 where §3.1a promises a 400. `9007199254740993` is worse: it
 * COMMITS, as `9007199254740992`, and because `node:sqlite` has BigInt off
 * (§1.1a) every later read of that row throws `RangeError [ERR_OUT_OF_RANGE]`.
 * One PATCH body from any authenticated family member would make `GET
 * /api/stores` a permanent 500 for everyone, with no way back through the API.
 */
export function integer(value: unknown, field: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw validationFailed(`${field} must be a whole number.`);
	}
	return value;
}

export function boolean(value: unknown, field: string): boolean {
	if (typeof value !== 'boolean') throw validationFailed(`${field} must be true or false.`);
	return value;
}

export function boundedInt(value: unknown, field: string, min: number, max: number): number {
	const n = integer(value, field);
	if (n < min || n > max) throw validationFailed(`${field} must be between ${min} and ${max}.`);
	return n;
}

/** §3.1b: a range bound on top of `isSafeInteger` wherever a client-supplied
 *  integer is STORED DIRECTLY, which today is `sortOrder` alone (R-15). */
export const INT32_MIN = -2147483648;
export const INT32_MAX = 2147483647;

export const sortOrder = (value: unknown) =>
	boundedInt(value, 'sortOrder', INT32_MIN, INT32_MAX);

/** §3.1b: `isSafeInteger`, `>= 1`. Not written today; it shares the helper. */
export const itemVersion = (value: unknown) =>
	boundedInt(value, 'version', 1, Number.MAX_SAFE_INTEGER);

/** §3.1b: the trip history cursor — `isSafeInteger`, `>= 1`. `trips.seq >= 1`. */
export const beforeSeq = (value: unknown) =>
	boundedInt(value, 'before', 1, Number.MAX_SAFE_INTEGER);

/** NFKC + lowercase + collapsed whitespace — the `stores.name_key` normalization. */
export function storeNameKey(name: string): string {
	return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * The delimiter between a private store's owner and its normalized name.
 * `storeName` rejects control characters, so a name can never contain one.
 */
export const NAME_KEY_SEPARATOR = '\u001f';

/**
 * §8.4 / migration 003: the stored `name_key`, scoped to the store's visibility.
 *
 * Uniqueness has to have the same scope as visibility, or the UNIQUE constraint
 * becomes an oracle — the M6 audit found that a table-wide key let any member
 * discover a private store's NAME by guessing it and reading the 409. Public
 * names stay unique among public stores; each member's private names stay
 * unique to that member; the two spaces never meet.
 *
 * `privateTo` is the owner id for a private store and `null` for a public one.
 * It is ALWAYS the value being written, never the value currently stored — a
 * store changing visibility changes its key in the same transaction.
 */
export function scopedNameKey(name: string, privateTo: string | null): string {
	const key = storeNameKey(name);
	return privateTo === null ? key : `${privateTo}${NAME_KEY_SEPARATOR}${key}`;
}
