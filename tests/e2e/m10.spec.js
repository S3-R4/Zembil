import { expect, test } from '@playwright/test';

/** @param {import('@playwright/test').Page} page @param {string} name */
async function addStore(page, name) {
	await page.goto('/');
	await page.getByRole('button', { name: 'Add a shop' }).click();
	await page.getByPlaceholder('Shop name').fill(name);
	await page.getByRole('button', { name: 'Add shop' }).click();
	await expect(page.getByRole('heading', { name })).toBeVisible();
	return new URL(page.url()).pathname;
}

/** @param {import('@playwright/test').Page} page @param {string} name */
async function addItem(page, name) {
	await page.getByPlaceholder('Item', { exact: true }).fill(name);
	await page.getByRole('button', { name: /^Add to / }).click();
	await expect(page.getByText(`Added “${name}”`)).toBeVisible();
}

test('recently bought items are suggested and duplicates need an explicit second submit', async ({
	page
}) => {
	const path = await addStore(page, 'Suggestion Shop');
	await page.getByRole('button', { name: 'Add an item' }).click();
	await addItem(page, 'Milk');
	await page.keyboard.press('Escape');
	await page.getByRole('checkbox', { name: /Milk/ }).click();
	await page.getByRole('button', { name: /Finish trip/ }).click();
	await page.getByRole('button', { name: 'Finish trip', exact: true }).click();

	await page.goto(path);
	await page.getByRole('button', { name: 'Add an item' }).click();
	await expect(page.getByRole('button', { name: 'Milk' })).toBeVisible();
	await page.getByRole('button', { name: 'Milk' }).click();
	await page.getByRole('button', { name: /^Add to / }).click();
	await expect(page.getByText('Added “Milk”')).toBeVisible();

	await page.getByPlaceholder('Item', { exact: true }).fill('  milk  ');
	await expect(page.getByText('“milk” is already on this list.')).toBeVisible();
	await page.getByRole('button', { name: /^Add to / }).click();
	await expect(page.getByRole('button', { name: 'Add another anyway' })).toBeVisible();
	await page.getByRole('button', { name: 'Add another anyway' }).click();
	await expect(page.getByText('Added “milk”')).toBeVisible();
});

test('an item carried repeatedly becomes an explicit finish-trip nudge', async ({ page }) => {
	const path = await addStore(page, 'Carry Nudge Shop');

	for (const bought of ['Bread one', 'Bread two']) {
		await page.getByRole('button', { name: 'Add an item' }).click();
		if (bought === 'Bread one') await addItem(page, 'Milk');
		await addItem(page, bought);
		await page.keyboard.press('Escape');
		await page.getByRole('checkbox', { name: new RegExp(bought) }).click();
		await page.getByRole('button', { name: /Finish trip/ }).click();
		if (bought === 'Bread two') {
			await expect(page.getByText('1 of them has already carried over before.')).toBeVisible();
		}
		await page.getByRole('button', { name: 'Finish trip', exact: true }).click();
		await page.goto(path);
	}

	await expect(page.getByText('Still needed after 2 trips')).toBeVisible();
});
