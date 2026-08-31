import { defineConfig } from '@playwright/test';

const PORT = 4173;
export const BASE_URL = `http://127.0.0.1:${PORT}`;
/** The password compose would print once on a first boot; pinned here so the
 *  setup project can sign in. */
export const BOOTSTRAP_PASSWORD = 'e2e-bootstrap-password';
export const ADMIN_PASSWORD = 'e2e-admin-password';

export default defineConfig({
	testDir: 'tests/e2e',
	// Against one server holding one SQLite file, parallel specs would race each
	// other's stores and trips. The suite is small; serial is honest.
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: 0,
	reporter: process.env.CI ? 'list' : [['list']],
	globalSetup: './tests/e2e/global-setup.js',

	use: {
		baseURL: BASE_URL,
		trace: 'retain-on-failure'
	},

	projects: [
		{ name: 'setup', testMatch: /.*\.setup\.js/ },
		{
			name: 'phone',
			dependencies: ['setup'],
			use: {
				// The brief's target: one-handed on a 390px phone. Every assertion
				// about reach and tap size is meaningless at any other size.
				//
				// Chromium rather than the built-in `devices['iPhone 13']`, which is
				// a WebKit descriptor: only the Chromium build is installed here, and
				// a suite that cannot run is worth less than one that runs on the
				// wrong engine. The viewport, touch and mobile flags are what the
				// layout assertions actually depend on.
				browserName: 'chromium',
				viewport: { width: 390, height: 844 },
				deviceScaleFactor: 3,
				isMobile: true,
				hasTouch: true,
				storageState: 'tests/e2e/.auth/admin.json'
			}
		}
	],

	webServer: {
		command: 'node build/index.js',
		url: `${BASE_URL}/api/health`,
		reuseExistingServer: false,
		stdout: 'pipe',
		stderr: 'pipe',
		env: {
			ZEMBIL_ORIGIN: BASE_URL,
			ZEMBIL_DATA_DIR: '.playwright-data',
			ZEMBIL_BOOTSTRAP_ADMIN_USERNAME: 'admin',
			ZEMBIL_BOOTSTRAP_ADMIN_PASSWORD: BOOTSTRAP_PASSWORD,
			// The whole suite runs from one address; the default per-IP buckets are
			// loose enough (§3.7) that this is not a problem, but the per-username
			// login bucket is 10 per 15 minutes and the failure-path tests spend it.
			ZEMBIL_TRUST_PROXY: '0',
			PORT: String(PORT),
			HOST: '127.0.0.1'
		}
	}
});
