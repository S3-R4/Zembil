import { expect, test } from '@playwright/test';

/**
 * M6 at 390×844: claiming a trip, taking one over, making a shop private,
 * switching language, and copying a one-time password.
 *
 * These are the flows a domain test cannot reach — the take-over prompt only
 * exists because a `409 TRIP_CLAIMED` reached a screen, and "only you" is only
 * true if the other member's browser really cannot see the shop.
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

/** @param {import('@playwright/test').Page} page */
const closeSheet = (page) => page.keyboard.press('Escape');
/** @param {import('@playwright/test').Page} page */
const openAdd = (page) => page.getByRole('button', { name: 'Add an item' }).click();
/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function addItem(page, name) {
	await page.getByPlaceholder('Item', { exact: true }).fill(name);
	await page.getByRole('button', { name: /^Add to / }).click();
	await expect(page.getByText(`Added “${name}”`)).toBeVisible();
}

/**
 * A context that is NOT the signed-in admin.
 *
 * `browser.newContext()` inherits the project's `storageState` in this
 * Playwright version, so a "fresh" context arrives already holding the admin's
 * session cookie — which is how a two-member test quietly becomes a one-member
 * test that passes for the wrong reason. The empty state is explicit.
 *
 * @param {import('@playwright/test').Browser} browser
 */
const signedOutContext = (browser) =>
	browser.newContext({
		viewport: { width: 390, height: 844 },
		storageState: { cookies: [], origins: [] }
	});

/** Puts the admin's interface back into English, so a spec that runs after the
 *  language spec is not reading a Turkish screen. */
/** @param {import('@playwright/test').Page} page */
async function useEnglish(page) {
	await page.goto('/you');
	const english = page.getByRole('button', { name: 'English' });
	if ((await english.getAttribute('aria-pressed')) !== 'true') {
		await english.click();
		await expect(page.getByRole('link', { name: 'You' })).toBeVisible();
	}
}

test('claim a trip with a note, then release it', async ({ page }) => {
	await addStore(page, 'Claim Shop');

	await expect(page.getByText('Nobody is going yet.')).toBeVisible();

	await page.getByRole('button', { name: 'I’m going to this shop' }).click();
	await page.getByPlaceholder('What are you picking up?').fill('only the milk');
	await page.getByRole('button', { name: 'I’m going', exact: true }).click();

	await expect(page.getByText('You are shopping here.')).toBeVisible();
	await expect(page.getByText('“only the milk”')).toBeVisible();

	// R-18: the home card shows it too — that is what stops two people driving
	// to the same shop.
	await page.goto('/');
	await expect(page.getByText('You are shopping here.')).toBeVisible();
	await page.getByRole('link', { name: /Claim Shop/ }).click();

	// M10: release is visible directly on the claim strip. Leaving without
	// finishing no longer requires discovering it inside the note sheet.
	await page.getByRole('button', { name: 'I’m not going' }).click();
	await expect(page.getByText('Nobody is going yet.')).toBeVisible();
});

test('the note field counts down and stops at 140', async ({ page }) => {
	await addStore(page, 'Note Shop');
	await page.getByRole('button', { name: 'I’m going to this shop' }).click();

	const field = page.getByPlaceholder('What are you picking up?');
	await expect(page.getByText('140 characters left')).toBeVisible();
	await field.fill('x'.repeat(200));
	// maxlength is the client half of §3.1a's 140; the server enforces it too.
	await expect(field).toHaveValue('x'.repeat(140));
	await expect(page.getByText('0 characters left')).toBeVisible();
	await closeSheet(page);
});

test('a second member is offered "take over" rather than silently displacing anyone', async ({
	page,
	browser
}) => {
	const path = await addStore(page, 'Takeover Shop');

	// A second household member, created through the admin screen so the
	// one-time password flow is exercised on the way past.
	await page.goto('/you/admin');
	await page.getByRole('button', { name: 'New person' }).click();
	await page.getByPlaceholder('Username').fill('ikinci');
	await page.getByPlaceholder('Name shown in the app').fill('İkinci');
	await page.getByRole('button', { name: 'Create account' }).click();

	const shown = await page.locator('.password').innerText();
	expect(shown.length).toBeGreaterThan(8);
	await page.getByRole('button', { name: 'I have written it down' }).click();

	// They claim the trip first, in their own browser.
	const second = await signedOutContext(browser);
	const theirs = await second.newPage();
	await theirs.goto('/login');
	await expect(theirs).toHaveURL(/\/login/);
	// `exact`, because "Name" is a substring of "Shop name" and Playwright
	// matches placeholders loosely.
	await theirs.getByPlaceholder('Name', { exact: true }).fill('ikinci');
	await theirs.getByPlaceholder('Password', { exact: true }).fill(shown);
	await theirs.getByRole('button', { name: 'Sign in' }).click();
	await theirs.getByPlaceholder('Temporary password').fill(shown);
	await theirs.getByPlaceholder('New password', { exact: true }).fill('second-member-password');
	await theirs.getByPlaceholder('Repeat new password').fill('second-member-password');
	await theirs.getByRole('button', { name: 'Save and continue' }).click();
	// Awaited, not fired and forgotten: navigating away here cancels the change
	// in flight and the next `goto` lands back on /password with no clue why.
	await expect(theirs).toHaveURL(/\/$/);

	await theirs.goto(path);
	await theirs.getByRole('button', { name: 'I’m going to this shop' }).click();
	await theirs.getByPlaceholder('What are you picking up?').fill('bread');
	await theirs.getByRole('button', { name: 'I’m going', exact: true }).click();
	await expect(theirs.getByText('You are shopping here.')).toBeVisible();

	// Now the admin sees who is going, and gets the take-over path.
	await page.goto(path);
	await expect(page.getByText('İkinci is shopping here.')).toBeVisible();

	await page.getByRole('button', { name: 'Take over', exact: true }).click();
	await page.getByRole('button', { name: 'I’m going', exact: true }).click();

	// R-19: the first attempt deliberately fails so the member is TOLD who is
	// already going, and the button becomes an explicit take-over.
	await expect(page.getByText(/İkinci is already shopping/)).toBeVisible();
	await page.getByRole('button', { name: 'Take over anyway' }).click();

	await expect(page.getByText('You are shopping here.')).toBeVisible();
	await theirs.reload();
	await expect(theirs.getByText(/is shopping here\./)).toBeVisible();
	await expect(theirs.getByText('You are shopping here.')).toBeHidden();

	await second.close();
});

