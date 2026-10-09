import { defineConfig } from '@playwright/test';

const port = 4173;
const baseURL = `http://localhost:${port}`;

/**
 * Runs against the production build (`npm run build` must have run; the
 * `test:e2e` script does it). DEMO_FIXTURES=true enables the labeled fixture
 * data outside dev mode; SETUP_TOKEN makes first-run setup deterministic.
 */
export default defineConfig({
	testDir: 'e2e',
	workers: 1,
	timeout: 30_000,
	expect: { timeout: 7_500 },
	retries: process.env.CI ? 1 : 0,
	reporter: process.env.CI ? 'github' : 'list',
	webServer: {
		command: `ORIGIN=${baseURL} DATA_DIR=.e2e-data SETUP_TOKEN=e2e-setup-token DEMO_FIXTURES=true HOST=127.0.0.1 PORT=${port} node server/index.js`,
		url: `${baseURL}/healthz`,
		reuseExistingServer: !process.env.CI,
		timeout: 30_000
	},
	use: {
		baseURL,
		trace: 'retain-on-failure'
	},
	projects: [
		{ name: 'setup', testMatch: /auth\.setup\.ts/ },
		{
			name: 'chromium',
			dependencies: ['setup'],
			use: { storageState: 'e2e/.auth/user.json' }
		}
	]
});
