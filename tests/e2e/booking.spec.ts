import { expect, test } from '@playwright/test';
import { OWNER_EMAIL, OWNER_PASSWORD } from '../harness/db';

/** The one flow the product exists for: choose a service → get a confirmation → the owner sees the booking. */
test('client books a service and the owner sees and confirms it', async ({ page, browser }) => {
  await page.goto('/s/graphite/');
  await expect(page.getByRole('heading', { level: 1, name: 'SGX Detailing' })).toBeVisible();

  await page.getByRole('button', { name: 'Записаться' }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: /Комплексная мойка/ }).click();
  await sheet.locator('button[role=radio]:not([disabled])').filter({ hasText: /^\d\d:\d\d$/ }).nth(1).click();
  await sheet.getByRole('button', { name: 'Далее' }).click();

  // validation is visible and blocks submit
  await sheet.getByRole('button', { name: 'Записаться' }).click();
  await expect(sheet.getByText('Укажите имя')).toBeVisible();
  await expect(sheet.getByText('Введите номер телефона полностью')).toBeVisible();

  await sheet.getByLabel('Имя').fill('Анна Тестова');
  await sheet.getByLabel('Телефон').fill('+7 912 345-67-89');
  await sheet.getByLabel('Автомобиль').fill('Audi Q5');
  await sheet.getByRole('button', { name: 'Записаться' }).click();
  await expect(sheet.getByText('Запись создана')).toBeVisible();
  await sheet.getByRole('button', { name: 'Моя запись' }).click();

  await expect(page).toHaveURL(/\/s\/graphite\/my$/);
  await expect(page.getByRole('heading', { name: 'Комплексная мойка' })).toBeVisible();
  await expect(page.getByText('Ожидает подтверждения')).toBeVisible();
  const when = await page.locator('main p, main span').filter({ hasText: /\d\d:\d\d/ }).first().innerText();
  const time = /\d\d:\d\d/.exec(when)![0];

  // owner, in a separate browser context (no shared storage with the client)
  const ctx = await browser.newContext();
  const owner = await ctx.newPage();
  await owner.goto('/s/graphite/owner/');
  await owner.getByLabel('Почта').fill(OWNER_EMAIL);
  await owner.getByLabel('Пароль').fill(OWNER_PASSWORD);
  await owner.getByRole('button', { name: 'Войти' }).click();
  await expect(owner.getByRole('heading', { level: 1, name: 'SGX Detailing' })).toBeVisible();
  for (let i = 0; i < 8 && !(await owner.getByText(/Анна Тестова/).count()); i++) {
    await owner.getByRole('button', { name: '→' }).click();
    await owner.waitForTimeout(400);
  }
  await expect(owner.getByText(/Анна Тестова/)).toBeVisible();
  await expect(owner.getByText(new RegExp(time))).toBeVisible();
  await owner.getByText(/Анна Тестова/).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Подтвердить' }).click();

  // the client sees the new status without any account
  await page.reload();
  await expect(page.getByText('Подтверждена')).toBeVisible();

  // another studio never shows this booking
  await page.goto('/s/garage47/my');
  await expect(page.getByText('Записей на этом устройстве нет')).toBeVisible();
  await ctx.close();
});
