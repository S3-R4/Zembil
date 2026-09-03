import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../../playwright.config.js';

/**
 * M8 at 390×844: who may change a shop's visibility, and the theme picker.
 *
 * Both of these are only true if a browser says so. A domain test can prove
 * that `PATCH /api/stores/{id}` answers 403; it cannot prove that the member
 * never sees a control that would produce one. And a domain test can prove that
 * `users.theme` was written; it cannot prove the SECOND device agrees, or that
 * the document arrives already painted rather than repainting a frame later.
 */

/**
 * The second member is created by `m6.spec.js`, which runs before this file in
 * the same serial project. Depending on a sibling spec's fixture is not lovely,
 * but the alternative is a second admin round trip per run for an account that
 * already exists — and the suite is deliberately serial against one database.
 *
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function addStore(page, name) {
	await page.goto('/');
	await page.getByRole('button', { name: 'Add a shop' }).click();
	await page.getByPlaceholder('Shop name').fill(name);
	await page.getByRole('button', { name: 'Add shop' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
	return new URL(page.url()).pathname;
}

/**
 * A context that is NOT the signed-in admin — `newContext()` inherits the
 * project's `storageState`, so the empty state has to be explicit.
 *
 * @param {import('@playwright/test').Browser} browser
 */
const signedOutContext = (browser) =>
	browser.newContext({
		viewport: { width: 390, height: 844 },
		storageState: { cookies: [], origins: [] }
	});

/**
 * @param {import('@playwright/test').Browser} browser
 * @param {string} username
 * @param {string} password
 */
async function signInAs(browser, username, password) {
	const context = await signedOutContext(browser);
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByPlaceholder('Name', { exact: true }).fill(username);
	await page.getByPlaceholder('Password', { exact: true }).fill(password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page).toHaveURL(/\/$/);
	return { context, page };
}

test('a member who did not create a shop is not offered its visibility control', async ({
	page,
	browser
}) => {
	// The admin creates it, so the admin is both creator AND admin here; the
	// member is neither.
	const path = await addStore(page, 'Kırtasiye');

	const { context, page: theirs } = await signInAs(browser, 'ikinci', 'second-member-password');
	try {
		await theirs.goto(path);
		await theirs.getByRole('button', { name: 'Shop settings' }).click();

		// The section is still there — knowing who can see a shop matters to
		// everyone on it — but the buttons that would change it are not.
		await expect(theirs.getByText('Who can see this shop')).toBeVisible();
		await expect(theirs.getByText(/Only the member who created this shop/)).toBeVisible();
		await expect(theirs.getByRole('button', { name: 'Only me' })).toBeHidden();
		await expect(theirs.getByRole('button', { name: 'Everyone' })).toBeHidden();

		// Renaming is still theirs to do: this restricts one field, not the sheet.
		await theirs.getByPlaceholder('Shop name').fill('Kırtasiye 2');
		await theirs.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(theirs.getByRole('heading', { name: 'Kırtasiye 2' })).toBeVisible();

		// And the server refuses the field even when the control is bypassed —
		// the interface is the convenience, not the boundary.
		const storeId = path.split('/').pop();
		const refused = await theirs.request.patch(`/api/stores/${storeId}`, {
			data: { visibility: 'private' }
		});
		expect(refused.status()).toBe(403);
	} finally {
		await context.close();
	}

	// The creator still has it.
	await page.goto(path);
	await page.getByRole('button', { name: 'Shop settings' }).click();
	await expect(page.getByRole('button', { name: 'Only me' })).toBeVisible();
	await page.keyboard.press('Escape');
});

test('the chosen theme follows the account, and the document arrives already wearing it', async ({
	page,
	browser
}) => {
	await page.goto('/you');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'auto');

	await page.getByLabel('Theme').selectOption('indigo');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'indigo');

	// A reload proves the value came back from the server rather than from this
	// tab's memory — and `data-theme` is on the document Playwright received, so
	// there was no frame of the previous theme to repaint.
	await page.reload();
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'indigo');
	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'indigo');

	// A different browser, same account: the preference is on the account, which
	// is the whole reason it left localStorage.
	const { context, page: elsewhere } = await signInAs(browser, 'admin', ADMIN_PASSWORD);
	try {
		await expect(elsewhere.locator('html')).toHaveAttribute('data-theme', 'indigo');
	} finally {
		await context.close();
	}

	// Every theme is selectable and each one reaches the document.
	for (const theme of ['sepia', 'sage', 'contrast', 'plum', 'light', 'dark']) {
		await page.goto('/you');
		await page.getByLabel('Theme').selectOption(theme);
		await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
	}

	// Back to following the device, so a later spec reads the default screen.
	await page.goto('/you');
	await page.getByLabel('Theme').selectOption('auto');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'auto');
});

test('the theme control clears 44px', async ({ page }) => {
	await page.goto('/you');
	const box = await page.getByLabel('Theme').boundingBox();
	if (!box) throw new Error('the theme control is not on the account screen');
	expect(box.height).toBeGreaterThanOrEqual(44);
});
