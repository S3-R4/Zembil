import { expect, test } from '@playwright/test';
import { ADMIN_PASSWORD } from '../../playwright.config.js';

/**
 * The brief's done-means clause: "passkey registration and login".
 *
 * A real browser ceremony, driven through Chrome DevTools Protocol's virtual
 * authenticator — the same `navigator.credentials` code path a phone takes,
 * against the same `@simplewebauthn` verification the server runs. The unit
 * suite already proves the server half with a hand-built software
 * authenticator; this proves the two halves meet.
 *
 * `http://127.0.0.1` is a secure context by browser rule, so WebAuthn is
 * available without TLS here. What that does NOT cover is a wrong
 * `ZEMBIL_ORIGIN` or `ZEMBIL_RP_ID` in a real deployment, which is a
 * configuration failure rather than a code one — see README.md.
 */

/** @param {import('@playwright/test').Page} page */
async function virtualAuthenticator(page) {
	const client = await page.context().newCDPSession(page);
	await client.send('WebAuthn.enable');
	const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			// Discoverable, because §3.2's usernameless login sends an empty
			// allowCredentials and can find nothing else. This is exactly what the
			// pinned `residentKey: 'required'` is there to guarantee.
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	return { client, authenticatorId };
}

test('register a passkey, then sign in with it and no username', async ({ page, context }) => {
	await virtualAuthenticator(page);

	await page.goto('/you');
	await expect(page.getByRole('heading', { name: 'Passkeys' })).toBeVisible();
	await expect(page.getByText('None on this account yet.')).toBeVisible();

	await page.getByRole('button', { name: 'Add a passkey' }).click();
	await page.getByLabel('Device name').fill('Kitchen tablet');
	await page.getByRole('button', { name: 'Create passkey' }).click();

	await expect(page.getByText('Kitchen tablet')).toBeVisible();
	await expect(page.getByText('never used')).toBeVisible();

	// Sign out, then back in with the passkey alone — no username typed anywhere.
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login/);

	await page.getByRole('button', { name: 'This phone remembers you' }).click();
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();

	// §3.2: a successful assertion writes back, so the account screen stops
	// saying "never used". Without that write the clone check could never fire.
	await page.goto('/you');
	await expect(page.getByText('Kitchen tablet')).toBeVisible();
	await expect(page.getByText('never used')).toBeHidden();

	// And the password still works — §3.2 requires the fallback to survive.
	await page.getByRole('button', { name: 'Sign out' }).click();
	await page.getByPlaceholder('Name').fill('admin');
	await page.getByPlaceholder('Password', { exact: true }).fill(ADMIN_PASSWORD);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await expect(page.getByRole('heading', { name: 'Shops' })).toBeVisible();

	// Removing it leaves the account reachable by password, which is the whole
	// point of I-10: a passkey-only account cannot exist.
	await page.goto('/you');
	await page.getByRole('button', { name: 'Remove' }).click();
	await expect(page.getByText('None on this account yet.')).toBeVisible();

	await context.clearCookies();
});