test('making a shop private hides it from everyone else, item authorship included', async ({
	page,
	browser
}) => {
	const path = await addStore(page, 'Private Shop');

	await openAdd(page);
	await addItem(page, 'Peynir');
	await closeSheet(page);

	// Public: the claim strip is there to offer, since the point of "I'm going"
	// is telling someone else. Authorship is real information too, with more
	// than one possible reader.
	await expect(page.getByRole('button', { name: 'I’m going to this shop' })).toBeVisible();
	await expect(page.getByText(/Added by admin/)).toBeVisible();

	await page.getByRole('button', { name: 'Shop settings' }).click();
	await page.getByRole('button', { name: 'Only me' }).click();
	await expect(page.getByText(/Only you can see this shop/)).toBeVisible();
	await closeSheet(page);
	await expect(page.getByText('Only you').first()).toBeVisible();

	// Private: nobody else can ever see this shop, so announcing a trip to
	// yourself has no reader. The whole claim strip goes away — and so does
	// "who added this", since the shop's one possible reader is also its one
	// possible author.
	await expect(page.getByRole('button', { name: 'I’m going to this shop' })).toBeHidden();
	await expect(page.getByText('Nobody is going yet.')).toBeHidden();
	await expect(page.getByText(/Added by admin/)).toBeHidden();

	// The other member signed in earlier; a fresh context for them proves the
	// shop is gone from the server's answers, not just from this screen.
	const second = await signedOutContext(browser);
	const theirs = await second.newPage();
	await theirs.goto('/login');
	await expect(theirs).toHaveURL(/\/login/);
	await theirs.getByPlaceholder('Name', { exact: true }).fill('ikinci');
	await theirs.getByPlaceholder('Password', { exact: true }).fill('second-member-password');
	await theirs.getByRole('button', { name: 'Sign in' }).click();
	await expect(theirs).toHaveURL(/\/$/);

	await expect(theirs.getByRole('link', { name: /Private Shop/ })).toBeHidden();

	// §8.4: asking for it directly is the same "not here" as an id that never
	// existed — not a 403, which would confirm it exists.
	const direct = await theirs.request.get(`/api/stores/${path.split('/').pop()}/list`);
	expect(direct.status()).toBe(404);

	await second.close();

	// And back again, unchanged.
	await page.goto(path);
	await page.getByRole('button', { name: 'Shop settings' }).click();
	await page.getByRole('button', { name: 'Everyone' }).click();
	await expect(page.getByText(/Everyone signed in sees this shop/)).toBeVisible();
	await closeSheet(page);
	await expect(page.getByRole('button', { name: 'I’m going to this shop' })).toBeVisible();
	await expect(page.getByText(/Added by admin/)).toBeVisible();
});

test('switching language changes the interface, and it survives a reload', async ({ page }) => {
	await useEnglish(page);
	await page.getByRole('button', { name: 'Türkçe' }).click();

	// The account screen's heading is the member's own name, so the nav is where
	// the language is legible.
	await expect(page.getByRole('link', { name: 'Hesabım' })).toBeVisible();
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Dükkanlar' })).toBeVisible();

	// It is a property of the PERSON, not the device: a reload re-renders from
	// `users.locale` on the server, so there is no flash of English.
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Dükkanlar' })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'tr');

	await page.goto('/you');
	await page.getByRole('button', { name: 'Deutsch' }).click();
	await expect(page.getByRole('link', { name: 'Konto' })).toBeVisible();
	await expect(page.locator('html')).toHaveAttribute('lang', 'de');

	await page.getByRole('button', { name: 'English' }).click();
	await expect(page.getByRole('link', { name: 'You' })).toBeVisible();
});

test('the one-time password can be copied instead of transcribed', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	await useEnglish(page);
	await page.goto('/you/admin');

	await page.getByRole('button', { name: 'New person' }).click();
	await page.getByPlaceholder('Username').fill('kopyala');
	await page.getByRole('button', { name: 'Create account' }).click();

	const shown = await page.locator('.password').innerText();
	const copy = page.getByRole('button', { name: 'Copy' });
	// PROJECT.md §8: no control below 44px, and this one appears in a sheet.
	const box = await copy.boundingBox();
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

	await copy.click();
	await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();

	const clipboard = await page.evaluate(() => navigator.clipboard.readText());
	expect(clipboard).toBe(shown);

	await page.getByRole('button', { name: 'I have written it down' }).click();
	// The password is shown ONCE: closing the sheet must remove it from the DOM,
	// not merely hide it.
	await expect(page.locator('.password')).toHaveCount(0);
});
