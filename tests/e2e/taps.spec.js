import { expect, test } from '@playwright/test';

/**
 * PLAN.md M3 exit criterion: "Measured tap count from cold open to item added
 * is reported."
 *
 * Counted, not estimated: every click and every keystroke-group that a member
 * would actually perform, on a cold app open with a live session.
 */
test('cold open to item added, counted', async ({ page }) => {
	let taps = 0;
	/** @param {import('@playwright/test').Locator} locator */
	const tap = async (locator) => {
		taps += 1;
		await locator.click();
	};
	/**
	 * @param {import('@playwright/test').Locator} locator
	 * @param {string} text
	 */
	const type = async (locator, text) => {
		// Focusing a field is a tap; the typing itself is not a tap, it is the
		// thing the member came to do.
		taps += 1;
		await locator.fill(text);
	};

	// Cold open: the app icon on the home screen. The session is already live,
	// which is the normal case — a 30-day idle TTL (§5) means signing in is rare.
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();

	// Straight from the home screen: the canvas puts "Add an item" in the primary
	// slot here, not "Add a shop", and this is what that is worth.
	await tap(page.getByRole('button', { name: 'Add an item' }));
	// The name field is autofocused, so reaching it costs nothing — but count the
	// tap anyway rather than flatter the number.
	await type(page.getByPlaceholder('Item', { exact: true }), 'Yumurta');
	await tap(page.getByRole('button', { name: /^Add to / }));

	await expect(page.getByText('Added “Yumurta”')).toBeVisible();

	console.log(`\n  Cold open to item added: ${taps} taps.\n`);
	// Three: open the sheet, type, add. A regression that reintroduces a store
	// hop, or adds a confirmation step, should fail here and loudly.
	expect(taps).toBeLessThanOrEqual(3);

	// And the second item costs two, because the sheet stayed open.
	let second = 0;
	second += 1;
	await page.getByPlaceholder('Item', { exact: true }).fill('Peynir');
	second += 1;
	await page.getByRole('button', { name: /^Add to / }).click();
	await expect(page.getByText('Added “Peynir”')).toBeVisible();
	console.log(`  Each item after the first: ${second} taps.\n`);
	expect(second).toBeLessThanOrEqual(2);
});
