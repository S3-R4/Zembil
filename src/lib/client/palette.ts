import type { StoreColor } from '$lib/types';

/** The eight keys of CONTRACT.md §1.1. A key selects a CSS class; it is never
 *  interpolated into a style, which is why the server validates it against this
 *  same closed set. */
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
