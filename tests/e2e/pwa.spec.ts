import { expect, test } from '@playwright/test';
import { OWNER_EMAIL, OWNER_PASSWORD } from '../harness/db';

test('each studio has its own shell, manifest, worker scope and caches', async ({ page }) => {
  for (const [slug, name] of [['graphite', 'GRAPHITE Detailing'], ['garage47', 'Гараж 47']] as const) {
    await page.goto(`/s/${slug}/my`); // a deep link must open the right studio's shell
    await expect(page).toHaveTitle(name);
    expect(await page.locator('link[rel=manifest]').getAttribute('href')).toBe(`/s/${slug}/manifest.webmanifest`);
    expect(await page.locator('link[rel=apple-touch-icon]').getAttribute('href')).toBe(`/s/${slug}/icons/apple-touch-icon.png`);
    const m = await (await page.request.get(`/s/${slug}/manifest.webmanifest`)).json();
    expect(m).toMatchObject({ id: `/s/${slug}/`, start_url: `/s/${slug}/`, scope: `/s/${slug}/`, name });
    await page.evaluate(() => navigator.serviceWorker.ready);
  }
  const state = await page.evaluate(async () => ({
    scopes: (await navigator.serviceWorker.getRegistrations()).map((r) => new URL(r.scope).pathname).sort(),
    caches: (await caches.keys()).sort(),
  }));
  expect(state.scopes).toEqual(['/s/garage47/', '/s/graphite/']);
  expect(state.caches.filter((c) => c.startsWith('avto-graphite-')).length).toBeGreaterThan(0);
  expect(state.caches.filter((c) => c.startsWith('avto-garage47-')).length).toBeGreaterThan(0);
  expect(state.caches.every((c) => /^avto-(graphite|garage47)-/.test(c))).toBe(true);
});

test('no private data is ever stored in the worker caches; sign-out clears the session', async ({ page }) => {
  await page.goto('/s/graphite/owner/');
  await page.getByLabel('Почта').fill(OWNER_EMAIL);
  await page.getByLabel('Пароль').fill(OWNER_PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page.getByRole('tab', { name: 'Записи' })).toBeVisible();
  await page.getByRole('tab', { name: 'Статистика' }).click();
  await expect(page.getByText('Получено денег')).toBeVisible();

  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const n of await caches.keys()) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
    return urls;
  });
  expect(cached.filter((u) => /\/(rest|auth|functions|storage)\//.test(u))).toEqual([]);

  await page.getByRole('button', { name: 'Выйти' }).click();
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('avto-owner:')));
  expect(left).toEqual([]);
  // going back must not reveal the cabinet
  await page.goto('/s/graphite/owner/');
  await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
});

test('hero button travels with the photo and the navigation never covers content', async ({ page }) => {
  await page.goto('/s/graphite/');
  const hero = page.locator('header.hero');
  const cta = hero.getByRole('button', { name: 'Записаться' });
  await expect(cta).toBeVisible();
  const rel = async () => {
    const [h, c] = [await hero.boundingBox(), await cta.boundingBox()];
    return Math.round(c!.y - h!.y);
  };
  const before = await rel();
  await page.evaluate(() => window.scrollBy(0, 120));
  expect(await rel()).toBe(before); // same place on the photo...
  const y1 = (await cta.boundingBox())!.y;
  expect(y1).toBeLessThan((await hero.boundingBox())!.y + (await hero.boundingBox())!.height); // ...inside it

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(300);
  const nav = (await page.getByRole('navigation', { name: 'Основная навигация' }).boundingBox())!;
  const lastBlock = (await page.locator('main section').last().boundingBox())!;
  expect(lastBlock.y + lastBlock.height).toBeLessThanOrEqual(nav.y + 1);
});

test('reduced motion: content is never hidden by reveal animations', async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto('/s/graphite/');
  await p.waitForTimeout(300);
  expect(await p.locator('[data-armed="true"]').count()).toBe(0);
  await ctx.close();
});

test('browser Back closes the booking sheet instead of leaving the app', async ({ page }) => {
  await page.goto('/s/graphite/');
  await page.getByRole('button', { name: 'Записаться' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page).toHaveURL(/\/s\/graphite\/$/);
});

test('unknown studio shows an honest state, other routes keep working', async ({ page, context }) => {
  await page.goto('/s/no-such-studio/');
  await expect(page.getByRole('heading', { name: 'Студия не найдена' })).toBeVisible();
  await page.goto('/s/graphite/services');
  await expect(page.getByRole('heading', { level: 1, name: 'Услуги' })).toBeVisible();
  void context;
});
