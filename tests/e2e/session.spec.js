import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD, BASE_URL } from '../../playwright.config.js';

/**
 * Two guards that were correct and untestable: the sign-in screen's `next=`
 * handling, and what the app does when the server says this session is gone.
 *
 * `safeNext` is thoroughly unit-tested as a function — but nothing checked that
 * login CALLS it. Replacing `next()` with a raw `searchParams.get('next')`
 * left every test green and an open redirect on the sign-in screen. That is
 * exactly D-030's "correct guard, test that cannot reach it".
 *
 * Runs after everything else: the first test signs out, which destroys the
 * session token the shared storage state holds.
 */

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} username
 * @param {string} password
 */
async function signIn(page, username, password) {
	await page.getByPlaceholder('Name').fill(username);
	await page.getByPlaceholder('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
}

test('sign-in refuses to bounce anywhere but this site', async ({ page, context }) => {
	// Start genuinely signed out rather than by signing out: the other spec in
	// this project also signs out, and depending on which ran first is how a
	// suite becomes order-sensitive.
	await context.clearCookies();

	// A link that really does go to the family's own hostname, really does sign
	// the member in, and then lands them somewhere else entirely.
	await page.goto('/login?next=https%3A%2F%2Fevil.example%2F');
	await signIn(page, 'admin', ADMIN_PASSWORD);

	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();
	expect(page.url().startsWith(BASE_URL)).toBe(true);
	expect(page.url()).not.toContain('evil.example');

	// And a genuine same-site target IS honoured, so the guard is not just
	// "always go home" — which is what it silently was until this test existed.
	await context.clearCookies();
	await page.goto('/login?next=%2Ftrips');
	await signIn(page, 'admin', ADMIN_PASSWORD);
	await expect(page).toHaveURL(/\/trips$/);
});

test('a disabled member is signed out of a live tab, not left holding a stale one', async ({
	page,
	browser
}) => {
	// Signs in for itself rather than inheriting the shared storage state, whose
	// session the other specs in this project destroy.
	await page.context().clearCookies();
	await page.goto('/login');
	await signIn(page, 'admin', ADMIN_PASSWORD);
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();

	// The admin makes an account.
	await page.goto('/you/admin');
	await page.getByRole('button', { name: 'New person' }).click();
	await page.getByPlaceholder('Username').fill('revoked-member');
	await page.getByPlaceholder('Name shown in the app').fill('Revoked Member');
	await page.getByRole('button', { name: 'Create account' }).click();

	const password = (await page.locator('.password').innerText()).trim();
	expect(password).toHaveLength(20);
	await page.getByRole('button', { name: 'I have written it down' }).click();

	// That member signs in on their own device and changes the temporary password.
	const theirs = await browser.newContext({ viewport: { width: 390, height: 844 } });
	const them = await theirs.newPage();
	await them.goto('/login');
	await signIn(them, 'revoked-member', password);
	await expect(them).toHaveURL(/\/password/);
	await them.getByPlaceholder('Temporary password').fill(password);
	await them.getByPlaceholder('New password', { exact: true }).fill('their-own-secret-1');
	await them.getByPlaceholder('Repeat new password').fill('their-own-secret-1');
	await them.getByRole('button', { name: 'Save and continue' }).click();
	await expect(them.getByRole('heading', { name: 'Shops' })).toBeVisible();

	// The admin disables them. §3.0: every session destroyed and every open SSE
	// stream terminated immediately — "disabling an account means now" is the
	// entire reason D-004 chose server-side sessions over JWTs.
	await page.reload();
	const row = page.locator('li', { hasText: 'revoked-member' });
	await row.getByRole('button', { name: 'Disable' }).click();
	await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible();

	// Their tab finds out on its own, over the stream, without a reload.
	await expect(them).toHaveURL(/\/login/, { timeout: 15_000 });
	// And the cached list went with it: the next person to use this browser must
	// not see a frame of the previous one's shopping.
	await expect(them.getByRole('heading', { name: 'Shops' })).toBeHidden();

	await theirs.close();
});
