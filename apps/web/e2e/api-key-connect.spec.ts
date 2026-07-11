/**
 * Playwright E2E — 8.5.3: API-key connection flow (Razorpay)
 *
 * Preconditions:
 *  - Web app running at WEB_URL (default: http://localhost:3000)
 *  - app-api running with seeded connector catalog
 *  - DB has been migrated and seeded with Razorpay connector
 */
import { test, expect } from '@playwright/test';
import { createTestUser, loginAs } from './helpers';

test.describe('8.5.3 API-key connect flow (Razorpay)', () => {
  let email: string;
  let password: string;

  test.beforeAll(async ({ browser }) => {
    const { userEmail, userPassword } = await createTestUser(browser);
    email = userEmail;
    password = userPassword;
  });

  test('user can connect Razorpay via API key', async ({ page }) => {
    await loginAs(page, email, password);

    // Navigate to connections page
    await page.goto('/dashboard/connections');
    await page.waitForLoadState('networkidle');

    // Click "Add Key" for Razorpay
    const addKeyBtn = page.locator('[id="connect-razorpay"]');
    await expect(addKeyBtn).toBeVisible({ timeout: 10_000 });
    await addKeyBtn.click();

    // Modal should appear
    await expect(page.locator('.modal')).toBeVisible();

    // Fill in the form
    await page.fill('[placeholder*="My Razorpay"]', 'Test Razorpay Account');
    await page.fill('[placeholder*="rzp_live"]', 'rzp_test_fake_key_123');
    await page.fill('[placeholder*="Leave blank"]', 'secret_fake_456');

    // Submit
    await page.click('[id="save-api-key-btn"]');

    // Modal should close and new connection should appear
    await expect(page.locator('.modal')).not.toBeVisible({ timeout: 5_000 });

    // Connection should now be listed
    await expect(page.getByText('Test Razorpay Account')).toBeVisible({ timeout: 5_000 });
  });
});
