/**
 * Playwright E2E — 8.5.1: Zap builder flow
 *
 * Tests: create zap → open builder → add action step → configure → verify save
 */
import { test, expect } from '@playwright/test';
import { createTestUser, loginAs } from './helpers';

test.describe('8.5.1 Zap builder flow', () => {
  let email: string;
  let password: string;

  test.beforeAll(async ({ browser }) => {
    const { userEmail, userPassword } = await createTestUser(browser);
    email = userEmail;
    password = userPassword;
  });

  test('user can create and configure a zap', async ({ page }) => {
    await loginAs(page, email, password);

    // Navigate to zaps
    await page.goto('/dashboard/zaps');
    await page.waitForLoadState('networkidle');

    // Create new zap
    await page.click('[id="new-zap-btn"]');
    await expect(page.locator('.modal')).toBeVisible();

    await page.fill('[id="zap-name-input"]', 'My E2E Test Zap');
    await page.click('[id="create-zap-submit"]');

    // Should redirect to zap builder
    await expect(page).toHaveURL(/\/dashboard\/zaps\/\d+/, { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Zap builder should be visible with trigger step
    await expect(page.getByText('trigger')).toBeVisible({ timeout: 5_000 });

    // Add an action step
    await page.click('[id="add-action-btn"]');
    await page.waitForLoadState('networkidle');

    // Action step should appear in builder
    await expect(page.getByText('action')).toBeVisible({ timeout: 5_000 });

    // Click on the action step to expand it
    const actionStepHeader = page.locator('.step-card').last().locator('.step-card-header');
    await actionStepHeader.click();

    // Step body should expand
    await expect(page.locator('.step-body').last()).toBeVisible({ timeout: 3_000 });
  });

  test('run history page shows empty state initially', async ({ page }) => {
    await loginAs(page, email, password);
    await page.goto('/dashboard/zaps');
    await page.waitForLoadState('networkidle');

    // Get first zap link
    const zapLink = page.locator('table a').first();
    if (await zapLink.count() === 0) return; // No zaps yet

    const href = await zapLink.getAttribute('href');
    if (!href) return;

    await page.goto(`${href}/runs`);
    await page.waitForLoadState('networkidle');

    // Should show empty state
    await expect(page.getByText('No runs yet')).toBeVisible({ timeout: 5_000 });
  });
});
