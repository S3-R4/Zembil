import { expect, test } from '@playwright/test';

/**
 * PLAN.md M3 exit criterion: "A test asserts the service worker never serves a
 * cached authenticated document."
 *
 * This is the one thing in the frontend that could leak a family's shopping
 * list to the next person who opens this browser, so it is asserted directly
 * rather than inferred from the worker's source.
 */

/** @param {import('@playwright/test').Page} page */
async function serviceWorkerReady(page) {
	await page.goto('/');
	await page.waitForFunction(async () => {
		const registration = await navigator.serviceWorker.ready;
		return registration.active?.state === 'activated';
	});
}

test('the service worker installs and precaches the shell', async ({ page }) => {
	await serviceWorkerReady(page);
	const cached = await page.evaluate(async () => {
		const keys = await caches.keys();
		const cache = await caches.open(keys[0]);
		return (await cache.keys()).map((r) => new URL(r.url).pathname);
	});
	expect(cached).toContain('/offline.html');
	expect(cached.some((p) => p.startsWith('/_app/'))).toBe(true);
});

test('it caches no authenticated document and no API response', async ({ page }) => {
	await serviceWorkerReady(page);
	// Visit real, signed-in screens and let every fetch they make complete.
	await page.goto('/');
	await page.goto('/trips');
	await page.goto('/you');
	await page.waitForTimeout(500);

	const cached = await page.evaluate(async () => {
		const out = [];
		for (const key of await caches.keys()) {
			const cache = await caches.open(key);
			for (const request of await cache.keys()) out.push(new URL(request.url).pathname);
		}
		return out;
	});

	// No API response, ever — not the list, not /api/me, not the event stream.
	expect(cached.filter((p) => p.startsWith('/api/'))).toEqual([]);
	// No document either. `/offline.html` is the only HTML in there and it is
	// static: it names nobody and lists nothing.
	const documents = cached.filter((p) => p === '/' || p === '/trips' || p === '/you');
	expect(documents).toEqual([]);
});

test('an offline navigation gets the static offline page, not a stale list', async ({ page, context }) => {
	await serviceWorkerReady(page);
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();

	await context.setOffline(true);
	await page.reload();

	await expect(page.getByRole('heading', { name: 'No signal' })).toBeVisible();
	// The thing that must NOT happen: the previous, signed-in page coming back
	// out of the cache.
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeHidden();
	await expect(page.getByText('Migros')).toBeHidden();

	await context.setOffline(false);
	await page.getByRole('button', { name: 'Retry' }).click();
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();
});
