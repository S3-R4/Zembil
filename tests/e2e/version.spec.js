import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * The version line — CONTRACT.md §11.1.
 *
 * A unit test can prove `displayVersion()` returns `v0.8`. Only a browser can
 * prove the line actually renders, that it renders in the member's language,
 * and — the part that matters most — that it renders on the account screen and
 * NOWHERE a stranger can reach.
 */

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const [major, minor, patch] = pkg.version.split('.');
const LABEL = patch === '0' ? `v${major}.${minor}` : `v${major}.${minor}.${patch}`;

test('the account screen shows the version, small and last', async ({ page }) => {
	await page.goto('/you');

	const line = page.locator('footer.version');
	// Day-first, per DESIGN.md §4 — English is formatted as `en-GB` so the date
	// agrees with the rest of the interface rather than with `Intl`'s idea of
	// what a bare `en` means.
	await expect(line).toHaveText(
		new RegExp(`^Zembil ${LABEL.replace('.', '\\.')} · as of \\d{1,2} \\w+ \\d{4}$`)
	);

	// Subtle is a requirement, not a preference (§11.1): it must be smaller and
	// dimmer than the body text around it, and it must not be a control.
	const size = await line.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
	expect(size).toBeLessThanOrEqual(12);
	await expect(line.locator('a, button')).toHaveCount(0);

	// Last on the page: below the Sign out button, which is the final control.
	const signOut = await page.getByRole('button', { name: 'Sign out' }).boundingBox();
	const box = await line.boundingBox();
	if (!signOut || !box) throw new Error('the account screen is missing Sign out or the version line');
	expect(box.y).toBeGreaterThan(signOut.y);
});

test('it follows the interface language', async ({ page }) => {
	await page.goto('/you');
	await page.getByRole('button', { name: 'Türkçe' }).click();
	await expect(page.getByRole('link', { name: 'Hesabım' })).toBeVisible();

	// The date is formatted with `users.locale`, not with the browser's own
	// setting: a September written in English beside Turkish labels reads as a
	// bug, and the whole point of §8.5 is that the member's column decides.
	await expect(page.locator('footer.version')).toHaveText(/itibarıyla$/);
	await expect(page.locator('footer.version')).not.toHaveText(/September/);

	await page.getByRole('button', { name: 'English' }).click();
	await expect(page.getByRole('link', { name: 'You' })).toBeVisible();
});

test('no version is exposed to anyone who is not signed in', async ({ browser }) => {
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		storageState: { cookies: [], origins: [] }
	});
	try {
		const page = await context.newPage();

		// The sign-in screen and the health endpoint are both reachable by anyone
		// who finds the hostname. §3.8 refuses to report a build for exactly this
		// reason, and the login screen must not undo that by printing one.
		await page.goto('/login');
		await expect(page.locator('footer.version')).toHaveCount(0);
		expect(await page.content()).not.toContain(LABEL);

		const health = await page.request.get('/api/health');
		expect(await health.json()).toEqual({ status: 'ok' });
	} finally {
		await context.close();
	}
});
