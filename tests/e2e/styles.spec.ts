import { expect, test } from '@playwright/test';

// Regression: Tailwind's preflight once outranked Astryx's layers in the production CSS, so headings
// fell back to 16px and Astryx padding props did nothing. Unit tests and axe do not see that.
test('Astryx typography and spacing win over the Tailwind reset', async ({ page }) => {
  await page.goto('/s/graphite/');
  const h1 = page.locator('h1').first();
  await expect(h1).toBeVisible();
  const { size, pad } = await h1.evaluate((el) => ({
    size: parseFloat(getComputedStyle(el).fontSize),
    pad: parseFloat(getComputedStyle(el.parentElement!).paddingLeft),
  }));
  expect(size).toBeGreaterThanOrEqual(24);
  expect(pad).toBeGreaterThanOrEqual(12);
});

test('owner screen is padded and styled too', async ({ page }) => {
  await page.goto('/s/graphite/owner/');
  const email = page.getByLabel(/Почта|Email|E-mail/i);
  await expect(email).toBeVisible();
  const box = await email.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(12);
});
