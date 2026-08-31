/**
 * Appearance — Light / Auto / Dark, per docs/DESIGN.md §4 (Account screen).
 *
 * Stored per browser in localStorage, because it is a per-device preference:
 * the phone in a dark kitchen and the tablet on a sunlit counter should not
 * have to agree, and it is not worth a column and a round trip.
 */
export type Appearance = 'light' | 'auto' | 'dark';

const KEY = 'zembil:appearance';

export function readAppearance(): Appearance {
	if (typeof localStorage === 'undefined') return 'auto';
	try {
		const raw = localStorage.getItem(KEY);
		return raw === 'light' || raw === 'dark' ? raw : 'auto';
	} catch {
		// Private mode, or site data blocked. Auto is the honest default.
		return 'auto';
	}
}

/**
 * 'auto' REMOVES the attribute rather than setting it to anything. The token
 * blocks in app.css are written as `:root:not([data-theme="light"])` under
 * `prefers-color-scheme: dark`, so the absence of the attribute is what lets
 * the OS decide.
 */
export function applyAppearance(value: Appearance): void {
	const root = document.documentElement;
	if (value === 'auto') root.removeAttribute('data-theme');
	else root.setAttribute('data-theme', value);
}

export function saveAppearance(value: Appearance): void {
	applyAppearance(value);
	try {
		localStorage.setItem(KEY, value);
	} catch {
		/* nothing to do; the choice lasts for this page */
	}
}
