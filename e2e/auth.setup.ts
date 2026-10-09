import { mkdirSync } from 'node:fs';
import { test as setup } from '@playwright/test';
import { authFile, e2eUser } from './helpers.ts';

setup('authenticate', async ({ page }) => {
	mkdirSync('e2e/.auth', { recursive: true });

	// `/` sends first runs to /setup and later runs to /login.
	await page.goto('/');

	if (page.url().includes('/setup')) {
		await page.getByLabel('Setup token').fill('e2e-setup-token');
		await page.getByLabel('Name').fill('E2E Admin');
		await page.getByLabel('Email').fill(e2eUser.email);
		await page.getByLabel('Password', { exact: true }).fill(e2eUser.password);
		await page.getByRole('button', { name: 'Create administrator' }).click();
	} else {
		await page.getByLabel('Email').fill(e2eUser.email);
		await page.getByLabel('Password').fill(e2eUser.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
	}

	await page.waitForURL('/');
	await page.context().storageState({ path: authFile });
});
