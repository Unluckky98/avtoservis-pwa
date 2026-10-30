import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function audit(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label}: ${v.id} (${v.nodes.length}) ${v.nodes[0]?.html.slice(0, 120)}`)).toEqual([]);
}

test('serious accessibility violations: none on the main client screens', async ({ page }) => {
  await page.goto('/s/graphite/');
  await page.waitForLoadState('networkidle');
  await audit(page, 'home');
  await page.goto('/s/graphite/services');
  await audit(page, 'services');
  await page.goto('/s/graphite/my');
  await audit(page, 'my-booking-empty');
  await page.goto('/s/graphite/');
  await page.getByRole('button', { name: 'Записаться' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page, 'booking-sheet');
});

test('serious accessibility violations: none on the other studio and the owner login', async ({ page }) => {
  await page.goto('/s/garage47/');
  await page.waitForLoadState('networkidle');
  await audit(page, 'home-garage47');
  await page.goto('/s/graphite/owner/');
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  await audit(page, 'owner-login');
});
