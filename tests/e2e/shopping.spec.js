import { expect, test } from '@playwright/test';

/**
 * The brief's core loop, at 390×844: add, tick, un-tick, switch store, finish
 * the trip, and see the carry-over land on the next one.
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
}

/** Adds one item into an ALREADY OPEN quick-add sheet. The sheet staying open
 *  between items is the design, so the helper does not reopen it. */
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} [note]
 */
async function addItem(page, name, note) {
	await page.getByPlaceholder('Item', { exact: true }).fill(name);
	if (note) await page.getByPlaceholder('Quantity or note').first().fill(note);
	await page.getByRole('button', { name: /^Add to / }).click();
	await expect(page.getByText(`Added “${name}”`)).toBeVisible();
}

/** @param {import('@playwright/test').Page} page */
const openAdd = (page) => page.getByRole('button', { name: 'Add an item' }).click();
/** @param {import('@playwright/test').Page} page */
const closeSheet = (page) => page.keyboard.press('Escape');

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
const row = (page, name) => page.getByRole('checkbox', { name: new RegExp(name) });

test('add, tick, un-tick and undo on one list', async ({ page }) => {
	await addStore(page, 'Migros');

	await openAdd(page);
	await addItem(page, 'Süt', '2 litre');
	// The sheet STAYS OPEN — the whole reason it is a sheet. The second item
	// costs one tap, not four.
	await expect(page.getByPlaceholder('Item', { exact: true })).toBeFocused();
	await addItem(page, 'Ekmek');
	await closeSheet(page);

	await expect(row(page, 'Süt')).toBeVisible();
	await expect(row(page, 'Ekmek')).toBeVisible();
	await expect(page.getByText('In the basket')).toBeHidden();

	// Tick. The row does not disappear — it sinks below the divider as history.
	await row(page, 'Süt').click();
	await expect(page.getByText('In the basket · 1')).toBeVisible();
	await expect(row(page, 'Süt')).toHaveAttribute('aria-checked', 'true');
	await expect(row(page, 'Süt')).toBeVisible();

	// Undo puts it back above the divider.
	await page.getByRole('button', { name: 'Undo' }).click();
	await expect(page.getByText('In the basket')).toBeHidden();
	await expect(row(page, 'Süt')).toHaveAttribute('aria-checked', 'false');

	// And it survives a reload, so the tick really reached the server.
	await row(page, 'Süt').click();
	await expect(page.getByText('In the basket · 1')).toBeVisible();
	await page.reload();
	await expect(page.getByText('In the basket · 1')).toBeVisible();
	await expect(row(page, 'Süt')).toHaveAttribute('aria-checked', 'true');
});

test('the item list shows who added each item, with no tap required', async ({ page }) => {
	await addStore(page, 'Author Shop');
	await openAdd(page);
	await addItem(page, 'Zeytinyağı');
	await closeSheet(page);

	await expect(page.getByText(/Added by admin/)).toBeVisible();

	// Still shown once ticked — a ticked row swaps Edit for Undo, but the
	// authorship line lives on the row itself, not behind either affordance.
	await row(page, 'Zeytinyağı').click();
	await expect(page.getByText(/Added by admin/)).toBeVisible();
});

test('finishing a trip carries the unticked items to the next one', async ({ page }) => {
	await addStore(page, 'Pazar');
	await openAdd(page);
	await addItem(page, 'Domates');
	await addItem(page, 'Zeytin');
	await closeSheet(page);

	await row(page, 'Domates').click();
	await expect(page.getByText('In the basket · 1')).toBeVisible();

	await page.getByRole('button', { name: /Finish trip · 1 bought/ }).click();
	// A STRING, not a regex: Playwright normalizes whitespace for string matching
	// and does not for a regex, and this sentence is assembled from several
	// interpolations separated by newlines in the template.
	await expect(page.getByText('1 thing still on the list will move')).toBeVisible();
	await page.getByRole('button', { name: 'Finish trip', exact: true }).click();

	await expect(page).toHaveURL(/\/trips/);

	// The next trip for that store starts with exactly what was left behind.
	await page.goto('/');
	await page.getByRole('link', { name: /Pazar/ }).click();
	await expect(row(page, 'Zeytin')).toBeVisible();
	await expect(row(page, 'Domates')).toBeHidden();
	await expect(page.getByText('In the basket')).toBeHidden();

	// And the closed trip is in the history with both counts.
	await page.goto('/trips');
	await page.getByRole('tab', { name: 'Pazar' }).click();
	await expect(page.getByText('1 bought · 1 left on the list')).toBeVisible();
});

test('each store keeps its own list', async ({ page }) => {
	// Self-contained: two fresh stores, so this still means something if the
	// specs above are skipped or reordered.
	await addStore(page, 'Bakkal');
	await openAdd(page);
	await addItem(page, 'Çay');
	await closeSheet(page);

	await addStore(page, 'Kasap');
	await openAdd(page);
	await addItem(page, 'Kıyma');
	await closeSheet(page);

	await expect(row(page, 'Kıyma')).toBeVisible();
	await expect(row(page, 'Çay')).toBeHidden();

	await page.getByRole('link', { name: 'Shops', exact: true }).click();
	await page.getByRole('link', { name: /Bakkal/ }).click();
	await expect(row(page, 'Çay')).toBeVisible();
	await expect(row(page, 'Kıyma')).toBeHidden();
});

test('every tap target on the list clears 44px, one-handed at 390px', async ({ page }) => {
	await addStore(page, 'Şarküteri');
	await openAdd(page);
	await addItem(page, 'Kaşar');
	await closeSheet(page);

	for (const target of await page.getByRole('button').all()) {
		if (!(await target.isVisible())) continue;
		const box = await target.boundingBox();
		if (!box) continue;
		expect(box.height, `${(await target.innerText()).trim() || 'icon button'} height`).toBeGreaterThanOrEqual(44);
		expect(box.width).toBeGreaterThanOrEqual(44);
	}

	// The primary action sits in the bottom third, where a thumb reaches.
	const add = page.getByRole('button', { name: 'Add an item' });
	const box = await add.boundingBox();
	const viewport = page.viewportSize();
	if (!box || !viewport) throw new Error('The primary action is not on screen at all.');
	expect(box.y).toBeGreaterThan(viewport.height * 0.66);
});
