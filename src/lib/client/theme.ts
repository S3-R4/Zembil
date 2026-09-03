/**
 * Theme — the client half of a preference the SERVER owns.
 *
 * `users.theme` (migration 004) is the single source. `hooks.server.ts`
 * substitutes it into `<html data-theme>` before the document leaves the
 * process, so the first paint is already correct and there is nothing here to
 * do on a cold load. This module exists for the other case: changing the theme
 * inside the app is a client-side navigation, which re-runs `load` and
 * re-renders the body while leaving `<html>` exactly as it was served — the
 * same asymmetry that `document.documentElement.lang` has to be fixed up for.
 *
 * It replaces the old `localStorage` appearance, which is gone on purpose. A
 * per-device value could not be read during SSR, which is what made the theme
 * flash (PROJECT.md §13), and it meant a member's phone and tablet disagreed
 * about what their own app looks like.
 */
import { DEFAULT_THEME, THEMES, type Theme } from '$lib/types';

/**
 * `auto` is SET, not removed. The token blocks in `app.css` match
 * `:root[data-theme='auto']` alongside `:root:not([data-theme])`, because with
 * eight themes the absence of the attribute can no longer stand in for "follow
 * the OS" — it has to mean it explicitly, or `sepia` would be repainted dark by
 * the `prefers-color-scheme` block.
 */
export function applyTheme(value: Theme): void {
	document.documentElement.setAttribute('data-theme', value);
}

/** For a value arriving from outside the type system — page data deserialised
 *  from the server, or a column read through an older connection. */
export function asTheme(value: unknown): Theme {
	return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
		? (value as Theme)
		: DEFAULT_THEME;
}
