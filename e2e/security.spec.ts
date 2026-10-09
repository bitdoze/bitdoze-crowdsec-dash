import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { authFile, e2eUser } from './helpers.ts';

const run = Date.now().toString(36);
const apiHeaders = { Origin: 'http://localhost:4173' };
const viewer = { email: `e2e-viewer-${run}@example.com`, password: 'viewer-password-1234' };
const twoFaUser = { email: `e2e-2fa-${run}@example.com`, password: 'twofa-password-1234' };

/** RFC 6238 TOTP for a base32 secret (Better Auth's format). */
function totp(secret: string): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const clean = secret.replace(/=+$/, '').toUpperCase();
	const bytes: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of clean) {
		value = (value << 5) | alphabet.indexOf(ch);
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
	const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
	const offset = digest[digest.length - 1] & 0x0f;
	const code =
		(((digest[offset] & 0x7f) << 24) |
			(digest[offset + 1] << 16) |
			(digest[offset + 2] << 8) |
			digest[offset + 3]) %
		1_000_000;
	return String(code).padStart(6, '0');
}

/** A context with no cookies — the project's storageState would leak in. */
const freshContext = (browser: import('@playwright/test').Browser) =>
	browser.newContext({ storageState: { cookies: [], origins: [] } });

/** Sign in via the real UI in a fresh context; returns the signed-in page. */
async function signIn(
	browser: import('@playwright/test').Browser,
	user: { email: string; password: string },
	otp?: () => string
) {
	const context = await freshContext(browser);
	const page = await context.newPage();
	await page.goto('/login');
	await page.getByLabel('Email').fill(user.email);
	await page.getByLabel('Password').fill(user.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	if (otp) {
		await page.getByLabel('Verification code').fill(otp());
		await page.getByRole('button', { name: 'Verify', exact: true }).click();
	}
	await page.waitForURL('/');
	return page;
}

test.describe.configure({ mode: 'serial' });

test('unauthenticated /settings redirect carries the target', async ({ browser }) => {
	const context = await freshContext(browser);
	const page = await context.newPage();
	await page.goto('/settings/users');
	await expect(page).toHaveURL(/\/login\?redirectTo=%2Fsettings%2Fusers/);
	await context.close();
});

test('settings lists the current session', async ({ page }) => {
	await page.goto('/settings');
	await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();
	await expect(page.getByText('current', { exact: true })).toBeVisible();
});

test('admin can create a user; viewers get 403 on user administration', async ({
	page,
	browser
}) => {
	await page.goto('/settings/users');
	await expect(page.getByRole('heading', { name: 'User administration' })).toBeVisible();
	await page.getByLabel('Email', { exact: true }).fill(viewer.email);
	await page.getByLabel('Display name').fill('E2E Viewer');
	await page.getByLabel('Temporary password').fill(viewer.password);
	await page.getByRole('button', { name: 'Create' }).click();
	await expect(page.getByText(viewer.email, { exact: true })).toBeVisible();

	const viewerPage = await signIn(browser, viewer);
	// The overview loads fine (read)…
	await expect(viewerPage).toHaveURL('/');
	// …but the admin area is denied server-side.
	const res = await viewerPage.request.get('/settings/users');
	expect(res.status()).toBe(403);
	await viewerPage.goto('/settings/users');
	await expect(viewerPage.getByRole('heading', { name: '403' })).toBeVisible();
	await expect(
		viewerPage.getByText('This action requires the configure permission.')
	).toBeVisible();
	await viewerPage.context().close();
});

test('TOTP setup enables two-step sign-in and can be disabled', async ({ page, browser }) => {
	const res = await page.request.post('/api/auth/admin/create-user', {
		headers: apiHeaders,
		data: {
			email: twoFaUser.email,
			name: 'E2E 2FA',
			password: twoFaUser.password,
			role: 'operator'
		}
	});
	expect(res.ok(), `create-user ${await res.text()}`).toBeTruthy();
	const userPage = await signIn(browser, twoFaUser);

	// Enable via the Better Auth HTTP API (same backend the settings UI uses).
	const enable = await userPage.request.post('/api/auth/two-factor/enable', {
		headers: apiHeaders,
		data: { password: twoFaUser.password }
	});
	expect(enable.ok(), `enable ${await enable.text()}`).toBeTruthy();
	const { totpURI, backupCodes } = (await enable.json()) as {
		totpURI: string;
		backupCodes: string[];
	};
	const secret = new URL(totpURI).searchParams.get('secret') ?? '';
	expect(secret.length).toBeGreaterThan(10);
	expect(backupCodes.length).toBeGreaterThanOrEqual(5);
	const confirm = await userPage.request.post('/api/auth/two-factor/verify-totp', {
		headers: apiHeaders,
		data: { code: totp(secret) }
	});
	expect(confirm.ok(), `verify ${await confirm.text()}`).toBeTruthy();
	await userPage.context().close();

	// Password now lands on the code step.
	const context = await freshContext(browser);
	const step2 = await context.newPage();
	await step2.goto('/login');
	await step2.getByLabel('Email').fill(twoFaUser.email);
	await step2.getByLabel('Password').fill(twoFaUser.password);
	await step2.getByRole('button', { name: 'Sign in' }).click();
	await expect(step2.getByLabel('Verification code')).toBeVisible();
	await step2.getByLabel('Verification code').fill(totp(secret));
	await step2.getByRole('button', { name: 'Verify', exact: true }).click();
	await expect(step2).toHaveURL('/');

	// Leave the account clean for future runs.
	await step2.request.post('/api/auth/two-factor/disable', {
		headers: apiHeaders,
		data: { password: twoFaUser.password }
	});
	await context.close();
});

test('repeated wrong passwords trigger the application throttle', async ({ page }) => {
	const email = `throttle-${run}@example.com`;
	let throttled = '';
	for (let i = 0; i < 8 && !throttled; i++) {
		const res = await page.request.post('/login?/signIn', {
			headers: apiHeaders,
			form: { email, password: 'wrong-password-xxxx' }
		});
		throttled = (await res.text()).match(/Too many attempts[^<]*/)?.[0] ?? '';
	}
	expect(throttled).toContain('Too many attempts');

	// The block is scoped to the identity — a different account still gets a
	// normal credential error, not the throttle.
	const other = await page.request.post('/login?/signIn', {
		headers: apiHeaders,
		form: { email: `other-${run}@example.com`, password: 'wrong-password-xxxx' }
	});
	expect(await other.text()).toContain('Invalid email or password');
});

test('sign-out lands on /login (last — invalidates the shared state)', async ({ page }) => {
	await page.goto('/');
	await page.getByRole('button', { name: 'Account menu' }).click();
	await page.getByRole('menuitem', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/login/);
});

// Re-arm the shared storage state for any subsequent suites.
test('re-authenticate shared session', async ({ page }) => {
	await page.goto('/login');
	await page.getByLabel('Email').fill(e2eUser.email);
	await page.getByLabel('Password').fill(e2eUser.password);
	await page.getByRole('button', { name: 'Sign in' }).click();
	await page.waitForURL('/');
	await page.context().storageState({ path: authFile });
});
