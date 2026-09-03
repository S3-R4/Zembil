/**
 * Interface theme — CONTRACT.md §10.1, migration 004.
 *
 * The theme used to live in `localStorage`. It now lives in `users.theme`, and
 * the whole value of that move is in two properties this file exists to hold
 * down:
 *
 *   1. it follows the ACCOUNT, so a second device agrees with the first, and
 *   2. it reaches `<html data-theme>` during SSR, so the first frame is already
 *      right — the theme flash PROJECT.md §13 listed as a known gap.
 *
 * The second one is not observable from a status code, so it is asserted where
 * it actually happens: through `createHandle`'s `transformPageChunk`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Handle } from '@sveltejs/kit';
import { createHandle } from '$lib/server/auth/handle';
import { resolveSession } from '$lib/server/auth/session';
import { setPreferences, setTheme } from '$lib/server/auth/users';
import { validateTheme } from '$lib/server/auth/theme';
import { THEMES } from '$lib/types';
import { GET as getMe, PATCH as patchMe } from '../../src/routes/api/me/+server';
import { setDb } from '$lib/server/db';
import {
	authHarness,
	bodyOf,
	cookiesWithSession,
	localsOf,
	routeEvent,
	seedUser,
	signIn,
	type AuthHarness,
	type SeededUser
} from './_support';

let h: AuthHarness;
let ayse: SeededUser;

beforeEach(async () => {
	h = authHarness();
	setDb(h.db);
	ayse = await seedUser(h.db);
});
afterEach(() => {
	setDb(null);
	h.close();
});

const themeOf = (id: string) =>
	(h.db.prepare('SELECT theme FROM users WHERE id = ?').get(id) as any).theme;

async function patch(body: unknown, locals: App.Locals) {
	return patchMe(
		routeEvent({ method: 'PATCH', path: '/api/me', routeId: '/api/me', body, locals }) as never
	);
}

// --------------------------------------------------------------------------
// The column
// --------------------------------------------------------------------------

describe('migration 004 — users.theme', () => {
	it('defaults to auto for a row that never named one', () => {
		expect(themeOf(ayse.id)).toBe('auto');
	});

	it('rejects a value outside the eight at the SCHEMA, not only in the validator', () => {
		// The validator is the 400; this is the reason a bypass of it would be a
		// crash rather than a stored value the stylesheet cannot render.
		expect(() =>
			h.db.prepare('UPDATE users SET theme = ? WHERE id = ?').run('neon', ayse.id)
		).toThrow();
		expect(themeOf(ayse.id)).toBe('auto');
	});

	it('accepts every theme the type system offers — the two lists cannot drift', () => {
		for (const theme of THEMES) {
			h.db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, ayse.id);
			expect(themeOf(ayse.id)).toBe(theme);
		}
	});
});

// --------------------------------------------------------------------------
// PATCH /api/me
// --------------------------------------------------------------------------

describe('PATCH /api/me — theme', () => {
	it('sets the caller`s own theme and returns the updated user', async () => {
		const res = await patch({ theme: 'indigo' }, localsOf(ayse, 'sid'));
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.user.theme).toBe('indigo');
		expect(body.user.id).toBe(ayse.id);
		expect(themeOf(ayse.id)).toBe('indigo');
	});

	it('accepts each theme and is idempotent', async () => {
		for (const theme of [...THEMES, 'plum', 'plum']) {
			const res = await patch({ theme }, localsOf(ayse, 'sid'));
			expect(res.status, theme).toBe(200);
			expect((await bodyOf(res)).user.theme).toBe(theme);
		}
	});

	it('sets locale and theme together, in one update', async () => {
		const res = await patch({ locale: 'tr', theme: 'sage' }, localsOf(ayse, 'sid'));
		expect(res.status).toBe(200);
		const body = await bodyOf(res);
		expect(body.user.locale).toBe('tr');
		expect(body.user.theme).toBe('sage');
	});

	it('leaves the other preference alone when only one is sent', async () => {
		await patch({ locale: 'de' }, localsOf(ayse, 'sid'));
		await patch({ theme: 'plum' }, localsOf(ayse, 'sid'));
		const row = h.db.prepare('SELECT locale, theme FROM users WHERE id = ?').get(ayse.id) as any;
		expect(row.locale).toBe('de');
		expect(row.theme).toBe('plum');
	});

	it('rejects an unknown, null or non-string theme with 400 and writes nothing', async () => {
		const locals = localsOf(ayse, 'sid');
		for (const body of [
			{ theme: null },
			{ theme: '' },
			{ theme: 'neon' },
			{ theme: 'Dark' },
			{ theme: 'auto ' },
			{ theme: 7 },
			{ theme: true },
			{ theme: ['dark'] },
			{ theme: { value: 'dark' } }
		]) {
			const res = await patch(body, locals);
			expect(res.status, JSON.stringify(body)).toBe(400);
			expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
		}
		expect(themeOf(ayse.id)).toBe('auto');
	});

	it('rejects a patch carrying a valid theme and an invalid locale, in full', async () => {
		const res = await patch({ theme: 'plum', locale: 'fr' }, localsOf(ayse, 'sid'));
		expect(res.status).toBe(400);
		// Both validators run before the UPDATE, so a half-valid body is a
		// half-applied nothing rather than a half-applied change.
		expect(themeOf(ayse.id)).toBe('auto');
	});

	it('a null theme beside a VALID locale is still 400 — present, not truthy', async () => {
		// The trap the `has()` helper exists for: reading presence with a truthy
		// test would make `{ theme: null }` mean "not part of this patch", so this
		// body would quietly apply the locale and drop the theme on the floor.
		const res = await patch({ locale: 'tr', theme: null }, localsOf(ayse, 'sid'));
		expect(res.status).toBe(400);
		const row = h.db.prepare('SELECT locale, theme FROM users WHERE id = ?').get(ayse.id) as any;
		expect(row.locale).toBe('en');
		expect(row.theme).toBe('auto');
	});

	it('an empty body is still 400 — the shape `locale` had before `theme` existed', async () => {
		const res = await patch({}, localsOf(ayse, 'sid'));
		expect(res.status).toBe(400);
		expect((await bodyOf(res)).error.code).toBe('VALIDATION_FAILED');
	});

	it('cannot set another member`s theme under any body, even as an admin', async () => {
		const admin = await seedUser(h.db, { username: 'root', isAdmin: true });
		const victim = ayse;
		for (const extra of [
			{ userId: victim.id },
			{ id: victim.id },
			{ user_id: victim.id },
			{ username: victim.username }
		]) {
			const res = await patch({ theme: 'plum', ...extra }, localsOf(admin, 'sid'));
			expect(res.status).toBe(200);
			expect((await bodyOf(res)).user.id).toBe(admin.id);
		}
		expect(themeOf(victim.id)).toBe('auto');
		expect(themeOf(admin.id)).toBe('plum');
	});

	it('is 401 without a session', async () => {
		const res = await patch({ theme: 'dark' }, localsOf(null));
		expect(res.status).toBe(401);
	});
});

describe('GET /api/me — theme', () => {
	it('carries the theme, so a client that never patched still knows which it is on', async () => {
		// §3.2: GET /api/me echoes the session's user, and `resolveSession` builds
		// that from the column — which the SSR tests below exercise end to end.
		// Here the question is only whether the field survives the response shape.
		const res = await getMe(
			routeEvent({
				method: 'GET',
				path: '/api/me',
				routeId: '/api/me',
				locals: localsOf(ayse, 'sid', { theme: 'contrast' })
			}) as never
		);
		expect((await bodyOf(res)).user.theme).toBe('contrast');
	});

	it('resolveSession reads the column, so the value in `locals` is the stored one', () => {
		setTheme(h.db, ayse.id, 'contrast');
		const { token } = signIn(h.db, ayse.id);
		expect(resolveSession(h.db, token)?.user.theme).toBe('contrast');
	});
});

// --------------------------------------------------------------------------
// The reason the column exists: the first frame
// --------------------------------------------------------------------------

describe('§10.1 — the theme reaches the document before it is painted', () => {
	/**
	 * Runs the real `handle` against a real session cookie, capturing what
	 * `transformPageChunk` did to the shell. `locals` cannot be injected here:
	 * `handle` clears it and resolves the session itself, which is exactly the
	 * property being tested — the theme comes from the COLUMN by way of the
	 * session, not from anything a caller supplied.
	 */
	async function render(cookies: ReturnType<typeof cookiesWithSession> | undefined) {
		const handle: Handle = createHandle(h.db, h.config);
		const event = routeEvent({ method: 'GET', path: '/', routeId: '/', cookies });
		const shell = '<html lang="%zembil.lang%" data-theme="%zembil.theme%"></html>';
		const response = await (handle as any)({
			event,
			resolve: (_: unknown, opts: any) =>
				Promise.resolve(
					new Response(opts.transformPageChunk({ html: shell }), {
						status: 200,
						headers: { 'content-type': 'text/html' }
					})
				)
		});
		return response.text();
	}

	it('substitutes the signed-in member`s theme, not a default', async () => {
		setTheme(h.db, ayse.id, 'sepia');
		const html = await render(cookiesWithSession(signIn(h.db, ayse.id).token));
		expect(html).toContain('data-theme="sepia"');
		expect(html).not.toContain('%zembil.theme%');
	});

	it('substitutes `auto` when nobody is signed in — the sign-in screen follows the device', async () => {
		const html = await render(undefined);
		expect(html).toContain('data-theme="auto"');
		expect(html).not.toContain('%zembil.theme%');
	});

	it('leaves the language substitution working beside it', async () => {
		setPreferences(h.db, ayse.id, { locale: 'tr', theme: 'plum' });
		const html = await render(cookiesWithSession(signIn(h.db, ayse.id).token));
		expect(html).toContain('lang="tr"');
		expect(html).toContain('data-theme="plum"');
		expect(html).not.toContain('%zembil.lang%');
	});
});

describe('validateTheme', () => {
	it('is the only gate, and it is exact', () => {
		for (const theme of THEMES) expect(validateTheme(theme)).toBe(theme);
		for (const bad of ['', 'AUTO', ' dark', 'dark ', 'neon', null, 7, {}, []]) {
			expect(() => validateTheme(bad)).toThrow();
		}
	});
});

describe('setPreferences', () => {
	it('refuses a call that would set nothing rather than writing an empty UPDATE', () => {
		expect(() => setPreferences(h.db, ayse.id, {})).toThrow();
	});
});
