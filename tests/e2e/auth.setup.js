import { expect, test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { ADMIN_PASSWORD, BOOTSTRAP_PASSWORD } from '../../playwright.config.js';

const STATE = 'tests/e2e/.auth/admin.json';
const HOME = /\/$/;

/**
 * Signs in with the password the container bootstrapped, changes it — which the
 * server requires before any other endpoint answers (§3.2) — and saves the
 * session for the rest of the suite.
 *
 * This is also the real coverage of the bootstrap and forced-change flow: if
 * either broke, every other spec would fail at the door.
 */
setup('bootstrap admin and change the temporary password', async ({ page }) => {
	mkdirSync('tests/e2e/.auth', { recursive: true });

	await page.goto('/');
	await expect(page).toHaveURL(/\/login/);

	await page.getByPlaceholder('Name').fill('admin');
	await page.getByPlaceholder('Password', { exact: true }).fill(BOOTSTRAP_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();

	// §3.2: the temporary password is a handoff credential, so the app sends the
	// member straight here and the API refuses everything else until it changes.
	await expect(page).toHaveURL(/\/password/);
	await page.getByPlaceholder('Temporary password').fill(BOOTSTRAP_PASSWORD);
	await page.getByPlaceholder('New password', { exact: true }).fill(ADMIN_PASSWORD);
	await page.getByPlaceholder('Repeat new password').fill(ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Save and continue' }).click();

	await expect(page).toHaveURL(HOME);
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();

	await page.context().storageState({ path: STATE });
});
