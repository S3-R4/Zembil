import { expect, test } from '@playwright/test';

/**
 * Deleting a shop at 390×844 — CONTRACT.md §9.1, R-23.
 *
 * The domain tests already prove the rows go. What only a browser can prove is
 * the part that keeps a family from losing a list by accident: the destructive
 * button is never the one already under the thumb, the confirm step does not
 * survive closing the sheet, and the screen you land on afterwards tells you
 * what went.
 */

/**
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

test('deleting a shop from its settings takes it and its items away for good', async ({ page }) => {
	await addStore(page, 'Doomed Shop');

	await page.getByRole('button', { name: 'Add an item' }).click();
	await page.getByPlaceholder('Item', { exact: true }).fill('Milk');
	await page.getByRole('button', { name: /^Add to / }).click();
	// The add sheet deliberately stays open (DESIGN.md §3), so close it before
	// looking at the list behind it.
	await page.keyboard.press('Escape');
	await expect(page.getByRole('checkbox', { name: 'Milk' })).toBeVisible();

	await page.getByRole('button', { name: 'Shop settings' }).click();

	// Arming is one tap and destroys nothing; the confirm is a different button.
	await page.getByRole('button', { name: 'Delete this shop' }).click();
	await expect(page.getByText('Delete Doomed Shop for good?')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Keep it' })).toBeVisible();

	// Backing out leaves the shop exactly where it was.
	await page.getByRole('button', { name: 'Keep it' }).click();
	await expect(page.getByRole('button', { name: 'Delete this shop' })).toBeVisible();

	// And the armed state does not survive closing the sheet — reopening must
	// not put "Delete permanently" one tap from a member who came back to
	// rename something.
	await page.getByRole('button', { name: 'Delete this shop' }).click();
	await page.keyboard.press('Escape');
	await page.getByRole('button', { name: 'Shop settings' }).click();
	await expect(page.getByRole('button', { name: 'Delete permanently' })).toBeHidden();

	await page.getByRole('button', { name: 'Delete this shop' }).click();
	await page.getByRole('button', { name: 'Delete permanently' }).click();

	// Home, with a receipt for what went: the shop had one trip and one item.
	await expect(page).toHaveURL(/\/$/);
	await expect(page.getByText('Doomed Shop was deleted.')).toBeVisible();
	await expect(page.getByText('1 trip and 1 item went with it.')).toBeVisible();
	await expect(page.getByRole('link', { name: /Doomed Shop/ })).toBeHidden();

	// The server agrees, and says it the way §8.4 says a missing shop is said.
	const gone = await page.request.get('/api/stores');
	const body = await gone.json();
	expect(body.stores.map((/** @type {any} */ s) => s.name)).not.toContain('Doomed Shop');
});

test('an archived shop can be deleted from the archived sheet', async ({ page }) => {
	await addStore(page, 'Archived Doomed');

	await page.getByRole('button', { name: 'Shop settings' }).click();
	await page.getByRole('button', { name: 'Archive this shop' }).click();
	await expect(page).toHaveURL(/\/$/);

	await page.getByRole('button', { name: 'Archived shops' }).click();
	await expect(page.getByText('Archived Doomed')).toBeVisible();

	// Same two taps as in settings: the row's Delete arms, and the confirm is a
	// second, differently-worded button.
	await page.getByRole('button', { name: 'Delete Archived Doomed for good?' }).click();
	await page.getByRole('button', { name: 'Delete permanently' }).click();

	await expect(page.getByText('Archived Doomed was deleted.')).toBeVisible();
	await expect(page.getByText('Nothing is archived.')).toBeVisible();
});

test('every control in the delete flow clears 44px', async ({ page }) => {
	await addStore(page, 'Target Shop');
	await page.getByRole('button', { name: 'Shop settings' }).click();
	await page.getByRole('button', { name: 'Delete this shop' }).click();

	for (const name of ['Keep it', 'Delete permanently']) {
		const box = await page.getByRole('button', { name }).boundingBox();
		expect(box).not.toBeNull();
		expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
		expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
	}

	await page.getByRole('button', { name: 'Keep it' }).click();
	await page.keyboard.press('Escape');
});
