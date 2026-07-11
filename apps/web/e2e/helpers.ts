/**
 * Playwright E2E helpers — shared utilities for test setup.
 *
 * Usage:
 *   import { createTestUser, loginAs } from './helpers';
 *
 *   const { userEmail, userPassword } = await createTestUser(browser);
 *   await loginAs(page, userEmail, userPassword);
 */
import { Browser, Page } from '@playwright/test';

const APP_API_URL = process.env.NEXT_PUBLIC_APP_API_URL ?? 'http://localhost:3001';

export async function createTestUser(
  browser: Browser,
): Promise<{ userEmail: string; userPassword: string }> {
  const email = `playwright-${Date.now()}@test.com`;
  const password = 'PlaywrightTest123!';

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/signup');
  await page.waitForLoadState('networkidle');

  // Fill signup form
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.click('button[type="submit"]');

  // Wait for redirect to dashboard
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 }).catch(() => {});

  await context.close();
  return { userEmail: email, userPassword: password };
}

export async function loginAs(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.click('button[type="submit"]');

  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
}

export async function getAuthToken(email: string, password: string): Promise<string> {
  const res = await fetch(`${APP_API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  return data.token as string;
}
